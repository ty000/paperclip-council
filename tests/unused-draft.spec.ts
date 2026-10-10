import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { executeMissionCommand, createMission, getMission } from "../src/missions.js";
import { executeN1BoardCommand } from "../src/n1-missions.js";
import { ensureMissionRepository } from "../src/repository-occupation.js";
import { configureContinuity } from "../src/continuity-configuration.js";
import { saveModelState } from "../src/model-runtime.js";
import { n2Cas, n2CommandCas, runtimeReceipt, runtimeUuid } from "../src/n2-missions.js";

function fixture() {
  const companyId = randomUUID(), missionId = randomUUID(), projectId = randomUUID(), rootIssueId = randomUUID();
  const aggregate: any = { schemaVersion: 1, companyId, missionId, projectId, rootIssueId, ownerUserId: "owner",
    phase: "draft", control: { status: "inactive", reason: "mission_not_enabled" }, mandate: {},
    compositions: {}, responsibilities: {}, readiness: {}, journal: [{ action: "mission_recorded" }],
    commandReceipts: [], effectIntents: [], modelSelection: { protocol: "native-variants-v1", choices: [{ profileId: "sol-high" }], tasks: [] } };
  const row: any = { company_id: companyId, mission_id: missionId, project_id: projectId, root_issue_id: rootIssueId,
    owner_user_id: "owner", aggregate, version: 2, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
  const issue: any = { id: rootIssueId, companyId, projectId, status: "backlog", checkoutRunId: null, executionRunId: null };
  const inventory: any = { companyId, issueId: rootIssueId, subtreeIssueIds: [rootIssueId], runs: [], approvals: [],
    costs: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
  const envelopes: any[] = [];
  const other = `${randomUUID()}:${randomUUID()}`;
  const registry = { version: 1, document: { initialized: true, holders: { [`${companyId}:${missionId}`]: { companyId, missionId, projectId, repository: null }, [other]: { repository: null } } as any } };
  const execute = vi.fn(async (sql: string, p: any[]) => {
    if (sql.includes("UPDATE test.missions")) {
      if (row.version !== p[3]) return { rowCount: 0 };
      row.aggregate = JSON.parse(p[0]); row.version++; return { rowCount: 1 };
    }
    if (sql.includes("repository_occupation")) {
      if (registry.version !== p[1] || row.version !== p[4]) return { rowCount: 0 };
      registry.document = JSON.parse(p[0]); registry.version++; return { rowCount: 1 };
    }
    throw new Error(`Unexpected mutation ${sql}`);
  });
  const ctx: any = { companies: { get: async () => ({ id: companyId, defaultResponsibleUserId: "owner" }) },
    db: { namespace: "test", query: async (sql: string) => structuredClone(sql.includes("admission_envelopes") ? envelopes : sql.includes("repository_occupation") ? [registry] : [row]), execute },
    issues: { get: async () => structuredClone(issue), summaries: { getOrchestration: vi.fn(async () => structuredClone(inventory)) } } };
  const body = { command: "abandon-unused-draft", commandId: randomUUID(), expectedVersion: 2, reason: "Disposable fixture" };
  const run = (overrides: any = {}) => executeMissionCommand(ctx, { companyId, missionId, actorUserId: "owner", body, ...overrides });
  return { companyId, missionId, ctx, row, aggregate, issue, inventory, envelopes, registry, other, execute, body, run };
}

it("preserves the draft, profile choices and audit trail; releases only its holder and replays the same identity", async () => {
  const f = fixture(); const before = structuredClone(f.aggregate);
  const result = await f.run();
  expect(result.outcome).toBe("applied");
  expect(f.row.aggregate).toMatchObject({ phase: "draft", modelSelection: before.modelSelection,
    control: { status: "blocked", reason: "unused_draft_abandoned" }, draftAbandonment: { commandId: f.body.commandId, actorUserId: "owner", reason: f.body.reason } });
  expect(f.row.aggregate.journal).toHaveLength(before.journal.length + 1);
  expect(f.row.aggregate.completion).toBeUndefined();
  expect(Object.keys(f.registry.document.holders)).toEqual([f.other]);
  const saved = structuredClone(f.row);
  expect((await f.run()).outcome).toBe("replayed"); expect(f.row).toEqual(saved);
  expect(f.ctx.issues.summaries.getOrchestration).toHaveBeenCalledWith({ companyId: f.companyId, issueId: f.issue.id, includeSubtree: true });
});

const failureMutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  started: f => { f.aggregate.phase = "executing"; },
  n1: f => { f.aggregate.n1 = {}; },
  n2: f => { f.aggregate.n2 = {}; },
  n3: f => { f.aggregate.n3 = {}; },
  n5: f => { f.aggregate.n5 = {}; },
  n6: f => { f.aggregate.n6 = {}; },
  "unknown field": f => { f.aggregate.futureExecution = {}; },
  intent: f => { f.aggregate.effectIntents.push({ state: "unknown" }); },
  launch: f => { f.aggregate.modelSelection.tasks.push({ launches: [] }); },
  delegation: f => { f.aggregate.continuity = {}; },
  hierarchy: f => { f.aggregate.hierarchy = {}; },
  baseline: f => { f.aggregate.nativeWakePolicy = { protocol: "council-native-wake-v2", rootBaseline: [{ runId: randomUUID() }] }; },
  reservation: f => { f.envelopes.push({ document: { reservations: [{ missionId: f.missionId, status: "reserved" }] } }); },
  "settled reservation": f => { f.envelopes.push({ document: { reservations: [{ missionId: f.missionId, status: "settled" }] } }); },
  "unadmitted run": f => { f.envelopes.push({ document: { reservations: [], unadmittedRuns: [{ missionId: f.missionId }] } }); },
  "unknown admission": f => { f.envelopes.push({ document: {} }); },
  "active run": f => { f.inventory.runs.push({ status: "running" }); },
  "historical run": f => { f.inventory.runs.push({ status: "succeeded" }); },
  "unknown inventory": f => { delete f.inventory.runs; },
  child: f => { f.inventory.subtreeIssueIds.push(randomUUID()); },
  "native lock": f => { f.issue.executionRunId = randomUUID(); },
  "native cost": f => { f.inventory.costs.inputTokens = 1; },
  approval: f => { f.inventory.approvals.push({ id: randomUUID() }); },
};
it.each(Object.entries(failureMutations))("retains occupation and makes no mutation for %s", async (_reason, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(f.run()).rejects.toMatchObject({ code: "unused_draft_unproven" });
  expect(f.execute).not.toHaveBeenCalled(); expect(Object.keys(f.registry.document.holders)).toHaveLength(2);
});

it.each(["wrong owner", "former owner", "version", "blank reason", "long reason"])("refuses %s before effects", async reason => {
  const f = fixture();
  if (reason === "former owner") f.row.owner_user_id = "former";
  if (reason === "version") f.body.expectedVersion = 1;
  if (reason === "blank reason") f.body.reason = " ";
  if (reason === "long reason") f.body.reason = "x".repeat(1001);
  await expect(f.run(reason === "wrong owner" ? { actorUserId: "intruder" } : {})).rejects.toBeDefined();
  expect(f.execute).not.toHaveBeenCalled();
});

it("keeps the marker and resumes a lost release under the same command after a process restart", async () => {
  const f = fixture(); const normal = f.execute.getMockImplementation()!;
  f.execute.mockImplementation(async (sql, params) => {
    if (sql.includes("repository_occupation")) throw new Error("synthetic interruption");
    return normal(sql, params);
  });
  await expect(f.run()).rejects.toThrow("synthetic interruption");
  expect(f.row.aggregate.draftAbandonment.commandId).toBe(f.body.commandId);
  expect(Object.keys(f.registry.document.holders)).toHaveLength(2);
  f.execute.mockImplementation(normal);
  expect((await f.run()).outcome).toBe("replayed");
  expect(Object.keys(f.registry.document.holders)).toEqual([f.other]);
  await expect(f.run({ body: { ...f.body, reason: "changed" } })).rejects.toMatchObject({ code: "command_identity_conflict" });
  await expect(f.run({ body: { ...f.body, commandId: randomUUID() } })).rejects.toMatchObject({ code: "mission_abandoned" });
});

it("retains occupation when a reservation arrived before the committed abandonment marker", async () => {
  const f = fixture(); const normal = f.execute.getMockImplementation()!;
  f.execute.mockImplementation(async (sql, params) => {
    const result = await normal(sql, params);
    if (sql.includes("UPDATE test.missions")) f.envelopes.push({ document: { reservations: [{ missionId: f.missionId }] } });
    return result;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "unused_draft_unproven" });
  expect(f.row.aggregate.draftAbandonment).toBeDefined(); expect(Object.keys(f.registry.document.holders)).toHaveLength(2);
});

it("does not mutate or release after a competing mission CAS", async () => {
  const f = fixture(); f.execute.mockImplementation(async () => { f.row.version++; return { rowCount: 0 }; });
  await expect(f.run()).rejects.toMatchObject({ code: "version_conflict" });
  expect(f.row.aggregate.draftAbandonment).toBeUndefined(); expect(Object.keys(f.registry.document.holders)).toHaveLength(2);
});

it("forbids activation, creation replay, mandate update, model mutation, continuity and repository reacquisition", async () => {
  const f = fixture(); await f.run(); const m = (await getMission(f.ctx, f.companyId, f.missionId))!;
  await expect(executeN1BoardCommand(f.ctx, { companyId: f.companyId, missionId: f.missionId, actorUserId: "owner", body: { command: "activate" } })).rejects.toMatchObject({ code: "mission_abandoned" });
  await expect(ensureMissionRepository(f.ctx, m)).rejects.toMatchObject({ code: "mission_abandoned" });
  await expect(saveModelState(f.ctx, m, m.aggregate.modelSelection!)).rejects.toMatchObject({ code: "mission_abandoned" });
  await expect(n2Cas(f.ctx, m, { ...m.aggregate, control: { status: "active" } })).rejects.toMatchObject({ code: "mission_abandoned" });
  await expect(configureContinuity(f.ctx, { ...m, aggregate: { ...m.aggregate, nativeWakePolicy: { protocol: "council-native-wake-v2", rootBaseline: [] } } }, "owner", { commandId: randomUUID(), authorizeProgression: true }, { n2CommandCas, runtimeReceipt, runtimeUuid })).rejects.toBeDefined();
  const mandate = { objective: "Unused", acceptanceCriteria: [], commitments: [], limits: { taskPolicy: "none", periodPolicy: "none", correctionLimit: 0, elapsedMinutes: 1 } };
  await expect(f.run({ body: { command: "update-mandate", commandId: randomUUID(), expectedVersion: m.version, mandate } })).rejects.toMatchObject({ code: "mission_abandoned" });
  await expect(createMission(f.ctx, f.companyId, "owner", { command: "create", commandId: randomUUID(), missionId: f.missionId, rootIssueId: f.issue.id, projectId: f.issue.projectId,
    teamRosterId: randomUUID(), teamRevision: randomUUID(), councilRosterId: randomUUID(), councilRevision: randomUUID(), mandate })).rejects.toMatchObject({ code: "mission_abandoned" });
});
