// Repository arbitration is exercised with real SQL in repository-occupation tests.
vi.mock("../src/repository-occupation.js", () => ({ ensureMissionRepository: vi.fn(async () => {}), releaseReconciledRepository: vi.fn(async () => {}) }));
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { linearFixture } from "./linear-intake-fixture.js";
import { reconcileProjectTasks } from "../src/project-task-intake.js";
import { MissionError } from "../src/mission-primitives.js";

const f = vi.hoisted(() => ({ fixture: null as any, mission: null as any, create: vi.fn(), activate: vi.fn(), source: vi.fn() }));
vi.mock("../src/project-mandate-state.js", async original => ({ ...await original<any>(),
  listProjectMandates: async () => [f.fixture.policy], readProjectMandate: async () => f.fixture.policy,
  projectTable: (_ctx: unknown, name: string) => name, projectMandateRow: (row: unknown) => row, operatingProfileHash: () => "profile" }));
vi.mock("../src/rosters.js", () => ({ validateRosterPair: async () => ({ eligible: true,
  team: { head: { publishedRevision: "team-v1" }, revision: { content: { members: [f.fixture.ids.lead, f.fixture.ids.a, f.fixture.ids.b].map(agentId => ({ agentId })) } } },
  council: { head: { publishedRevision: "council-v1" } } }) }));
vi.mock("../src/missions.js", async original => ({ ...await original<any>(),
  getMissionByRootIssue: async () => f.mission, getMission: async () => structuredClone(f.mission),
  createMission: async (_ctx: unknown, companyId: string, ownerUserId: string, body: any) => { await f.create(body);
    if (!f.mission) f.mission = { companyId, projectId: f.fixture.ids.project, rootIssueId: f.fixture.ids.root, missionId: body.missionId, ownerUserId, version: 1,
      aggregate: { phase: "draft", mandate: body.mandate, responsibilities: { integrationLeadAgentId: f.fixture.ids.lead } } }; } }));
vi.mock("../src/n2-missions.js", () => ({ n2CommandCas: vi.fn(), runtimeReceipt: vi.fn(), runtimeUuid: vi.fn(),
  n2Cas: async (_ctx: unknown, m: any, aggregate: any) => { f.mission = { ...m, version: m.version + 1, aggregate }; return structuredClone(f.mission); } }));
vi.mock("../src/continuity-configuration.js", () => ({ configureContinuity: async (_ctx: unknown, m: any) => {
  f.mission = { ...m, version: m.version + 1, aggregate: { ...m.aggregate, continuity: {} } };
} }));
vi.mock("../src/n1-missions.js", () => ({ executeN1BoardCommand: async (_ctx: unknown, input: any) => {
  await f.activate(input.body); f.mission.aggregate.n1 = {}; f.mission.aggregate.phase = "executing";
} }));
vi.mock("../src/g4-native.js", () => ({ readNativeG4Profile: async () => ({ periodKey: "original-period", runReservationUnits: 1000 }) }));
vi.mock("../src/linear-intake-revalidation.js", () => ({ assertLinearSource: (...args: unknown[]) => f.source(...args) }));

function context() {
  let row: any = null;
  const ask = vi.fn(async () => ({ issueId: f.fixture.ids.root, addresseeUserId: f.fixture.ids.owner }));
  const execute = vi.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith("INSERT") && !row) row = { company_id: p[0], root_issue_id: p[1], project_id: p[2], policy_revision_id: p[3], mission_id: p[4], version: 1, state: JSON.parse(p[5]) };
    if (sql.startsWith("UPDATE")) {
      if (row.version !== p[3]) return { rowCount: 0 };
      row.state = JSON.parse(p[0]); row.version++;
    }
    return { rowCount: 1 };
  });
  const ctx = f.fixture.ctx;
  ctx.db = { execute, query: async (sql: string) => sql.includes("project_mandates") ? [f.fixture.policy] : row ? [structuredClone(row)] : [] };
  ctx.companies = { get: async () => ({ defaultResponsibleUserId: f.fixture.ids.owner }) }; ctx.config = { get: async () => ({}) };
  ctx.issues.askUserQuestions = ask;
  return { ctx, ask, execute, receipt: () => structuredClone(row) };
}
function receipt(stage: "preparation" | "admission", validUntil = Date.now() + 60_000) {
  return { challengeId: randomUUID(), stage, requestSha256: "a".repeat(64), observedAt: new Date().toISOString(), validUntil: new Date(validUntil).toISOString() };
}
beforeEach(() => {
  vi.resetAllMocks(); f.fixture = linearFixture(); f.mission = null;
  f.source.mockImplementation(async (_ctx, _policy, _admissionId, _subject, stage) => receipt(stage));
});
it("waits for both original-source gates then admits one retained mission/reservation without changing source provenance", async () => {
  const c = context(); let allowed: "none" | "preparation" | "all" = "none";
  f.source.mockImplementation(async (_ctx, _policy, _admissionId, _subject, stage) => {
    if (allowed === "none" || allowed === "preparation" && stage === "admission") throw new MissionError(409, "linear_source_pending", "Waiting");
    return receipt(stage);
  });
  await reconcileProjectTasks(c.ctx); const initial = c.receipt();
  expect(f.fixture.update).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(c.ask).not.toHaveBeenCalled();
  allowed = "preparation"; await reconcileProjectTasks(c.ctx);
  expect(f.fixture.update).toHaveBeenCalledTimes(3); expect(f.create).toHaveBeenCalledTimes(1); expect(f.activate).not.toHaveBeenCalled(); expect(c.ask).not.toHaveBeenCalled();
  allowed = "all"; await reconcileProjectTasks(c.ctx); await reconcileProjectTasks(c.ctx);
  expect(f.activate).toHaveBeenCalledTimes(1); expect(f.activate.mock.calls[0]![0]).toMatchObject({ periodKey: "original-period", requestedUnits: 1000 });
  expect(c.receipt().mission_id).toBe(initial.mission_id); expect(f.mission.missionId).toBe(initial.mission_id);
  expect(f.mission.aggregate.mandate.objective.length).toBeLessThanOrEqual(4000);
  expect(f.fixture.issues.get(f.fixture.ids.root).description.length).toBeGreaterThan(30_000);
  expect(f.fixture.issues.get(f.fixture.ids.root).originKind).toBe("plugin:ty000.linear-intake");
  expect(c.receipt().state.linearIntake.preparationReceipt.stage).toBe("preparation");
  expect(c.receipt().state.linearIntake.admissionReceipt.stage).toBe("admission");
});
it("requires fresh source before each preparation effect and before the persisted activation command", async () => {
  const c = context(); f.source.mockImplementation(async (_ctx, _policy, _admission, _subject, stage) => receipt(stage, Date.now() - 1));
  await reconcileProjectTasks(c.ctx);
  expect(f.fixture.update).not.toHaveBeenCalled(); expect(c.ask).not.toHaveBeenCalled();
  f.source.mockImplementation(async (_ctx, _policy, _admission, _subject, stage) => receipt(stage, Date.now() + (stage === "admission" ? -1 : 60_000)));
  await reconcileProjectTasks(c.ctx); const before = c.receipt();
  expect(f.activate).not.toHaveBeenCalled(); expect(before.state.commands.activate).toBeDefined(); expect(c.ask).not.toHaveBeenCalled();
  f.source.mockImplementation(async (_ctx, _policy, _admission, _subject, stage) => receipt(stage));
  await reconcileProjectTasks(c.ctx);
  expect(f.activate.mock.calls[0]![0]).toEqual(before.state.commands.activate);
});
it("does not prepare if project authority changes during the source challenge", async () => {
  const c = context();
  f.source.mockImplementation(async (_ctx, _policy, _admission, _subject, stage) => { f.fixture.policy.content.operatingProfileHash = "changed"; return receipt(stage); });
  await reconcileProjectTasks(c.ctx);
  expect(f.fixture.update).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(c.ask).toHaveBeenCalledTimes(1);
});
