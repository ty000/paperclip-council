import { physicalAgent } from "./model-state.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { nativeN2Profile, n2Cas, n2CommandCas, runtimeReceipt, runtimeUuid,
  type N2ReviewRound, type N2Submission } from "./n2-missions.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { ordinaryTask, type OrdinaryN2State, type OrdinaryTask } from "./n2-ordinary-state.js";
import { n3Round, type N3NativeRound } from "./n3-state.js";

type MissingOutput = "opinion" | "verdict";
type ReplacedCouncilSettlement = { prior: OrdinaryTask; replacement: OrdinaryTask };
type ReplacementGrant = NonNullable<OrdinaryN2State["missingOpinionReplacement"]>;

function requestedReplacement(body: Record<string, unknown>): { command: string; taskKind: "specialist" | "council"; missingOutput: MissingOutput } {
  if (body.command === "replace-missing-opinion") {
    return { command: body.command, taskKind: "specialist", missingOutput: "opinion" };
  }
  if (body.command === "replace-missing-verdict") {
    return { command: body.command, taskKind: "council", missingOutput: "verdict" };
  }
  throw new MissionError(400, "ordinary_replacement_command", "Use the explicit replacement command for the missing terminal output");
}

function submissionSubject(submission: N2Submission) {
  return { submissionId: submission.submissionId, candidateCommit: submission.candidateCommit, bundleSha256: submission.sha256,
    evidenceRevision: submission.evidenceRevision, mandateHash: submission.mandateHash };
}
function exactHash(left: unknown, right: unknown) {
  return left !== undefined && left !== null && right !== undefined && right !== null
    && canonicalPayloadHash(left) === canonicalPayloadHash(right);
}

function requireTargetParts(task: OrdinaryTask | undefined, submission: N2Submission | undefined, round: N3NativeRound | undefined) {
  if (!task || !submission || !round) {
    throw new MissionError(409, "ordinary_replacement_unavailable",
      "Exact active candidate and first terminal task with one unused replacement grant required");
  }
  return { task, submission, round };
}

function requireExactCommonTarget(input: { mission: MissionRecord; body: Record<string, unknown>;
  taskKind: "specialist" | "council"; state: NonNullable<MissionRecord["aggregate"]["n2"]>;
  ordinary: OrdinaryN2State; task: OrdinaryTask; firstOpen: OrdinaryTask | undefined;
  submission: N2Submission; round: N3NativeRound; runId: string; submissionId: string }) {
  const { mission, body, taskKind, state, ordinary, task, firstOpen, submission, round, runId, submissionId } = input;
  const exactTarget = [mission.version === body.expectedVersion, !ordinary.missingOpinionReplacement,
    task === firstOpen, task.kind === taskKind, task.runId === runId, task.submissionId === submissionId,
    submission.candidateCommit === body.candidateCommit, task.submissionId === state.activeSubmissionId,
    canonicalPayloadHash(round.review.subject) === canonicalPayloadHash(submissionSubject(submission)),
    !task.closedAt, !task.replacedBy, task.issueId, task.creation === "confirmed", task.wake === "claimed"].every(Boolean);
  if (!exactTarget) {
    throw new MissionError(409, "ordinary_replacement_unavailable",
      "Exact active candidate and first terminal task with one unused replacement grant required");
  }
}

function requireCommonTarget(mission: MissionRecord, body: Record<string, unknown>, taskKind: "specialist" | "council") {
  const state = mission.aggregate.n2!;
  const ordinary = state.ordinary!;
  const taskId = runtimeUuid(body.taskId, "taskId");
  const runId = runtimeUuid(body.runId, "runId");
  const submissionId = runtimeUuid(body.submissionId, "submissionId");
  const task = ordinary.tasks.find((item) => item.taskId === taskId);
  const firstOpen = ordinary.tasks.find((item) => !item.closedAt);
  const submission = state.submissions.find((item) => item.submissionId === state.activeSubmissionId);
  const round = n3Round(mission);
  const parts = requireTargetParts(task, submission, round);
  requireExactCommonTarget({ mission, body, taskKind, state, ordinary, firstOpen, runId, submissionId, ...parts });
  return { state, ordinary, ...parts };
}

function requireMissingSpecialistOpinion(mission: MissionRecord, task: OrdinaryTask) {
  if (!task.settledAt || task.report || task.receiptRecordedAt
      || n3Round(mission)!.review.opinions.some((item) => item.slotId === task.slotId)) {
    throw new MissionError(409, "ordinary_replacement_opinion_or_usage", "A settled specialist without any slot opinion is required");
  }
}

function requireMissingCouncilVerdict(mission: MissionRecord, task: OrdinaryTask) {
  const state = mission.aggregate.n2!;
  const reviewRound = state.rounds.at(-1);
  const round = n3Round(mission)!;
  const application = state.application;
  const competingDecision = mission.aggregate.effectIntents.some((intent) => intent.kind === "n2_decision"
    && intent.submissionId === state.activeSubmissionId);
  const handoff = reviewRound?.handoff;
  const exactReview = [mission.aggregate.phase === "reviewing", state.status === "reviewing",
    reviewRound?.submissionId === state.activeSubmissionId, handoff?.state === "confirmed",
    handoff?.reviewerRunId === task.runId, handoff?.reservationId === task.reservationId,
    !handoff?.usageSettledAt, !reviewRound?.verdict, round.review.status === "ready_for_synthesis"].every(Boolean);
  const outputAbsent = [!round.review.synthesis, !task.settledAt, !task.report, !task.receiptRecordedAt].every(Boolean);
  const applicationAbsent = [application.state === "none", !application.submissionId, !application.operationId,
    !application.receiptState, application.nativeStatus === null, !competingDecision].every(Boolean);
  if (![exactReview, outputAbsent, applicationAbsent].every(Boolean)) {
    throw new MissionError(409, "ordinary_replacement_verdict_or_effect",
      "Replacement requires the exact active settled Council run with no synthesis, report, receipt, verdict, application, or decision intent");
  }
}

function requireReplacedCouncilParts(mission: MissionRecord, grant: ReplacementGrant) {
  const state = mission.aggregate.n2!;
  const ordinary = state.ordinary!;
  const prior = ordinary.tasks.find((item) => item.taskId === grant.priorTaskId);
  const replacement = ordinary.tasks.find((item) => item.taskId === grant.replacementTaskId);
  const submission = state.submissions.find((item) => item.submissionId === state.activeSubmissionId);
  const round = state.rounds.find((item) => item.submissionId === grant.submissionId);
  const n3 = n3Round(mission);
  const decisionIntents = mission.aggregate.effectIntents.filter((item) => item.kind === "n2_decision"
    && item.submissionId === grant.submissionId);
  if (!prior || !replacement || !submission || !round || !n3 || decisionIntents.length !== 1) {
    throw new MissionError(409, "ordinary_replaced_settlement_binding",
      "Historical settlement reconciliation requires the exact accepted replacement verdict, receipt, handoff and application");
  }
  return { prior, replacement, submission, round, n3, decisionIntent: decisionIntents[0]! };
}

function acceptedReplacementStateMatches(mission: MissionRecord, grant: ReplacementGrant,
  submission: N2Submission, replacement: OrdinaryTask) {
  const state = mission.aggregate.n2!;
  const acceptedControl = mission.aggregate.control.status === "inactive"
    && mission.aggregate.control.reason === "mission_accepted";
  return [mission.aggregate.phase === "accepted", acceptedControl, !mission.aggregate.n5?.publication,
    state.activeSubmissionId === grant.submissionId, state.application.state === "observed",
    submission.candidateCommit === grant.candidateCommit, exactHash(grant.subject, submissionSubject(submission)),
    state.application.submissionId === grant.submissionId, state.application.operationId === replacement.taskId,
    state.application.receiptState === "native_observed", state.application.nativeStatus === 200].every(Boolean);
}

function replacementLineageMatches(grant: ReplacementGrant, prior: OrdinaryTask, replacement: OrdinaryTask) {
  return [prior.kind === "council", prior.submissionId === grant.submissionId, prior.runId === grant.priorRunId,
    prior.reservationId === grant.priorReservationId, prior.replacedBy === replacement.taskId,
    prior.issueId, prior.closedAt, !prior.report, !prior.receiptRecordedAt,
    replacement.kind === "council", replacement.replacementOf === prior.taskId,
    replacement.reservationId === grant.reservationId, replacement.submissionId === grant.submissionId,
    replacement.agentId === prior.agentId, replacement.runId, replacement.settledAt, replacement.closedAt,
    replacement.report?.verdict === "approved", replacement.report?.taskId === replacement.taskId,
    replacement.receiptRecordedAt, exactHash(replacement.report?.subject, grant.subject)].every(Boolean);
}

function acceptedReplacementDecisionMatches(grant: ReplacementGrant, replacement: OrdinaryTask,
  round: N2ReviewRound, n3: N3NativeRound, decisionIntent: Record<string, unknown>) {
  return [round.verdict?.verdict === "approved", round.verdict?.operationId === replacement.taskId,
    round.verdict?.runId === replacement.runId, round.verdict?.receiptState === "native_observed",
    round.handoff.reviewerRunId === replacement.runId, round.handoff.reservationId === replacement.reservationId,
    round.handoff.usageSettledAt === replacement.settledAt,
    n3.review.synthesis?.verdict === "approved", n3.review.synthesis?.finalReviewerRunId === replacement.runId,
    exactHash(n3.review.synthesis?.subject, grant.subject), decisionIntent.operationId === replacement.taskId,
    decisionIntent.actorRunId === replacement.runId, decisionIntent.receiptState === "native_observed",
    decisionIntent.nativeStatus === 200, decisionIntent.verdict === "approved"].every(Boolean);
}

function replacedCouncilSettlementTarget(mission: MissionRecord): ReplacedCouncilSettlement | null {
  const state = mission.aggregate.n2!;
  const ordinary = state.ordinary!;
  const grant = ordinary.missingOpinionReplacement;
  const inactive = [grant?.missingOutput !== "verdict", grant?.taskKind !== "council", state.status !== "accepted",
    ordinary.tasks.some((item) => !item.closedAt)].some(Boolean);
  if (inactive || !grant) return null;
  const parts = requireReplacedCouncilParts(mission, grant);
  if (parts.prior.settledAt) return null;
  const exactBinding = [acceptedReplacementStateMatches(mission, grant, parts.submission, parts.replacement),
    replacementLineageMatches(grant, parts.prior, parts.replacement),
    acceptedReplacementDecisionMatches(grant, parts.replacement, parts.round, parts.n3, parts.decisionIntent)].every(Boolean);
  if (!exactBinding) {
    throw new MissionError(409, "ordinary_replaced_settlement_binding",
      "Historical settlement reconciliation requires the exact accepted replacement verdict, receipt, handoff and application");
  }
  return { prior: parts.prior, replacement: parts.replacement };
}

/** Reconcile one historical accounting stamp only after its replacement produced the accepted decision. */
export async function reconcileReplacedCouncilSettlement(ctx: PluginContext, mission: MissionRecord) {
  const target = replacedCouncilSettlementTarget(mission);
  if (!target) return mission;
  const { prior } = target;
  const identity = { companyId: mission.companyId, issueId: prior.issueId!,
    agentId: physicalAgent(mission, prior.agentId, { issueId: prior.issueId, runId: prior.runId }), runId: prior.runId! };
  const run = await readOrdinaryRun(ctx, identity);
  if (run.status !== "succeeded" || !run.startedAt || !run.finishedAt) {
    throw new MissionError(409, "ordinary_replaced_settlement_run",
      "Historical Council accounting requires the exact successful terminal native run");
  }
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  const reservation = envelope.reservations.find((item) => item.reservationId === prior.reservationId);
  const receipt = reservation?.settlementReceipts.find((item) => item.commandId === prior.settlementCommandId);
  const missionReservations = envelope.reservations.filter((item) => item.missionId === mission.missionId);
  const exactLedger = [reservation, reservation?.missionId === mission.missionId, reservation?.effectId === prior.taskId,
    reservation?.status === "settled", reservation?.usage?.status === "known",
    reservation?.remainingExposure.status === "known", reservation?.remainingExposure.status === "known"
      && reservation.remainingExposure.units === 0, receipt?.command === "settle", receipt?.settlement?.usage.status === "known",
    receipt?.settlement?.remainingExposure.status === "known", receipt?.settlement?.remainingExposure.status === "known"
      && receipt.settlement.remainingExposure.units === 0,
    missionReservations.length > 0, missionReservations.every((item) => item.status === "settled"
      && item.usage?.status === "known" && item.remainingExposure.status === "known" && item.remainingExposure.units === 0),
    exactHash(receipt?.settlement?.usage, reservation?.usage),
    exactHash(receipt?.settlement?.remainingExposure, reservation?.remainingExposure)].every(Boolean);
  if (!exactLedger || !receipt) {
    throw new MissionError(409, "ordinary_replaced_settlement_ledger",
      "Historical Council accounting requires its exact existing settled known-zero reservation receipt");
  }
  const replay = await settleOrdinaryRunUsage(ctx, { ...identity, commandId: prior.settlementCommandId,
    reservationId: prior.reservationId, periodKey: profile.periodKey, expectedVersion: envelope.version });
  if (replay.outcome !== "replayed") {
    throw new MissionError(409, "ordinary_replaced_settlement_replay",
      "Historical Council accounting may only replay an existing exact settlement");
  }
  const state = mission.aggregate.n2!;
  return n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...state, ordinary: { ...state.ordinary!,
    tasks: state.ordinary!.tasks.map((item) => item.taskId === prior.taskId ? { ...item, settledAt: receipt.recordedAt } : item) } } });
}

/** Explicit owner exception, once per mission. Preparation itself never wakes an agent. */
export async function replaceMissingOpinion(ctx: PluginContext, mission: MissionRecord, owner: string, body: Record<string, unknown>) {
  const request = requestedReplacement(body);
  const commandId = runtimeUuid(body.commandId, "commandId");
  if (owner !== mission.ownerUserId || body.authorizeOneReplacement !== true) {
    throw new MissionError(403, "ordinary_replacement_authority", "Owner must explicitly authorize this single replacement");
  }
  const prior = runtimeReceipt(mission, commandId, owner, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission, receipt: prior };
  const { state, ordinary, task, submission, round } = requireCommonTarget(mission, body, request.taskKind);
  if (request.missingOutput === "opinion") requireMissingSpecialistOpinion(mission, task);
  else requireMissingCouncilVerdict(mission, task);
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000) {
    throw new MissionError(400, "ordinary_replacement_reason", "A bounded owner reason is required");
  }
  const reason = body.reason.trim();
  const identity = { companyId: mission.companyId, issueId: task.issueId!,
    agentId: physicalAgent(mission, task.agentId, { issueId: task.issueId, runId: task.runId }), runId: task.runId! };
  const run = await readOrdinaryRun(ctx, identity);
  if (run.status !== "succeeded" || !run.startedAt || !run.finishedAt) {
    throw new MissionError(409, "ordinary_replacement_run", `Only a successful terminal run with no ${request.missingOutput} can be replaced`);
  }
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  const reservation = envelope.reservations.find((item) => item.reservationId === task.reservationId);
  const exactSettlement = reservation?.settlementReceipts.some((receipt) => receipt.commandId === task.settlementCommandId);
  if (!reservation || reservation.missionId !== mission.missionId || reservation.effectId !== task.taskId
      || reservation.status !== "settled" || reservation.usage?.status !== "known"
      || reservation.remainingExposure.status !== "known" || reservation.remainingExposure.units !== 0 || !exactSettlement
      || envelope.reservations.some((item) => item.missionId === mission.missionId && item.status !== "settled")) {
    throw new MissionError(409, "ordinary_replacement_usage", "The original exact reservation and all mission exposure must already be fully settled");
  }
  // Same settlement key/payload must replay, proving public terminal per_run usage still matches the ledger.
  await settleOrdinaryRunUsage(ctx, { ...identity, commandId: task.settlementCommandId, reservationId: task.reservationId,
    periodKey: profile.periodKey, expectedVersion: envelope.version });
  const replacement = { ...ordinaryTask(task.kind, task.submissionId, task.agentId, task.slotId), replacementOf: task.taskId };
  const grant = { commandId, authorizedBy: owner, authorizedAt: new Date().toISOString(), reason,
    missingOutput: request.missingOutput, taskKind: request.taskKind,
    priorTaskId: task.taskId, priorRunId: task.runId!, priorReservationId: task.reservationId,
    replacementTaskId: replacement.taskId, reservationId: replacement.reservationId, submissionId: task.submissionId,
    candidateCommit: submission.candidateCommit, subject: round.review.subject };
  const tasks = ordinary.tasks.flatMap((item) => item.taskId === task.taskId ? [{ ...item, replacedBy: replacement.taskId }, replacement] : [item]);
  const n2 = request.taskKind === "council" ? { ...state, status: "review_handoff" as const,
    rounds: state.rounds.map((item) => item.submissionId === task.submissionId ? { ...item,
      handoff: { ...item.handoff, state: "awaiting_native" as const, reservationId: replacement.reservationId,
        reviewerRunId: null, reason: null, observedAt: null, usageSettledAt: undefined } } : item),
    ordinary: { ...ordinary, tasks, missingOpinionReplacement: grant } }
    : { ...state, ordinary: { ...ordinary, tasks, missingOpinionReplacement: grant } };
  return n2CommandCas(ctx, mission, body, "user", owner, { ...mission.aggregate,
    ...(request.taskKind === "council" ? { phase: "review_handoff" as const } : {}), n2,
    journal: [...mission.aggregate.journal, { action: "ordinary_missing_terminal_output_replacement_authorized", ...grant,
      terminalOutputAbsent: true }] });
}
