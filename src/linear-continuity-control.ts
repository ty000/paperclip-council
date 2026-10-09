import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { nativeRunBindings } from "./native-run-bindings.js";
import { assertNativeRunInventory } from "./native-runs.js";
import { nativeN2Profile } from "./n2-missions.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { FIXED_CAMPAIGN_MODE, assertTerminalPublicationProtocol, pendingLinearPublication, assertContinuityBinding, linearAuthorityHash, responseFresh, type LinearContinuityChange } from "./linear-continuity-contract.js";
import { linearPublicationState, saveLinearContinuity } from "./linear-continuity-transport.js";
import { readLinearProof } from "./linear-continuity-documents.js";
import { appliedContextAnnotations } from "./linear-context-guidance.js";
import { sourceHoldMessage } from "./linear-source-hold.js";

const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
function originalSettlement(m: MissionRecord, reservationId: string) {
  const state = m.aggregate.n1 as import("./n1-missions.js").N1State | undefined;
  const tasks = [...(m.aggregate.n2?.ordinary?.tasks ?? []), ...(m.aggregate.n6?.coordination?.tasks ?? []),
    ...(state?.integration ? [state.integration] : []), ...(m.aggregate.n5?.publication ? [m.aggregate.n5.publication] : []),
    ...(m.aggregate.n5?.integration?.previousPublication ? [m.aggregate.n5.integration.previousPublication] : []),
    ...(m.aggregate.campaignClosure ? [m.aggregate.campaignClosure.task] : [])];
  return tasks.find(task => task.reservationId === reservationId)?.settlementCommandId;
}
/** Cooperative safe point: read admitted runs and settle original costs, never interrupt or wake. */
export async function settleLinearSafePoint(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; await assertNativeRunInventory(ctx, m);
  const bindings = [...new Map(nativeRunBindings(m).map(binding => [binding.reservationId, binding])).values()];
  for (const binding of bindings) {
    const { envelope, profile } = await nativeN2Profile(ctx, m);
    const reservation = envelope.reservations.find(r => r.missionId === m.missionId && r.reservationId === binding.reservationId);
    if (!reservation) continue; // Prepared but not admitted actors cannot contribute exposure.
    if (binding.pending || !binding.runId) return { mission: m, safe: false };
    const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: binding.issueId, runId: binding.runId, agentId: binding.agentId });
    if (!terminal.has(run.status)) return { mission: m, safe: false };
    if (reservation.status === "settled") continue;
    const state = m.aggregate.linearContinuity!;
    let commandId = originalSettlement(m, binding.reservationId) ?? state.safeSettlementIds[binding.reservationId];
    if (!commandId) {
      commandId = randomUUID();
      m = await saveLinearContinuity(ctx, m, { ...state, safeSettlementIds: { ...state.safeSettlementIds, [binding.reservationId]: commandId } });
    }
    await settleOrdinaryRunUsage(ctx, { companyId: m.companyId, issueId: binding.issueId, runId: binding.runId,
      agentId: binding.agentId, commandId, reservationId: binding.reservationId, periodKey: profile.periodKey, expectedVersion: envelope.version });
  }
  const { envelope } = await nativeN2Profile(ctx, m);
  const reservations = envelope.reservations.filter(r => r.missionId === m.missionId);
  let safe = reservations.every(r => r.status === "settled" && r.usage?.status === "known" && r.remainingExposure.status === "known" && r.remainingExposure.units === 0);
  if (safe && m.aggregate.linearContinuity?.mode === FIXED_CAMPAIGN_MODE) {
    const { campaignMembersSafe } = await import("./repository-campaign.js");
    safe = await campaignMembersSafe(ctx, m);
  }
  return { mission: m, safe };
}
export function uncertainLinearEffects(m: MissionRecord) {
  const p = m.aggregate.n5?.publication ?? {} as Partial<NonNullable<NonNullable<MissionRecord["aggregate"]["n5"]>["publication"]>>;
  const i = m.aggregate.n5?.integration ?? {} as Partial<NonNullable<NonNullable<MissionRecord["aggregate"]["n5"]>["integration"]>>;
  const flags = [p.creation === "claimed" && !p.issueId, p.wake === "claimed" && !p.runId,
    p.claimedAt && !p.observation && p.operation !== "integrate", i.mergeClaimedAt && !i.report,
    i.state === "unknown", m.aggregate.completion?.notification.state === "claimed"];
  return flags.some(Boolean);
}
async function resumePrerequisites(ctx: PluginContext, m: MissionRecord) {
  const state = m.aggregate.linearContinuity!;
  if (state.control !== "paused" || !state.observation || !responseFresh(state.observation.response)
      || state.observation.response.availability !== "available" || uncertainLinearEffects(m)
      || state.publications.some(p => ["question", "decision"].includes(p.kind) && !p.acknowledgement)) {
    throw new MissionError(409, "linear_resume_pending", "Explicit resume needs fresh source/authority, acknowledged arbitration and reconciled effects");
  }
  assertContinuityBinding(m, state.binding);
  const { mission, safe } = await settleLinearSafePoint(ctx, m);
  if (!safe) throw new MissionError(409, "linear_resume_run_pending", "Every original admitted run and cost must reach a known safe point before resume");
  return mission;
}
function affectedNativeIds(m: MissionRecord) {
  return new Set([m.rootIssueId, ...(m.aggregate.hierarchy?.nodes ?? []).map(node => node.issueId)]);
}
function assertArbitrationResolved(m: MissionRecord, kind: LinearContinuityChange["kind"]) {
  const state = m.aggregate.linearContinuity!;
  if (["pause", "cancel"].includes(kind)) return;
  const unresolved = state.consumed.filter(command => command.outcome === "arbitration_required").some(command =>
    !state.publications.some(publication => publication.kind === "decision"
      && publication.payload.resolvesCommandId === command.commandId && publication.payload.authorizedBy === m.ownerUserId
      && Boolean(publication.acknowledgement)));
  if (unresolved) throw new MissionError(409, "linear_arbitration_pending", "Every held command needs a linked owner decision published and read back before dependent continuation");
}
export async function applyLinearChanges(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; const response = m.aggregate.linearContinuity?.observation?.response;
  if (!response || !responseFresh(response)) return m;
  if (m.aggregate.linearContinuity!.mode === FIXED_CAMPAIGN_MODE) {
    const diagnostic = m.aggregate.linearContinuity!.controlDiagnostic;
    if (diagnostic) {
      const linearContinuity = linearPublicationState(m, "blocker", { reason: sourceHoldMessage(diagnostic), diagnostic });
      return linearContinuity === m.aggregate.linearContinuity ? m : saveLinearContinuity(ctx, m, linearContinuity);
    }
    return holdChangedCampaign(ctx, m, response.sourceSha256);
  }
  for (const change of response.changes) m = await applyOneChange(ctx, m, change);
  const state = m.aggregate.linearContinuity!;
  if (response.sourceSha256 !== state.sourceSha256) return saveLinearContinuity(ctx, m, { ...state, controlReason: "source_revision_unreconciled" });
  return m;
}
async function holdChangedCampaign(ctx: PluginContext, m: MissionRecord, sourceSha256: string) {
  const state = m.aggregate.linearContinuity!;
  if (sourceSha256 === state.sourceSha256 || ["cancel_requested", "cancelled"].includes(state.control)) return m;
  if (state.controlReason === "source_revision_changed") return m;
  const next = { ...state, control: state.control === "paused" ? "paused" as const : "pause_requested" as const, controlReason: "source_revision_changed" };
  const subject = { ...m, aggregate: { ...m.aggregate, linearContinuity: next } };
  return saveLinearContinuity(ctx, m, linearPublicationState(subject, "blocker", { reason: "source_revision_changed", expectedSourceSha256: state.sourceSha256, observedSourceSha256: sourceSha256 }));
}
function retainedControlReason(state: NonNullable<MissionRecord["aggregate"]["linearContinuity"]>, kind: LinearContinuityChange["kind"]) {
  return ["pause", "cancel"].includes(kind) ? state.controlReason : undefined;
}
async function applyOneChange(ctx: PluginContext, m: MissionRecord, change: LinearContinuityChange) {
  let state = m.aggregate.linearContinuity!;
  const payloadSha256 = canonicalPayloadHash(change), prior = state.consumed.find(item => item.commandId === change.commandId);
  if (prior) {
    if (prior.payloadSha256 !== payloadSha256) throw new MissionError(409, "linear_command_identity", "Original command ID cannot carry another payload");
    return m;
  }
  if (state.consumed.length >= 100 || change.sequence !== state.sequence + 1 || change.previousSourceSha256 !== state.sourceSha256) {
    throw new MissionError(409, "linear_command_order", "Retain complete ordered changes; no skipped command, history truncation or reset");
  }
  const doc = await readLinearProof(ctx, m, change.evidence), ids = affectedNativeIds(m);
  const evidence = JSON.parse(doc.body) as Record<string, unknown>;
  const { evidence: _reference, ...content } = change;
  if (canonicalPayloadHash(evidence.command) !== canonicalPayloadHash(content)) throw new MissionError(409, "linear_command_evidence", "Native decision document must bind the command identity");
  const authorized = change.authoritySha256 === linearAuthorityHash(m) && change.impact === "context-only"
    && change.affectedNativeIds.every(id => ids.has(id)) && new Set(change.affectedNativeIds).size === change.affectedNativeIds.length;
  if (!authorized) {
    const next = { ...state, controlReason: "arbitration_required", sequence: change.sequence,
      consumed: [...state.consumed, { commandId: change.commandId, sequence: change.sequence, payloadSha256, evidence: change.evidence, outcome: "arbitration_required" as const }] };
    const subject = { ...m, aggregate: { ...m.aggregate, linearContinuity: next } };
    return saveLinearContinuity(ctx, m, linearPublicationState(subject, "question", { commandId: change.commandId, reason: "Change exceeds known delegated authority; retain original candidate and mandate", evidence: change.evidence }));
  }
  if (["cancel_requested", "cancelled"].includes(state.control)) throw new MissionError(409, "linear_cancellation_final", "Cancellation cannot silently resume the original campaign");
  assertArbitrationResolved(m, change.kind);
  if (change.kind === "resume") m = await resumePrerequisites(ctx, m);
  state = m.aggregate.linearContinuity!;
  const controls = { context: state.control, pause: "pause_requested", resume: "running", cancel: "cancel_requested" } as const;
  const next = { ...state, sourceSha256: change.sourceSha256, sequence: change.sequence,
    control: controls[change.kind], controlReason: retainedControlReason(state, change.kind),
    contextAnnotations: appliedContextAnnotations(state, change),
    consumed: [...state.consumed, { commandId: change.commandId, sequence: change.sequence, payloadSha256, evidence: change.evidence, outcome: "applied" as const }] };
  const subject = { ...m, aggregate: { ...m.aggregate, linearContinuity: next } };
  return saveLinearContinuity(ctx, m, linearPublicationState(subject, "decision", { commandId: change.commandId, kindOfDecision: change.kind,
    affectedNativeIds: change.affectedNativeIds, evidence: change.evidence, consequence: controls[change.kind] }));
}
/** Read current durable state at each wake/merge/closure, rather than trusting a stale actor snapshot. */
export async function assertLinearContinuityDeparture(ctx: PluginContext, initial: MissionRecord, cancellationReservationId?: string,
  terminalIntent?: { intentId: string; payloadSha256: string }) {
  if (!initial.aggregate.linearContinuity) return;
  const m = await getMission(ctx, initial.companyId, initial.missionId), state = m?.aggregate.linearContinuity;
  if (!m || !state) throw new MissionError(409, "linear_continuity_missing", "Original continuity binding cannot disappear");
  assertContinuityBinding(m, state.binding);
  assertTerminalPublicationProtocol(state);
  const controlPublisher = state.mode !== FIXED_CAMPAIGN_MODE && cancellationReservationId && state.control === "cancel_requested"
    && m.aggregate.n5?.publication?.operation === "cancel-pr" && m.aggregate.n5.publication.reservationId === cancellationReservationId;
  for (const command of state.consumed) await readLinearProof(ctx, m, command.evidence);
  if (controlPublisher) return; // Only the specifically reserved cancellation actor may close the obsolete PR.
  if (state.control !== "running" || state.controlReason || !state.observation || !responseFresh(state.observation.response)
      || state.observation.response.availability !== "available" || state.observation.response.sourceSha256 !== state.sourceSha256
      || state.publications.some(p => pendingLinearPublication(p) && !pendingTerminalClaim(m, p, terminalIntent))) throw new MissionError(409, "linear_continuity_hold", "Fresh compatible source, running control and Linear publication readbacks are required for new departures, merges and closure");
  await readLinearProof(ctx, m, state.observation.reference);
  for (const publication of state.publications) if (publication.acknowledgement) await readLinearProof(ctx, m, publication.acknowledgement.reference);
}

function pendingTerminalClaim(m: MissionRecord, publication: import("./linear-continuity-contract.js").LinearPublication,
  intent?: { intentId: string; payloadSha256: string }) {
  const closure = m.aggregate.campaignClosure;
  return Boolean(intent && m.aggregate.linearContinuity?.mode === FIXED_CAMPAIGN_MODE && !m.aggregate.repositoryCampaign
    && closure?.phase === "publishing" && !closure.terminalClaim && !publication.withdrawn && publication.kind === "closure"
    && intent.intentId === closure.publicationIntentId && intent.payloadSha256 === closure.publicationPayloadSha256
    && intent.intentId === publication.intentId && intent.payloadSha256 === publication.payloadSha256);
}
