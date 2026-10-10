import { z } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import { linearSourceSubjectSchema } from "./linear-intake-revalidation-contract.js";

export const LINEAR_CONTINUITY_EVENT = "plugin.ty000.linear-intake.council-continuity-result";
export const SOURCE_OBSERVATION_PROTOCOL = "council-linear-source-observation-v1" as const;
export const SOURCE_INVALIDATION_PROTOCOL = "council-linear-source-invalidation-v1" as const;
export const SOURCE_INVALIDATION_KEY = "linear-source-invalidation";
export const SOURCE_INVALIDATION_EVENT = "plugin.ty000.linear-intake.council-source-invalidated";
const observationPurposeSchema = z.enum(["action", "event", "publication", "recovery", "readback"]);
export type ObservationPurpose = z.infer<typeof observationPurposeSchema>;
export const LINEAR_CONTINUITY_PROTOCOL = "council-linear-continuity-v1" as const;
export const FIXED_CAMPAIGN_MODE = "milestone-fixed-v1" as const;
export const TERMINAL_PUBLICATION_PROTOCOL = "council-terminal-publication-claim-v1" as const;
export type LinearContinuityPolicy = { protocol: typeof LINEAR_CONTINUITY_PROTOCOL; mode?: typeof FIXED_CAMPAIGN_MODE };
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), time = z.string().datetime({ offset: true });
const documentReferenceSchema = z.object({ key: z.string().min(1).max(200), documentId: uuid, revisionId: uuid, bodySha256: hash }).strict();
export type NativeProofReference = z.infer<typeof documentReferenceSchema>;
export const continuityBindingSchema = z.object({ companyId: uuid, projectId: uuid, missionId: uuid, nativeRootId: uuid,
  campaignId: uuid, sourceRootId: uuid, authoritySha256: hash, subject: linearSourceSubjectSchema }).strict();
export type LinearContinuityBinding = z.infer<typeof continuityBindingSchema>;
export const sourceInvalidationSchema = z.object({ protocol: z.literal(SOURCE_INVALIDATION_PROTOCOL), binding: continuityBindingSchema,
  sourceSha256: hash, generation: z.number().int().positive(), sourceIds: z.array(uuid).max(33),
  changedFields: z.array(z.enum(["membership", "hierarchy", "title", "description", "dependencies", "milestone", "references", "status", "archive"])).max(9) }).strict();
export const sourceInvalidationNoticeSchema = z.object({ protocol: z.literal(SOURCE_INVALIDATION_PROTOCOL), companyId: uuid,
  missionId: uuid, nativeRootId: uuid, bindingSha256: hash, generation: z.number().int().positive(), invalidation: documentReferenceSchema }).strict();
const changeSchema = z.object({ commandId: uuid, sequence: z.number().int().positive(),
  kind: z.enum(["context", "pause", "resume", "cancel"]), affectedNativeIds: z.array(uuid).min(1).max(33),
  previousSourceSha256: hash, sourceSha256: hash, authoritySha256: hash,
  impact: z.enum(["context-only", "criteria", "scope", "unknown"]), context: z.string().trim().min(1).max(4000).optional(),
  evidence: documentReferenceSchema }).strict().refine(change => change.kind !== "context" || Boolean(change.context), "Context changes need an explicit bounded annotation");
export type LinearContinuityChange = z.infer<typeof changeSchema>;
const acknowledgementSchema = z.object({ intentId: uuid, payloadSha256: hash, status: z.literal("confirmed"),
  publicationReceipt: documentReferenceSchema }).strict();
const sourceDiagnosticSchema = z.object({
  code: z.enum(["source_changed", "source_state_changed", "source_unavailable", "publication_unavailable"]),
  expectedSourceSha256: hash, observedSourceSha256: hash.optional(), changedSourceIds: z.array(uuid).max(33),
  changedFields: z.array(z.enum(["membership", "hierarchy", "title", "description", "dependencies", "milestone", "references", "status", "archive"])).max(9),
}).strict();
export type SourceDiagnostic = z.infer<typeof sourceDiagnosticSchema>;
export type TerminalPublicationClaim = { intentId: string; payloadSha256: string; claimedVersion: number; claimedAt: string };
export const continuityResponseSchema = z.object({ protocol: z.literal(LINEAR_CONTINUITY_PROTOCOL), binding: continuityBindingSchema,
  mode: z.literal(FIXED_CAMPAIGN_MODE).optional(),
  challengeId: uuid, nonce: hash, requestSha256: hash, observedAt: time, validUntil: time,
  sourceObservationProtocol: z.literal(SOURCE_OBSERVATION_PROTOCOL).optional(),
  sourceInvalidationVersion: z.number().int().nonnegative().optional(), observationPurpose: observationPurposeSchema.optional(),
  capabilities: z.array(z.enum(["continuous-context", "cooperative-control", "publication-readback", "fixed-source", "terminal-publication-claim", "event-driven-source"])).min(2).max(4),
  sourceSha256: hash, availability: z.enum(["available", "unavailable"]),
  diagnostic: sourceDiagnosticSchema.optional(),
  terminalClaimRequest: z.object({ intentId: uuid, payloadSha256: hash }).strict().optional(),
  changes: z.array(changeSchema).max(32), acknowledgements: z.array(acknowledgementSchema).max(32) }).strict().refine(response => {
    const expected = response.mode === FIXED_CAMPAIGN_MODE ? ["fixed-source", "publication-readback", "terminal-publication-claim"]
      : ["continuous-context", "cooperative-control", "publication-readback"];
    if (response.sourceObservationProtocol) expected.push("event-driven-source");
    return (response.sourceObservationProtocol ? response.sourceInvalidationVersion !== undefined && response.observationPurpose !== undefined
      : response.sourceInvalidationVersion === undefined && response.observationPurpose === undefined)
      && (!response.sourceObservationProtocol || response.mode === FIXED_CAMPAIGN_MODE)
      && response.capabilities.length === expected.length && expected.every(c => response.capabilities.includes(c as typeof response.capabilities[number]))
      && (response.mode !== FIXED_CAMPAIGN_MODE || response.changes.length === 0)
      && (!response.diagnostic || response.mode === FIXED_CAMPAIGN_MODE)
      && (!response.terminalClaimRequest || response.mode === FIXED_CAMPAIGN_MODE && response.availability === "available");
  }, "The fixed campaign mode accepts no remote commands and requires its exact capabilities");
export type LinearContinuityResponse = z.infer<typeof continuityResponseSchema>;
export const continuityNoticeSchema = z.object({ protocol: z.literal(LINEAR_CONTINUITY_PROTOCOL), companyId: uuid,
  missionId: uuid, challengeId: uuid, response: documentReferenceSchema }).strict();
export type LinearPublication = { intentId: string; kind: "progress" | "blocker" | "question" | "decision" | "closure" | "cancellation";
  payload: Record<string, unknown>; payloadSha256: string; documentKey: string; document?: NativeProofReference;
  reconciliationAttempts?: number; reconciliationLimit?: number;
  withdrawn?: { commandId: string; reason: "cancelled_before_terminal_claim" };
  acknowledgement?: { reference: NativeProofReference; responseSha256: string; confirmedAt: string } };
export type LinearContinuityState = { protocol: typeof LINEAR_CONTINUITY_PROTOCOL; binding: LinearContinuityBinding;
  mode?: typeof FIXED_CAMPAIGN_MODE;
  terminalPublicationProtocol?: typeof TERMINAL_PUBLICATION_PROTOCOL;
  resumeVersion?: number;
  sourceInvalidationVersion?: number;
  transportHold?: { code: "linear_source_retry_exhausted" | "linear_publication_retry_exhausted"; challengeId: string; at: string };
  sourceSha256: string; sequence: number; control: "running" | "pause_requested" | "paused" | "cancel_requested" | "cancelled";
  authorizedBy: string; controlReason?: string; controlDiagnostic?: SourceDiagnostic; consumed: Array<{ commandId: string; payloadSha256: string; sequence: number;
    evidence: NativeProofReference; outcome: "applied" | "arbitration_required" }>;
  challenge?: { challengeId: string; nonce: string; requestedAt: string; expiresAt: string; payload: Record<string, unknown>;
    requestSha256: string; documentKey: string; document?: NativeProofReference; lastEmittedAt?: string; attempts?: number; answeredAt?: string };
  observation?: { reference: NativeProofReference; response: LinearContinuityResponse; bodySha256: string };
  publications: LinearPublication[]; safeSettlementIds: Record<string, string>;
  contextAnnotations?: Array<{ commandId: string; sequence: number; affectedNativeIds: string[]; context: string; evidence: NativeProofReference }>;
  cancelledNodes?: Array<{ issueId: string; state: "claimed" | "confirmed" }>;
  cancellation?: { previousPublication: NonNullable<NonNullable<MissionRecord["aggregate"]["n5"]>["publication"]>;
    claimCommandId?: string; claimedAt?: string; state: "pending" | "unknown" | "closed"; report?: Record<string, unknown> } };

export function linearAuthorityHash(m: MissionRecord) {
  return canonicalPayloadHash({ mandate: m.aggregate.mandate, projectMandate: m.aggregate.projectMandate,
    responsibilities: m.aggregate.responsibilities, compositions: m.aggregate.compositions });
}
export function assertContinuityBinding(m: MissionRecord, b: LinearContinuityBinding) {
  const expected = { companyId: m.companyId, projectId: m.projectId, missionId: m.missionId, nativeRootId: m.rootIssueId,
    authoritySha256: linearAuthorityHash(m) };
  if (Object.entries(expected).some(([key, value]) => b[key as keyof LinearContinuityBinding] !== value)
      || canonicalPayloadHash(b.subject) !== canonicalPayloadHash(m.aggregate.projectMandate?.linearIntake?.subject)) {
    throw new MissionError(409, "linear_continuity_binding", "Exact imported subject and existing Council authority are required");
  }
}
export function responseFresh(response: LinearContinuityResponse, now = Date.now()) {
  const observed = Date.parse(response.observedAt), until = Date.parse(response.validUntil);
  return Number.isFinite(observed) && observed <= now && now < until && until - observed > 0 && until - observed <= 120_000;
}

/** A withdrawn unclaimed terminal intent is retained history, never a successful readback. */
export function pendingLinearPublication(publication: LinearPublication) {
  return !publication.acknowledgement && !publication.withdrawn;
}

export function assertTerminalPublicationProtocol(state: LinearContinuityState) {
  if (state.mode === FIXED_CAMPAIGN_MODE && state.terminalPublicationProtocol !== TERMINAL_PUBLICATION_PROTOCOL) {
    throw new MissionError(409, "linear_terminal_protocol_missing", "Existing fixed campaigns without terminal claim negotiation remain held; no automatic adoption");
  }
}

/** Expiry invalidates an action proof; it never creates work by itself. */
export function fixedSourceFresh(state: LinearContinuityState, now = Date.now()) {
  const response = state.observation?.response;
  return Boolean(response && responseFresh(response, now) && response.sourceObservationProtocol === SOURCE_OBSERVATION_PROTOCOL
    && response.observationPurpose !== "readback" && response.sourceInvalidationVersion === (state.sourceInvalidationVersion ?? 0));
}
