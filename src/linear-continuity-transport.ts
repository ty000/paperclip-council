import { randomBytes, randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas } from "./n2-missions.js";
import { continuityNoticeSchema, continuityResponseSchema, LINEAR_CONTINUITY_EVENT, LINEAR_CONTINUITY_PROTOCOL,
  assertContinuityBinding, responseFresh, type LinearContinuityState, type LinearPublication } from "./linear-continuity-contract.js";
import { ensureLinearDocument, readLinearProof } from "./linear-continuity-documents.js";

export async function saveLinearContinuity(ctx: PluginContext, m: MissionRecord, state: LinearContinuityState) {
  return n2Cas(ctx, m, { ...m.aggregate, linearContinuity: state });
}
export function linearPublicationState(m: MissionRecord, kind: LinearPublication["kind"], content: Record<string, unknown>) {
  const state = m.aggregate.linearContinuity!;
  const payload = { protocol: LINEAR_CONTINUITY_PROTOCOL, ...(state.mode ? { mode: state.mode } : {}), binding: state.binding, sourceSha256: state.sourceSha256, kind, ...content };
  const payloadSha256 = canonicalPayloadHash(payload);
  if (state.publications.some(item => item.payloadSha256 === payloadSha256)) return state;
  if (state.publications.length >= 64) throw new MissionError(409, "linear_publication_bound", "Retain the bounded original outbox; no truncation or reset");
  const intentId = randomUUID();
  return { ...state, publications: [...state.publications,
    { intentId, kind, payload, payloadSha256, documentKey: `council-linear-publication-${intentId}` }] };
}
export async function queueLinearPublication(ctx: PluginContext, m: MissionRecord, kind: LinearPublication["kind"], content: Record<string, unknown>) {
  const state = linearPublicationState(m, kind, content);
  return state === m.aggregate.linearContinuity ? m : saveLinearContinuity(ctx, m, state);
}
async function finishOutbox(ctx: PluginContext, m: MissionRecord) {
  for (const item of m.aggregate.linearContinuity!.publications.filter(item => !item.acknowledgement)) {
    const document = await ensureLinearDocument(ctx, m, item.documentKey, { intentId: item.intentId, payloadSha256: item.payloadSha256, payload: item.payload }, item.document);
    if (!item.document) m = await saveLinearContinuity(ctx, m, { ...m.aggregate.linearContinuity!, publications: m.aggregate.linearContinuity!.publications.map(p => p.intentId === item.intentId ? { ...p, document } : p) });
  }
  return m;
}
export async function reconcileLinearTransport(ctx: PluginContext, initial: MissionRecord) {
  let m = (await getMission(ctx, initial.companyId, initial.missionId))!;
  if (!m.aggregate.linearContinuity) return m;
  assertContinuityBinding(m, m.aggregate.linearContinuity.binding);
  m = await finishOutbox(ctx, m);
  const state = m.aggregate.linearContinuity!, pending = state.publications.filter(p => !p.acknowledgement);
  const requests = pending.map(p => ({ intentId: p.intentId, payloadSha256: p.payloadSha256, document: p.document }));
  let challenge = state.challenge;
  // Expiry or a changed outbox permits a fresh observation nonce, never a new publication intent.
  if (!challenge || Date.parse(challenge.expiresAt) <= Date.now() || canonicalPayloadHash(challenge.payload.publications) !== canonicalPayloadHash(requests)) {
    const challengeId = randomUUID(), nonce = randomBytes(32).toString("hex"), requestedAtMs = Date.now();
    const requestedAt = new Date(requestedAtMs).toISOString(), expiresAt = new Date(requestedAtMs + 300_000).toISOString();
    const payload = { protocol: LINEAR_CONTINUITY_PROTOCOL, ...(state.mode ? { mode: state.mode } : {}), binding: state.binding, challengeId, nonce, requestedAt, expiresAt,
      sourceSha256: state.sourceSha256, consumedSequence: state.sequence, control: state.control, publications: requests };
    challenge = { challengeId, nonce, requestedAt, expiresAt, payload, requestSha256: canonicalPayloadHash(payload), documentKey: `council-linear-request-${challengeId}` };
    m = await saveLinearContinuity(ctx, m, { ...state, challenge });
  }
  const document = await ensureLinearDocument(ctx, m, challenge.documentKey, challenge.payload, challenge.document);
  if (!challenge.document) { challenge = { ...challenge, document }; m = await saveLinearContinuity(ctx, m, { ...m.aggregate.linearContinuity!, challenge }); }
  if (!challenge.lastEmittedAt || Date.now() - Date.parse(challenge.lastEmittedAt) >= 30_000) {
    // Persist before emit. A lost hint is repeated with the same nonce/document/intent by the existing job.
    challenge = { ...challenge, lastEmittedAt: new Date().toISOString() };
    m = await saveLinearContinuity(ctx, m, { ...m.aggregate.linearContinuity!, challenge });
    await ctx.events.emit("linear-continuity-request", m.companyId, { protocol: LINEAR_CONTINUITY_PROTOCOL,
      companyId: m.companyId, missionId: m.missionId, nativeRootId: m.rootIssueId,
      challengeId: challenge.challengeId, requestSha256: challenge.requestSha256, request: document });
  }
  return m;
}
async function validatePublicationReceipts(ctx: PluginContext, m: MissionRecord, response: ReturnType<typeof continuityResponseSchema.parse>) {
  const state = m.aggregate.linearContinuity!, publications = [...state.publications];
  for (const ack of response.acknowledgements) {
    const index = publications.findIndex(p => p.intentId === ack.intentId && p.payloadSha256 === ack.payloadSha256);
    if (index < 0) throw new MissionError(409, "linear_publication_identity", "Only an original outbox intent may be confirmed");
    const doc = await readLinearProof(ctx, m, ack.publicationReceipt);
    const receipt = JSON.parse(doc.body) as Record<string, unknown>;
    const expected = { protocol: "linear-publication-readback-v1", intentId: ack.intentId, payloadSha256: ack.payloadSha256,
      bindingSha256: canonicalPayloadHash(state.binding), sourceSha256: publications[index]!.payload.sourceSha256 };
    if (Object.entries(expected).some(([key, value]) => receipt[key] !== value) || receipt.status !== "confirmed"
        || !Array.isArray(receipt.effects) || !receipt.effects.length || receipt.effects.length > 64
        || receipt.effects.some(e => !e || typeof e !== "object" || typeof e.sourceId !== "string" || !e.sourceId || !/^[a-f0-9]{64}$/.test(e.readbackSha256))) {
      throw new MissionError(409, "linear_publication_readback", "Authenticated importer must supply bounded per-effect Linear readback evidence");
    }
    const prior = publications[index]!.acknowledgement;
    if (prior && canonicalPayloadHash(prior.reference) !== canonicalPayloadHash(ack.publicationReceipt)) throw new MissionError(409, "linear_publication_receipt_changed", "Original confirmed receipt cannot be replaced");
    publications[index] = { ...publications[index]!, acknowledgement: prior ?? { reference: ack.publicationReceipt, responseSha256: canonicalPayloadHash(response), confirmedAt: response.observedAt } };
  }
  return publications;
}
export async function handleLinearContinuityNotice(ctx: PluginContext, event: PluginEvent) {
  if (event.eventType !== LINEAR_CONTINUITY_EVENT || event.actorType !== "plugin" || event.actorId !== "ty000.linear-intake") return;
  const parsed = continuityNoticeSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.companyId !== event.companyId) return;
  const notice = parsed.data;
  const m = await getMission(ctx, event.companyId, notice.missionId), state = m?.aggregate.linearContinuity, challenge = state?.challenge;
  if (!m || !state || !challenge?.document || challenge.challengeId !== notice.challengeId) return;
  const doc = await readLinearProof(ctx, m, notice.response);
  if (Buffer.byteLength(doc.body) > 128_000) throw new MissionError(409, "linear_response_bound", "Response exceeds bounded native exchange");
  const response = continuityResponseSchema.parse(JSON.parse(doc.body));
  if (!responseFresh(response) || response.mode !== state.mode || response.nonce !== challenge.nonce
      || response.challengeId !== challenge.challengeId || response.requestSha256 !== challenge.requestSha256
      || canonicalPayloadHash(response.binding) !== canonicalPayloadHash(state.binding)
      || Date.parse(response.observedAt) < Date.parse(challenge.requestedAt) || Date.parse(response.observedAt) >= Date.parse(challenge.expiresAt)
      || !Number.isFinite(Date.parse(event.occurredAt)) || Date.parse(event.occurredAt) < Date.parse(response.observedAt) || Date.parse(event.occurredAt) > Date.now() + 5000) return;
  await readLinearProof(ctx, m, challenge.document); assertContinuityBinding(m, state.binding);
  const bodySha256 = canonicalPayloadHash(doc.body);
  if (state.observation?.bodySha256 === bodySha256) return;
  if (state.observation && Date.parse(state.observation.response.observedAt) > Date.parse(response.observedAt)) return;
  const publications = await validatePublicationReceipts(ctx, m, response);
  await saveLinearContinuity(ctx, m, { ...state, publications, observation: { reference: notice.response, response, bodySha256 } });
}
export function registerLinearContinuity(ctx: PluginContext) {
  ctx.events.on(LINEAR_CONTINUITY_EVENT, event => handleLinearContinuityNotice(ctx, event));
}
