import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, runtimeUuid } from "./n2-missions.js";

export type N6Priority = "low" | "medium" | "high" | "critical";
export type CoordinationReport = { schema: "n6-coordination-report-v1"; missionId: string; taskId: string;
  action: "release" | "hold" | "facilitate" | "escalate" | "resolved"; reason: string; priority?: N6Priority;
  question?: string; expectedOutcome?: string; participants?: string[]; nextActor: string };
export type CoordinationTask = { taskId: string; kind: "coordinator" | "facilitator"; agentId: string;
  issueId: string | null; creation: "pending" | "claimed" | "confirmed"; wake: "pending" | "claimed";
  runId: string | null; reservationId: string; settlementCommandId: string; report?: CoordinationReport;
  settledAt?: string; closedAt?: string; request?: Pick<CoordinationReport, "question" | "expectedOutcome" | "participants"> };
export type N6Coordination = { protocol: "delegated-coordination-v1"; coordinatorAgentId: string; facilitatorAgentId: string;
  authorizedBy: string; authorizedAt: string; mandate: string; allowedPriorities: N6Priority[]; participantAgentIds: string[];
  periodKey: string; requestedUnits: number; state: "working" | "held" | "released" | "owner_required";
  reason: string; nextActor: string; priority: N6Priority; tasks: CoordinationTask[] };

export const coordinationTask = (kind: CoordinationTask["kind"], agentId: string): CoordinationTask => ({ taskId: randomUUID(), kind, agentId,
  issueId: null, creation: "pending", wake: "pending", runId: null, reservationId: randomUUID(), settlementCommandId: randomUUID() });
export function coordinationText(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new MissionError(422, "n6_coordination_input", `${label} must be bounded nonempty text`);
  return value.trim();
}
export async function coordinationActor(ctx: PluginContext, m: MissionRecord, id: string) {
  const agent = await ctx.agents.get(id, m.companyId);
  if (!agent || agent.companyId !== m.companyId || agent.adapterType !== "codex_local" || agent.adapterConfig?.engine !== "cli"
      || ["paused", "terminated", "pending_approval"].includes(agent.status) || id === m.aggregate.responsibilities.integrationLeadAgentId) {
    throw new MissionError(422, "n6_coordination_actor", "Available same-company CLI actor distinct from the integration lead required");
  }
}
export async function coordinationMandate(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>): Promise<N6Coordination> {
  const coordinatorAgentId = runtimeUuid(body.coordinatorAgentId, "coordinatorAgentId");
  const facilitatorAgentId = runtimeUuid(body.facilitatorAgentId, "facilitatorAgentId");
  if (coordinatorAgentId === facilitatorAgentId) throw new MissionError(422, "n6_distinct_roles", "Coordinator and facilitator must be distinct");
  await coordinationActor(ctx, m, coordinatorAgentId); await coordinationActor(ctx, m, facilitatorAgentId);
  const allowed = body.allowedPriorities as N6Priority[];
  if (!Array.isArray(allowed) || !allowed.length || allowed.length > 4 || allowed.some(p => !["low", "medium", "high", "critical"].includes(p))) {
    throw new MissionError(422, "n6_priority_delegation", "Explicit allowed native priorities required");
  }
  const participants = body.participantAgentIds as string[];
  if (!Array.isArray(participants) || !participants.length || participants.length > 7) throw new MissionError(422, "n6_participants", "Name 1-7 handoff participants");
  for (const id of participants) if (!(await ctx.agents.get(runtimeUuid(id, "participant"), m.companyId))) throw new MissionError(422, "n6_participants", "Same-company participants required");
  if (!Number.isSafeInteger(body.requestedUnits) || Number(body.requestedUnits) < 1) throw new MissionError(422, "n6_coordination_budget", "Explicit per-work-item reservation required (at most two PM runs and one facilitation)");
  const root = await ctx.issues.get(m.rootIssueId, m.companyId);
  return { protocol: "delegated-coordination-v1", coordinatorAgentId, facilitatorAgentId, authorizedBy: m.ownerUserId,
    authorizedAt: new Date().toISOString(), mandate: coordinationText(body.mandate, "mandate"), allowedPriorities: [...new Set(allowed)],
    participantAgentIds: [...new Set(participants)], periodKey: m.aggregate.n6!.periodKey, requestedUnits: Number(body.requestedUnits),
    state: "working", reason: "Owner delegated the bounded handoff and downstream priority decision", nextActor: coordinatorAgentId,
    priority: (root?.priority ?? "medium") as N6Priority, tasks: [coordinationTask("coordinator", coordinatorAgentId)] };
}
export const saveCoordination = (ctx: PluginContext, m: MissionRecord, coordination: N6Coordination) =>
  n2Cas(ctx, m, { ...m.aggregate, n6: { ...m.aggregate.n6!, coordination } });
export function coordinationTaskAt(m: MissionRecord, id: string) {
  const task = m.aggregate.n6?.coordination?.tasks.find(t => t.taskId === id);
  if (!task) throw new MissionError(409, "n6_work_missing", "Persisted coordination task required");
  return task;
}
