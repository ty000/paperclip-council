import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { linearFixture } from "./linear-intake-fixture.js";
import { reconcileProjectTasks } from "../src/project-task-intake.js";
import { resumeRepositoryIntake } from "../src/project-intake-recovery.js";
import { handleLinearSourceResult } from "../src/linear-intake-revalidation.js";
import { LINEAR_RESULT_EVENT } from "../src/linear-intake-revalidation-contract.js";
import { canonicalPayloadHash as hash, MissionError } from "../src/mission-primitives.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";
import { ensureMissionRepository } from "../src/repository-occupation.js";

const f = vi.hoisted(() => ({ policy: null as any, mission: null as any, occupied: true, acquisition: vi.fn() }));
vi.mock("../src/project-mandate-state.js", async original => ({ ...await original<any>(),
  listProjectMandates: async () => [f.policy], projectIssues: async () => [] }));
vi.mock("../src/repository-occupation.js", () => ({ ensureMissionRepository: (...args: unknown[]) => {
  f.acquisition(...args);
  if (f.occupied) throw new MissionError(409, "repository_occupied", "Le dépôt est occupé par une autre campagne.");
} }));
vi.mock("../src/missions.js", async original => ({ ...await original<any>(), getMission: async () => structuredClone(f.mission),
  createMission: async (ctx: any, companyId: string, ownerUserId: string, body: any) => {
    await ensureMissionRepository(ctx, f.mission ?? { companyId, missionId: body.missionId, projectId: f.policy.projectId, aggregate: {} } as any);
    f.mission ??= { companyId, projectId: f.policy.projectId, rootIssueId: body.rootIssueId, missionId: body.missionId,
      ownerUserId, version: 1, aggregate: { schemaVersion: 1, phase: "draft", mandate: body.mandate, commandReceipts: [] } };
  } }));
// Ongoing continuity is a separate protocol: it deliberately permits the unchanged
// campaign's later Started status. The initial admission challenge below is real.
vi.mock("../src/linear-continuity-runtime.js", () => ({ reconcileLinearContinuity: async (_ctx: any, m: any) => m }));
vi.mock("../src/linear-continuity-control.js", () => ({ assertLinearContinuityDeparture: async (_ctx: any, m: any) => {
  if (m.aggregate.linearContinuity.publications.some((p: any) => !p.acknowledgement)) throw new MissionError(409, "linear_continuity_hold", "Wait for the original plan ACK");
} }));

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T10:00:00Z")); f.mission = null; f.occupied = true; });
afterEach(() => vi.useRealTimers());

function fixture() {
  const native = linearFixture(), { ids, readiness, readinessDocument } = native;
  f.policy = { ...native.policy, content: { ...native.policy.content, operatingProfileHash: operatingProfileHash({}),
    linearContinuity: { protocol: "council-linear-continuity-v1", mode: "milestone-fixed-v1" } } };
  const subject = Object.fromEntries(["companyId", "intakeId", "activationId", "configurationFingerprint", "requestVersion", "nativeRootId",
    "targetProjectId", "sourceSha256", "planSha256"].map(key => [key, (readiness as any)[key]]));
  Object.assign(subject, { readinessDocumentId: readinessDocument.id, readinessRevisionId: readinessDocument.latestRevisionId, readinessSha256: hash(readinessDocument.body) });
  const missionId = randomUUID(), createBody = { missionId, rootIssueId: ids.root, commandId: randomUUID(), mandate: f.policy.content.template };
  const intake: any = { company_id: ids.company, project_id: ids.project, root_issue_id: ids.root, policy_revision_id: f.policy.revisionId,
    mission_id: missionId, version: 4, state: { createBody, commands: {}, questions: {}, snapshot: { linearIntake: { subject }, revisionId: f.policy.revisionId },
      linearIntake: { effects: {}, snapshot: { subject, body: { ...readiness, campaign: { milestoneId: randomUUID() } },
        nodes: [{ nativeId: ids.alpha, sourceId: ids["source-alpha"], role: "contribution", blockerIds: [], assigneeAgentId: ids.a, ownedPaths: ["src/alpha"] }] } } } };
  const challenges: any[] = [], emissions: any[] = [], leaves = new Map<string, string>();
  const query = async (sql: string, p: any[]) => {
    if (sql.includes("project_mandates")) return [{ company_id: ids.company, project_id: ids.project, revision_id: f.policy.revisionId,
      version: 1, authorized_by: ids.owner, content: f.policy.content }];
    if (sql.includes("project_task_intakes")) return [structuredClone(intake)];
    if (sql.includes(".missions")) return f.mission ? [{ company_id: ids.company, project_id: ids.project, mission_id: missionId,
      root_issue_id: ids.root, owner_user_id: ids.owner, version: f.mission.version, aggregate: structuredClone(f.mission.aggregate),
      created_at: new Date(), updated_at: new Date() }] : [];
    const selected = sql.includes("ORDER BY generation") ? challenges.filter(row => row.stage === p[2]).slice(-1) : challenges.filter(row => row.challenge_id === p[1]);
    return structuredClone(selected);
  };
  function updateMission(p: any[]) {
    if (f.mission.version !== p[3]) return { rowCount: 0 };
    f.mission = { ...f.mission, version: f.mission.version + 1, aggregate: JSON.parse(p[0]) };
    return { rowCount: 1 };
  }
  function updateChallenge(sql: string, p: any[]) {
    if (sql.startsWith("INSERT")) challenges.push({ challenge_id: p[0], generation: p[4], subject_hash: p[5], request_hash: p[6], request: JSON.parse(p[7]), stage: p[3], response: null, consumed_at: null });
    else if (sql.includes("SET response =")) Object.assign(challenges.find(row => row.challenge_id === p[4]), { response: JSON.parse(p[0]), response_hash: p[1] });
    else if (sql.includes("SET consumed_at")) {
      const row = challenges.find(row => row.challenge_id === p[0]);
      if (row.consumed_at || row.response_hash !== p[1] || Date.parse(p[2]) <= Date.now()) return { rowCount: 0 };
      row.consumed_at = new Date().toISOString();
    }
    return { rowCount: 1 };
  }
  function updateIntake(sql: string, p: any[]) {
    if (intake.version !== (sql.includes("policy_revision_id = $6") ? p[4] : p[3])) return { rowCount: 0 };
    intake.state = JSON.parse(p[0]); intake.version++;
    return { rowCount: 1 };
  }
  const execute = async (sql: string, p: any[]) => {
    if (sql.includes("SET aggregate")) return updateMission(p);
    if (sql.includes("linear_intake_challenges")) return updateChallenge(sql, p);
    if (!sql.startsWith("INSERT")) return updateIntake(sql, p);
    if (!leaves.has(p[1])) leaves.set(p[1], p[4]);
    return { rowCount: 1 };
  };
  const ctx = { ...native.ctx, db: { namespace: "test", query, execute }, config: { get: async () => ({}) },
    companies: { get: async () => ({ defaultResponsibleUserId: ids.owner }) },
    events: { emit: vi.fn(async (_name: string, _company: string, request: any) => { emissions.push(structuredClone(request)); }) } } as any;
  ctx.issues.askUserQuestions = vi.fn(async () => ({ issueId: ids.root, addresseeUserId: ids.owner }));
  ctx.issues.requestWakeup = vi.fn();
  const resume = async () => {
    await resumeRepositoryIntake(ctx, f.policy, ids.owner!, { commandId: randomUUID(), rootIssueId: ids.root, policyRevisionId: f.policy.revisionId,
      expectedIntakeVersion: intake.version, authorizeResume: true, reason: "Le dépôt est libéré ; revérifier cette demande." });
    vi.advanceTimersByTime(1);
  };
  const answer = async (withdrawn = false) => {
    const request = emissions.at(-1);
    await handleLinearSourceResult(ctx, { eventType: LINEAR_RESULT_EVENT, actorType: "plugin", actorId: "ty000.linear-intake", companyId: ids.company,
      occurredAt: new Date().toISOString(), payload: { schema: "linear-intake-revalidation-result.v1", request, requestSha256: hash(request),
        status: withdrawn ? "blocked" : "confirmed", reason: withdrawn ? "handoff_source_withdrawn" : "handoff_confirmed",
        observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 120_000).toISOString() } } as any);
  };
  return { ctx, intake, challenges, emissions, leaves, resume, answer };
}

it("blocks the retained pre-mission create payload when the missed Todo exit/re-entry is observed on explicit recovery", async () => {
  const x = fixture(), original = structuredClone(x.intake.state.createBody);
  await reconcileProjectTasks(x.ctx);
  expect(f.mission).toBeNull(); expect(x.intake.state.repositoryHold.status).toBe("held"); expect(x.emissions).toHaveLength(0);
  f.occupied = false; await x.resume(); await reconcileProjectTasks(x.ctx);
  expect(f.mission.aggregate.linearContinuity.mode).toBe("milestone-fixed-v1");
  expect(x.emissions[0].stage).toBe("admission");
  expect(Date.parse(x.emissions[0].requestedAt)).toBeGreaterThan(Date.parse(x.intake.state.repositoryResumptions[0].resumedAt));
  await x.answer(true); await reconcileProjectTasks(x.ctx);
  expect(x.intake.state.questions).toHaveProperty("linear_source_blocked");
  expect(f.mission.aggregate.linearContinuity.publications).toHaveLength(0); expect(x.leaves.size).toBe(0);
  expect(x.ctx.issues.requestWakeup).not.toHaveBeenCalled(); expect(f.mission.aggregate.n1).toBeUndefined();
  expect(x.intake.state.createBody).toEqual(original); expect(x.challenges[0].consumed_at).toBeNull();
});

it("resumes through the real initial challenge, survives restart before the plan, then retains the plan under lost ACK and Started continuity", async () => {
  const x = fixture(); await reconcileProjectTasks(x.ctx);
  f.occupied = false; await x.resume(); await reconcileProjectTasks(x.ctx);
  const before = structuredClone({ missionId: f.mission.missionId, createBody: x.intake.state.createBody, request: x.emissions[0] });
  await reconcileProjectTasks(x.ctx); // Continuity exists, but initial admission is still pending.
  expect(x.leaves.size).toBe(0); expect(f.mission.aggregate.linearContinuity.publications).toHaveLength(0);
  expect(x.emissions.every(request => request.challengeId === before.request.challengeId)).toBe(true);
  await x.answer(); await reconcileProjectTasks(x.ctx);
  expect(Object.keys(x.intake.state.questions)).toEqual(["repository_occupied"]);
  expect(x.challenges.map(row => ({ response: row.response?.status, consumed: row.consumed_at }))).toEqual([{ response: "confirmed", consumed: expect.any(String) }]);
  const plan = structuredClone(f.mission.aggregate.linearContinuity.publications[0]);
  expect(plan.payload.repositoryResumption).toEqual(x.intake.state.repositoryResumptions[0]);
  expect(x.intake.state.linearIntake.admissionReceipt.challengeId).toBe(before.request.challengeId);
  expect(x.challenges[0].consumed_at).not.toBeNull(); expect(x.leaves.size).toBe(1);
  const requests = x.emissions.length;
  await reconcileProjectTasks(x.ctx); // Missing ACK must not solicit another initial Todo observation.
  expect(f.mission.aggregate.linearContinuity.publications).toEqual([plan]);
  f.mission.aggregate.linearContinuity.publications[0].acknowledgement = { reference: {} };
  await reconcileProjectTasks(x.ctx); // An ongoing Started campaign uses continuity only.
  expect(x.emissions).toHaveLength(requests); expect(x.challenges).toHaveLength(1); expect(x.leaves.size).toBe(1);
  expect(f.mission.missionId).toBe(before.missionId); expect(x.intake.state.createBody).toEqual(before.createBody);
  expect(x.ctx.issues.requestWakeup).not.toHaveBeenCalled();
});
