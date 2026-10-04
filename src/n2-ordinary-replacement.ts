import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { nativeN2Profile, n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { ordinaryTask } from "./n2-ordinary-state.js";
import { n3Round } from "./n3-state.js";

/** Explicit owner exception, once per mission. Preparation itself never wakes an agent. */
export async function replaceMissingOpinion(ctx: PluginContext, mission: MissionRecord, owner: string, body: Record<string, unknown>) {
  const prior = runtimeReceipt(mission, runtimeUuid(body.commandId, "commandId"), owner, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission, receipt: prior };
  if (owner !== mission.ownerUserId || body.authorizeOneReplacement !== true) throw new MissionError(403, "ordinary_replacement_authority", "Owner must explicitly authorize this single replacement");
  const state = mission.aggregate.n2!; const ordinary = state.ordinary!;
  const task = ordinary.tasks.find(item => !item.closedAt);
  const submission = state.submissions.find(item => item.submissionId === state.activeSubmissionId)!;
  if (mission.version !== body.expectedVersion || ordinary.missingOpinionReplacement || !task || task.kind !== "specialist"
      || task.taskId !== body.taskId || task.runId !== body.runId || task.submissionId !== body.submissionId
      || submission.candidateCommit !== body.candidateCommit || task.submissionId !== state.activeSubmissionId) {
    throw new MissionError(409, "ordinary_replacement_unavailable", "Exact current candidate and first missing specialist task required; one replacement maximum");
  }
  if (!task.issueId || !task.runId || !task.settledAt || task.report || n3Round(mission)!.review.opinions.some(item => item.slotId === task.slotId)) {
    throw new MissionError(409, "ordinary_replacement_opinion_or_usage", "A settled specialist without any slot opinion is required");
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000) throw new MissionError(400, "ordinary_replacement_reason", "A bounded owner reason is required");
  const reason = body.reason.trim();
  const identity = { companyId: mission.companyId, issueId: task.issueId, agentId: task.agentId, runId: task.runId };
  const run = await readOrdinaryRun(ctx, identity);
  if (run.status !== "succeeded") throw new MissionError(409, "ordinary_replacement_run", "Only a successful terminal run with no opinion can be replaced");
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  const reservation = envelope.reservations.find(item => item.reservationId === task.reservationId);
  if (!reservation || reservation.status !== "settled" || reservation.usage?.status !== "known"
      || reservation.remainingExposure.status !== "known" || reservation.remainingExposure.units !== 0) {
    throw new MissionError(409, "ordinary_replacement_usage", "The original exact reservation must already be fully settled");
  }
  // Same settlement key/payload must replay, proving public terminal per_run usage still matches the ledger.
  await settleOrdinaryRunUsage(ctx, { ...identity, commandId: task.settlementCommandId, reservationId: task.reservationId,
    periodKey: profile.periodKey, expectedVersion: envelope.version });
  const replacement = { ...ordinaryTask("specialist", task.submissionId, task.agentId, task.slotId), replacementOf: task.taskId };
  const grant = { commandId: String(body.commandId), authorizedBy: owner, authorizedAt: new Date().toISOString(), reason,
    priorTaskId: task.taskId, priorRunId: task.runId, priorReservationId: task.reservationId,
    replacementTaskId: replacement.taskId, reservationId: replacement.reservationId, submissionId: task.submissionId,
    candidateCommit: submission.candidateCommit, subject: n3Round(mission)!.review.subject };
  const tasks = ordinary.tasks.flatMap(item => item.taskId === task.taskId ? [{ ...item, replacedBy: replacement.taskId }, replacement] : [item]);
  return n2CommandCas(ctx, mission, body, "user", owner, { ...mission.aggregate,
    n2: { ...state, ordinary: { ...ordinary, tasks, missingOpinionReplacement: grant } },
    journal: [...mission.aggregate.journal, { action: "ordinary_missing_opinion_replacement_authorized", ...grant, opinionAbsent: true }] });
}
