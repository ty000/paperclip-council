import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
import { RosterError, type RosterSnapshot } from "../src/rosters.js";

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

function createInput() {
  return parseMissionCreateInput({
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
}

function storedMissionRow() {
  const create = createInput();
  const aggregate = buildMissionAggregate({
    create,
    companyId: ids.company,
    ownerUserId: "owner-1",
    team: roster("team"),
    council: roster("council"),
    payloadHash: canonicalPayloadHash(create),
    at: new Date(0).toISOString(),
  });
  return {
    company_id: ids.company,
    mission_id: ids.mission,
    root_issue_id: ids.issue,
    project_id: ids.project,
    owner_user_id: "owner-1",
    team_roster_id: ids.team,
    team_revision: ids.teamRevision,
    council_roster_id: ids.council,
    council_revision: ids.councilRevision,
    version: 1,
    aggregate,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function createRequest() {
  return {
    routeKey: "missions-command",
    method: "POST",
    path: "",
    params: { companyId: ids.company },
    query: {},
    body: createInput(),
    actor: { actorType: "user" as const, actorId: "owner-1", userId: "owner-1" },
    companyId: ids.company,
    headers: {},
  };
}

function stageAdmissionFailure(admissionError: unknown, appearingMission: ReturnType<typeof storedMissionRow> | null) {
  let exposeMission = false;
  let signalAdmissionStarted!: () => void;
  let releaseAdmission!: () => void;
  const admissionStarted = new Promise<void>((resolve) => { signalAdmissionStarted = resolve; });
  const admissionBlocked = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  const query = vi.fn(async () => exposeMission && appearingMission ? [appearingMission] : []);
  const execute = vi.fn();
  const ctx = {
    companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: "owner-1" }) },
    issues: {
      get: vi.fn(async () => {
        signalAdmissionStarted();
        await admissionBlocked;
        throw admissionError;
      }),
    },
    db: { namespace: "plugin_private_paperclip_council_test", query, execute },
  } as unknown as PluginContext;
  return {
    ctx,
    query,
    execute,
    admissionStarted,
    exposeMissionAndFailAdmission() {
      exposeMission = true;
      releaseAdmission();
    },
    failAdmission() {
      releaseAdmission();
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

  it("replays stored creation before consulting mutable issue, project or roster eligibility", async () => {
    const row = storedMissionRow();
    const admissionRead = vi.fn(async () => { throw new Error("Current admission is no longer valid"); });
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes(".missions")) throw new Error("Roster eligibility must not be read on replay");
      return [row];
    });
    const execute = vi.fn();
    const ctx = {
      companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: "owner-1" }) },
      issues: { get: admissionRead },
      projects: { get: admissionRead },
      db: { namespace: "plugin_private_paperclip_council_test", query, execute },
    } as unknown as PluginContext;
    const result = await executeMissionCommand(ctx, {
      companyId: ids.company,
      actorUserId: "owner-1",
      body: createInput(),
    });
    expect(result.outcome).toBe("replayed");
    expect(result.receipt).toEqual(row.aggregate.commandReceipts[0]);
    expect(result.mission.aggregate).toEqual(row.aggregate);
    expect(result.mission.version).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("(mission_id = $2 OR root_issue_id = $3)");
    expect(admissionRead).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("replays a matching creation that appears while mutable admission is in flight", async () => {
    const row = storedMissionRow();
    const staged = stageAdmissionFailure(
      new RosterError(409, "roster_selection_changed", "Roster selection changed"),
      row,
    );
    const pending = executeMissionCommand(staged.ctx, {
      companyId: ids.company,
      actorUserId: "owner-1",
      body: createInput(),
    });
    await staged.admissionStarted;
    staged.exposeMissionAndFailAdmission();
    await expect(pending).resolves.toMatchObject({
      outcome: "replayed",
      receipt: row.aggregate.commandReceipts[0],
    });
    expect(staged.query).toHaveBeenCalledTimes(2);
    expect(staged.execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "changed payload",
      body: { ...createInput(), mandate: { ...mandate, objective: "Different objective" } },
      code: "command_identity_conflict",
    },
    {
      name: "different command on an occupied identity",
      body: { ...createInput(), commandId: randomUUID() },
      code: "mission_exists",
    },
  ])("rejects $name when a mission appears while mutable admission is in flight", async ({ body, code }) => {
    const staged = stageAdmissionFailure(
      new RosterError(409, "roster_selection_changed", "Roster selection changed"),
      storedMissionRow(),
    );
    const pending = executeMissionCommand(staged.ctx, {
      companyId: ids.company,
      actorUserId: "owner-1",
      body,
    });
    await staged.admissionStarted;
    const rejection = expect(pending).rejects.toMatchObject({ status: 409, code });
    staged.exposeMissionAndFailAdmission();
    await rejection;
    expect(staged.query).toHaveBeenCalledTimes(2);
    expect(staged.execute).not.toHaveBeenCalled();
  });

  it("rethrows the exact unexpected admission error when both fallback identity reads remain empty", async () => {
    const unexpected = new Error("Admission dependency unavailable");
    const staged = stageAdmissionFailure(unexpected, null);
    const pending = executeMissionCommand(staged.ctx, {
      companyId: ids.company,
      actorUserId: "owner-1",
      body: createInput(),
    });
    await staged.admissionStarted;
    const rejection = expect(pending).rejects.toBe(unexpected);
    staged.failAdmission();
    await rejection;
    expect(staged.query).toHaveBeenCalledTimes(2);
    expect(staged.execute).not.toHaveBeenCalled();
  });

  it("preserves the original admission error when fallback identity readback fails", async () => {
    const admissionError = new RosterError(409, "roster_selection_changed", "Roster selection changed");
    const readbackError = new Error("Mission storage unavailable during fallback");
    let identityReads = 0;
    const ctx = {
      companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: "owner-1" }) },
      issues: { get: async () => { throw admissionError; } },
      db: {
        namespace: "plugin_private_paperclip_council_test",
        query: vi.fn(async () => {
          identityReads += 1;
          if (identityReads === 1) return [];
          throw readbackError;
        }),
        execute: vi.fn(),
      },
    } as unknown as PluginContext;
    await expect(executeMissionCommand(ctx, {
      companyId: ids.company,
      actorUserId: "owner-1",
      body: createInput(),
    })).rejects.toBe(admissionError);
    expect(identityReads).toBe(2);
  });

  it.each([
    { name: "changed payload", change: { mandate: { ...mandate, objective: "Different objective" } }, code: "command_identity_conflict", actor: "owner-1" },
    { name: "changed authenticated owner", change: {}, code: "command_identity_conflict", actor: "owner-2" },
    { name: "occupied mission ID", change: { commandId: randomUUID(), rootIssueId: randomUUID() }, code: "mission_exists", actor: "owner-1" },
    { name: "occupied root issue", change: { commandId: randomUUID(), missionId: randomUUID() }, code: "mission_exists", actor: "owner-1" },
    { name: "same command with another mission ID", change: { missionId: randomUUID() }, code: "command_identity_conflict", actor: "owner-1" },
  ])("rejects $name before mutable admission or writes", async ({ change, code, actor }) => {
    const row = storedMissionRow();
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (!sql.includes(".missions")) throw new Error("Unexpected roster lookup");
      const matches = values[1] === row.mission_id || values[2] === row.root_issue_id;
      return matches ? [row] : [];
    });
    const execute = vi.fn();
    const ctx = {
      companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: actor }) },
      db: { namespace: "plugin_private_paperclip_council_test", query, execute },
    } as unknown as PluginContext;
    await expect(executeMissionCommand(ctx, {
      companyId: ids.company,
      actorUserId: actor,
      body: { ...createInput(), ...change },
    })).rejects.toMatchObject({ status: 409, code });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a structured 404 for missing roster selection without inserting a mission", async () => {
    const execute = vi.fn();
    const ctx = {
      companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: "owner-1" }) },
      issues: { get: async () => ({ companyId: ids.company, projectId: ids.project, parentId: null }) },
      projects: { get: async () => ({ companyId: ids.company, archivedAt: null }) },
      db: { namespace: "plugin_private_paperclip_council_test", query: async () => [], execute },
    } as unknown as PluginContext;
    await expect(handleMissionApi(createRequest(), ctx)).resolves.toMatchObject({
      status: 404,
      body: { code: "roster_not_found", error: "Team or council roster not found in this company" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves roster error details and lets unexpected failures escape", async () => {
    const query = vi.fn();
    const ctx = {
      companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: "owner-1" }) },
      db: { namespace: "plugin_private_paperclip_council_test", query },
    } as unknown as PluginContext;
    const details = { rosterId: ids.team };
    query.mockRejectedValueOnce(new RosterError(422, "roster_fixture", "Roster fixture error", details));
    await expect(handleMissionApi(createRequest(), ctx)).resolves.toEqual({
      status: 422,
      body: { code: "roster_fixture", error: "Roster fixture error", details },
    });
    const unexpected = new Error("Database unavailable");
    query.mockRejectedValueOnce(unexpected);
    await expect(handleMissionApi(createRequest(), ctx)).rejects.toBe(unexpected);
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
