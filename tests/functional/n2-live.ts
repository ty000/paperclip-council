import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { nativeRunEvidence } from "./n1-live.js";

type ApiResult = { status: number; body: any; headers: Headers };
type ApiRequest = (actor: string, method: string, path: string, body?: unknown) => Promise<ApiResult>;
type RunSnapshot = {
  id: string;
  agentId: string;
  status: string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  error: string | null;
  usageJson: Record<string, unknown> | null;
};

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

async function waitForNewRun(
  agentId: string,
  priorRunIds: Set<string>,
  listRuns: (agentId: string) => Promise<RunSnapshot[]>,
  timeoutMs = 20 * 60_000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = (await listRuns(agentId)).find((item) => !priorRunIds.has(item.id));
    if (run) return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`No fresh native run appeared for agent ${agentId}`);
}

async function waitForTerminalRun(
  runId: string,
  getRun: (runId: string) => Promise<RunSnapshot | null>,
  timeoutMs = 20 * 60_000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(runId);
    if (run && terminalStatuses.has(run.status)) return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`Native Paperclip run ${runId} did not reach a terminal state`);
}

function assertSucceeded(run: RunSnapshot, label: string) {
  assert.equal(run.status, "succeeded", `${label} failed: ${run.error ?? "unknown error"}`);
  assert(run.finishedAt, `${label} has no terminal timestamp`);
}

async function inspectMission(request: ApiRequest, path: string, companyId: string) {
  const result = await request("human", "GET", `${path}?companyId=${companyId}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function settleN2Usage(input: {
  request: ApiRequest;
  missionPath: string;
  admissionPath: string;
  companyId: string;
  target: "review" | "correction";
  round?: 1 | 2;
}) {
  const mission = await inspectMission(input.request, input.missionPath, input.companyId);
  const admission = await input.request(
    "human",
    "GET",
    `${input.admissionPath}?companyId=${input.companyId}&periodKey=${encodeURIComponent(mission.admission.periodKey)}`,
  );
  assert.equal(admission.status, 200, JSON.stringify(admission.body));
  const settled = await input.request("human", "POST", `${input.missionPath}/commands`, {
    companyId: input.companyId,
    command: "settle-n2-usage",
    commandId: randomUUID(),
    expectedVersion: mission.mission.version,
    target: input.target,
    ...(input.round ? { round: input.round } : {}),
    settlementCommandId: randomUUID(),
    expectedAdmissionVersion: admission.body.envelope.version,
  });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  return settled.body;
}

export async function runLiveN2(input: {
  request: ApiRequest;
  getRun: (runId: string) => Promise<RunSnapshot | null>;
  listRuns: (agentId: string) => Promise<RunSnapshot[]>;
  pluginId: string;
  evidence: Record<string, any>;
  n1: {
    companyId: string;
    missionId: string;
    rootIssueId: string;
    mission: any;
    admission: any;
    agents: { lead: any; contributorA: any; contributorB: any; reviewer: any };
    periodKey: string;
  };
  runEvidence: typeof nativeRunEvidence;
}) {
  const { companyId, missionId, rootIssueId, agents } = input.n1;
  const missionPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/missions/${missionId}`;
  const admissionPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/admission`;
  const reviewerRunIds = new Set((await input.listRuns(agents.reviewer.id)).map((run) => run.id));

  const nativeReviewPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [{
      id: randomUUID(),
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "agent", agentId: agents.reviewer.id }],
    }],
  };
  const reopened = await input.request("human", "PATCH", `/api/issues/${rootIssueId}`, {
    status: "in_progress",
    assigneeAgentId: agents.lead.id,
    executionPolicy: nativeReviewPolicy,
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.status, "in_progress");
  assert.equal(reopened.body.assigneeAgentId, agents.lead.id);

  const beforeStart = await inspectMission(input.request, missionPath, companyId);
  const started = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId,
    command: "start-review",
    commandId: randomUUID(),
    expectedVersion: beforeStart.mission.version,
    submissionId: randomUUID(),
    reservationId: randomUUID(),
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.outcome, "requested");

  const reviewRun1 = await waitForNewRun(agents.reviewer.id, reviewerRunIds, input.listRuns);
  reviewerRunIds.add(reviewRun1.id);
  const terminalReview1 = await waitForTerminalRun(reviewRun1.id, input.getRun);
  assertSucceeded(terminalReview1, "initial independent review");
  const afterReview1 = await inspectMission(input.request, missionPath, companyId);
  assert.equal(afterReview1.n2.status, "correction_requested");
  assert.equal(afterReview1.n2.review.round, 1);
  assert.equal(afterReview1.n2.review.verdict.verdict, "changes_requested");

  await settleN2Usage({
    request: input.request,
    missionPath,
    admissionPath,
    companyId,
    target: "review",
    round: 1,
  });
  const leadEnabled = await input.request("human", "PATCH", `/api/agents/${agents.lead.id}`, {
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
  });
  assert.equal(leadEnabled.status, 200, JSON.stringify(leadEnabled.body));
  const beforeCorrection = await inspectMission(input.request, missionPath, companyId);
  const correctionStart = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId,
    command: "start-correction",
    commandId: randomUUID(),
    expectedVersion: beforeCorrection.mission.version,
  });
  assert.equal(correctionStart.status, 200, JSON.stringify(correctionStart.body));
  assert.equal(correctionStart.body.outcome, "requested");
  const correctionRunId = correctionStart.body.mission.aggregate.n2.correction.runId as string;
  assert.match(correctionRunId, /^[0-9a-f-]{36}$/i);
  const correctionRun = await waitForTerminalRun(correctionRunId, input.getRun);
  assertSucceeded(correctionRun, "integration lead correction");
  const prepared = await inspectMission(input.request, missionPath, companyId);
  assert.equal(prepared.n2.status, "resubmission_prepared");
  assert.equal(prepared.n2.correction.runId, correctionRunId);
  assert.deepEqual(prepared.n2.correction.correctedPaths, ["alpha.txt"]);

  await settleN2Usage({
    request: input.request,
    missionPath,
    admissionPath,
    companyId,
    target: "correction",
  });
  const leadDisabled = await input.request("human", "PATCH", `/api/agents/${agents.lead.id}`, {
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
  });
  assert.equal(leadDisabled.status, 200, JSON.stringify(leadDisabled.body));

  const beforeSecondReview = await inspectMission(input.request, missionPath, companyId);
  const secondReview = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId,
    command: "start-resubmitted-review",
    commandId: randomUUID(),
    expectedVersion: beforeSecondReview.mission.version,
    reservationId: randomUUID(),
  });
  assert.equal(secondReview.status, 200, JSON.stringify(secondReview.body));
  assert.equal(secondReview.body.outcome, "requested");

  const reviewRun2 = await waitForNewRun(agents.reviewer.id, reviewerRunIds, input.listRuns);
  reviewerRunIds.add(reviewRun2.id);
  const terminalReview2 = await waitForTerminalRun(reviewRun2.id, input.getRun);
  assertSucceeded(terminalReview2, "final independent review");
  const acceptedBeforeSettlement = await inspectMission(input.request, missionPath, companyId);
  assert.equal(acceptedBeforeSettlement.n2.status, "accepted");
  assert.equal(acceptedBeforeSettlement.n2.application.state, "observed");
  assert.equal(acceptedBeforeSettlement.n2.review.round, 2);
  assert.equal(acceptedBeforeSettlement.n2.review.verdict.verdict, "approved");

  await settleN2Usage({
    request: input.request,
    missionPath,
    admissionPath,
    companyId,
    target: "review",
    round: 2,
  });
  const finalMission = await inspectMission(input.request, missionPath, companyId);
  assert.equal(finalMission.mission.aggregate.phase, "accepted");
  assert.equal(finalMission.n2.status, "accepted");
  assert.equal(finalMission.n2.correctionsUsed, 1);
  assert.equal(finalMission.n2.submissions.length, 2);
  assert.equal(finalMission.n2.usage.complete, true);
  assert.notEqual(finalMission.n2.submissions[0].candidateCommit, finalMission.n2.submissions[1].candidateCommit);
  assert.notEqual(finalMission.n2.submissions[0].sha256, finalMission.n2.submissions[1].sha256);

  const finalAdmission = await input.request(
    "human",
    "GET",
    `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(input.n1.periodKey)}`,
  );
  assert.equal(finalAdmission.status, 200, JSON.stringify(finalAdmission.body));
  const reservations = finalAdmission.body.envelope.reservations as any[];
  assert.equal(reservations.length, 6);
  assert(reservations.every((entry) => entry.status === "settled"
    && entry.usage?.status === "known" && entry.usage.units > 0
    && entry.remainingExposure?.status === "known" && entry.remainingExposure.units === 0));

  const decisions = await input.request(
    "human",
    "GET",
    `/api/plugins/${input.pluginId}/api/companies/${companyId}/decisions?companyId=${companyId}`,
  );
  assert.equal(decisions.status, 200, JSON.stringify(decisions.body));
  const receiptByOperation = new Map(decisions.body.receipts
    .filter((entry: any) => entry.issueId === rootIssueId)
    .map((entry: any) => [entry.operationId, entry]));
  const n2Receipts = finalMission.mission.aggregate.n2.rounds
    .map((round: any) => receiptByOperation.get(round.verdict?.operationId));
  assert(n2Receipts.every(Boolean), "every N2 round must have its exact decision receipt");
  assert.deepEqual(n2Receipts.map((entry: any) => entry.verdict), ["changes_requested", "approved"]);
  assert(n2Receipts.every((entry: any) => entry.state === "native_observed" && entry.actorAgentId === agents.reviewer.id));

  const n2Runs = [terminalReview1, correctionRun, terminalReview2];
  input.evidence.liveN2 = {
    companyId,
    missionId,
    rootIssueId,
    agents: { lead: agents.lead.id, reviewer: agents.reviewer.id },
    runs: n2Runs.map(input.runEvidence),
    mission: finalMission,
    admission: finalAdmission.body,
    decisionReceipts: n2Receipts,
    correction: {
      path: "alpha.txt",
      runId: correctionRunId,
      v1: finalMission.n2.submissions[0],
      v2: finalMission.n2.submissions[1],
    },
    limits: { runCount: 6, maxConcurrent: 2, maxRetries: 0, maxCorrections: 1 },
  };
  Object.assign(input.evidence.results, {
    n2InitialIndependentReview: "PASS",
    n2ChangesRequestedApplied: "PASS",
    n2CorrectionRunSettled: "PASS",
    n2ChangedV2Verified: "PASS",
    n2FreshFinalReviewAccepted: "PASS",
    n2AllSixRunsSettled: "PASS",
  });
  return { missionPath, finalMission, finalAdmission: finalAdmission.body, n2Runs };
}
