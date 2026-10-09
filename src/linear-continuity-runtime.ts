import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { continuityBindingSchema, assertContinuityBinding, LINEAR_CONTINUITY_PROTOCOL, responseFresh } from "./linear-continuity-contract.js";
import { parseLinearReadiness, LINEAR_READINESS_KEY } from "./linear-intake-contract.js";
import { applyLinearChanges, settleLinearSafePoint } from "./linear-continuity-control.js";
import { reconcileLinearTransport, queueLinearPublication, saveLinearContinuity, linearPublicationState } from "./linear-continuity-transport.js";
import { campaignControlCommands, controlFixedCampaign } from "./linear-campaign-control.js";
import { reconcileRepositoryRelease } from "./repository-release.js";

async function configure(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, owner: string) {
  if (m.aggregate.linearContinuity || m.aggregate.phase !== "draft" || m.aggregate.n1 || !m.aggregate.projectMandate?.linearIntake) throw new MissionError(409, "linear_continuity_opt_in", "Enable once for a natively imported mission with the existing continuity job; history is not upgraded automatically");
  const binding = continuityBindingSchema.parse(body.binding); assertContinuityBinding(m, binding);
  const doc = await ctx.issues.documents.get(binding.subject.nativeRootId, LINEAR_READINESS_KEY, m.companyId);
  if (!doc || doc.id !== binding.subject.readinessDocumentId || doc.latestRevisionId !== binding.subject.readinessRevisionId
      || parseLinearReadiness(doc.body).sourceRootId !== binding.sourceRootId) throw new MissionError(409, "linear_continuity_original_source", "Original native import source identity must remain exact");
  return n2CommandCas(ctx, m, body, "user", owner, { ...m.aggregate, linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL,
    binding, authorizedBy: owner, sourceSha256: binding.subject.sourceSha256, sequence: 0, control: "running", consumed: [], publications: [], safeSettlementIds: {} } });
}
export async function handleLinearContinuityBoard(ctx: PluginContext, input: PluginApiRequestInput) {
  const body = input.body as Record<string, unknown>, m = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
  if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
  const owner = input.actor.userId, company = await ctx.companies.get(m.companyId);
  if (input.actor.actorType !== "user" || !owner || owner !== m.ownerUserId || company?.defaultResponsibleUserId !== owner) throw new MissionError(403, "linear_continuity_owner", "Current company/mission owner required");
  if (body.command === "reconcile-linear-continuity") return { status: 200, body: { outcome: "reconciled", mission: await reconcileLinearContinuity(ctx, m) } };
  const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), owner, canonicalPayloadHash(body));
  if (prior) return { status: 200, body: { outcome: "replayed", mission: m, receipt: prior, effectPermission: "none" } };
  if (campaignControlCommands.includes(String(body.command))) return { status: 200, body: await controlFixedCampaign(ctx, m, body, owner) };
  if (body.command === "configure-linear-continuity") return { status: 200, body: await configure(ctx, m, body, owner) };
  if (!m.aggregate.linearContinuity || !["question", "decision"].includes(String(body.kind)) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000) throw new MissionError(422, "linear_arbitration_input", "Existing continuity and bounded owner question/decision text required");
  const resolvesCommandId = body.resolvesCommandId === undefined ? undefined : runtimeUuid(body.resolvesCommandId, "resolvesCommandId");
  if (resolvesCommandId && !m.aggregate.linearContinuity.consumed.some(command => command.commandId === resolvesCommandId && command.outcome === "arbitration_required")) throw new MissionError(422, "linear_arbitration_subject", "Link only an original held command");
  const linearContinuity = linearPublicationState(m, body.kind as "question" | "decision", { commandId: body.commandId, text: body.text, authorizedBy: owner, ...(resolvesCommandId ? { resolvesCommandId } : {}) });
  return { status: 200, body: await n2CommandCas(ctx, m, body, "user", owner, { ...m.aggregate, linearContinuity }) };
}
/** Transport and control are reconciled by the existing job, never by another campaign scheduler. */
export async function reconcileLinearContinuity(ctx: PluginContext, initial: MissionRecord) {
  let m = await reconcileLinearTransport(ctx, initial);
  if (!m.aggregate.linearContinuity) return m;
  m = await applyLinearChanges(ctx, m);
  const state = m.aggregate.linearContinuity!;
  if (!state.observation || !responseFresh(state.observation.response) || state.observation.response.availability !== "available") {
    m = (await settleLinearSafePoint(ctx, m)).mission;
  }
  if (["pause_requested", "cancel_requested"].includes(state.control)) {
    const point = await settleLinearSafePoint(ctx, m); m = point.mission;
    if (point.safe && state.control === "pause_requested") m = await saveLinearContinuity(ctx, m, { ...m.aggregate.linearContinuity!, control: "paused" });
    if (point.safe && state.control === "cancel_requested") {
      const { reconcileLinearCancellation } = await import("./linear-continuity-cancellation.js");
      m = await reconcileLinearCancellation(ctx, m);
    }
  }
  const completion = m.aggregate.completion;
  if (completion?.state === "closed") m = await queueLinearPublication(ctx, m, "closure", { workResultAcquired: true,
    proofId: completion.proofId, documentKey: completion.documentKey, revisionId: completion.documentRevisionId, result: m.aggregate.projectMandate?.completion?.result });
  else m = await queueLinearPublication(ctx, m, "progress", { phase: m.aggregate.phase, control: m.aggregate.linearContinuity!.control,
    sourceRevision: m.aggregate.linearContinuity!.sourceSha256, workResultAcquired: false, n5State: m.aggregate.n5?.integration?.state ?? null });
  m = await reconcileLinearTransport(ctx, m);
  await reconcileRepositoryRelease(ctx, m);
  return m;
}
