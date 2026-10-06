import { isDeepStrictEqual } from "node:util";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readOrdinaryRun } from "./g4-native.js";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { physicalAgent } from "./model-state.js";
import { nativeN2Profile, n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { ordinaryTask, type OrdinaryTask } from "./n2-ordinary-state.js";

function correctionTarget(m: MissionRecord, body: Record<string, unknown>) {
  const state = m.aggregate.n2!; const ordinary = state.ordinary!; const correction = state.correction;
  const task = ordinary.tasks.find(item => !item.closedAt);
  const submission = state.submissions.find(item => item.submissionId === state.activeSubmissionId);
  if (!task || !correction || !submission || !task.runId || !task.issueId) {
    throw new MissionError(409, "correction_resume_binding", "An exact correction task and run are required");
  }
  const unavailable = [ordinary.correctionResume, m.aggregate.n5?.continuation, m.aggregate.n5?.publication,
    task.replacedBy, !task.settledAt, correction.usageSettledAt !== task.settledAt, correction.preparedSubmission,
    body.authorizeCorrectionResume !== true, typeof body.reason !== "string",
    String(body.reason).trim().length === 0, String(body.reason).length > 2000].some(Boolean);
  const actual = { version: m.version, status: state.status, corrections: state.correctionsUsed, limit: state.correctionLimit,
    kind: task.kind, wake: task.wake, creation: task.creation, taskId: task.taskId, runId: task.runId,
    reservationId: task.reservationId, correctionRunId: correction.runId, correctionReservationId: correction.reservationId,
    submissionId: task.submissionId, candidateCommit: submission.candidateCommit };
  const expected = { version: body.expectedVersion, status: "correcting", corrections: 1, limit: 1,
    kind: "correction", wake: "claimed", creation: "confirmed", taskId: body.taskId, runId: body.runId,
    reservationId: body.reservationId, correctionRunId: body.runId, correctionReservationId: body.reservationId,
    submissionId: state.activeSubmissionId, candidateCommit: body.candidateCommit };
  if (unavailable || !isDeepStrictEqual(actual, expected)) throw new MissionError(409, "correction_resume_binding", "Explicit unused owner authority on the exact settled unfinished correction is required");
  return task;
}

async function assertSettledRun(ctx: PluginContext, m: MissionRecord, task: OrdinaryTask) {
  const agentId = physicalAgent(m, task.agentId, { issueId: task.issueId, launchKey: task.reservationId });
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: task.issueId!, agentId, runId: task.runId! });
  if (run.status !== "succeeded" || !run.startedAt || !run.finishedAt) throw new MissionError(409, "correction_resume_terminal", "The previous correction must have succeeded and terminated");
  const { envelope } = await nativeN2Profile(ctx, m);
  const reservation = envelope.reservations.find(item => item.reservationId === task.reservationId);
  if (!reservation || !run.usageJson) throw new MissionError(409, "correction_resume_usage", "Settled reservation and measured usage are required");
  const source = `paperclip:GET-heartbeat-run:terminal-token-ledger;run=${run.id};agent=${agentId};issue=${task.issueId}`;
  const units = Number(run.usageJson.inputTokens) + Number(run.usageJson.outputTokens);
  const accounting = { missionId: reservation.missionId, effectId: reservation.effectId,
    status: reservation.status, usage: reservation.usage, usageSource: run.usageJson.usageSource };
  const expected = { missionId: m.missionId, effectId: task.taskId, status: "settled",
    usage: { status: "known", source, units }, usageSource: "per_run" };
  if (!Number.isSafeInteger(units) || units <= 0 || !isDeepStrictEqual(accounting, expected)
      || envelope.reservations.some(item => item.missionId === m.missionId && item.status !== "settled")) {
    throw new MissionError(409, "correction_resume_usage", "Exact terminal usage and all existing mission reservations must already be settled");
  }
}

/** One owner-admitted continuation of the same unfinished correction; no dispatch. */
export async function resumeSettledCorrection(ctx: PluginContext, m: MissionRecord, owner: string, body: Record<string, unknown>) {
  const commandId = runtimeUuid(body.commandId, "commandId");
  const prior = runtimeReceipt(m, commandId, owner, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed" as const, mission: m, receipt: prior };
  const task = correctionTarget(m, body);
  await assertSettledRun(ctx, m, task);
  const state = m.aggregate.n2!; const ordinary = state.ordinary!; const correction = state.correction!;
  const next = ordinaryTask("correction", task.submissionId, task.agentId);
  const grant = { commandId, authorizedBy: owner, reason: String(body.reason), priorTaskId: task.taskId,
    priorRunId: task.runId!, priorReservationId: task.reservationId, replacementTaskId: next.taskId, reservationId: next.reservationId };
  return n2CommandCas(ctx, m, body, "user", owner, { ...m.aggregate, phase: "correction_requested",
    n2: { ...state, status: "correction_requested", correction: { ...correction!, runId: null,
      reservationId: next.reservationId, usageSettledAt: undefined, wakeState: undefined },
      ordinary: { ...ordinary, correctionResume: grant, tasks: ordinary.tasks.flatMap(item => item.taskId === task.taskId
        ? [{ ...item, closedAt: new Date().toISOString(), replacedBy: next.taskId }, next] : [item]) } },
    journal: [...m.aggregate.journal, { action: "owner_resumed_settled_correction", ...grant }] });
}
