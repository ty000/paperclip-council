import { randomBytes, randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { operatingProfileHash, readProjectMandate, type ProjectMandate } from "./project-mandate-state.js";
import {
  LINEAR_RESULT_EVENT, linearSourceRequestSchema, linearSourceResultSchema,
  linearSourceSubjectSchema, validSourceResultTime,
  type LinearSourceSubject, type LinearSourceRequest, type LinearSourceResult, type LinearRevalidationReceipt,
} from "./linear-intake-revalidation-contract.js";

type Challenge = {
  challenge_id: string; generation: number; subject_hash: string; request_hash: string;
  request: LinearSourceRequest; response: LinearSourceResult | null; response_hash: string | null;
  consumed_at: string | null;
};
function table(ctx: PluginContext) {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe Council namespace");
  return `"${ctx.db.namespace}".linear_intake_challenges`;
}
function waiting(code = "linear_source_pending"): never {
  throw new MissionError(409, code, "A fresh authenticated Linear source observation is required; retain the original intake and mission.");
}
async function currentAuthority(ctx: PluginContext, policy: ProjectMandate) {
  const current = await readProjectMandate(ctx, policy.companyId, policy.projectId);
  const company = await ctx.companies.get(policy.companyId);
  if (!policy.content.enabled || !current?.content.enabled || current.revisionId !== policy.revisionId
      || canonicalPayloadHash(current.content) !== canonicalPayloadHash(policy.content)
      || current.authorizedBy !== policy.authorizedBy || company?.defaultResponsibleUserId !== policy.authorizedBy
      || policy.content.operatingProfileHash !== operatingProfileHash(await ctx.config.get(policy.companyId))) {
    waiting("linear_source_authority_changed");
  }
}
async function latest(ctx: PluginContext, companyId: string, missionId: string, stage: string) {
  const rows = await ctx.db.query<Challenge>(`SELECT * FROM ${table(ctx)}
    WHERE company_id = $1 AND mission_id = $2 AND stage = $3 ORDER BY generation DESC LIMIT 1`, [companyId, missionId, stage]);
  return rows[0];
}
async function createChallenge(ctx: PluginContext, policy: ProjectMandate, admissionId: string,
  subject: LinearSourceSubject, stage: "preparation" | "admission", subjectHash: string, generation: number) {
  if (generation > 128) waiting("linear_source_observation_bound");
  const now = Date.now();
  const request = linearSourceRequestSchema.parse({ ...subject, schema: "linear-intake-revalidation-request.v1",
    challengeId: randomUUID(), nonce: randomBytes(32).toString("hex"), stage, admissionId,
    mandateId: policy.revisionId, mandateRevisionSha256: canonicalPayloadHash(policy.content),
    requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() });
  await ctx.db.execute(`INSERT INTO ${table(ctx)}
    (challenge_id, company_id, mission_id, stage, generation, subject_hash, request_hash, request)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT DO NOTHING`,
    [request.challengeId, subject.companyId, admissionId, stage, generation, subjectHash, canonicalPayloadHash(request), JSON.stringify(request)]);
  return (await latest(ctx, subject.companyId, admissionId, stage))!;
}
async function emitPending(ctx: PluginContext, row: Challenge) {
  const changed = await ctx.db.execute(`UPDATE ${table(ctx)} SET last_emitted_at = now()
    WHERE challenge_id = $1 AND consumed_at IS NULL AND response IS NULL
      AND (last_emitted_at IS NULL OR last_emitted_at < now() - interval '30 seconds')`, [row.challenge_id]);
  if (changed.rowCount === 1) await ctx.events.emit("linear-intake-revalidation-request", row.request.companyId, row.request);
}
async function consume(ctx: PluginContext, policy: ProjectMandate, row: Challenge): Promise<LinearRevalidationReceipt> {
  const result = linearSourceResultSchema.parse(row.response);
  if (result.status !== "confirmed") waiting("linear_source_blocked");
  if (!validSourceResultTime(result, Date.now())) waiting();
  await currentAuthority(ctx, policy);
  const changed = await ctx.db.execute(`UPDATE ${table(ctx)} SET consumed_at = now()
    WHERE challenge_id = $1 AND consumed_at IS NULL AND response_hash = $2 AND $3::timestamptz > now()`,
    [row.challenge_id, row.response_hash, result.validUntil]);
  if (changed.rowCount !== 1) waiting();
  return { challengeId: row.challenge_id, stage: result.request.stage, observedAt: result.observedAt,
    validUntil: result.validUntil, requestSha256: row.request_hash };
}

/** Existing continuity job drives requests; events only persist observations. */
export async function assertLinearSource(ctx: PluginContext, policy: ProjectMandate, admissionId: string,
  input: LinearSourceSubject, stage: "preparation" | "admission"): Promise<LinearRevalidationReceipt> {
  const subject = linearSourceSubjectSchema.parse(input);
  if (subject.companyId !== policy.companyId || subject.targetProjectId !== policy.projectId) waiting("linear_source_scope_changed");
  await currentAuthority(ctx, policy);
  const subjectHash = canonicalPayloadHash({ subject, mandateId: policy.revisionId, mandateRevisionSha256: canonicalPayloadHash(policy.content) });
  let row = await latest(ctx, subject.companyId, admissionId, stage);
  if (row && row.subject_hash !== subjectHash) waiting("linear_source_subject_changed");
  if (row && !row.consumed_at && row.response && validSourceResultTime(row.response, Date.now())) return consume(ctx, policy, row);
  const expired = row && Date.parse(row.response?.validUntil ?? row.request.expiresAt) <= Date.now();
  if (!row || row.consumed_at || expired) {
    row = await createChallenge(ctx, policy, admissionId, subject, stage, subjectHash, (row?.generation ?? 0) + 1);
  }
  if (row.subject_hash !== subjectHash) waiting("linear_source_subject_changed");
  await emitPending(ctx, row);
  waiting();
}

/** Only the host-authenticated importer can answer an already persisted nonce. */
export async function handleLinearSourceResult(ctx: PluginContext, event: PluginEvent) {
  if (event.eventType !== LINEAR_RESULT_EVENT || event.actorType !== "plugin" || event.actorId !== "ty000.linear-intake") return;
  if (!event.payload || typeof event.payload !== "object" || Buffer.byteLength(JSON.stringify(event.payload)) > 8192) return;
  const parsed = linearSourceResultSchema.safeParse(event.payload);
  if (!parsed.success) return;
  const result = parsed.data, now = Date.now(), eventTime = Date.parse(event.occurredAt);
  if (result.request.companyId !== event.companyId || !validSourceResultTime(result, now)
      || (result.status === "confirmed") !== (result.reason === "handoff_confirmed")
      || !Number.isFinite(eventTime) || eventTime < Date.parse(result.observedAt) || eventTime > now
      || canonicalPayloadHash(result.request) !== result.requestSha256) return;
  const rows = await ctx.db.query<Challenge>(`SELECT * FROM ${table(ctx)} WHERE company_id = $1 AND challenge_id = $2`,
    [event.companyId, result.request.challengeId]);
  const row = rows[0];
  if (!row || row.consumed_at || row.request_hash !== result.requestSha256
      || canonicalPayloadHash(row.request) !== result.requestSha256) return;
  await ctx.db.execute(`UPDATE ${table(ctx)} SET response = $1::jsonb, response_hash = $2, observed_at = $3::timestamptz
    WHERE company_id = $4 AND challenge_id = $5 AND consumed_at IS NULL
      AND (observed_at IS NULL OR observed_at < $3::timestamptz
        OR (observed_at = $3::timestamptz AND $6 = 'blocked'))`,
    [JSON.stringify(result), canonicalPayloadHash(result), result.observedAt, event.companyId, result.request.challengeId, result.status]);
}
export function registerLinearSourceResults(ctx: PluginContext) {
  ctx.events.on(LINEAR_RESULT_EVENT, event => handleLinearSourceResult(ctx, event));
}
