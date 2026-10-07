import { z } from "@paperclipai/plugin-sdk";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
export const LINEAR_RESULT_EVENT = "plugin.ty000.linear-intake.linear-intake-revalidation-result";
export const linearSourceSubjectSchema = z.strictObject({
  companyId: z.uuid(), intakeId: z.string().regex(/^linear-intake-[a-f0-9]{64}$/), activationId: z.uuid(), configurationFingerprint: digest,
  requestVersion: z.number().int().positive().max(2_147_483_647), nativeRootId: z.uuid(), targetProjectId: z.uuid(),
  readinessDocumentId: z.uuid(), readinessRevisionId: z.uuid(), readinessSha256: digest,
  sourceSha256: digest, planSha256: digest,
});
export const linearSourceRequestSchema = linearSourceSubjectSchema.extend({
  schema: z.literal("linear-intake-revalidation-request.v1"), challengeId: z.uuid(), nonce: digest,
  stage: z.enum(["preparation", "admission"]), admissionId: z.uuid(), mandateId: z.uuid(),
  mandateRevisionSha256: digest, requestedAt: instant, expiresAt: instant,
});
export const linearSourceResultSchema = z.strictObject({
  schema: z.literal("linear-intake-revalidation-result.v1"), request: linearSourceRequestSchema,
  requestSha256: digest, status: z.enum(["confirmed", "blocked"]),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), observedAt: instant, validUntil: instant,
});
export type LinearSourceSubject = z.infer<typeof linearSourceSubjectSchema>;
export type LinearSourceRequest = z.infer<typeof linearSourceRequestSchema>;
export type LinearSourceResult = z.infer<typeof linearSourceResultSchema>;
export type LinearRevalidationReceipt = {
  challengeId: string; stage: "preparation" | "admission"; observedAt: string;
  validUntil: string; requestSha256: string;
};

export function validSourceResultTime(result: LinearSourceResult, now: number) {
  const requested = Date.parse(result.request.requestedAt), expires = Date.parse(result.request.expiresAt);
  const observed = Date.parse(result.observedAt), validUntil = Date.parse(result.validUntil);
  return requested <= observed && observed < expires && expires - requested <= 300_000
    && observed <= now && now < validUntil && validUntil > observed && validUntil - observed <= 120_000;
}
