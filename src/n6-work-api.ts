import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { AdmissionError } from "./admission.js";
import { readOrdinaryRun } from "./g4-native.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { assertN6Owner } from "./n6-guards.js";
import { coordinationActor, coordinationText, type CoordinationReport, type CoordinationTask, type N6Priority } from "./n6-coordination-state.js";
import { saveCoordinationTask } from "./n6-work-runtime.js";
import { coordinationInstructions } from "./n6-work-instructions.js";
import { recordVariantWake } from "./model-runtime.js";
import { modelLaunch, physicalAgent } from "./model-state.js";

function refuseReserved(body: Record<string, unknown>, permitted: string[]) {
  if (Object.keys(body).some(k => !["missionId", "command", "commandId", "expectedVersion", ...permitted].includes(k))) {
    throw new MissionError(403, "n6_reserved_decision", "Source, result, mandate, budget and acceptance are reserved; explicitly escalate to the owner");
  }
}
export function coordinationReport(m: MissionRecord, task: CoordinationTask, body: Record<string, unknown>): CoordinationReport {
  const c = m.aggregate.n6!.coordination!;
  const base = { schema: "n6-coordination-report-v1" as const, missionId: m.missionId, taskId: task.taskId,
    reason: coordinationText(body.reason, "reason"), nextActor: c.authorizedBy };
  if (task.kind === "facilitator") {
    refuseReserved(body, ["action", "reason"]);
    if (body.command !== "n6-facilitation-outcome" || !["resolved", "escalate"].includes(String(body.action))) {
      throw new MissionError(403, "n6_facilitation_authority", "Facilitator may only clarify or escalate; no priority, acceptance or dispatch authority");
    }
    return { ...base, action: body.action as "resolved" | "escalate", nextActor: body.action === "escalate" ? c.authorizedBy : c.coordinatorAgentId };
  }
  refuseReserved(body, ["action", "reason", "priority", "question", "participants", "expectedOutcome"]);
  if (task.agentId !== c.coordinatorAgentId || body.command !== "n6-coordinate") throw new MissionError(403, "n6_coordinator_required", "Current delegated coordinator required");
  if (!["release", "hold", "facilitate", "escalate"].includes(String(body.action))) throw new MissionError(422, "n6_coordination_action", "Choose bounded release, hold, facilitation or escalation");
  if (body.priority !== undefined && !c.allowedPriorities.includes(body.priority as N6Priority)) throw new MissionError(403, "n6_reserved_priority", "Priority outside delegation must be escalated to owner");
  const report: CoordinationReport = { ...base, action: body.action as CoordinationReport["action"], priority: body.priority as N6Priority | undefined };
  if (report.action === "escalate") report.nextActor = c.authorizedBy;
  if (report.action === "facilitate") {
    if (c.tasks.some(t => t.kind === "facilitator")) throw new MissionError(409, "n6_facilitation_bound", "One facilitation maximum; unresolved repetition goes to owner");
    const participants = body.participants as string[];
    if (!Array.isArray(participants) || !participants.length || participants.some(id => !c.participantAgentIds.includes(id))) throw new MissionError(403, "n6_participant_scope", "Use explicitly delegated participants");
    report.question = coordinationText(body.question, "question"); report.expectedOutcome = coordinationText(body.expectedOutcome, "expectedOutcome");
    report.participants = [...new Set(participants)]; report.nextActor = c.facilitatorAgentId;
  }
  return report;
}
async function bind(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput) {
  const task = m.aggregate.n6?.coordination?.tasks.find(t => t.issueId === input.params.issueId && !t.closedAt);
  const launch = task ? modelLaunch(m, task.reservationId) : undefined;
  if (!task || input.actor.actorType !== "agent"
      || input.actor.agentId !== physicalAgent(m, task.agentId, { launchKey: task.reservationId, issueId: task.issueId! }) || !input.actor.runId
      || m.aggregate.modelSelection && (!launch || !["wake_claimed", "unknown", "bound"].includes(launch.state))
      || task.wake !== "claimed" || task.runId && task.runId !== input.actor.runId) throw new MissionError(403, "n6_work_binding", "Exact admitted role/task/run required");
  const c = m.aggregate.n6!.coordination!;
  if (task.kind === "coordinator" && task.agentId !== c.coordinatorAgentId) throw new MissionError(403, "n6_coordinator_required", "Old coordinator cannot mutate this delegation");
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: task.issueId!, runId: input.actor.runId, agentId: input.actor.agentId });
  if (run.status !== "running" || run.finishedAt) throw new MissionError(409, "n6_work_inactive", "Current active admitted run required");
  m = task.runId ? await recordVariantWake(ctx, m, task.reservationId, input.actor.runId)
    : await recordVariantWake(ctx, m, task.reservationId, input.actor.runId, (before, aggregate, effectiveRunId) =>
      saveCoordinationTask(ctx, { ...before, aggregate }, { ...task, runId: effectiveRunId }));
  return { mission: m, task: m.aggregate.n6!.coordination!.tasks.find(t => t.taskId === task.taskId)! };
}
export async function handleN6WorkAgent(ctx: PluginContext, input: PluginApiRequestInput) {
  try {
    const body = input.body as Record<string, unknown>;
    const initial = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
    if (!initial?.aggregate.n6?.coordination) throw new MissionError(404, "n6_coordination_missing", "Coordination mandate not found");
    await assertN6Owner(ctx, initial, initial.aggregate.n6.coordination.authorizedBy);
    const { mission: m, task } = await bind(ctx, initial, input);
    if (["inspect", "n6-inspect"].includes(String(body.command))) return { status: 200, body: {
      missionId: m.missionId, version: m.version, task, dependency: m.aggregate.n6, instructions: coordinationInstructions(m, task) } };
    const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), input.actor.agentId!, canonicalPayloadHash(body));
    if (prior) { await ctx.issues.update(task.issueId!, { status: "blocked" }, m.companyId); return { status: 200, body: { outcome: "replayed", finishReport: task.report } }; }
    if (task.report) throw new MissionError(409, "n6_report_frozen", "One prepared outcome per admitted run");
    const report = coordinationReport(m, task, body); const c = m.aggregate.n6!.coordination!;
    const result = await n2CommandCas(ctx, m, body, "agent", input.actor.agentId!, { ...m.aggregate, n6: { ...m.aggregate.n6!, coordination: { ...c,
      tasks: c.tasks.map(t => t.taskId === task.taskId ? { ...task, report } : t) } }, journal: [...m.aggregate.journal,
        { action: "coordination_report_prepared", actorAgentId: input.actor.agentId, logicalAgentId: task.agentId, runId: task.runId, taskId: task.taskId, report, at: new Date().toISOString() }] });
    await ctx.issues.update(task.issueId!, { status: "blocked" }, m.companyId);
    return { status: 200, body: { ...result, finishReport: report } };
  } catch (error) {
    if (error instanceof MissionError || error instanceof AdmissionError) return { status: error.status, body: { code: error.code, error: error.message } };
    throw error;
  }
}

export async function transferCoordinator(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  const c = m.aggregate.n6?.coordination;
  if (!c || m.aggregate.n1 || c.tasks.some(t => t.kind === "coordinator" && !t.closedAt)) throw new MissionError(409, "n6_transfer_wait", "Transfer only between settled PM work items before B activation");
  const id = runtimeUuid(body.coordinatorAgentId, "coordinatorAgentId");
  if (id === c.facilitatorAgentId) throw new MissionError(422, "n6_distinct_roles", "Coordinator and facilitator remain distinct");
  await coordinationActor(ctx, m, id);
  return n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n6: { ...m.aggregate.n6!, coordination: {
    ...c, coordinatorAgentId: id, nextActor: c.nextActor === c.coordinatorAgentId ? id : c.nextActor } }, journal: [...m.aggregate.journal,
    { action: "coordinator_transferred", authorizedBy: actorId, from: c.coordinatorAgentId, to: id, reason: coordinationText(body.reason, "reason"), at: new Date().toISOString() }] });
}

export async function resolveCoordination(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  const c = m.aggregate.n6?.coordination;
  if (!c || m.aggregate.n1 || c.tasks.some(t => !t.closedAt)) throw new MissionError(409, "n6_resolution_wait", "Owner resolves only idle coordination before N1 activation");
  if (!["release", "hold"].includes(String(body.action))) throw new MissionError(422, "n6_resolution_action", "Owner chooses release or hold");
  const reason = coordinationText(body.reason, "reason");
  const result = await n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n6: { ...m.aggregate.n6!, coordination: {
    ...c, state: body.action === "release" ? "released" : "held", reason, nextActor: actorId } }, journal: [...m.aggregate.journal,
    { action: "coordination_owner_resolution", actorUserId: actorId, decision: body.action, reason, at: new Date().toISOString() }] });
  return result;
}
