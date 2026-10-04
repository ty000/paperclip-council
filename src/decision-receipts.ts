import { readOrdinaryRun } from "./g4-native.js";
import { canonicalPayloadHash } from "./missions.js";
import type { OrdinaryReport } from "./n2-ordinary-state.js";
import { createHash, randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import type { CouncilConfig, CouncilDecisionInput, CouncilVerdict } from "./contracts.js";
import { buildCouncilDecisionRequest, emitCouncilDecision } from "./decision-adapter.js";

export type DecisionReceiptState = "indeterminate" | "native_observed";
export type DecisionHumanAction = "acknowledge" | "abandon";

export type DecisionHumanDisposition = {
  action: DecisionHumanAction;
  userId: string;
  note: string | null;
  at: string;
};

export type DecisionNativeObservation = {
  status: number;
  body: unknown;
  observedAt: string;
  usable: boolean;
};

export type DecisionReceipt = {
  companyId: string;
  issueId: string;
  operationId: string;
  verdict: CouncilVerdict;
  state: DecisionReceiptState;
  blockReason: string | null;
  targetUrl: string;
  requestBody: Record<string, unknown>;
  actorAgentId: string;
  runId: string;
  claimedAt: string;
  updatedAt: string;
  nativeObservation: DecisionNativeObservation | null;
  humanDecisions: DecisionHumanDisposition[];
};

type ReceiptRow = {
  company_id: string;
  issue_id: string;
  operation_id: string;
  content_sha256: string;
  verdict: CouncilVerdict;
  target_url: string;
  request_body: unknown;
  actor_agent_id: string;
  run_id: string;
  attempt_id: string;
  state: DecisionReceiptState;
  block_reason: string | null;
  native_status: number | null;
  native_body: unknown;
  native_observed_at: Date | string | null;
  human_decisions: unknown;
  claimed_at: Date | string;
  updated_at: Date | string;
};

export class DecisionReceiptError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly receipt?: DecisionReceipt,
  ) {
    super(message);
    this.name = "DecisionReceiptError";
  }
}

function table(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return `${ctx.db.namespace}.decision_receipts`;
}

function timestamp(value: Date | string, label: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Invalid ${label} timestamp`);
  return parsed.toISOString();
}

function asRequestBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored decision request body");
  return value as Record<string, unknown>;
}

function parseHumanDecisions(value: unknown): DecisionHumanDisposition[] {
  if (!Array.isArray(value)) throw new Error("Invalid stored human decision audit");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid stored human decision");
    const item = entry as Record<string, unknown>;
    if (item.action !== "acknowledge" && item.action !== "abandon") throw new Error("Invalid stored human action");
    if (typeof item.userId !== "string" || typeof item.at !== "string") throw new Error("Invalid stored human actor");
    return {
      action: item.action,
      userId: item.userId,
      note: typeof item.note === "string" ? item.note : null,
      at: timestamp(item.at, "human decision"),
    };
  });
}

function parseReceipt(row: ReceiptRow): DecisionReceipt {
  const observedAt = row.native_observed_at ? timestamp(row.native_observed_at, "native observation") : null;
  return {
    companyId: row.company_id,
    issueId: row.issue_id,
    operationId: row.operation_id,
    verdict: row.verdict,
    state: row.state,
    blockReason: row.block_reason,
    targetUrl: row.target_url,
    requestBody: asRequestBody(row.request_body),
    actorAgentId: row.actor_agent_id,
    runId: row.run_id,
    claimedAt: timestamp(row.claimed_at, "claim"),
    updatedAt: timestamp(row.updated_at, "update"),
    nativeObservation: row.native_status !== null && observedAt
      ? { status: row.native_status, body: row.native_body, observedAt, usable: row.state === "native_observed" }
      : null,
    humanDecisions: parseHumanDecisions(row.human_decisions),
  };
}

const selectColumns = `company_id, issue_id, operation_id, content_sha256, verdict, target_url,
  request_body, actor_agent_id, run_id, attempt_id, state, block_reason, native_status,
  native_body, native_observed_at, human_decisions, claimed_at, updated_at`;

export async function getDecisionReceipt(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  operationId: string,
): Promise<DecisionReceipt | null> {
  const rows = await ctx.db.query<ReceiptRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)}
      WHERE company_id = $1 AND issue_id = $2 AND operation_id = $3`,
    [companyId, issueId, operationId],
  );
  return rows[0] ? parseReceipt(rows[0]) : null;
}

async function getReceiptRow(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  operationId: string,
): Promise<ReceiptRow | null> {
  const rows = await ctx.db.query<ReceiptRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)}
      WHERE company_id = $1 AND issue_id = $2 AND operation_id = $3`,
    [companyId, issueId, operationId],
  );
  return rows[0] ?? null;
}

async function getCompanyOperationRow(
  ctx: PluginContext,
  companyId: string,
  operationId: string,
): Promise<ReceiptRow | null> {
  const rows = await ctx.db.query<ReceiptRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)}
      WHERE company_id = $1 AND operation_id = $2`,
    [companyId, operationId],
  );
  return rows[0] ?? null;
}

async function getIssueHold(ctx: PluginContext, companyId: string, issueId: string): Promise<DecisionReceipt | null> {
  const rows = await ctx.db.query<ReceiptRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)}
      WHERE company_id = $1 AND issue_id = $2 AND state = 'indeterminate'
      ORDER BY claimed_at, operation_id LIMIT 1`,
    [companyId, issueId],
  );
  return rows[0] ? parseReceipt(rows[0]) : null;
}

export async function listDecisionReceipts(ctx: PluginContext, companyId: string): Promise<DecisionReceipt[]> {
  const rows = await ctx.db.query<ReceiptRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)}
      WHERE company_id = $1 ORDER BY claimed_at DESC, issue_id, operation_id`,
    [companyId],
  );
  return rows.map(parseReceipt);
}

function contentHash(input: CouncilDecisionInput, targetUrl: string, requestBody: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    companyId: input.companyId,
    issueId: input.issueId,
    actorAgentId: input.actorAgentId,
    targetUrl,
    requestBody,
  })).digest("hex");
}

function isUsableNativeResponse(
  body: unknown,
  input: CouncilDecisionInput,
): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (input.nativeReview) {
    const payload = record.payload as { target?: { key?: unknown; revisionId?: unknown } } | null;
    return record.id === input.nativeReview.interactionId && record.companyId === input.companyId
      && record.issueId === input.issueId && record.sourceRunId === input.nativeReview.sourceRunId
      && record.resolvedByRunId === input.runId && record.resolvedByAgentId === input.actorAgentId
      && record.status === (input.verdict === "approved" ? "accepted" : "rejected")
      && payload?.target?.key === "native_completion_review" && payload.target.revisionId === input.nativeReview.decisionId;
  }
  const executionState = record.executionState;
  return record.id === input.issueId
    && record.companyId === input.companyId
    && executionState !== null
    && typeof executionState === "object"
    && !Array.isArray(executionState)
    && typeof (executionState as Record<string, unknown>).lastDecisionId === "string"
    && ((executionState as Record<string, unknown>).lastDecisionId as string).trim() !== ""
    && (executionState as Record<string, unknown>).lastDecisionOutcome === input.verdict;
}

async function recordNativeObservation(
  ctx: PluginContext,
  input: CouncilDecisionInput,
  attemptId: string,
  observation: { status: number; body: unknown; usable: boolean; blockReason: string | null },
): Promise<DecisionReceipt> {
  const update = await ctx.db.execute(
    `UPDATE ${table(ctx)} SET state = $1, block_reason = $2, native_status = $3,
      native_body = $4::jsonb, native_observed_at = now(), updated_at = now()
      WHERE company_id = $5 AND issue_id = $6 AND operation_id = $7
        AND attempt_id = $8 AND native_observed_at IS NULL`,
    [
      observation.usable ? "native_observed" : "indeterminate",
      observation.blockReason,
      observation.status,
      JSON.stringify(observation.body),
      input.companyId,
      input.issueId,
      input.operationId,
      attemptId,
    ],
  );
  const receipt = await getDecisionReceipt(ctx, input.companyId, input.issueId, input.operationId);
  if (!receipt) throw new Error("Decision receipt disappeared after native observation");
  if (update.rowCount !== 1 && !receipt.nativeObservation) {
    throw new Error("Original decision attempt could not record its native observation");
  }
  return receipt;
}

export async function executeCouncilDecision(
  ctx: PluginContext,
  config: CouncilConfig,
  input: CouncilDecisionInput,
): Promise<{ receipt: DecisionReceipt; replayed: boolean }> {
  const request = buildCouncilDecisionRequest(config, input);
  const hash = contentHash(input, request.targetUrl, request.body);
  const existingRow = await getCompanyOperationRow(ctx, input.companyId, input.operationId);
  if (existingRow) {
    const receipt = parseReceipt(existingRow);
    if (existingRow.content_sha256 !== hash) {
      throw new DecisionReceiptError(409, "operation_content_conflict", "operationId is already bound to different decision content", receipt);
    }
    return { receipt, replayed: true };
  }

  const hold = await getIssueHold(ctx, input.companyId, input.issueId);
  if (hold) {
    throw new DecisionReceiptError(409, "issue_decision_indeterminate", "An indeterminate decision already holds this issue", hold);
  }

  const attemptId = randomUUID();
  try {
    const insert = await ctx.db.execute(
      `INSERT INTO ${table(ctx)}
        (company_id, issue_id, operation_id, content_sha256, verdict, target_url, request_body,
          actor_agent_id, run_id, attempt_id, state, block_reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'indeterminate', 'native_outcome_pending')
        ON CONFLICT (company_id, issue_id, operation_id) DO NOTHING`,
      [input.companyId, input.issueId, input.operationId, hash, input.verdict, request.targetUrl,
        JSON.stringify(request.body), input.actorAgentId, input.runId, attemptId],
    );
    if (insert.rowCount !== 1) {
      const concurrent = await getCompanyOperationRow(ctx, input.companyId, input.operationId);
      if (!concurrent) throw new Error("Decision claim lost without a persisted receipt");
      const receipt = parseReceipt(concurrent);
      if (concurrent.content_sha256 !== hash) {
        throw new DecisionReceiptError(409, "operation_content_conflict", "operationId is already bound to different decision content", receipt);
      }
      return { receipt, replayed: true };
    }
  } catch (error) {
    if (error instanceof DecisionReceiptError) throw error;
    const concurrent = await getCompanyOperationRow(ctx, input.companyId, input.operationId);
    if (concurrent) {
      const receipt = parseReceipt(concurrent);
      if (concurrent.content_sha256 !== hash) {
        throw new DecisionReceiptError(409, "operation_content_conflict", "operationId is already bound to different decision content", receipt);
      }
      return { receipt, replayed: true };
    }
    const concurrentHold = await getIssueHold(ctx, input.companyId, input.issueId);
    if (concurrentHold) {
      throw new DecisionReceiptError(409, "issue_decision_indeterminate", "An indeterminate decision already holds this issue", concurrentHold);
    }
    throw error;
  }

  try {
    const native = await emitCouncilDecision(ctx, config, input);
    const usable = native.nativeStatus >= 200 && native.nativeStatus < 300
      && native.nativeBodyValid
      && !native.nativeBodyTruncated
      && isUsableNativeResponse(native.nativeResponse, input);
    const receipt = await recordNativeObservation(ctx, input, attemptId, {
      status: native.nativeStatus,
      body: native.nativeResponse,
      usable,
      blockReason: usable ? null : native.nativeBodyTruncated
        ? "native_response_too_large"
        : native.nativeStatus < 200 || native.nativeStatus >= 300
          ? "native_http_error"
          : native.nativeBodyValid ? "native_response_mismatch" : "native_response_malformed",
    });
    return { receipt, replayed: false };
  } catch {
    await ctx.db.execute(
      `UPDATE ${table(ctx)} SET block_reason = 'native_outcome_unknown', updated_at = now()
        WHERE company_id = $1 AND issue_id = $2 AND operation_id = $3
          AND attempt_id = $4 AND state = 'indeterminate' AND native_observed_at IS NULL`,
      [input.companyId, input.issueId, input.operationId, attemptId],
    ).catch(() => ({ rowCount: 0 }));
    const receipt = await getDecisionReceipt(ctx, input.companyId, input.issueId, input.operationId);
    if (!receipt) throw new Error("Decision receipt disappeared after transport failure");
    return { receipt, replayed: false };
  }
}

export async function findDecisionReplay(
  ctx: PluginContext,
  config: CouncilConfig,
  input: CouncilDecisionInput,
): Promise<{ receipt: DecisionReceipt; replayed: true } | null> {
  const request = buildCouncilDecisionRequest(config, input);
  const hash = contentHash(input, request.targetUrl, request.body);
  const existingRow = await getCompanyOperationRow(ctx, input.companyId, input.operationId);
  if (existingRow) {
    const receipt = parseReceipt(existingRow);
    if (existingRow.content_sha256 !== hash) {
      throw new DecisionReceiptError(409, "operation_content_conflict", "operationId is already bound to different decision content", receipt);
    }
    return { receipt, replayed: true };
  }
  const hold = await getIssueHold(ctx, input.companyId, input.issueId);
  if (hold) {
    throw new DecisionReceiptError(409, "issue_decision_indeterminate", "An indeterminate decision already holds this issue", hold);
  }
  return null;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DecisionReceiptError(400, "malformed_request", `${label} is required`);
  }
  const parsed = value.trim();
  if (parsed.length > maximum) throw new DecisionReceiptError(400, "malformed_request", `${label} is too long`);
  return parsed;
}

export async function recordDecisionHumanDisposition(ctx: PluginContext, input: {
  companyId: string;
  operationId: string;
  action: DecisionHumanAction;
  note: string | null;
  actorUserId: string | null;
}): Promise<DecisionReceipt> {
  const company = await ctx.companies.get(input.companyId);
  if (!company?.defaultResponsibleUserId || input.actorUserId !== company.defaultResponsibleUserId) {
    throw new DecisionReceiptError(403, "owner_required", "Configured company owner identity required");
  }
  const update = await ctx.db.execute(
    `UPDATE ${table(ctx)} SET human_decisions = human_decisions || jsonb_build_array(jsonb_build_object(
      'action', $1::text, 'userId', $2::text, 'note', $3::text, 'at', now()
    )), updated_at = now() WHERE company_id = $4 AND operation_id = $5`,
    [input.action, input.actorUserId, input.note, input.companyId, input.operationId],
  );
  if (update.rowCount === 0) throw new DecisionReceiptError(404, "receipt_not_found", "Decision receipt not found");
  if (update.rowCount !== 1) throw new Error("operationId is not unique inside the company");
  const rows = await ctx.db.query<ReceiptRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1 AND operation_id = $2`,
    [input.companyId, input.operationId],
  );
  if (!rows[0]) throw new Error("Decision receipt disappeared after human action");
  return parseReceipt(rows[0]);
}

export async function handleDecisionReceiptApi(input: {
  routeKey: string;
  companyId: string;
  params: Record<string, string>;
  body: unknown;
  actor: { actorType: string; userId?: string | null };
}, ctx: PluginContext) {
  try {
    const pathCompanyId = requiredString(input.params.companyId, "companyId path parameter", 64);
    if (pathCompanyId !== input.companyId) {
      throw new DecisionReceiptError(403, "company_scope_mismatch", "Path company does not match the host-authorized company scope");
    }
    if (input.routeKey === "council-decisions-list") {
      return { status: 200, body: { receipts: await listDecisionReceipts(ctx, input.companyId) } };
    }
    if (input.routeKey !== "council-decision-human") return { status: 404, body: { error: "Unknown decision receipt route" } };
    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? input.body as Record<string, unknown> : {};
    if (body.action !== "acknowledge" && body.action !== "abandon") {
      throw new DecisionReceiptError(400, "malformed_request", "action must be acknowledge or abandon");
    }
    const receipt = await recordDecisionHumanDisposition(ctx, {
      companyId: input.companyId,
      operationId: requiredString(body.operationId, "operationId", 128),
      action: body.action,
      note: body.note === undefined || body.note === null || body.note === "" ? null : requiredString(body.note, "note", 1000),
      actorUserId: input.actor.actorType === "user" ? input.actor.userId ?? null : null,
    });
    return { status: 200, body: { receipt } };
  } catch (error) {
    if (error instanceof DecisionReceiptError) {
      return { status: error.status, body: { error: error.message, code: error.code, receipt: error.receipt } };
    }
    throw error;
  }
}

export function registerDecisionReceiptBridge(ctx: PluginContext) {
  ctx.data.register("council-decisions", async (params) => {
    const companyId = requiredString(params.companyId, "companyId", 64);
    return {
      receipts: await listDecisionReceipts(ctx, companyId),
      ownerUserId: (await ctx.companies.get(companyId))?.defaultResponsibleUserId ?? null,
    };
  });
  ctx.actions.register("council-decision-human", async (params, context: PluginPerformActionContext) => {
    const companyId = context.companyId;
    if (!companyId) throw new DecisionReceiptError(403, "company_scope_required", "A host-authorized company scope is required");
    if (params.action !== "acknowledge" && params.action !== "abandon") {
      throw new DecisionReceiptError(400, "malformed_request", "action must be acknowledge or abandon");
    }
    return await recordDecisionHumanDisposition(ctx, {
      companyId,
      operationId: requiredString(params.operationId, "operationId", 128),
      action: params.action,
      note: params.note === undefined || params.note === null || params.note === "" ? null : requiredString(params.note, "note", 1000),
      actorUserId: context.actor.type === "user" ? context.actor.userId : null,
    });
  });
}

/** Persists a verified GET observation; never emits or retries the reviewer's native effect. */
export async function recordCouncilNativeReadback(ctx: PluginContext, input: CouncilDecisionInput, evidence: {
  packetHash: string; reportHash: string; card: unknown;
}): Promise<DecisionReceipt> {
  if (!input.nativeReview || !isUsableNativeResponse(evidence.card, input)) {
    throw new DecisionReceiptError(409, "native_readback_invalid", "Exact attributed native review observation required");
  }
  const targetUrl = `/api/issues/${input.issueId}/interactions`;
  const requestBody = { method: "GET", provenance: "native-review-terminal-readback-v1", packetHash: evidence.packetHash,
    reportHash: evidence.reportHash, nativeReview: input.nativeReview, runId: input.runId };
  return recordReadback(ctx, input, targetUrl, requestBody, evidence.card);
}

/** A terminal CLI report observation, never a native completion-review receipt. */
export async function recordCouncilOrdinaryReadback(ctx: PluginContext, input: CouncilDecisionInput, evidence: {
  issueId: string; report: OrdinaryReport; requestBody: Record<string, unknown>;
}): Promise<DecisionReceipt> {
  const run = await readOrdinaryRun(ctx, { companyId: input.companyId, issueId: evidence.issueId, agentId: input.actorAgentId, runId: input.runId });
  let report: unknown;
  try { report = JSON.parse(String(run.resultJson?.summary)); } catch { report = null; }
  if (run.status !== "succeeded" || !run.finishedAt || !report || canonicalPayloadHash(report) !== canonicalPayloadHash(evidence.report)
      || input.verdict !== evidence.report.verdict || evidence.requestBody.provenance !== "ordinary-task-terminal-readback-v1"
      || evidence.requestBody.reportHash !== canonicalPayloadHash(report) || evidence.requestBody.runId !== run.id
      || evidence.requestBody.issueId !== evidence.issueId || run.usageJson?.usageSource !== "per_run") {
    throw new DecisionReceiptError(409, "ordinary_readback_invalid", "Exact terminal CLI report and attributed usage required");
  }
  return recordReadback(ctx, input, `/api/heartbeat-runs/${run.id}`, evidence.requestBody,
    { runId: run.id, issueId: evidence.issueId, agentId: run.agentId, report, usage: run.usageJson });
}

async function recordReadback(ctx: PluginContext, input: CouncilDecisionInput, targetUrl: string,
  requestBody: Record<string, unknown>, observation: unknown): Promise<DecisionReceipt> {
  const hash = contentHash(input, targetUrl, requestBody);
  const attemptId = randomUUID();
  await ctx.db.execute(`INSERT INTO ${table(ctx)}
    (company_id, issue_id, operation_id, content_sha256, verdict, target_url, request_body,
      actor_agent_id, run_id, attempt_id, state, block_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'indeterminate','readback_record_pending')
    ON CONFLICT (company_id, issue_id, operation_id) DO NOTHING`,
    [input.companyId, input.issueId, input.operationId, hash, input.verdict, targetUrl, JSON.stringify(requestBody), input.actorAgentId, input.runId, attemptId]);
  const row = await getCompanyOperationRow(ctx, input.companyId, input.operationId);
  if (!row || row.content_sha256 !== hash || row.run_id !== input.runId || row.verdict !== input.verdict) {
    throw new DecisionReceiptError(409, "operation_content_conflict", "Native readback operation is bound to different evidence");
  }
  if (row.native_observed_at) return parseReceipt(row);
  return recordNativeObservation(ctx, input, row.attempt_id, { status: 200, body: observation, usable: true, blockReason: null });
}
