import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import { normalizeN3Slots, type N3OpinionSlot } from "./n3-opinions.js";

type ContinuityCommands = Pick<typeof import("./n2-missions.js"), "n2CommandCas" | "runtimeReceipt" | "runtimeUuid">;

export async function configureContinuity(ctx: PluginContext, m: MissionRecord, actorId: string, body: Record<string, unknown>, commands: ContinuityCommands) {
  const { n2CommandCas, runtimeReceipt, runtimeUuid } = commands;
  const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), actorId, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission: m, receipt: prior };
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
