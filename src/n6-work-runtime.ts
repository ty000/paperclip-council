import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readAdmission, reserveAdmission } from "./admission.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { readOrdinaryRunSummary } from "./n2-ordinary-report.js";
import { coordinationActor, coordinationTask, coordinationTaskAt, saveCoordination, type CoordinationTask } from "./n6-coordination-state.js";
import { coordinationInstructions } from "./n6-work-instructions.js";
import { bindVariantIssue, claimVariantWake, observeVariantRun, prepareVariantLaunch, recordVariantWake } from "./model-runtime.js";
import { physicalAgent } from "./model-state.js";

const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;
export function saveCoordinationTask(ctx: PluginContext, m: MissionRecord, task: CoordinationTask) {
  const c = m.aggregate.n6!.coordination!;
  return saveCoordination(ctx, m, { ...c, tasks: c.tasks.map(t => t.taskId === task.taskId ? task : t) });
}
async function dispatch(ctx: PluginContext, initial: MissionRecord, initialTask: CoordinationTask) {
  let m = initial; let task = initialTask;
  if (task.wake === "claimed") return m; // An unbound wake is uncertain, never repeated.
  if (!task.issueId && task.creation !== "pending") throw new MissionError(409, "n6_work_effect_unknown", "Creation claimed: retain existing identity; no replacement task");
  await coordinationActor(ctx, m, task.agentId);
  const prepared = await prepareVariantLaunch(ctx, m, { taskKey: "coordination", interventionKey: task.kind, launchKey: task.reservationId,
    logicalAgentId: task.agentId, family: "orchestration", expectedRoles: [task.kind], ...(task.issueId ? { issueId: task.issueId } : {}) });
  m = prepared.mission;
  const agentId = prepared.binding?.agentId ?? task.agentId;
  if (!task.issueId) {
    m = await saveCoordinationTask(ctx, m, { ...task, creation: "claimed" });
    const issue = await ctx.issues.create({ companyId: m.companyId, projectId: m.projectId, status: "backlog", assigneeAgentId: agentId,
      title: `Council N6 ${task.kind}: ${m.missionId}`, description: coordinationInstructions(m, task),
      inheritExecutionWorkspaceFromIssueId: m.rootIssueId, originKind: "plugin:private.paperclip-council:coordination", originId: task.taskId });
    task = { ...task, issueId: issue.id, creation: "confirmed" }; m = await saveCoordinationTask(ctx, m, task);
  }
  const c = m.aggregate.n6!.coordination!;
  const envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey: c.periodKey });
  if (!envelope) throw new MissionError(409, "n6_work_budget", "Configured native admission required");
  await reserveAdmission(ctx, { companyId: m.companyId, periodKey: c.periodKey, reservationId: task.reservationId, missionId: m.missionId,
    effectId: task.taskId, requestedUnits: c.requestedUnits, attempt: { kind: "initial", ordinal: 0 }, expectedVersion: envelope.version });
  m = await bindVariantIssue(ctx, m, task.reservationId, task.issueId!);
  task = { ...task, wake: "claimed" }; m = await saveCoordinationTask(ctx, m, task);
  m = await claimVariantWake(ctx, m, task.reservationId);
  let wake: { runId: string | null };
  try {
    await ctx.issues.update(task.issueId!, { status: "todo" }, m.companyId);
    wake = await ctx.issues.requestWakeup(task.issueId!, m.companyId, { idempotencyKey: `council:n6:${task.taskId}`,
      reason: "council_n6_coordination_admitted", actorUserId: c.authorizedBy });
  } catch (error) {
    await recordVariantWake(ctx, await fresh(ctx, m), task.reservationId, null);
    throw error;
  }
  m = await fresh(ctx, m); task = coordinationTaskAt(m, task.taskId);
  m = await recordVariantWake(ctx, m, task.reservationId, wake.runId);
  if (!wake.runId || task.runId && task.runId !== wake.runId) throw new MissionError(409, "n6_work_effect_unknown", "Exact admitted run must be observed");
  return saveCoordinationTask(ctx, m, { ...task, runId: wake.runId });
}
async function settle(ctx: PluginContext, m: MissionRecord, task: CoordinationTask) {
  const identity = { companyId: m.companyId, issueId: task.issueId!,
    agentId: physicalAgent(m, task.agentId, { launchKey: task.reservationId, issueId: task.issueId!, runId: task.runId! }), runId: task.runId! };
  const run = await readOrdinaryRun(ctx, identity);
  if (["queued", "running"].includes(run.status)) return null;
  const c = m.aggregate.n6!.coordination!;
  const envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey: c.periodKey });
  if (!envelope) throw new MissionError(409, "n6_work_budget", "Existing reservation envelope required");
  await settleOrdinaryRunUsage(ctx, { ...identity, periodKey: c.periodKey, reservationId: task.reservationId,
    commandId: task.settlementCommandId, expectedVersion: envelope.version });
  if (run.status !== "succeeded") throw new MissionError(409, "n6_work_failed", "Terminal costs recorded; failed coordination cannot continue");
  let report: unknown;
  try { report = JSON.parse(String(await readOrdinaryRunSummary(ctx, run))); } catch { throw new MissionError(409, "n6_work_report", "Exact terminal report required"); }
  if (!task.report || canonicalPayloadHash(task.report) !== canonicalPayloadHash(report)) throw new MissionError(409, "n6_work_report", "Terminal report must match its attributed prepared command");
  m = await fresh(ctx, m); task = coordinationTaskAt(m, task.taskId);
  m = await observeVariantRun(ctx, m, task.reservationId);
  return saveCoordinationTask(ctx, m, { ...task, settledAt: new Date().toISOString() });
}
async function apply(ctx: PluginContext, m: MissionRecord, task: CoordinationTask) {
  const c = m.aggregate.n6!.coordination!; const report = task.report!;
  const tasks = c.tasks.map(t => t.taskId === task.taskId ? { ...t, closedAt: new Date().toISOString() } : t);
  let state = c.state; let nextActor = c.authorizedBy;
  if (report.priority) await ctx.issues.update(m.rootIssueId, { priority: report.priority }, m.companyId, { actorUserId: c.authorizedBy });
  if (report.action === "facilitate") tasks.push({ ...coordinationTask("facilitator", c.facilitatorAgentId),
    request: { question: report.question, participants: report.participants, expectedOutcome: report.expectedOutcome } });
  else if (report.action === "resolved") { tasks.push(coordinationTask("coordinator", c.coordinatorAgentId)); nextActor = c.coordinatorAgentId; }
  else if (report.action === "escalate") { state = "owner_required"; nextActor = c.authorizedBy; }
  else state = report.action === "release" ? "released" : "held";
  if (report.action === "facilitate") nextActor = c.facilitatorAgentId;
  await ctx.issues.update(task.issueId!, { status: "done" }, m.companyId);
  return saveCoordination(ctx, m, { ...c, tasks, state, nextActor, reason: report.reason, priority: report.priority ?? c.priority });
}
/** Bounded PM -> optional facilitator -> PM; existing native lifecycle and G4, no polling models. */
export async function reconcileCoordination(ctx: PluginContext, initial: MissionRecord) {
  let m = initial;
  for (let step = 0; step < 7; step++) {
    const task = m.aggregate.n6!.coordination!.tasks.find(t => !t.closedAt);
    if (!task) return m;
    if (!task.runId) return dispatch(ctx, m, task);
    if (!task.settledAt) { const next = await settle(ctx, m, task); if (!next) return m; m = next; continue; }
    m = await apply(ctx, m, task);
  }
  throw new MissionError(409, "n6_work_bound", "Bounded coordination reconciliation exhausted");
}
