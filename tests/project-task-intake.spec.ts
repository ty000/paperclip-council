import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reconcileProjectTasks } from "../src/project-task-intake.js";
import type { MissionRecord } from "../src/missions.js";
import { LINEAR_ORIGIN } from "../src/linear-intake-contract.js";

const f = vi.hoisted(() => ({ policy: {} as any, issues: [] as any[], mission: null as MissionRecord | null, create: vi.fn(), activate: vi.fn(), configure: vi.fn(), guard: vi.fn() }));
vi.mock("../src/project-mandate-state.js", () => ({ listProjectMandates: async () => [f.policy], projectIssues: async () => f.issues,
  projectTable: (_ctx: unknown, name: string) => name, operatingProfileHash: () => "profile", projectMandateRow: (row: unknown) => row }));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: (...args: unknown[]) => f.guard(...args) }));
vi.mock("../src/missions.js", async importOriginal => ({ ...await importOriginal<any>(),
  getMissionByRootIssue: async () => f.mission, getMission: async () => structuredClone(f.mission),
  createMission: async (_ctx: unknown, _company: unknown, _owner: unknown, body: any) => { await f.create(body);
    if (!f.mission) f.mission = { companyId: "company", projectId: "project", rootIssueId: "root", missionId: body.missionId, ownerUserId: "owner", version: 1,
      aggregate: { phase: "draft", mandate: body.mandate } } as MissionRecord; } }));
vi.mock("../src/n2-missions.js", () => ({ n2CommandCas: vi.fn(), runtimeReceipt: vi.fn(), runtimeUuid: vi.fn(),
  n2Cas: async (_ctx: unknown, m: MissionRecord, aggregate: MissionRecord["aggregate"]) => {
  f.mission = { ...m, version: m.version + 1, aggregate }; return structuredClone(f.mission);
} }));
vi.mock("../src/continuity-configuration.js", () => ({ configureContinuity: async (_ctx: unknown, m: MissionRecord, _owner: unknown, body: any) => {
  await f.configure(body); f.mission = { ...m, version: m.version + 1, aggregate: { ...m.aggregate, continuity: {} as any } };
} }));
vi.mock("../src/n1-missions.js", () => ({ executeN1BoardCommand: async (_ctx: unknown, input: any) => {
  await f.activate(input.body); f.mission!.aggregate.n1 = {}; f.mission!.aggregate.phase = "executing";
} }));
vi.mock("../src/g4-native.js", () => ({ readNativeG4Profile: async () => ({ periodKey: "existing", runReservationUnits: 1000 }) }));

function context() {
  let row: any = null;
  const interactions = new Map<string, any>(); const ask = vi.fn(async (_issue: string, body: any) => {
    const result = interactions.get(body.idempotencyKey) ?? { issueId: "root", addresseeUserId: "owner" };
    interactions.set(body.idempotencyKey, result); return result;
  });
  const ctx = { db: {
    query: async (sql: string) => sql.includes("project_mandates") ? [f.policy] : row ? [structuredClone(row)] : [],
    execute: async (sql: string, p: any[]) => {
      if (sql.startsWith("INSERT") && !row) row = { company_id: p[0], root_issue_id: p[1], project_id: p[2], policy_revision_id: p[3], mission_id: p[4], version: 1, state: JSON.parse(p[5]) };
      if (sql.startsWith("UPDATE")) {
        if (row.version !== p[3]) return { rowCount: 0 };
        row.state = JSON.parse(p[0]); row.version++;
      }
      return { rowCount: 1 };
    } }, companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) }, config: { get: async () => ({}) },
    issues: { get: async () => f.issues[0], askUserQuestions: ask, documents: { get: async () => null } } } as unknown as PluginContext;
  return { ctx, ask, interactions, receipt: () => structuredClone(row) };
}
beforeEach(() => {
  vi.resetAllMocks(); f.mission = null;
  f.policy = { companyId: "company", projectId: "project", revisionId: "revision", version: 1, authorizedBy: "owner", content: {
    enabled: true, operatingProfileHash: "profile", leadAgentId: "lead", baselineRootIds: [], criteriaSource: "project-defaults", publication: null,
    allowedPaths: ["src"], n3Slots: [], template: { acceptanceCriteria: ["Explicit criterion"], commitments: [],
      limits: { taskPolicy: "1000", periodPolicy: "20000", correctionLimit: 0, elapsedMinutes: 30 } } } };
  f.issues = [{ id: "root", title: "Task", description: "Explicit result", status: "backlog", originKind: "manual", assigneeAgentId: "lead" }];
});
describe("stable project task intake", () => {
  it.each([
    { name: "manual backlog assigned to lead", issue: {}, policy: {}, eligible: true },
    { name: "manual blocked without adoption", issue: { status: "blocked" }, policy: {}, eligible: false },
    { name: "manual blocked with adoption", issue: { status: "blocked" }, policy: { hierarchy: { adoptExistingChildren: true } }, eligible: true },
    { name: "manual blocked with adoption refused", issue: { status: "blocked" }, policy: { hierarchy: { adoptExistingChildren: false } }, eligible: false },
    { name: "manual active", issue: { status: "in_progress" }, policy: {}, eligible: false },
    { name: "manual unassigned", issue: { assigneeAgentId: null }, policy: {}, eligible: false },
    { name: "manual other contributor", issue: { assigneeAgentId: "contributor" }, policy: {}, eligible: false },
    { name: "manual child", issue: { parentId: "parent" }, policy: {}, eligible: false },
    { name: "manual baseline root", issue: {}, policy: { baselineRootIds: ["root"] }, eligible: false },
    { name: "unknown origin", issue: { originKind: "plugin" }, policy: {}, eligible: false },
    { name: "Linear disabled", issue: { originKind: LINEAR_ORIGIN, status: "blocked", assigneeAgentId: null }, policy: {}, eligible: false },
  ])("selects only eligible roots: $name", async ({ issue, policy, eligible }) => {
    Object.assign(f.issues[0], issue); Object.assign(f.policy.content, policy);
    const c = context(), insert = vi.fn(async () => ({ rowCount: 1 }));
    // Observe selection through the public reconciliation entry, without advancing an intake.
    c.ctx.db.execute = insert; c.ctx.db.query = vi.fn(async () => []);
    await reconcileProjectTasks(c.ctx);
    expect(insert).toHaveBeenCalledTimes(Number(eligible));
    expect(f.create).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
  });
  it.each([
    { name: "blocked unassigned", issue: {}, policy: {}, eligible: true },
    { name: "backlog", issue: { status: "backlog" }, policy: {}, eligible: false },
    { name: "completed", issue: { status: "done" }, policy: {}, eligible: false },
    { name: "cancelled", issue: { status: "cancelled" }, policy: {}, eligible: false },
    { name: "assigned to lead", issue: { assigneeAgentId: "lead" }, policy: {}, eligible: false },
    { name: "missing assignment field", issue: { assigneeAgentId: undefined }, policy: {}, eligible: false },
    { name: "child", issue: { parentId: "parent" }, policy: {}, eligible: false },
    { name: "baseline root", issue: {}, policy: { baselineRootIds: ["root"] }, eligible: false },
  ])("selects opted-in Linear roots: $name", async ({ issue, policy, eligible }) => {
    Object.assign(f.issues[0], { originKind: LINEAR_ORIGIN, status: "blocked", assigneeAgentId: null }, issue);
    Object.assign(f.policy.content, { linearIntake: {} }, policy);
    const c = context(), insert = vi.fn(async () => ({ rowCount: 1 }));
    c.ctx.db.execute = insert; c.ctx.db.query = vi.fn(async () => []);
    await reconcileProjectTasks(c.ctx);
    expect(insert).toHaveBeenCalledTimes(Number(eligible));
    expect(f.create).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
  });
  it("retains creation identity after a lost response and admits once against the existing period", async () => {
    const c = context(); f.create.mockRejectedValueOnce(new Error("lost response"));
    await reconcileProjectTasks(c.ctx); const first = c.receipt();
    await reconcileProjectTasks(c.ctx); await reconcileProjectTasks(c.ctx);
    expect(f.create.mock.calls.every(([body]) => JSON.stringify(body) === JSON.stringify(first.state.createBody))).toBe(true);
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(f.activate.mock.calls[0]![0]).toMatchObject({ periodKey: "existing", requestedUnits: 1000 });
    expect(c.receipt().mission_id).toBe(first.mission_id); expect(f.mission!.aggregate.projectMandate!.revisionId).toBe("revision");
  });
  it("retains the same activation reservation and command after an uncertain admission response", async () => {
    const c = context(); f.activate.mockRejectedValueOnce(new Error("lost admission response"));
    await reconcileProjectTasks(c.ctx); const body = c.receipt().state.commands.activate;
    await reconcileProjectTasks(c.ctx);
    expect(f.activate.mock.calls[1]![0]).toEqual(body); expect(f.configure).toHaveBeenCalledTimes(1);
  });
  it("asks one native owner question for incomplete information over repeated passes without creating a mission", async () => {
    const c = context(); f.issues[0].description = "";
    await reconcileProjectTasks(c.ctx); await reconcileProjectTasks(c.ctx);
    expect(c.ask).toHaveBeenCalledTimes(1); expect(c.interactions.size).toBe(1); expect(f.create).not.toHaveBeenCalled();
    expect(c.ask.mock.calls[0]![1]).toMatchObject({ addresseeUserId: "owner", continuationPolicy: "none" });
  });
  it("never recreates or silently adopts existing children, historical roots or non-manual tasks", async () => {
    const c = context(); f.issues.push({ id: randomUUID(), parentId: "root" });
    await reconcileProjectTasks(c.ctx); expect(f.create).not.toHaveBeenCalled(); expect(c.ask).toHaveBeenCalledTimes(1);
    expect(c.receipt().state.questions.project_hierarchy_pending).toBeDefined();
    f.policy.content.baselineRootIds = ["root"]; const historical = context(); await reconcileProjectTasks(historical.ctx);
    expect(historical.receipt()).toBeNull();
    f.policy.content.baselineRootIds = []; f.issues[0].originKind = "plugin"; const plugin = context(); await reconcileProjectTasks(plugin.ctx);
    expect(plugin.receipt()).toBeNull();
  });
  it("stops at policy drift while preserving the original intake instead of switching mandate or budget", async () => {
    const c = context(); f.create.mockRejectedValueOnce(new Error("lost response"));
    await reconcileProjectTasks(c.ctx); const first = c.receipt(); f.policy.content.operatingProfileHash = "new-profile";
    await reconcileProjectTasks(c.ctx);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.activate).not.toHaveBeenCalled(); expect(c.receipt().mission_id).toBe(first.mission_id);
  });
});
