import { z, type PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { MissionError, canonicalPayloadHash } from "./mission-primitives.js";
import { operatingProfileHash, projectTable, readProjectMandate } from "./project-mandate-state.js";
import { linearSourceRequestSchema, linearSourceResultSchema, linearSourceSubjectSchema, validSourceResultTime,
  type LinearSourceRequest, type LinearSourceResult } from "./linear-intake-revalidation-contract.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.strictObject({ challengeId: z.uuid(), stage: z.literal("admission"), observedAt: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }), requestSha256: digest });
const stateSchema = z.object({ linearIntake: z.object({ snapshot: z.object({ subject: linearSourceSubjectSchema, bodySha256: digest }),
  admissionReceipt: receiptSchema }), commands: z.object({ activate: z.record(z.string(), z.unknown()) }) });
type ChallengeRow = { company_id: string; mission_id: string; stage: string; challenge_id: string; subject_hash: string;
  request_hash: string; request: unknown; response_hash: string | null; response: unknown; consumed_at: string | Date | null };
function requireAdmission(condition: unknown): asserts condition {
  if (!condition) throw new MissionError(409, "linear_source_pending", "A fresh consumed source attestation and the original persisted activation payload are required; retain the same mission and reservation");
}
function same(actual: unknown, expected: unknown) { requireAdmission(canonicalPayloadHash(actual) === canonicalPayloadHash(expected)); }
async function currentPolicy(ctx: PluginContext, m: MissionRecord) {
  const pinned = m.aggregate.projectMandate!, policy = await readProjectMandate(ctx, m.companyId, m.projectId);
  requireAdmission(policy?.content.enabled && policy.revisionId === pinned.revisionId);
  same([policy.authorizedBy, (await ctx.companies.get(m.companyId))?.defaultResponsibleUserId], [m.ownerUserId, m.ownerUserId]);
  same(operatingProfileHash(await ctx.config.get(m.companyId)), pinned.operatingProfileHash);
  return policy;
}
async function retainedState(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>) {
  const pinned = m.aggregate.projectMandate!;
  const rows = await ctx.db.query<{ state: unknown }>(`SELECT state FROM ${projectTable(ctx, "project_task_intakes")}
    WHERE company_id = $1 AND mission_id = $2 AND root_issue_id = $3 AND project_id = $4 AND policy_revision_id = $5`,
    [m.companyId, m.missionId, m.rootIssueId, m.projectId, pinned.revisionId]);
  requireAdmission(rows.length === 1);
  const parsed = stateSchema.safeParse(rows[0]!.state);
  requireAdmission(parsed.success);
  const state = parsed.data;
  same(state.linearIntake.snapshot, pinned.linearIntake);
  same(state.commands.activate, body);
  return state;
}
async function challengeRow(ctx: PluginContext, m: MissionRecord, challengeId: string) {
  // projectTable validates the native plugin namespace; no other plugin's tables are read.
  const challenges = projectTable(ctx, "project_task_intakes").replace(/project_task_intakes$/, "linear_intake_challenges");
  const rows = await ctx.db.query<ChallengeRow>(`SELECT company_id, mission_id, stage, challenge_id, subject_hash,
    request_hash, request, response_hash, response, consumed_at FROM ${challenges}
    WHERE company_id = $1 AND mission_id = $2 AND stage = 'admission' AND challenge_id = $3`, [m.companyId, m.missionId, challengeId]);
  requireAdmission(rows.length === 1); return rows[0]!;
}
function verifyChallenge(row: ChallengeRow, m: MissionRecord, subjectHash: string, request: LinearSourceRequest, result: LinearSourceResult) {
  requireAdmission(row.consumed_at !== null);
  same([row.company_id, row.mission_id, row.stage, row.challenge_id], [m.companyId, m.missionId, "admission", request.challengeId]);
  same(row.subject_hash, subjectHash);
  same(row.request_hash, canonicalPayloadHash(request));
  same(result.request, request); same(result.requestSha256, row.request_hash);
  same(row.response_hash, canonicalPayloadHash(result));
  requireAdmission(result.status === "confirmed" && result.reason === "handoff_confirmed");
}
function verifyFresh(row: ChallengeRow, receipt: z.infer<typeof receiptSchema>, result: LinearSourceResult) {
  same(receipt, { challengeId: row.challenge_id, stage: result.request.stage, observedAt: result.observedAt,
    validUntil: result.validUntil, requestSha256: row.request_hash });
  const consumedAt = new Date(row.consumed_at!).getTime(), now = Date.now();
  requireAdmission(Number.isFinite(consumedAt) && consumedAt >= Date.parse(result.observedAt));
  requireAdmission(consumedAt <= now && consumedAt < Date.parse(result.validUntil));
  requireAdmission(validSourceResultTime(result, now));
}

/** Read-only boundary guard. N1 never issues or renews a challenge and never replaces an activation command. */
export async function assertLinearAdmissionFresh(ctx: PluginContext, m: MissionRecord, activationBody: Record<string, unknown>) {
  const pinned = m.aggregate.projectMandate?.linearIntake;
  if (!pinned) return;
  const policy = await currentPolicy(ctx, m), state = await retainedState(ctx, m, activationBody);
  const row = await challengeRow(ctx, m, state.linearIntake.admissionReceipt.challengeId);
  const request = linearSourceRequestSchema.safeParse(row.request), result = linearSourceResultSchema.safeParse(row.response);
  requireAdmission(request.success && result.success);
  const subject = linearSourceSubjectSchema.parse(pinned.subject), mandateRevisionSha256 = canonicalPayloadHash(policy.content);
  same(request.data, { ...subject, schema: "linear-intake-revalidation-request.v1", challengeId: row.challenge_id, nonce: request.data.nonce,
    stage: "admission", admissionId: m.missionId, mandateId: policy.revisionId, mandateRevisionSha256,
    requestedAt: request.data.requestedAt, expiresAt: request.data.expiresAt });
  const subjectHash = canonicalPayloadHash({ subject, mandateId: policy.revisionId, mandateRevisionSha256 });
  verifyChallenge(row, m, subjectHash, request.data, result.data);
  verifyFresh(row, state.linearIntake.admissionReceipt, result.data);
}
