import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/g4-native.js", async original => ({ ...await original(), readNativeG4Profile: vi.fn(),
  assertNativeEnvelope: vi.fn(), settleNativeExactRunUsage: vi.fn() }));
vi.mock("../src/admission.js", async original => ({ ...await original(), readAdmission: vi.fn(), reserveAdmission: vi.fn() }));
vi.mock("../src/decision-receipts.js", async original => ({ ...await original(), recordCouncilOrdinaryReadback: vi.fn(), recordCouncilNativeReadback: vi.fn() }));
vi.mock("../src/n2-native-report.js", async original => ({ ...await original(), readNativeReviewIdentity: vi.fn(), validateNativeReviewOutcome: vi.fn() }));

import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";
import { readNativeG4Profile, settleNativeExactRunUsage } from "../src/g4-native.js";
import { readAdmission, reserveAdmission } from "../src/admission.js";
import { recordCouncilNativeReadback, recordCouncilOrdinaryReadback, type DecisionReceipt } from "../src/decision-receipts.js";
import { readNativeReviewIdentity, validateNativeReviewOutcome } from "../src/n2-native-report.js";
import { inspectN2State, nativeN2Profile, prepareN2Decision, recordN2Decision } from "../src/n2-missions.js";
import { reconcileOrdinaryN2 } from "../src/n2-ordinary-runtime.js";
import { reconcileNativeN2, reconcileNativeVerdict } from "../src/n2-native-runtime.js";
import { ordinaryTask } from "../src/n2-ordinary-state.js";
import { prepareN5Continuation } from "../src/n5-continuation.js";
import { acceptedN5Submission } from "../src/n5-preflight.js";

function harness(verdict: "approved" | "changes_requested" = "changes_requested") {
  const task = { ...ordinaryTask("council", randomUUID(), randomUUID()), issueId: randomUUID(),
    creation: "confirmed" as const, wake: "claimed" as const, runId: randomUUID(), settledAt: "settled" };
  const mandate = { objective: "One bounded review", acceptanceCriteria: ["Check the candidate"], commitments: [],
    limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 0, elapsedMinutes: 60 } };
  const submission = { submissionId: task.submissionId, candidateCommit: "a".repeat(40), sha256: "b".repeat(64),
    attachmentId: randomUUID(), byteSize: 120, evidenceRevision: 1,
    mandateHash: createHash("sha256").update(JSON.stringify(mandate)).digest("hex") };
  const subject = { submissionId: submission.submissionId, candidateCommit: submission.candidateCommit,
    bundleSha256: submission.sha256, evidenceRevision: submission.evidenceRevision, mandateHash: submission.mandateHash };
  const synthesis = { verdict, rationale: "Exact candidate evidence" };
  let current = { companyId: randomUUID(), projectId: randomUUID(), missionId: randomUUID(), rootIssueId: randomUUID(), ownerUserId: randomUUID(), version: 1,
    aggregate: { schemaVersion: 1, mandate, journal: [], effectIntents: [], commandReceipts: [], phase: "reviewing", control: { status: "active" },
      responsibilities: { integrationLeadAgentId: randomUUID(), finalReviewerAgentId: task.agentId },
      compositions: { council: { members: [{ agentId: task.agentId }] } }, n1: { periodKey: "zero-period" },
      n2: { schemaVersion: 1, correctionLimit: 0, correctionsUsed: 0, correction: null, activeSubmissionId: task.submissionId, status: "reviewing",
        application: { state: "none", submissionId: null, operationId: null, receiptState: null, nativeStatus: null },
        submissions: [submission], ordinary: { protocol: "ordinary-cli-v1", tasks: [task] },
        rounds: [{ round: 1, submissionId: task.submissionId, reviewerAgentId: task.agentId, verdict: null,
          handoff: { state: "confirmed", reviewerRunId: task.runId, reservationId: task.reservationId, usageSettledAt: task.settledAt } }] },
      n3: { slots: [], rounds: [{ review: { subject, synthesis, opinions: [], slots: [] }, specialists: [] }] } },
  } as unknown as MissionRecord;
  current.aggregate.n2!.ordinary!.tasks[0]!.report = { schema: "council-ordinary-result-v1", missionId: current.missionId,
    taskId: task.taskId, subject, verdict, rationale: "Exact candidate evidence", synthesisHash: canonicalPayloadHash(synthesis) };
  let interruptAfterVerdict = false;
  const execute = vi.fn(async (_sql: string, args: unknown[]) => {
    const aggregate = JSON.parse(String(args[0])) as MissionRecord["aggregate"];
    if (interruptAfterVerdict && aggregate.n2?.ordinary?.tasks[0]?.receiptRecordedAt) {
      interruptAfterVerdict = false;
      throw new Error("interrupted after durable verdict");
    }
    if (args[3] !== current.version) return { rowCount: 0 };
    current = { ...current, version: current.version + 1, aggregate };
    return { rowCount: 1 };
  });
  const query = vi.fn(async () => [{ company_id: current.companyId, mission_id: current.missionId, root_issue_id: current.rootIssueId,
    project_id: current.projectId, owner_user_id: current.ownerUserId, team_roster_id: current.teamRosterId, team_revision: current.teamRevision,
    council_roster_id: current.councilRosterId, council_revision: current.councilRevision, version: current.version,
    aggregate: structuredClone(current.aggregate), created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }]);
  const ctx = { db: { namespace: "zero_correction", execute, query },
    agents: { get: vi.fn(async () => ({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })) }, issues: { create: vi.fn(), requestWakeup: vi.fn(), update: vi.fn(),
    listAttachments: vi.fn(async () => [{ ...submission, id: submission.attachmentId, companyId: current.companyId, issueId: current.rootIssueId }]) },
  } as unknown as PluginContext;
  vi.mocked(recordCouncilOrdinaryReadback).mockImplementation(async (_ctx, decision, input) => receipt(decision, input.requestBody));
  function receipt(decision: { operationId: string; actorAgentId: string; runId: string; verdict: "approved" | "changes_requested" }, requestBody: Record<string, unknown>): DecisionReceipt {
    return { companyId: current.companyId, issueId: current.rootIssueId, ...decision, state: "native_observed", blockReason: null,
      targetUrl: "http://localhost/readback", requestBody, claimedAt: "observed", updatedAt: "observed", humanDecisions: [],
      nativeObservation: { status: 200, body: {}, observedAt: "observed", usable: true } };
  }
  return { ctx, task, submission, subject, current: () => structuredClone(current), replace: (m: MissionRecord) => { current = structuredClone(m); },
    interrupt: () => { interruptAfterVerdict = true; }, receipt, execute };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readNativeG4Profile).mockResolvedValue({ maxCorrections: 0, periodKey: "zero-period" } as never);
  vi.mocked(readAdmission).mockResolvedValue({ version: 1, reservations: [] } as never);
});

it.each([0, 1] as const)("admits the nominal operating profile with maxCorrections=%s", async maxCorrections => {
  const h = harness();
  vi.mocked(readNativeG4Profile).mockResolvedValue({ maxCorrections, periodKey: "zero-period" } as never);
  expect((await nativeN2Profile(h.ctx, h.current())).profile.maxCorrections).toBe(maxCorrections);
});
it.each([-1, 2, 0.5, NaN])("refuses unsupported operating maxCorrections=%s", async maxCorrections => {
  const h = harness();
  vi.mocked(readNativeG4Profile).mockResolvedValue({ maxCorrections } as never);
  await expect(nativeN2Profile(h.ctx, h.current())).rejects.toMatchObject({ code: "n2_correction_profile_required" });
});

it.each(["approved", "changes_requested"] as const)("retains ordinary %s with no correction, including after restart", async verdict => {
  const h = harness(verdict);
  const result = await reconcileOrdinaryN2(h.ctx, h.current());
  const state = result.aggregate.n2!;
  expect(state).toMatchObject({ status: verdict === "approved" ? "accepted" : "rejected", correctionsUsed: 0, correction: null,
    rounds: [{ verdict: { verdict, operationId: h.task.taskId, runId: h.task.runId, reasons: ["Exact candidate evidence"] } }] });
  expect(state.ordinary!.tasks).toHaveLength(1);
  expect(state.ordinary!.tasks[0]).toMatchObject({ receiptRecordedAt: expect.any(String), closedAt: expect.any(String) });
  expect(result.aggregate.effectIntents).toHaveLength(1);
  expect(result.aggregate.effectIntents[0]).not.toHaveProperty("reservationId");
  if (verdict === "changes_requested") {
    expect(result.aggregate).toMatchObject({ phase: "blocked", control: { status: "blocked", reason: "correction_limit_exceeded" } });
    expect(inspectN2State(result)).toMatchObject({ status: "rejected", blockage: { code: "correction_limit_exceeded" } });
    expect(inspectN2State(result)!.nextAction.label).not.toMatch(/accepted|Acceptance/);
    expect(() => acceptedN5Submission(result)).toThrowError(/acceptance/);
  } else {
    expect(acceptedN5Submission(result)).toEqual(h.submission);
    expect(() => prepareN5Continuation(result, { requestId: randomUUID(), reservationId: randomUUID(), reason: "PR feedback",
      criteria: ["fix"], actorId: result.ownerUserId, periodKey: "zero-period" })).toThrowError(/correction/);
  }
  const writes = h.execute.mock.calls.length, updates = vi.mocked(h.ctx.issues.update).mock.calls.length;
  h.replace(JSON.parse(JSON.stringify(result)) as MissionRecord);
  expect(await reconcileOrdinaryN2(h.ctx, h.current())).toEqual(result);
  expect(h.execute).toHaveBeenCalledTimes(writes);
  expect(h.ctx.issues.update).toHaveBeenCalledTimes(updates);
  expect(h.ctx.issues.create).not.toHaveBeenCalled();
  expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  expect(reserveAdmission).not.toHaveBeenCalled();
  expect(recordCouncilOrdinaryReadback).toHaveBeenCalledTimes(1);
});

it("resumes an interruption after the rejection receipt without losing it or creating correction effects", async () => {
  const h = harness(); h.interrupt();
  await expect(reconcileOrdinaryN2(h.ctx, h.current())).rejects.toThrow("interrupted after durable verdict");
  expect(h.current().aggregate.n2).toMatchObject({ status: "rejected", correction: null, rounds: [{ verdict: { verdict: "changes_requested" } }] });
  const result = await reconcileOrdinaryN2(h.ctx, h.current());
  expect(result.aggregate.n2!.ordinary!.tasks[0]!.closedAt).toBeDefined();
  expect(result.aggregate.effectIntents).toHaveLength(1);
  expect(h.ctx.issues.create).not.toHaveBeenCalled();
  expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  expect(reserveAdmission).not.toHaveBeenCalled();
  expect(recordCouncilOrdinaryReadback).toHaveBeenCalledTimes(1);
});

it("prepares and replays a legacy zero-correction rejection without admitting a correction", async () => {
  const h = harness(), mission = h.current(); delete mission.aggregate.n2!.ordinary; h.replace(mission);
  const decision = { verdict: "changes_requested" as const, operationId: h.task.taskId, actorAgentId: h.task.agentId,
    runId: h.task.runId, resultReference: `council:n2:submission:${h.task.submissionId}`, justification: "Exact candidate evidence" };
  const prepared = await prepareN2Decision(h.ctx, h.current(), decision);
  expect(prepared.aggregate.effectIntents[0]).not.toHaveProperty("reservationId");
  const receipt = h.receipt(decision, { status: "in_progress", comment: `Result reference: ${decision.resultReference}\nOperation ID: ${decision.operationId}` });
  const result = await recordN2Decision(h.ctx, mission.missionId, decision, receipt);
  expect(result.aggregate.n2!.status).toBe("rejected");
  const writes = h.execute.mock.calls.length;
  expect(await recordN2Decision(h.ctx, mission.missionId, decision, receipt)).toEqual(result);
  expect(h.execute).toHaveBeenCalledTimes(writes);
  expect(reserveAdmission).not.toHaveBeenCalled();
  expect(h.ctx.issues.create).not.toHaveBeenCalled(); expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
});

it("records the native zero-correction verdict and readback instead of discarding the rejected round", async () => {
  const h = harness(), mission = h.current(), state = mission.aggregate.n2!;
  delete state.ordinary; delete mission.aggregate.n3;
  const report = { verdict: "changes_requested" as const, rationale: "Exact candidate evidence", subject: h.subject };
  const record = { packet: { submission: h.submission }, hash: "packet-hash", operationId: h.task.taskId,
    correctionReservationId: randomUUID(), settlementCommandId: randomUUID(), publishedAt: "published" };
  state.native = { profile: "paperclip_runner-experimental", reviewProtocol: "native-verdict-readback-v1",
    transmission: { settledAt: "settled" }, reviewCards: [], reviewPackets: [record] } as never;
  h.replace(mission);
  const identity = { record, card: { id: "card" }, run: { id: h.task.runId, agentId: h.task.agentId }, binding: { decisionId: "decision" } };
  vi.mocked(readNativeReviewIdentity).mockImplementation(async (_ctx, m) => m.aggregate.n2!.rounds[0]!.verdict ? null : identity as never);
  vi.mocked(validateNativeReviewOutcome).mockReturnValue({ ...identity, report } as never);
  vi.mocked(recordCouncilNativeReadback).mockImplementation(async (_ctx, decision, input) => h.receipt(decision, {
    method: "GET", provenance: "native-review-terminal-readback-v1", packetHash: input.packetHash, reportHash: input.reportHash }));
  const result = await reconcileNativeVerdict(h.ctx, h.current());
  expect(result.aggregate).toMatchObject({ phase: "blocked", control: { status: "blocked", reason: "correction_limit_exceeded" },
    n2: { status: "rejected", correction: null, correctionsUsed: 0, rounds: [{ verdict: { verdict: "changes_requested" } }] } });
  expect(result.aggregate.n2!.native!.reviewPackets![0]!.observation!.report).toEqual(report);
  const writes = h.execute.mock.calls.length;
  await reconcileNativeN2(h.ctx, h.current());
  expect(h.execute).toHaveBeenCalledTimes(writes);
  expect(settleNativeExactRunUsage).toHaveBeenCalledTimes(1);
  expect(recordCouncilNativeReadback).toHaveBeenCalledTimes(1);
  expect(reserveAdmission).not.toHaveBeenCalled();
  expect(h.ctx.issues.create).not.toHaveBeenCalled(); expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
});
