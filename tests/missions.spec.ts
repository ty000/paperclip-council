import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  buildMissionAggregate,
  canonicalPayloadHash,
  executeMissionCommand,
  handleMissionApi,
  missionInsertSql,
  parseMissionCreateInput,
  type MissionMandate,
} from "../src/missions.js";
import type { RosterSnapshot } from "../src/rosters.js";

const ids = {
  command: randomUUID(),
  mission: randomUUID(),
  issue: randomUUID(),
  company: randomUUID(),
  project: randomUUID(),
  team: randomUUID(),
  teamRevision: randomUUID(),
  council: randomUUID(),
  councilRevision: randomUUID(),
  lead: randomUUID(),
  reviewer: randomUUID(),
};

const mandate: MissionMandate = {
  objective: "Persist an exact mission composition",
  acceptanceCriteria: ["Pinned revisions remain inspectable"],
  commitments: ["No dispatch while G4 is open"],
  limits: {
    taskPolicy: "No provider calls in this bounded fixture",
    periodPolicy: "No provider calls in this bounded fixture period",
    correctionLimit: 2,
    elapsedMinutes: 60,
  },
};

function roster(kind: "team" | "council"): RosterSnapshot {
  const team = kind === "team";
  return {
    head: {
      companyId: ids.company,
      rosterId: team ? ids.team : ids.council,
      publishedRevision: team ? ids.teamRevision : ids.councilRevision,
      lifecycle: "active",
      version: 2,
      auditEntries: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    revision: {
      companyId: ids.company,
      rosterId: team ? ids.team : ids.council,
      revision: team ? ids.teamRevision : ids.councilRevision,
      kind,
      name: team ? "Team" : "Council",
      projectId: ids.project,
      content: {
        members: [{
          agentId: team ? ids.lead : ids.reviewer,
          responsibilities: [team ? "integration_lead" : "final_reviewer"],
        }],
        integrationLeadAgentId: team ? ids.lead : null,
        finalReviewerAgentId: team ? null : ids.reviewer,
        requiredPerspectives: team ? [] : ["quality"],
      },
      createdByUserId: "owner-1",
      createdAt: new Date(0).toISOString(),
    },
  };
}

describe("Council mission contracts", () => {
  it("normalizes create input and rejects absent limit declarations", () => {
    const body = {
      command: "create",
      commandId: ids.command,
      missionId: ids.mission,
      rootIssueId: ids.issue,
      projectId: ids.project,
      teamRosterId: ids.team,
      teamRevision: ids.teamRevision,
      councilRosterId: ids.council,
      councilRevision: ids.councilRevision,
      mandate,
    };
    expect(parseMissionCreateInput(body)).toEqual(body);
    expect(() => parseMissionCreateInput({ ...body, mandate: { ...mandate, limits: undefined } })).toThrow(/mandate\.limits/);
  });

  it("pins exact revisions while keeping execution explicitly blocked", () => {
    const create = parseMissionCreateInput({
      command: "create",
      commandId: ids.command,
      missionId: ids.mission,
      rootIssueId: ids.issue,
      projectId: ids.project,
      teamRosterId: ids.team,
      teamRevision: ids.teamRevision,
      councilRosterId: ids.council,
      councilRevision: ids.councilRevision,
      mandate,
    });
    const aggregate = buildMissionAggregate({
      create,
      companyId: ids.company,
      ownerUserId: "owner-1",
      team: roster("team"),
      council: roster("council"),
      payloadHash: canonicalPayloadHash(create),
      at: new Date(0).toISOString(),
    });
    expect(aggregate.compositions).toMatchObject({
      status: "pinned",
      team: { revision: ids.teamRevision },
      council: { revision: ids.councilRevision },
    });
    expect(aggregate.responsibilities).toEqual({
      integrationLeadAgentId: ids.lead,
      finalReviewerAgentId: ids.reviewer,
      requiredPerspectives: ["quality"],
    });
    expect(aggregate.readiness.execution).toBe("blocked");
    expect(aggregate.readiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "runtime_budget_exposure", status: "unsupported" }),
    ]));
    expect(aggregate.effectIntents).toEqual([]);
  });

  it("requires the configured owner before touching mission storage", async () => {
    const ctx = {
      companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: "owner-1" }) },
    } as unknown as PluginContext;
    await expect(executeMissionCommand(ctx, {
      companyId: ids.company,
      actorUserId: "intruder-1",
      body: { command: "create" },
    })).rejects.toMatchObject({ status: 403, code: "owner_required" });
  });

  it("makes mission insertion conditional on locking both active current roster heads", () => {
    const sql = missionInsertSql({
      db: { namespace: "plugin_private_paperclip_council_test" },
    } as unknown as PluginContext);
    expect(sql).toContain("lifecycle = 'active'");
    expect(sql).toContain("published_revision = $7");
    expect(sql).toContain("published_revision = $9");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("SELECT count(*)");
  });

  it("refuses mission list and detail inspection to a non-owner board user", async () => {
    const ctx = {
      companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: "owner-1" }) },
      db: {
        namespace: "plugin_private_paperclip_council_test",
        query: async () => { throw new Error("mission storage must not be read before authorization"); },
      },
    } as unknown as PluginContext;
    const request = (routeKey: string, params: Record<string, string>) => ({
      routeKey,
      method: "GET",
      path: "",
      params: { companyId: ids.company, ...params },
      query: { companyId: ids.company },
      body: undefined,
      actor: { actorType: "user" as const, actorId: "intruder-1", userId: "intruder-1" },
      companyId: ids.company,
      headers: {},
    });
    await expect(handleMissionApi(request("missions-list", {}), ctx)).resolves.toMatchObject({
      status: 403,
      body: { code: "owner_required" },
    });
    await expect(handleMissionApi(request("mission-read", { missionId: ids.mission }), ctx)).resolves.toMatchObject({
      status: 403,
      body: { code: "owner_required" },
    });
  });
});
