import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeMissionCommand, type MissionAggregate } from "../src/missions.js";
import { ModelSelectionError } from "../src/model-state.js";
import { inspectVariant, type VariantInspection } from "../src/model-variants.js";
import { validateRosterPair, type RosterSnapshot } from "../src/rosters.js";

vi.mock("../src/rosters.js", async original => ({ ...await original(), validateRosterPair: vi.fn() }));
vi.mock("../src/model-variants.js", () => ({ inspectVariant: vi.fn() }));

function harness(config: Record<string, unknown> = { modelVariantsEnabled: true, n2RuntimeProfile: "ordinary-cli-v1" }) {
  const ids = { company: randomUUID(), mission: randomUUID(), root: randomUUID(), project: randomUUID(), owner: randomUUID(),
    lead: randomUUID(), contributor: randomUUID(), reviewer: randomUUID(), specialist: randomUUID() };
  function roster(kind: "team" | "council"): RosterSnapshot {
    const rosterId = randomUUID(), revision = randomUUID(), now = new Date(0).toISOString();
    return { head: { companyId: ids.company, rosterId, publishedRevision: revision, lifecycle: "active", version: 1,
      auditEntries: [], createdAt: now, updatedAt: now },
    revision: { companyId: ids.company, rosterId, revision, kind, name: kind, projectId: ids.project,
      createdAt: now, createdByUserId: ids.owner,
      content: { members: (kind === "team" ? [ids.lead, ids.contributor] : [ids.reviewer, ids.specialist]).map(agentId => ({ agentId, responsibilities: [] })),
        integrationLeadAgentId: kind === "team" ? ids.lead : null, finalReviewerAgentId: kind === "council" ? ids.reviewer : null,
        requiredPerspectives: kind === "council" ? ["quality"] : [] } } };
  }
  const team = roster("team"), council = roster("council");
  vi.mocked(validateRosterPair).mockResolvedValue({ eligible: true, errors: [], prerequisites: [], team, council });
  const body = { command: "create", commandId: randomUUID(), missionId: ids.mission, rootIssueId: ids.root, projectId: ids.project,
    teamRosterId: team.head.rosterId, teamRevision: team.revision.revision, councilRosterId: council.head.rosterId, councilRevision: council.revision.revision,
    mandate: { objective: "Create only a launchable standard mission", acceptanceCriteria: ["All logical roles have prepared native variants"],
      commitments: ["No provider effects in this test"], limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 1, elapsedMinutes: 60 } } };
  const rows: Array<Record<string, unknown> & { aggregate: MissionAggregate }> = [];
  const execute = vi.fn(async (sql: string, values: unknown[]) => {
    expect(sql).toContain("INSERT INTO plugin_private_council_test.missions");
    if (rows.some(row => row.company_id === values[0] && (row.mission_id === values[1] || row.root_issue_id === values[2]))) return { rowCount: 0 };
    rows.push({ company_id: values[0], mission_id: values[1], root_issue_id: values[2], project_id: values[3], owner_user_id: values[4],
      team_roster_id: values[5], team_revision: values[6], council_roster_id: values[7], council_revision: values[8],
      aggregate: JSON.parse(String(values[9])), version: 1, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() });
    return { rowCount: 1 };
  });
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    expect(sql).toContain(".missions");
    return structuredClone(rows.filter(row => row.company_id === values[0] && (row.mission_id === values[1] || row.root_issue_id === values[2])));
  });
  const getConfig = vi.fn(async () => config);
  const getIssue = vi.fn(async () => ({ id: ids.root, companyId: ids.company, projectId: ids.project, parentId: null }));
  const getProject = vi.fn(async () => ({ id: ids.project, companyId: ids.company, archivedAt: null }));
  const ctx = { companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: ids.owner }) },
    config: { get: getConfig }, issues: { get: getIssue }, projects: { get: getProject },
    db: { namespace: "plugin_private_council_test", execute, query } } as unknown as PluginContext;
  const compatible = (logicalId: string): VariantInspection => ({ logicalAgentId: logicalId, agentId: logicalId,
    roleKey: logicalId === ids.lead ? "lead" : logicalId === ids.contributor ? "contributor-1"
      : logicalId === ids.reviewer ? "generalist-reviewer" : logicalId === ids.specialist ? "quality-reviewer" : null, profileId: "sol-medium",
    revision: "1", ready: true, expected: {}, observed: {}, gaps: [] });
  vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalId) => {
    expect(execute).not.toHaveBeenCalled();
    return compatible(logicalId);
  });
  return { ids, ctx, config, body, team, council, rows, execute, getConfig, getIssue, getProject, compatible,
    create: () => executeMissionCommand(ctx, { companyId: ids.company, actorUserId: ids.owner, body }) };
}

beforeEach(() => vi.resetAllMocks());

describe("mission native-variant eligibility", () => {
  it("pins the explicit workspace preflight only on a newly created ordinary fixed-variant mission", async () => {
    const profile = { codexHome: "/native/observed/home", codexCommand: "/tools/codex" };
    const h = harness({ modelVariantsEnabled: true, n2RuntimeProfile: "ordinary-cli-v1", workspacePreflight: profile });
    const result = await h.create();
    expect(result.mission.aggregate.workspacePreflight).toEqual(profile);
    h.getConfig.mockResolvedValue({ modelVariantsEnabled: true, n2RuntimeProfile: "ordinary-cli-v1", workspacePreflight: { codexHome: "/other/home" } } as never);
    const replay = await h.create();
    expect(replay.mission.aggregate.workspacePreflight).toEqual(profile);
  });
  it("refuses a preflight registration on an unsupported runtime rather than silently ignoring it", async () => {
    const h = harness({ workspacePreflight: { codexHome: "/native/home" } });
    await expect(h.create()).rejects.toMatchObject({ code: "workspace_preflight_profile_incompatible" });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it.each(["lead", "contributor", "reviewer", "specialist"] as const)("rejects an old %s outside the catalogue before inserting the mission", async role => {
    const h = harness();
    vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalId) => {
      if (logicalId === h.ids[role]) throw new ModelSelectionError("logical_identity_unknown", "No prepared catalogue anchor");
      return h.compatible(logicalId);
    });
    await expect(h.create()).rejects.toMatchObject({ name: "ModelSelectionError", code: "logical_identity_unknown" });
    expect(vi.mocked(inspectVariant).mock.calls.some(call => call[2] === h.ids[role])).toBe(true);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.rows).toEqual([]);
  });

  it("rejects a divergent anchor even when its physical identity is known", async () => {
    const h = harness();
    vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalId) => logicalId === h.ids.specialist
      ? { ...h.compatible(logicalId), ready: false, gaps: ["instructions_drift"], expected: { instructionSha256: "expected" }, observed: { instructionDrift: "changed" } }
      : h.compatible(logicalId));
    await expect(h.create()).rejects.toBeInstanceOf(ModelSelectionError);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.rows).toEqual([]);
  });

  it.each([
    { role: "lead", wrongRole: "security-reviewer" },
    { role: "contributor", wrongRole: "generalist-reviewer" },
    { role: "reviewer", wrongRole: "security-reviewer" },
    { role: "specialist", wrongRole: "generalist-reviewer" },
  ] as const)("rejects a ready $wrongRole anchor assigned as $role before insertion", async ({ role, wrongRole }) => {
    const h = harness();
    vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalId) => ({ ...h.compatible(logicalId),
      ...(logicalId === h.ids[role] ? { roleKey: wrongRole } : {}) }));
    await expect(h.create()).rejects.toMatchObject({ name: "ModelSelectionError", code: "model_roster_role_mismatch",
      details: { agentId: h.ids[role], role: wrongRole } });
    expect(vi.mocked(inspectVariant).mock.calls.some(call => call[2] === h.ids[role])).toBe(true);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.rows).toEqual([]);
  });

  it("preflights every team and council member before creating an opted-in standard mission", async () => {
    const h = harness(); const result = await h.create();
    expect(result).toMatchObject({ outcome: "applied", mission: { version: 1,
      aggregate: { modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [] } } } });
    expect(inspectVariant).toHaveBeenCalledTimes(4);
    for (const id of [h.ids.lead, h.ids.contributor, h.ids.reviewer, h.ids.specialist]) {
      expect(vi.mocked(inspectVariant).mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([h.ctx, h.ids.company, id, "sol-medium"])]));
    }
    expect(h.execute).toHaveBeenCalledTimes(1); expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.aggregate.compositions.team.members).toEqual(h.team.revision.content.members);
    expect(h.rows[0]!.aggregate.compositions.council.members).toEqual(h.council.revision.content.members);
    expect(h.rows[0]!.aggregate.responsibilities).toMatchObject({ integrationLeadAgentId: h.ids.lead, finalReviewerAgentId: h.ids.reviewer });
  });

  it.each([
    { name: "unspecified configuration", config: {} },
    { name: "unspecified runtime profile", config: { modelVariantsEnabled: true } },
    { name: "experimental runtime", config: { modelVariantsEnabled: true, n2RuntimeProfile: "paperclip_runner-experimental" } },
    { name: "disabled variants", config: { modelVariantsEnabled: false, n2RuntimeProfile: "ordinary-cli-v1" } },
    { name: "missing opt-in", config: { n2RuntimeProfile: "ordinary-cli-v1" } },
  ])("does not opt in or preflight $name", async ({ config }) => {
    const h = harness(config); const result = await h.create();
    expect(result.outcome).toBe("applied"); expect(result.mission.aggregate).not.toHaveProperty("modelSelection");
    expect(inspectVariant).not.toHaveBeenCalled(); expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("replays a historical creation without consulting current variants or upgrading its stored selection", async () => {
    const h = harness({}); const initial = await h.create();
    h.getConfig.mockResolvedValue({ modelVariantsEnabled: true, n2RuntimeProfile: "ordinary-cli-v1" });
    vi.mocked(inspectVariant).mockRejectedValue(new ModelSelectionError("logical_identity_unknown", "Historic roster has no catalogue anchor"));
    vi.mocked(validateRosterPair).mockRejectedValue(new Error("Historical roster is no longer selectable"));
    h.getIssue.mockRejectedValue(new Error("Mutable eligibility must not be rechecked"));
    const replay = await h.create();
    expect(replay).toMatchObject({ outcome: "replayed", mission: { version: 1 }, receipt: initial.receipt });
    expect(replay.mission.aggregate).toEqual(initial.mission.aggregate); expect(replay.mission.aggregate).not.toHaveProperty("modelSelection");
    expect(inspectVariant).not.toHaveBeenCalled(); expect(h.getConfig).toHaveBeenCalledTimes(1);
    expect(validateRosterPair).toHaveBeenCalledTimes(1); expect(h.getIssue).toHaveBeenCalledTimes(1); expect(h.getProject).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
