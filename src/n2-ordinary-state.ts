import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, type N2Submission } from "./n2-missions.js";
import { n3Subject } from "./n3-runtime.js";
import type { N3CandidateSubject } from "./n3-opinions.js";

export type OrdinaryReport = { schema: "council-ordinary-result-v1"; missionId: string; taskId: string;
  subject: N3CandidateSubject; verdict: "approved" | "changes_requested"; rationale: string; synthesisHash: string };
export type OrdinaryTask = { taskId: string; kind: "specialist" | "council" | "correction"; submissionId: string;
  agentId: string; slotId?: string; issueId: string | null; creation: "pending" | "claimed" | "confirmed";
  reservationId: string; settlementCommandId: string; runId: string | null; wake: "pending" | "claimed";
  replacementOf?: string; replacedBy?: string; settledAt?: string; report?: OrdinaryReport; receiptRecordedAt?: string; closedAt?: string };
export type OrdinaryN2State = { protocol: "ordinary-cli-v1"; tasks: OrdinaryTask[]; missingOpinionReplacement?: { commandId: string; authorizedBy: string; authorizedAt: string; reason: string; priorTaskId: string; priorRunId: string; priorReservationId: string; replacementTaskId: string; reservationId: string; submissionId: string; candidateCommit: string; subject: N3CandidateSubject } };

export function ordinaryTask(kind: OrdinaryTask["kind"], submissionId: string, agentId: string, slotId?: string): OrdinaryTask {
  return { taskId: randomUUID(), kind, submissionId, agentId, slotId, issueId: null, creation: "pending",
    reservationId: randomUUID(), settlementCommandId: randomUUID(), runId: null, wake: "pending" };
}
export async function freshOrdinary(ctx: PluginContext, mission: MissionRecord) {
  const current = await getMission(ctx, mission.companyId, mission.missionId);
  if (!current?.aggregate.n2?.ordinary) throw new MissionError(409, "ordinary_n2_required", "Persisted ordinary N2 state required");
  return current;
}
export async function saveOrdinaryTask(ctx: PluginContext, mission: MissionRecord, task: OrdinaryTask) {
  const state = mission.aggregate.n2!;
  return n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...state,
    ordinary: { ...state.ordinary!, tasks: state.ordinary!.tasks.map(item => item.taskId === task.taskId ? task : item) } } });
}
export function currentOrdinaryTask(mission: MissionRecord, taskId: string) {
  const task = mission.aggregate.n2?.ordinary?.tasks.find(item => item.taskId === taskId);
  if (!task) throw new MissionError(409, "ordinary_task_missing", "Admitted ordinary task is missing");
  return task;
}
export function validateOrdinaryReport(mission: MissionRecord, task: OrdinaryTask, summary: unknown): OrdinaryReport {
  const submission = mission.aggregate.n2!.submissions.find(item => item.submissionId === task.submissionId)!;
  let report: OrdinaryReport;
  try { report = JSON.parse(String(summary)); } catch { throw new MissionError(409, "ordinary_report_missing", "Council must finish with the exact prepared JSON report"); }
  if (!task.report || canonicalPayloadHash(report) !== canonicalPayloadHash(task.report)
      || report.schema !== "council-ordinary-result-v1" || report.missionId !== mission.missionId || report.taskId !== task.taskId
      || canonicalPayloadHash(report.subject) !== canonicalPayloadHash(n3Subject(submission))) {
    throw new MissionError(409, "ordinary_report_mismatch", "Terminal Council report differs from its immutable candidate-bound synthesis");
  }
  return report;
}
export function ordinaryReceiptSubject(submission: N2Submission, task: OrdinaryTask) {
  return { method: "GET", provenance: "ordinary-task-terminal-readback-v1", issueId: task.issueId, runId: task.runId,
    reportHash: canonicalPayloadHash(task.report), subjectHash: canonicalPayloadHash(n3Subject(submission)) };
}
