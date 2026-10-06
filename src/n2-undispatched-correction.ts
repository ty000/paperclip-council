import type { PluginContext } from "@paperclipai/plugin-sdk";
import { settleAdmission, type AdmissionSnapshot } from "./admission.js";
import { readOrdinaryRun, suppressedBeforeProvider } from "./g4-native.js";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { physicalAgent } from "./model-state.js";
import { nativeN2Profile, n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { ordinaryTask, type OrdinaryTask } from "./n2-ordinary-state.js";

function correctionTarget(mission: MissionRecord, body: Record<string, unknown>) {
  const state = mission.aggregate.n2!; const ordinary = state.ordinary!;
  const task = ordinary.tasks.find(item => !item.closedAt);
  const submission = state.submissions.find(item => item.submissionId === state.activeSubmissionId);
  if (!task || !submission || task.kind !== "correction" || !task.runId || !task.issueId) {
    throw new MissionError(409, "undispatched_correction_binding", "An existing claimed correction is required");
  }
  const exact = [body.authorizePreExecutionReplacement === true, mission.version === body.expectedVersion,
    !ordinary.preExecutionRecovery, state.status === "correction_requested", !state.correction?.runId,
    !state.correction?.preparedSubmission, !task.settledAt, task.taskId === body.taskId, task.runId === body.runId,
    task.reservationId === body.reservationId, task.wake === "claimed", !task.replacedBy,
    task.submissionId === state.activeSubmissionId, submission.candidateCommit === body.candidateCommit].every(Boolean);
  if (!exact) throw new MissionError(409, "undispatched_correction_binding", "Exact first unexecuted correction and explicit unused owner recovery required");
  return task;
}

function assertUntouchedReservation(envelope: AdmissionSnapshot, missionId: string, task: OrdinaryTask) {
  const reservation = envelope.reservations.find(item => item.reservationId === task.reservationId);
  if (!reservation || reservation.missionId !== missionId || reservation.effectId !== task.taskId
      || reservation.lastKnownUsageUnits !== 0 || reservation.usage && (reservation.usage.status !== "known" || reservation.usage.units !== 0)
      || envelope.reservations.some(item => item.reservationId !== task.reservationId && item.missionId === missionId && item.status !== "settled")) {
    throw new MissionError(409, "undispatched_correction_accounting", "The exact untouched reservation and no other open mission exposure are required");
  }
}

/** Explicit owner recovery only; no wake and no automatic retry. */
export async function replaceUndispatchedCorrection(ctx: PluginContext, mission: MissionRecord,
  owner: string, body: Record<string, unknown>) {
  const commandId = runtimeUuid(body.commandId, "commandId");
  const prior = runtimeReceipt(mission, commandId, owner, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed" as const, mission, receipt: prior };
  const state = mission.aggregate.n2!; const ordinary = state.ordinary!;
  const task = correctionTarget(mission, body);
  const identity = { companyId: mission.companyId, issueId: task.issueId!,
    agentId: physicalAgent(mission, task.agentId, { issueId: task.issueId, launchKey: task.reservationId }), runId: task.runId! };
  const run = await readOrdinaryRun(ctx, identity);
  if (!suppressedBeforeProvider(run)) {
    throw new MissionError(409, "correction_execution_not_excluded", "Only the host's exact pre-provider suppression proves this correction did not execute");
  }
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  assertUntouchedReservation(envelope, mission.missionId, task);
  const source = `paperclip:GET-heartbeat-run:legacy_disposition_repair_suppressed;run=${run.id};before-provider`;
  await settleAdmission(ctx, { commandId: task.settlementCommandId, companyId: mission.companyId,
    periodKey: profile.periodKey, reservationId: task.reservationId, expectedVersion: envelope.version,
    usage: { status: "known", source, units: 0 }, remainingExposure: { status: "known", source, units: 0 } });
  // The unexecuted task is retained. A fresh issue avoids the root's stale recovery context.
  const replacement = { ...ordinaryTask("correction", task.submissionId, task.agentId), preExecutionReplacementOf: task.taskId };
  const grant = { commandId, authorizedBy: owner, priorTaskId: task.taskId, priorRunId: task.runId!,
    priorReservationId: task.reservationId, replacementTaskId: replacement.taskId, reservationId: replacement.reservationId };
  const at = new Date().toISOString();
  return n2CommandCas(ctx, mission, body, "user", owner, { ...mission.aggregate,
    n2: { ...state, correction: { ...state.correction!, reservationId: replacement.reservationId },
      ordinary: { ...ordinary, preExecutionRecovery: grant, tasks: ordinary.tasks.flatMap(item => item.taskId === task.taskId
        ? [{ ...item, settledAt: at, closedAt: at, replacedBy: replacement.taskId }, replacement] : [item]) } },
    journal: [...mission.aggregate.journal, { action: "owner_replaced_undispatched_correction", ...grant, source, at }] });
}
