import { randomBytes, randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas } from "./n2-missions.js";
import { continuityNoticeSchema, continuityResponseSchema, LINEAR_CONTINUITY_EVENT, LINEAR_CONTINUITY_PROTOCOL,
  assertContinuityBinding, assertTerminalPublicationProtocol, pendingLinearPublication, FIXED_CAMPAIGN_MODE, responseFresh, type LinearContinuityState, type LinearPublication, type LinearContinuityResponse } from "./linear-continuity-contract.js";
import { ensureLinearDocument, readLinearProof } from "./linear-continuity-documents.js";
import { fixedExchangePlan, LINEAR_MAX_ATTEMPTS, type LinearTransportOptions } from "./linear-source-demand.js";
import { handleSourceInvalidation, readSourceInvalidation } from "./linear-source-invalidation.js";
import { SOURCE_INVALIDATION_EVENT, SOURCE_OBSERVATION_PROTOCOL, type ObservationPurpose } from "./linear-continuity-contract.js";
import { retainSourceHold } from "./linear-source-hold.js";

const LOST_NOTICE_RETRY_MS = 30_000;
type LinearChallenge = NonNullable<LinearContinuityState["challenge"]>;
type FixedTerminalProtocol = { terminalPublicationProtocol?: LinearContinuityState["terminalPublicationProtocol"]; resumeVersion?: number };

function continuityRequestChanged(challenge: LinearChallenge | undefined, state: LinearContinuityState,
  requests: unknown[], terminalProtocol: FixedTerminalProtocol) {
  if (!challenge) return false;
  return canonicalPayloadHash(challenge.payload.publications) !== canonicalPayloadHash(requests)
    || challenge.payload.control !== state.control
    || challenge.payload.terminalPublicationProtocol !== terminalProtocol.terminalPublicationProtocol
    || challenge.payload.resumeVersion !== terminalProtocol.resumeVersion
    || challenge.payload.consumedSequence !== state.sequence;
}

function newLinearChallenge(state: LinearContinuityState, requests: unknown[], terminalProtocol: FixedTerminalProtocol, now: number, purpose?: ObservationPurpose): LinearChallenge {
  const challengeId = randomUUID(), nonce = randomBytes(32).toString("hex");
  const requestedAt = new Date(now).toISOString(), expiresAt = new Date(now + 300_000).toISOString();
  const payload = { protocol: LINEAR_CONTINUITY_PROTOCOL, ...(state.mode ? { mode: state.mode } : {}), ...terminalProtocol,
    binding: state.binding, challengeId, nonce, requestedAt, expiresAt, sourceSha256: state.sourceSha256,
    ...(purpose ? { sourceObservationProtocol: SOURCE_OBSERVATION_PROTOCOL, sourceInvalidationVersion: state.sourceInvalidationVersion ?? 0, observationPurpose: purpose } : {}),
    consumedSequence: state.sequence, control: state.control, publications: requests };
  return { challengeId, nonce, requestedAt, expiresAt, payload, requestSha256: canonicalPayloadHash(payload),
    documentKey: `council-linear-request-${challengeId}` };
}

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
  for (const item of m.aggregate.linearContinuity!.publications.filter(pendingLinearPublication)) {
    const document = await ensureLinearDocument(ctx, m, item.documentKey, { intentId: item.intentId, payloadSha256: item.payloadSha256, payload: item.payload }, item.document);
    if (!item.document) m = await saveLinearContinuity(ctx, m, { ...m.aggregate.linearContinuity!, publications: m.aggregate.linearContinuity!.publications.map(p => p.intentId === item.intentId ? { ...p, document } : p) });
  }
  return m;
}
export async function reconcileLinearTransport(ctx: PluginContext, initial: MissionRecord, options: LinearTransportOptions = {}) {
  let m = (await getMission(ctx, initial.companyId, initial.missionId))!;
  if (!m.aggregate.linearContinuity) return m;
  assertContinuityBinding(m, m.aggregate.linearContinuity.binding);
  assertTerminalPublicationProtocol(m.aggregate.linearContinuity);
  m = await readSourceInvalidation(ctx, m);
  m = await finishOutbox(ctx, m);
  let state = m.aggregate.linearContinuity!, pending = state.publications.filter(pendingLinearPublication);
  const claim = m.aggregate.campaignClosure?.terminalClaim;
  const requests = pending.map(p => ({ intentId: p.intentId, payloadSha256: p.payloadSha256, document: p.document,
    ...(claim?.intentId === p.intentId && claim.payloadSha256 === p.payloadSha256 ? { terminalClaim: claim } : {}) }));
  const terminalProtocol: FixedTerminalProtocol = state.mode === FIXED_CAMPAIGN_MODE ? {
    terminalPublicationProtocol: state.terminalPublicationProtocol, resumeVersion: state.resumeVersion ?? 0,
  } : {};
  let challenge = state.challenge;
  const now = Date.now();
  const requestChanged = continuityRequestChanged(challenge, state, requests, terminalProtocol);
  if (state.mode === FIXED_CAMPAIGN_MODE) {
    const priorRequests = challenge?.payload.publications as Array<{ intentId: string; terminalClaim?: unknown }> | undefined;
    const terminalGrantChanged = Boolean(claim && requests.some(p => p.terminalClaim
      && canonicalPayloadHash(priorRequests?.find(prior => prior.intentId === p.intentId)?.terminalClaim ?? null) !== canonicalPayloadHash(p.terminalClaim)));
    const plan = fixedExchangePlan(state, pending, options, now, terminalGrantChanged);
    if (plan.hold) return saveLinearContinuity(ctx, m, { ...state, transportHold: {
      code: plan.hold, challengeId: challenge?.challengeId ?? "", at: new Date(now).toISOString(),
    } });
    if (!plan.purpose && !plan.repeat) return m;
    if (plan.purpose === "recovery") {
      state = { ...state, transportHold: undefined, publications: state.publications.map(p => pendingLinearPublication(p)
        ? { ...p, reconciliationLimit: (p.reconciliationAttempts ?? 0) + LINEAR_MAX_ATTEMPTS } : p) };
    }
    if (plan.purpose) {
      challenge = newLinearChallenge(state, requests, terminalProtocol, now, plan.purpose);
      m = await saveLinearContinuity(ctx, m, { ...state, challenge });
    }
  } else if (!challenge || requestChanged || Date.parse(challenge.expiresAt) <= now) {
    challenge = newLinearChallenge(state, requests, terminalProtocol, now);
    m = await saveLinearContinuity(ctx, m, { ...state, challenge });
  }
  if (!challenge) return m;
  const document = await ensureLinearDocument(ctx, m, challenge.documentKey, challenge.payload, challenge.document);
  if (!challenge.document) { challenge = { ...challenge, document }; m = await saveLinearContinuity(ctx, m, { ...m.aggregate.linearContinuity!, challenge }); }
  if (!challenge.lastEmittedAt || now - Date.parse(challenge.lastEmittedAt) >= LOST_NOTICE_RETRY_MS) {
    // Persist before emit. A lost hint is repeated with the same nonce/document/intent by the existing job.
    challenge = { ...challenge, lastEmittedAt: new Date().toISOString(), attempts: (challenge.attempts ?? 0) + 1 };
    const current = m.aggregate.linearContinuity!;
    const sent = new Set((challenge.payload.publications as Array<{ intentId: string }>).map(p => p.intentId));
    const publications = current.mode === FIXED_CAMPAIGN_MODE ? current.publications.map(p => sent.has(p.intentId)
      ? { ...p, reconciliationAttempts: (p.reconciliationAttempts ?? 0) + 1 } : p) : current.publications;
    m = await saveLinearContinuity(ctx, m, { ...current, challenge, publications });
    await ctx.events.emit("linear-continuity-request", m.companyId, { protocol: LINEAR_CONTINUITY_PROTOCOL,
      companyId: m.companyId, missionId: m.missionId, nativeRootId: m.rootIssueId,
      challengeId: challenge.challengeId, requestSha256: challenge.requestSha256, request: document });
  }
  return m;
}
function assertPublicationAcknowledgement(m: MissionRecord, publication: LinearPublication) {
  if (publication.withdrawn) throw new MissionError(409, "linear_publication_withdrawn", "A withdrawn intent cannot acknowledge successful effects");
  const claim = m.aggregate.campaignClosure?.terminalClaim;
  if (m.aggregate.linearContinuity!.mode === FIXED_CAMPAIGN_MODE && publication.kind === "closure"
      && (!claim || claim.intentId !== publication.intentId || claim.payloadSha256 !== publication.payloadSha256)) {
    throw new MissionError(409, "linear_terminal_claim_missing", "A terminal readback must retain its original Council effect claim");
  }
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
    assertPublicationAcknowledgement(m, publications[index]!);
    const prior = publications[index]!.acknowledgement;
    if (prior && canonicalPayloadHash(prior.reference) !== canonicalPayloadHash(ack.publicationReceipt)) throw new MissionError(409, "linear_publication_receipt_changed", "Original confirmed receipt cannot be replaced");
    publications[index] = { ...publications[index]!, acknowledgement: prior ?? { reference: ack.publicationReceipt, responseSha256: canonicalPayloadHash(response), confirmedAt: response.observedAt } };
  }
  return publications;
}
function matchingSourceNegotiation(state: LinearContinuityState, challenge: LinearChallenge, response: LinearContinuityResponse) {
  if (state.mode !== FIXED_CAMPAIGN_MODE) return true;
  return response.sourceObservationProtocol === SOURCE_OBSERVATION_PROTOCOL
    && response.sourceInvalidationVersion === challenge.payload.sourceInvalidationVersion
    && response.observationPurpose === challenge.payload.observationPurpose;
}
function matchingResponse(state: LinearContinuityState, challenge: LinearChallenge, response: LinearContinuityResponse) {
  return matchingSourceNegotiation(state, challenge, response) && response.mode === state.mode
    && response.nonce === challenge.nonce && response.challengeId === challenge.challengeId
    && response.requestSha256 === challenge.requestSha256
    && canonicalPayloadHash(response.binding) === canonicalPayloadHash(state.binding);
}
function responseTimingAllowed(response: LinearContinuityResponse, challenge: LinearChallenge, event: PluginEvent) {
  const observed = Date.parse(response.observedAt), occurred = Date.parse(event.occurredAt);
  return responseFresh(response) && observed >= Date.parse(challenge.requestedAt) && observed < Date.parse(challenge.expiresAt)
    && Number.isFinite(occurred) && occurred >= observed && occurred <= Date.now() + 5000;
}
export async function handleLinearContinuityNotice(ctx: PluginContext, event: PluginEvent) {
  if (event.eventType !== LINEAR_CONTINUITY_EVENT || event.actorType !== "plugin" || event.actorId !== "ty000.linear-intake") return;
  const parsed = continuityNoticeSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.companyId !== event.companyId) return;
  const notice = parsed.data;
  const m = await getMission(ctx, event.companyId, notice.missionId), state = m?.aggregate.linearContinuity, challenge = state?.challenge;
  if (!m || !state || !challenge?.document || challenge.challengeId !== notice.challengeId) return;
  assertTerminalPublicationProtocol(state);
  const doc = await readLinearProof(ctx, m, notice.response);
  if (Buffer.byteLength(doc.body) > 128_000) throw new MissionError(409, "linear_response_bound", "Response exceeds bounded native exchange");
  const response = continuityResponseSchema.parse(JSON.parse(doc.body));
  if (response.diagnostic && response.diagnostic.expectedSourceSha256 !== state.sourceSha256) return;
  if (!matchingResponse(state, challenge, response) || !responseTimingAllowed(response, challenge, event)) return;
  await readLinearProof(ctx, m, challenge.document); assertContinuityBinding(m, state.binding);
  const bodySha256 = canonicalPayloadHash(doc.body);
  if (state.observation?.bodySha256 === bodySha256) {
    await requestTerminalClaim(ctx, m, response, bodySha256);
    return;
  }
  if (state.observation && Date.parse(state.observation.response.observedAt) > Date.parse(response.observedAt)) return;
  const publications = await validatePublicationReceipts(ctx, m, response);
  const readback = response.observationPurpose === "readback";
  const observed = await saveLinearContinuity(ctx, m, { ...(readback ? state : retainSourceHold(state, response)), publications,
    challenge: { ...challenge, answeredAt: response.observedAt },
    ...(!readback ? { observation: { reference: notice.response, response, bodySha256 } } : {}) });
  await requestTerminalClaim(ctx, observed, response, bodySha256);
}
async function requestTerminalClaim(ctx: PluginContext, m: MissionRecord, response: import("./linear-continuity-contract.js").LinearContinuityResponse, bodySha256: string) {
  if (!response.terminalClaimRequest) return;
  const { claimTerminalPublication } = await import("./linear-terminal-publication.js");
  await claimTerminalPublication(ctx, m, response.terminalClaimRequest, bodySha256);
}
export function registerLinearContinuity(ctx: PluginContext) {
  ctx.events.on(LINEAR_CONTINUITY_EVENT, event => handleLinearContinuityNotice(ctx, event));
  ctx.events.on(SOURCE_INVALIDATION_EVENT, event => handleSourceInvalidation(ctx, event));
}
