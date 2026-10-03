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

function errorEvidence(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "UnknownError", message: String(error) };
}

async function setWakeOnDemand(request: ApiRequest, agentId: string, wakeOnDemand: boolean) {
  const response = await request("human", "PATCH", `/api/agents/${agentId}`, {
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand, maxConcurrentRuns: 1 } },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.runtimeConfig?.heartbeat?.wakeOnDemand, wakeOnDemand);
  return response.body;
}

export function n2MissionWakeContext(input: {
  pluginId: string;
  rootIssueId: string;
  missionId: string;
}) {
  assert.match(input.rootIssueId, /^[0-9a-f-]{36}$/i, "N2 wake context requires the exact root issue ID");
  assert.match(input.missionId, /^[0-9a-f-]{36}$/i, "N2 wake context requires the exact mission ID");
  assert.notEqual(input.rootIssueId, input.missionId, "N2 issue and mission identities must remain distinct");
  const councilCommandRoute = `/api/plugins/${input.pluginId}/api/issues/${input.rootIssueId}/council/commands`;
  return {
    pluginId: input.pluginId,
    rootIssueId: input.rootIssueId,
    missionId: input.missionId,
    councilCommandRoute,
    descriptionBlock: [
      "Council N2 execution context (authoritative):",
      `Root issue ID: ${input.rootIssueId}`,
      `Mission ID: ${input.missionId}`,
      `Council command route: ${councilCommandRoute}`,
      "Use the Mission ID above in every inspect, confirm-review-handoff, and prepare-resubmission command. Never substitute PAPERCLIP_TASK_ID for the Mission ID.",
    ].join("\n"),
  };
}

export async function configureNativeN2ReviewEntry(input: {
  request: ApiRequest;
  pluginId: string;
  rootIssueId: string;
  missionId: string;
  leadId: string;
  reviewerId: string;
}) {
  const current = await input.request("human", "GET", `/api/issues/${input.rootIssueId}`);
  assert.equal(current.status, 200, JSON.stringify(current.body));
  const wakeContext = n2MissionWakeContext(input);
  const existingDescription = typeof current.body.description === "string" ? current.body.description.trim() : "";
  const response = await input.request("human", "PATCH", `/api/issues/${input.rootIssueId}`, {
    status: "in_progress",
    assigneeAgentId: input.leadId,
    description: [existingDescription, wakeContext.descriptionBlock].filter(Boolean).join("\n\n"),
    executionPolicy: {
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: input.reviewerId }],
      }],
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, "in_progress");
  assert.equal(response.body.assigneeAgentId, input.leadId);
  assert(response.body.description.includes(`Mission ID: ${input.missionId}`));
  assert(response.body.description.includes(`Council command route: ${wakeContext.councilCommandRoute}`));
  return { issue: response.body, wakeContext };
}

export function assertProviderFreeN2HandoffReady(n1: any) {
  if (!n1?.providerFreePrerequisite) return;
  const lifecycle = n1?.fixtureLifecycle;
  assert.equal(lifecycle?.activeRunCount, 0, "N2 prerequisite fixture runs still occupy an execution slot");
  assert.equal(lifecycle?.openCheckoutCount, 0, "N2 prerequisite fixture checkout remains open");
  assert.equal(lifecycle?.openExecutionCount, 0, "N2 prerequisite fixture execution remains open");
  assert.equal(lifecycle?.terminalRuns?.length, 3, "N2 prerequisite must retain exactly three terminal fixture runs");
  assert(lifecycle.terminalRuns.every((run: any) => run.status === "succeeded"
    && run.finishedAt && run.wakeupRequestId === null && run.processStartedAt === null),
  "N2 prerequisite fixtures must be terminal without wakeup or process execution");
}

export async function preserveN2RunBeforeBusinessAssertion(input: {
  evidence: Record<string, any>;
  run: unknown;
  label: string;
  observe: () => Promise<any>;
  reconcile: () => Promise<unknown>;
  readback: () => Promise<{ mission: any; admission: any }>;
  validateBusiness: (mission: any) => void;
  persist?: () => Promise<void>;
}) {
  input.evidence.runs.push(input.run);
  let persistenceError: unknown;
  try {
    await input.persist?.();
  } catch (error) {
    persistenceError = error;
    input.evidence.persistenceError = errorEvidence(error);
  }
  const observed = await input.observe();
  input.evidence.mission = observed;

  let reconciliationError: unknown;
  try {
    await input.reconcile();
    input.evidence.settlements.push({ label: input.label, status: "settled" });
  } catch (error) {
    reconciliationError = error;
    input.evidence.settlements.push({ label: input.label, status: "failed", error: errorEvidence(error) });
  }

  let readbackError: unknown;
  let validatedMission = observed;
  try {
    const readback = await input.readback();
    input.evidence.mission = readback.mission;
    input.evidence.admission = readback.admission;
    validatedMission = readback.mission;
  } catch (error) {
    readbackError = error;
    input.evidence.readbackError = errorEvidence(error);
  }

  let businessError: unknown;
  try {
    input.validateBusiness(validatedMission);
  } catch (error) {
    businessError = error;
    input.evidence.businessError = errorEvidence(error);
  }

  try {
    await input.persist?.();
  } catch (error) {
    persistenceError ??= error;
    input.evidence.persistenceError = errorEvidence(error);
  }

  if (businessError) throw businessError;
  if (reconciliationError) throw reconciliationError;
  if (readbackError) throw readbackError;
  if (persistenceError) throw persistenceError;
  return observed;
}

async function closeOwnedN2Execution(input: {
  request: ApiRequest;
  getRun: (runId: string) => Promise<RunSnapshot | null>;
  listRuns: (agentId: string) => Promise<RunSnapshot[]>;
  leadId: string;
  reviewerId: string;
  baselineRunIds: Set<string>;
  evidence: Record<string, any>;
  runEvidence: typeof nativeRunEvidence;
  persist: () => Promise<void>;
}) {
  const disabledAgents = [];
  for (const agentId of [input.reviewerId, input.leadId]) {
    const agent = await setWakeOnDemand(input.request, agentId, false);
    disabledAgents.push({ agentId, wakeOnDemand: agent.runtimeConfig?.heartbeat?.wakeOnDemand });
  }
  const readCampaignRuns = async () => {
    const runs = [...await input.listRuns(input.reviewerId), ...await input.listRuns(input.leadId)];
    return runs.filter((run, index) => !input.baselineRunIds.has(run.id)
      && runs.findIndex((candidate) => candidate.id === run.id) === index);
  };
  const beforeCancellation = await readCampaignRuns();
  const cancellations = [];
  for (const run of beforeCancellation.filter((entry) => !terminalStatuses.has(entry.status))) {
    const cancelled = await input.request("human", "POST", `/api/heartbeat-runs/${run.id}/cancel`);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const terminal = await waitForTerminalRun(run.id, input.getRun, 60_000);
    cancellations.push({ runId: run.id, requestedStatus: run.status, terminalStatus: terminal.status });
  }
  const observedRuns = await readCampaignRuns();
  assert(observedRuns.every((run) => terminalStatuses.has(run.status)),
    "owned N2 runs must be terminal before isolated database teardown");
  const recordedRunIds = new Set((input.evidence.runs as Array<{ id?: string }>).map((run) => run.id));
  input.evidence.wakeupCleanup = {
    disabledAgents,
    cancellations,
    observedRuns: observedRuns.map(input.runEvidence),
    additionalRuns: observedRuns.filter((run) => !recordedRunIds.has(run.id)).map(input.runEvidence),
    nonterminalRunCount: 0,
  };
  await input.persist();
}

export async function withN2WakeCleanup<T>(input: Parameters<typeof closeOwnedN2Execution>[0], operation: () => Promise<T>) {
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await closeOwnedN2Execution(input);
    } catch (cleanupError) {
      input.evidence.wakeupCleanupError = errorEvidence(cleanupError);
      await input.persist().catch(() => undefined);
      if (!operationError) throw cleanupError;
    }
  }
}

async function inspectMission(request: ApiRequest, path: string, companyId: string) {
  const result = await request("human", "GET", `${path}?companyId=${companyId}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function waitForN2Status(
  request: ApiRequest,
  path: string,
  companyId: string,
  expected: "correction_requested" | "accepted",
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const mission = await inspectMission(request, path, companyId);
    if (mission.n2?.status === expected) return mission;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`N2 finished-event handler did not reach ${expected}`);
}

async function settleN2Usage(input: {
  request: ApiRequest;
  missionPath: string;
  admissionPath: string;
  companyId: string;
  periodKey: string;
  target: "review" | "correction";
  round?: 1 | 2;
}) {
  const mission = await inspectMission(input.request, input.missionPath, input.companyId);
  const admission = await input.request(
    "human",
    "GET",
    `${input.admissionPath}?companyId=${input.companyId}&periodKey=${encodeURIComponent(input.periodKey)}`,
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

async function readN2MissionAndAdmission(input: {
  request: ApiRequest;
  missionPath: string;
  admissionPath: string;
  companyId: string;
  periodKey: string;
}) {
  const mission = await inspectMission(input.request, input.missionPath, input.companyId);
  const admission = await input.request(
    "human",
    "GET",
    `${input.admissionPath}?companyId=${input.companyId}&periodKey=${encodeURIComponent(input.periodKey)}`,
  );
  assert.equal(admission.status, 200, JSON.stringify(admission.body));
  return { mission, admission: admission.body };
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
    fixturePeriodKey?: string;
    nativePeriodKey?: string;
    nativeAdmission?: any;
    providerFreePrerequisite?: boolean;
    fixtureLifecycle?: any;
  };
  runEvidence: typeof nativeRunEvidence;
  persistEvidence: () => Promise<void>;
  onRunCaptured?: (runId: string) => void;
}) {
  const { companyId, missionId, rootIssueId, agents } = input.n1;
  assertProviderFreeN2HandoffReady(input.n1);
  const n2PeriodKey = input.n1.nativePeriodKey ?? input.n1.periodKey;
  const missionPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/missions/${missionId}`;
  const admissionPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/admission`;
  const reviewerRunIds = new Set((await input.listRuns(agents.reviewer.id)).map((run) => run.id));
  const leadRunIds = new Set((await input.listRuns(agents.lead.id)).map((run) => run.id));
  const baselineRunIds = new Set([...reviewerRunIds, ...leadRunIds]);
  input.evidence.liveN2 = {
    companyId,
    missionId,
    rootIssueId,
    agents: { lead: agents.lead.id, reviewer: agents.reviewer.id },
    runs: [],
    settlements: [],
    mission: null,
    admission: input.n1.nativeAdmission ?? input.n1.admission,
    fixtureAdmission: input.n1.admission,
    decisionReceipts: [],
    limits: {
      runCount: input.n1.providerFreePrerequisite ? 3 : 6,
      maxConcurrent: 2,
      maxRetries: 0,
      maxCorrections: 1,
    },
  };
  const progressiveEvidence = input.evidence.liveN2;
  await input.persistEvidence();

  return withN2WakeCleanup({
    request: input.request,
    getRun: input.getRun,
    listRuns: input.listRuns,
    leadId: agents.lead.id,
    reviewerId: agents.reviewer.id,
    baselineRunIds,
    evidence: progressiveEvidence,
    runEvidence: input.runEvidence,
    persist: input.persistEvidence,
  }, async () => {
  const reviewEntry = await configureNativeN2ReviewEntry({
    request: input.request,
    pluginId: input.pluginId,
    rootIssueId,
    missionId,
    leadId: agents.lead.id,
    reviewerId: agents.reviewer.id,
  });
  progressiveEvidence.wakeContext = reviewEntry.wakeContext;

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
  assert.equal(started.body.outcome, "prepared");
  assert.deepEqual(started.body.nativeTransition, {
    method: "PATCH",
    path: `/api/issues/${rootIssueId}`,
    body: { status: "in_review" },
  });
  await setWakeOnDemand(input.request, agents.reviewer.id, true);
  const initialReviewTransition = await input.request("human", "PATCH", `/api/issues/${rootIssueId}`, {
    status: "in_review",
  });
  assert.equal(initialReviewTransition.status, 200, JSON.stringify(initialReviewTransition.body));
  assert.equal(initialReviewTransition.body.status, "in_review");
  assert.equal(initialReviewTransition.body.assigneeAgentId, agents.reviewer.id);
  assert.equal(initialReviewTransition.body.executionState?.currentParticipant?.agentId, agents.reviewer.id);
  assert.equal(initialReviewTransition.body.executionState?.returnAssignee?.agentId, agents.lead.id);

  const reviewRun1 = await waitForNewRun(agents.reviewer.id, reviewerRunIds, input.listRuns);
  reviewerRunIds.add(reviewRun1.id);
  await setWakeOnDemand(input.request, agents.reviewer.id, false);
  input.onRunCaptured?.(reviewRun1.id);
  const terminalReview1 = await waitForTerminalRun(reviewRun1.id, input.getRun);
  await preserveN2RunBeforeBusinessAssertion({
    evidence: progressiveEvidence,
    run: input.runEvidence(terminalReview1),
    label: "review-1",
    observe: () => inspectMission(input.request, missionPath, companyId),
    reconcile: () => waitForN2Status(input.request, missionPath, companyId, "correction_requested"),
    readback: () => readN2MissionAndAdmission({
      request: input.request, missionPath, admissionPath, companyId, periodKey: n2PeriodKey,
    }),
    persist: input.persistEvidence,
    validateBusiness: (mission) => {
      assertSucceeded(terminalReview1, "initial independent review");
      assert.equal(mission.n2.status, "correction_requested");
      assert.equal(mission.n2.review.round, 1);
      assert.equal(mission.n2.review.verdict.verdict, "changes_requested");
    },
  });
  await setWakeOnDemand(input.request, agents.lead.id, true);
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
  await setWakeOnDemand(input.request, agents.lead.id, false);
  input.onRunCaptured?.(correctionRunId);
  const correctionRun = await waitForTerminalRun(correctionRunId, input.getRun);
  await preserveN2RunBeforeBusinessAssertion({
    evidence: progressiveEvidence,
    run: input.runEvidence(correctionRun),
    label: "correction",
    observe: () => inspectMission(input.request, missionPath, companyId),
    reconcile: () => settleN2Usage({
      request: input.request, missionPath, admissionPath, companyId,
      periodKey: n2PeriodKey, target: "correction",
    }),
    readback: () => readN2MissionAndAdmission({
      request: input.request, missionPath, admissionPath, companyId, periodKey: n2PeriodKey,
    }),
    persist: input.persistEvidence,
    validateBusiness: (mission) => {
      assertSucceeded(correctionRun, "integration lead correction");
      assert.equal(mission.n2.status, "resubmission_prepared");
      assert.equal(mission.n2.correction.runId, correctionRunId);
      assert.deepEqual(mission.n2.correction.correctedPaths, ["alpha.txt"]);
    },
  });
  const beforeSecondReview = await inspectMission(input.request, missionPath, companyId);
  const secondReview = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId,
    command: "start-resubmitted-review",
    commandId: randomUUID(),
    expectedVersion: beforeSecondReview.mission.version,
    reservationId: randomUUID(),
  });
  assert.equal(secondReview.status, 200, JSON.stringify(secondReview.body));
  assert.equal(secondReview.body.outcome, "prepared");
  assert.deepEqual(secondReview.body.nativeTransition, {
    method: "PATCH",
    path: `/api/issues/${rootIssueId}`,
    body: { status: "in_review" },
  });
  await setWakeOnDemand(input.request, agents.reviewer.id, true);
  const finalReviewTransition = await input.request("human", "PATCH", `/api/issues/${rootIssueId}`, {
    status: "in_review",
  });
  assert.equal(finalReviewTransition.status, 200, JSON.stringify(finalReviewTransition.body));
  assert.equal(finalReviewTransition.body.status, "in_review");
  assert.equal(finalReviewTransition.body.assigneeAgentId, agents.reviewer.id);
  assert.equal(finalReviewTransition.body.executionState?.currentParticipant?.agentId, agents.reviewer.id);
  assert.equal(finalReviewTransition.body.executionState?.returnAssignee?.agentId, agents.lead.id);

  const reviewRun2 = await waitForNewRun(agents.reviewer.id, reviewerRunIds, input.listRuns);
  reviewerRunIds.add(reviewRun2.id);
  await setWakeOnDemand(input.request, agents.reviewer.id, false);
  input.onRunCaptured?.(reviewRun2.id);
  const terminalReview2 = await waitForTerminalRun(reviewRun2.id, input.getRun);
  await preserveN2RunBeforeBusinessAssertion({
    evidence: progressiveEvidence,
    run: input.runEvidence(terminalReview2),
    label: "review-2",
    observe: () => inspectMission(input.request, missionPath, companyId),
    reconcile: () => waitForN2Status(input.request, missionPath, companyId, "accepted"),
    readback: () => readN2MissionAndAdmission({
      request: input.request, missionPath, admissionPath, companyId, periodKey: n2PeriodKey,
    }),
    persist: input.persistEvidence,
    validateBusiness: (mission) => {
      assertSucceeded(terminalReview2, "final independent review");
      assert.equal(mission.n2.status, "accepted");
      assert.equal(mission.n2.application.state, "observed");
      assert.equal(mission.n2.review.round, 2);
      assert.equal(mission.n2.review.verdict.verdict, "approved");
    },
  });
  const finalMission = await inspectMission(input.request, missionPath, companyId);
  assert.equal(finalMission.mission.aggregate.phase, "accepted");
  assert.equal(finalMission.n2.status, "accepted");
  assert.equal(finalMission.mission.aggregate.n2.correctionsUsed, 1);
  assert.equal(finalMission.n2.submissions.length, 2);
  assert.equal(finalMission.n2.usage.complete, true);
  assert.notEqual(finalMission.n2.submissions[0].candidateCommit, finalMission.n2.submissions[1].candidateCommit);
  assert.notEqual(finalMission.n2.submissions[0].sha256, finalMission.n2.submissions[1].sha256);

  const finalAdmission = await input.request(
    "human",
    "GET",
    `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(n2PeriodKey)}`,
  );
  assert.equal(finalAdmission.status, 200, JSON.stringify(finalAdmission.body));
  const reservations = finalAdmission.body.envelope.reservations as any[];
  assert.equal(reservations.length, input.n1.providerFreePrerequisite ? 3 : 6);
  assert(reservations.every((entry) => entry.status === "settled"
    && entry.usage?.status === "known"
    && entry.usage.units > 0
    && entry.remainingExposure?.status === "known" && entry.remainingExposure.units === 0));
  let fixtureAdmission: any = null;
  if (input.n1.providerFreePrerequisite) {
    assert(input.n1.fixturePeriodKey, "isolated N2 prerequisite fixture period is missing");
    const response = await input.request(
      "human",
      "GET",
      `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(input.n1.fixturePeriodKey)}`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const fixtureReservations = response.body.envelope.reservations as any[];
    assert.equal(fixtureReservations.length, 3);
    assert(fixtureReservations.every((entry) => entry.status === "settled"
      && entry.usage?.status === "known" && entry.usage.units === 0
      && entry.remainingExposure?.status === "known" && entry.remainingExposure.units === 0));
    assert.equal(response.body.envelope.exposure.units, 0);
    fixtureAdmission = response.body;
  }

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
  Object.assign(input.evidence.liveN2, {
    mission: finalMission,
    admission: finalAdmission.body,
    ...(fixtureAdmission ? { fixtureAdmission } : {}),
    decisionReceipts: n2Receipts,
    correction: {
      path: "alpha.txt",
      runId: correctionRunId,
      v1: finalMission.n2.submissions[0],
      v2: finalMission.n2.submissions[1],
    },
  });
  await input.persistEvidence();
  Object.assign(input.evidence.results, {
    n2InitialIndependentReview: "PASS",
    n2ChangesRequestedApplied: "PASS",
    n2CorrectionRunSettled: "PASS",
    n2ChangedV2Verified: "PASS",
    n2FreshFinalReviewAccepted: "PASS",
    [input.n1.providerFreePrerequisite ? "n2AllThreeRunsSettled" : "n2AllSixRunsSettled"]: "PASS",
    ...(input.n1.providerFreePrerequisite ? { n2PrerequisiteHandoffCommandsConsumable: "PASS" } : {}),
  });
  return { missionPath, finalMission, finalAdmission: finalAdmission.body, n2Runs };
  });
}
