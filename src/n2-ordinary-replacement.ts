import { physicalAgent } from "./model-state.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { nativeN2Profile, n2CommandCas, runtimeReceipt, runtimeUuid, type N2Submission } from "./n2-missions.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { ordinaryTask, type OrdinaryN2State, type OrdinaryTask } from "./n2-ordinary-state.js";
import { n3Round, type N3NativeRound } from "./n3-state.js";

type MissingOutput = "opinion" | "verdict";

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
