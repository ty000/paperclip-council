import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { MissionError } from "../src/missions.js";
import { prepareLinearContinuity } from "../src/linear-continuity-intake.js";
import { reconcileProjectTasks } from "../src/project-task-intake.js";

const f = vi.hoisted(() => ({ policy: {} as any, create: vi.fn() }));
vi.mock("../src/project-mandate-state.js", async original => ({ ...await original<any>(),
  listProjectMandates: async () => [f.policy], projectIssues: async () => [],
  operatingProfileHash: () => "profile", projectMandateRow: (row: unknown) => row,
}));
vi.mock("../src/missions.js", async original => ({ ...await original<any>(), createMission: (...args: unknown[]) => f.create(...args) }));
vi.mock("../src/linear-continuity-intake.js", async original => ({ ...await original<any>(), prepareLinearContinuity: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prepareLinearContinuity).mockImplementation(async (_ctx, mission) => mission);
});

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), missionId = randomUUID(), rootIssueId = randomUUID(), leafId = randomUUID();
  f.policy = { companyId, projectId, revisionId: randomUUID(), authorizedBy: "owner", version: 1,
    content: { enabled: true, operatingProfileHash: "profile", baselineRootIds: [] } };
  const snapshot = { revisionId: f.policy.revisionId, operatingProfileHash: "profile" };
  const intake = { company_id: companyId, project_id: projectId, root_issue_id: rootIssueId,
    mission_id: missionId, policy_revision_id: f.policy.revisionId, version: 1, state: {
      createBody: { command: "create", commandId: randomUUID(), missionId }, snapshot, commands: {}, questions: {},
      linearIntake: { snapshot: { body: { sourceRootId: "campaign-source", campaign: { milestoneId: randomUUID() } },
        nodes: [{ nativeId: leafId, sourceId: randomUUID(), role: "contribution", blockerIds: [], assigneeAgentId: "lead", ownedPaths: ["src"] }] } },
    } };
  let mission = { companyId, projectId, missionId, rootIssueId, ownerUserId: "owner", version: 1, aggregate: {
    schemaVersion: 1, commandReceipts: [], projectMandate: snapshot,
    campaignClosure: { phase: "reviewing", task: { taskId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), wake: "claimed" } },
    linearContinuity: { mode: "milestone-fixed-v1", protocol: "council-linear-continuity-v1", binding: { campaignId: missionId },
      sourceSha256: "a".repeat(64), publications: [] },
  } } as unknown as MissionRecord;
  let conflict = true;
  const leaves = new Map<string, string>(), reads: number[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("project_mandates")) return [f.policy];
    if (sql.includes("project_task_intakes")) return [structuredClone(intake)];
    reads.push(mission.version);
    return [{ company_id: companyId, project_id: projectId, mission_id: missionId, root_issue_id: rootIssueId, owner_user_id: "owner",
      version: mission.version, aggregate: structuredClone(mission.aggregate), created_at: new Date(), updated_at: new Date() }];
  });
  const execute = vi.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith("INSERT")) { if (!leaves.has(p[1])) leaves.set(p[1], p[4]); return { rowCount: 1 }; }
    if (sql.includes("project_task_intakes")) {
      if (p[3] !== intake.version) return { rowCount: 0 };
      intake.state = JSON.parse(p[0]); intake.version++; return { rowCount: 1 };
    }
    if (conflict) { conflict = false; mission = { ...mission, version: mission.version + 1 }; }
    if (p[3] !== mission.version) return { rowCount: 0 };
    mission = { ...mission, version: mission.version + 1, aggregate: JSON.parse(p[0]) };
    return { rowCount: 1 };
  });
  const ctx = { db: { namespace: "test", query, execute }, config: { get: async () => ({}) },
    companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) }, issues: {
      askUserQuestions: vi.fn(async () => ({ issueId: rootIssueId, addresseeUserId: "owner" })), requestWakeup: vi.fn(),
    } } as any;
  return { ctx, intake, leaves, reads, mission: () => mission, noConflict: () => { conflict = false; } };
}

it("rereads after a real campaign CAS conflict and preserves the original mission, review run and publication identity", async () => {
  const x = fixture(), before = structuredClone(x.mission());
  await reconcileProjectTasks(x.ctx);
  expect(x.mission().version).toBe(2);
  expect(x.mission().aggregate.linearContinuity!.publications).toHaveLength(0);
  expect(x.ctx.issues.askUserQuestions).not.toHaveBeenCalled();
  expect(x.intake.state.questions).toEqual({});
  expect(x.leaves.size).toBe(0);

  await reconcileProjectTasks(x.ctx);
  const publication = structuredClone(x.mission().aggregate.linearContinuity!.publications[0]!);
  const leafMissions = [...x.leaves];
  await reconcileProjectTasks(x.ctx);
  expect(x.mission().missionId).toBe(before.missionId);
  expect(x.mission().aggregate.campaignClosure).toEqual(before.aggregate.campaignClosure);
  expect(x.mission().aggregate.linearContinuity!.publications).toEqual([publication]);
  expect([...x.leaves]).toEqual(leafMissions); expect(x.leaves.size).toBe(1);
  expect(x.reads.slice(0, 3)).toEqual([1, 2, 2]);
  expect(f.create.mock.calls.every(call => JSON.stringify(call[3]) === JSON.stringify(x.intake.state.createBody))).toBe(true);
  expect(x.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  expect(x.ctx.issues.askUserQuestions).not.toHaveBeenCalled();
});

it.each([
  ["project_authority_changed", "Authority changed"],
  ["campaign_review_wake_unknown", "Retain uncertain wake"],
  ["version_conflict", "Mission version is stale"],
])("still asks about %s instead of treating it as a refused campaign CAS", async (code, message) => {
  const x = fixture(); x.noConflict();
  vi.mocked(prepareLinearContinuity).mockRejectedValue(new MissionError(409, code, message));
  await reconcileProjectTasks(x.ctx);
  await reconcileProjectTasks(x.ctx);
  expect(x.ctx.issues.askUserQuestions).toHaveBeenCalledTimes(1);
  expect(x.intake.state.questions).toHaveProperty(code);
  expect(x.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  expect(x.leaves.size).toBe(0);
});

it("does not swallow a transport failure whose effect is unknown", async () => {
  const x = fixture();
  vi.mocked(prepareLinearContinuity).mockRejectedValue(new Error("database response lost"));
  await reconcileProjectTasks(x.ctx);
  expect(x.intake.state.questions).toHaveProperty("project_intake_transport");
  expect(x.ctx.issues.askUserQuestions).toHaveBeenCalledTimes(1);
});
