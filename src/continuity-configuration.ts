import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import { normalizeN3Slots, type N3OpinionSlot } from "./n3-opinions.js";

type ContinuityCommands = Pick<typeof import("./n2-missions.js"), "n2CommandCas" | "runtimeReceipt" | "runtimeUuid">;

function requireSuspendedPolicy(m: MissionRecord, actorId: string) {
  const policy = m.aggregate.continuity;
  if (!policy || policy.enabled || !m.aggregate.n1 || m.aggregate.control.status !== "active"
      || m.aggregate.completion?.state === "closed" || m.ownerUserId !== actorId
      || policy.authorizedBy !== actorId || policy.mandateHash !== canonicalPayloadHash(m.aggregate.mandate)) {
    throw new MissionError(409, "continuity_resume_unavailable", "Resume requires the suspended active mission and unchanged owner and mandate");
  }
  return policy;
}

function resumeReason(body: Record<string, unknown>) {
  if (body.authorizeProgression !== true || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000) {
    throw new MissionError(403, "continuity_authorization_required", "Explicit owner authorization and a reason are required for a new departure window");
  }
  return body.reason.trim();
}

function resumeDeadline(m: MissionRecord, body: Record<string, unknown>, previousDeadline: string, now: number) {
  const deadline = typeof body.deadline === "string" ? Date.parse(body.deadline) : NaN;
  if (!Number.isFinite(deadline) || deadline <= now || deadline <= Date.parse(previousDeadline)
      || deadline > now + m.aggregate.mandate.limits.elapsedMinutes * 60_000) {
    throw new MissionError(422, "continuity_deadline_invalid", "Use an explicit later deadline within one mandate-length window from now");
  }
  return new Date(deadline).toISOString();
}

async function resumeContinuity(ctx: PluginContext, m: MissionRecord, actorId: string,
  body: Record<string, unknown>, commands: ContinuityCommands) {
  const policy = requireSuspendedPolicy(m, actorId);
  const reason = resumeReason(body);
  const now = Date.now();
  const deadline = resumeDeadline(m, body, policy.deadline, now);
  const extension = { commandId: commands.runtimeUuid(body.commandId, "commandId"), previousDeadline: policy.deadline,
    deadline, authorizedBy: actorId, authorizedAt: new Date(now).toISOString(), reason };
  return commands.n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate,
    continuity: { ...policy, enabled: true, deadline: extension.deadline, extensions: [...(policy.extensions ?? []), extension] },
    journal: [...m.aggregate.journal, { action: "owner_extended_continuity_window", ...extension }] });
}

export async function configureContinuity(ctx: PluginContext, m: MissionRecord, actorId: string, body: Record<string, unknown>, commands: ContinuityCommands) {
  const { n2CommandCas, runtimeReceipt, runtimeUuid } = commands;
  const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), actorId, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission: m, receipt: prior };
  if (body.command === "resume-continuity") return resumeContinuity(ctx, m, actorId, body, commands);
  if (body.command === "suspend-continuity") {
    if (!m.aggregate.continuity) throw new MissionError(409, "continuity_unconfigured", "No delegated continuity policy exists");
    return n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate,
      continuity: { ...m.aggregate.continuity, enabled: false } });
  }
  if (m.aggregate.continuity || m.aggregate.phase !== "draft" || m.aggregate.n1
      || m.aggregate.nativeWakePolicy?.protocol !== "council-native-wake-v2") {
    throw new MissionError(409, "continuity_configuration_frozen", "Configure once on a new inactive ordinary v2 mission before activation");
  }
  if (body.authorizeProgression !== true) throw new MissionError(403, "continuity_authorization_required", "Owner must explicitly delegate the nominal transitions within the existing mandate");
  let slots: N3OpinionSlot[];
  try {
    slots = normalizeN3Slots(body.n3Slots as N3OpinionSlot[], m.aggregate.compositions.team.members.map(member => member.agentId),
      m.aggregate.responsibilities.finalReviewerAgentId);
  } catch (error) {
    throw new MissionError(422, "continuity_slots_invalid", error instanceof Error ? error.message : "Invalid independent specialist selection");
  }
  for (const id of [...slots.map(slot => slot.specialistAgentId), m.aggregate.responsibilities.finalReviewerAgentId]) {
    const agent = await ctx.agents.get(id, m.companyId);
    if (!agent || agent.adapterType !== "codex_local" || agent.adapterConfig?.engine !== "cli"
        || ["paused", "terminated", "pending_approval"].includes(agent.status)) {
      throw new MissionError(422, "continuity_actor_unavailable", "Selected independent CLI actors must be available in this company");
    }
  }
  const now = Date.now();
  return n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate,
    continuity: { protocol: "council-continuity-v1", enabled: true, authorizedBy: actorId,
      authorizedAt: new Date(now).toISOString(), deadline: new Date(now + m.aggregate.mandate.limits.elapsedMinutes * 60_000).toISOString(),
      mandateHash: canonicalPayloadHash(m.aggregate.mandate), n3Slots: slots, commands: {} },
    journal: [...m.aggregate.journal, { action: "owner_delegated_nominal_progression", actorUserId: actorId,
      delegationId: randomUUID(), at: new Date(now).toISOString() }] });
}
