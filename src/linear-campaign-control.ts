import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError, type MissionRecord } from "./missions.js";
import { n2CommandCas } from "./n2-missions.js";
import { FIXED_CAMPAIGN_MODE, assertContinuityBinding, responseFresh } from "./linear-continuity-contract.js";
import { settleLinearSafePoint, uncertainLinearEffects } from "./linear-continuity-control.js";
import { readLinearProof } from "./linear-continuity-documents.js";
import { linearPublicationState } from "./linear-continuity-transport.js";

export const campaignControlCommands = ["pause-linear-campaign", "resume-linear-campaign", "cancel-linear-campaign"];

async function resumeCampaign(ctx: PluginContext, m: MissionRecord) {
  const state = m.aggregate.linearContinuity!, observation = state.observation;
  if (state.control !== "paused" || !observation || !responseFresh(observation.response)
      || observation.response.availability !== "available" || observation.response.sourceSha256 !== state.sourceSha256
      || uncertainLinearEffects(m)) {
    throw new MissionError(409, "linear_campaign_resume_pending", "Restore the fixed source and reconcile original native effects before explicit resume");
  }
  assertContinuityBinding(m, state.binding);
  await readLinearProof(ctx, m, observation.reference);
  for (const p of state.publications) if (p.acknowledgement) await readLinearProof(ctx, m, p.acknowledgement.reference);
  // Resume lets the publisher reconcile the same retained intent. Every work,
  // merge and closure boundary still requires all publication acknowledgements.
  const point = await settleLinearSafePoint(ctx, m);
  if (!point.safe) throw new MissionError(409, "linear_campaign_run_pending", "Original admitted runs and costs must reach a safe point");
  return point.mission;
}

/** Called only after the native route has authenticated the current company/mission owner. */
export async function controlFixedCampaign(ctx: PluginContext, initial: MissionRecord, body: Record<string, unknown>, owner: string) {
  let m = initial;
  const state = m.aggregate.linearContinuity;
  if (state?.mode !== FIXED_CAMPAIGN_MODE || !campaignControlCommands.includes(String(body.command))) {
    throw new MissionError(422, "linear_campaign_control", "Native campaign commands require the explicit fixed-source mode");
  }
  if (m.aggregate.completion?.state === "closed" || ["cancel_requested", "cancelled"].includes(state.control)) {
    throw new MissionError(409, "linear_campaign_terminal", "A completed or cancelling campaign cannot resume or change its result");
  }
  if (["publishing", "closing"].includes(m.aggregate.campaignClosure?.phase ?? "")) {
    throw new MissionError(409, "linear_campaign_terminal_claimed", "The terminal campaign publication is already claimed; reconcile its original readback before any competing control result");
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000) {
    throw new MissionError(422, "linear_campaign_reason", "An explicit bounded operator reason is required");
  }
  const command = String(body.command);
  if (command === "resume-linear-campaign") m = await resumeCampaign(ctx, m);
  const control = command === "cancel-linear-campaign" ? "cancel_requested"
    : command === "resume-linear-campaign" ? "running" : state.control === "paused" ? "paused" : "pause_requested";
  const next = { ...m.aggregate.linearContinuity!, control, controlReason: command === "resume-linear-campaign" ? undefined : state.controlReason } as const;
  const subject = { ...m, aggregate: { ...m.aggregate, linearContinuity: next } };
  const linearContinuity = linearPublicationState(subject, "decision", { commandId: body.commandId, command,
    reason: body.reason.trim(), authorizedBy: owner, consequence: control });
  // Phase, admission, original source and consumed budget are retained by the same mission CAS.
  return n2CommandCas(ctx, m, body, "user", owner, { ...m.aggregate, linearContinuity });
}
