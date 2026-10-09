import { z } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import { linearSourceSubjectSchema } from "./linear-intake-revalidation-contract.js";

export const LINEAR_CONTINUITY_EVENT = "plugin.ty000.linear-intake.council-continuity-result";
export const LINEAR_CONTINUITY_PROTOCOL = "council-linear-continuity-v1" as const;
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), time = z.string().datetime({ offset: true });
const documentReferenceSchema = z.object({ key: z.string().min(1).max(200), documentId: uuid, revisionId: uuid, bodySha256: hash }).strict();
export type NativeProofReference = z.infer<typeof documentReferenceSchema>;
export const continuityBindingSchema = z.object({ companyId: uuid, projectId: uuid, missionId: uuid, nativeRootId: uuid,
  campaignId: uuid, sourceRootId: uuid, authoritySha256: hash, subject: linearSourceSubjectSchema }).strict();
export type LinearContinuityBinding = z.infer<typeof continuityBindingSchema>;
const changeSchema = z.object({ commandId: uuid, sequence: z.number().int().positive(),
  kind: z.enum(["context", "pause", "resume", "cancel"]), affectedNativeIds: z.array(uuid).min(1).max(33),
  previousSourceSha256: hash, sourceSha256: hash, authoritySha256: hash,
  impact: z.enum(["context-only", "criteria", "scope", "unknown"]), context: z.string().trim().min(1).max(4000).optional(),
  evidence: documentReferenceSchema }).strict().refine(change => change.kind !== "context" || Boolean(change.context), "Context changes need an explicit bounded annotation");
export type LinearContinuityChange = z.infer<typeof changeSchema>;
const acknowledgementSchema = z.object({ intentId: uuid, payloadSha256: hash, status: z.literal("confirmed"),
  publicationReceipt: documentReferenceSchema }).strict();
export const continuityResponseSchema = z.object({ protocol: z.literal(LINEAR_CONTINUITY_PROTOCOL), binding: continuityBindingSchema,
  challengeId: uuid, nonce: hash, requestSha256: hash, observedAt: time, validUntil: time,
  capabilities: z.array(z.enum(["continuous-context", "cooperative-control", "publication-readback"])).length(3),
  sourceSha256: hash, availability: z.enum(["available", "unavailable"]),
  changes: z.array(changeSchema).max(32), acknowledgements: z.array(acknowledgementSchema).max(32) }).strict();
export type LinearContinuityResponse = z.infer<typeof continuityResponseSchema>;
export const continuityNoticeSchema = z.object({ protocol: z.literal(LINEAR_CONTINUITY_PROTOCOL), companyId: uuid,
  missionId: uuid, challengeId: uuid, response: documentReferenceSchema }).strict();
export type LinearPublication = { intentId: string; kind: "progress" | "blocker" | "question" | "decision" | "closure" | "cancellation";
  payload: Record<string, unknown>; payloadSha256: string; documentKey: string; document?: NativeProofReference;
  acknowledgement?: { reference: NativeProofReference; responseSha256: string; confirmedAt: string } };
export type LinearContinuityState = { protocol: typeof LINEAR_CONTINUITY_PROTOCOL; binding: LinearContinuityBinding;
  sourceSha256: string; sequence: number; control: "running" | "pause_requested" | "paused" | "cancel_requested" | "cancelled";
  authorizedBy: string; controlReason?: string; consumed: Array<{ commandId: string; payloadSha256: string; sequence: number;
    evidence: NativeProofReference; outcome: "applied" | "arbitration_required" }>;
  challenge?: { challengeId: string; nonce: string; requestedAt: string; expiresAt: string; payload: Record<string, unknown>;
    requestSha256: string; documentKey: string; document?: NativeProofReference; lastEmittedAt?: string };
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
