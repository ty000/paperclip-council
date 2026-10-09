import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas } from "./n2-missions.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { assertTerminalPublicationProtocol, FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";
import { campaignClosureFingerprint } from "./campaign-closure-contract.js";
import { currentCampaignClosureSubject } from "./campaign-closure-subject.js";

type ClaimRequest = { intentId: string; payloadSha256: string };

async function readClaimSubject(ctx: PluginContext, initial: MissionRecord, request: ClaimRequest, observationSha256: string) {
  const m = await getMission(ctx, initial.companyId, initial.missionId);
  const state = m?.aggregate.linearContinuity, closure = m?.aggregate.campaignClosure;
  if (!m || !state || state.mode !== FIXED_CAMPAIGN_MODE || m.aggregate.repositoryCampaign || !closure
      || state.observation?.bodySha256 !== observationSha256
      || canonicalPayloadHash(state.observation.response.terminalClaimRequest ?? null) !== canonicalPayloadHash(request)) {
    throw new MissionError(409, "linear_terminal_claim_subject", "Only the current authenticated observation may request its exact campaign claim");
  }
  assertTerminalPublicationProtocol(state);
  assertClaimIntent(m, request);
  return { m, state, closure };
}

function assertClaimIntent(m: MissionRecord, request: ClaimRequest) {
  const state = m.aggregate.linearContinuity!, closure = m.aggregate.campaignClosure!;
  const publication = state.publications.find(p => p.intentId === request.intentId && p.payloadSha256 === request.payloadSha256);
  if (closure.publicationIntentId !== request.intentId || closure.publicationPayloadSha256 !== request.payloadSha256
      || !publication || publication.kind !== "closure" || publication.withdrawn
      || canonicalPayloadHash(publication.payload) !== publication.payloadSha256) {
    throw new MissionError(409, "linear_terminal_claim_identity", "Retain the original terminal intent and payload; withdrawn effects cannot acquire permission");
  }
}

/** Only this same-mission CAS arbitrates an operator stop against terminal effect permission. */
export async function claimTerminalPublication(ctx: PluginContext, initial: MissionRecord, request: ClaimRequest, observationSha256: string) {
  const { m, state, closure } = await readClaimSubject(ctx, initial, request, observationSha256);
  if (closure.terminalClaim) {
    if (closure.terminalClaim.intentId !== request.intentId || closure.terminalClaim.payloadSha256 !== request.payloadSha256) {
      throw new MissionError(409, "linear_terminal_claim_identity", "An existing terminal claim cannot be replaced");
    }
    return m;
  }
  if (closure.phase !== "publishing" || state.control !== "running" || state.controlReason || m.aggregate.completion
      || closure.report?.verdict !== "approved" || canonicalPayloadHash(closure.report) !== closure.reportSha256) {
    throw new MissionError(409, "linear_terminal_claim_held", "A pending exact approved closure and running campaign are required before terminal permission");
  }
  await assertProjectDeparture(ctx, m, undefined, request);
  const current = await currentCampaignClosureSubject(ctx, m);
  if (campaignClosureFingerprint(current) !== campaignClosureFingerprint(closure.subject)) {
    throw new MissionError(409, "linear_terminal_claim_stale", "The approved coverage and integrated results changed before terminal permission");
  }
  await assertClaimProof(ctx, m);
  // If a stop/hold wins during the reads, this version loses. No grant is emitted here.
  return n2Cas(ctx, m, { ...m.aggregate, campaignClosure: { ...closure, terminalClaim: {
    intentId: request.intentId, payloadSha256: request.payloadSha256, claimedVersion: m.version + 1, claimedAt: new Date().toISOString(),
  } } });
}

async function assertClaimProof(ctx: PluginContext, m: MissionRecord) {
  const closure = m.aggregate.campaignClosure!;
  const proof = await ctx.issues.documents.get(m.rootIssueId, closure.proofDocument.key, m.companyId);
  if (!proof || !closure.proofDocument.revisionId || proof.latestRevisionId !== closure.proofDocument.revisionId
      || proof.body !== closure.proofDocument.body) {
    throw new MissionError(409, "linear_terminal_claim_proof", "The original global review proof must remain exact before terminal permission");
  }
}
