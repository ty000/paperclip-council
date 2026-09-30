import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  PluginApiRequestInput,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import type { CouncilConfig } from "./contracts.js";

const execFileAsync = promisify(execFile);
export const MAX_CANDIDATE_BUNDLE_BYTES = 32 * 1024 * 1024;

type ProbeRow = {
  company_id: string;
  issue_id: string;
  probe_id: string;
  version: string | number;
  payload: unknown;
};

export type FoundationProbeRecord = {
  companyId: string;
  issueId: string;
  probeId: string;
  version: number;
  payload: Record<string, unknown>;
};

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${label}`);
  return value.trim();
}

function tableName(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) {
    throw new Error("Unsafe plugin database namespace");
  }
  return `${ctx.db.namespace}.foundation_probes`;
}

function parseProbe(row: ProbeRow): FoundationProbeRecord {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("Invalid probe version");
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error("Invalid probe payload");
  }
  return {
    companyId: row.company_id,
    issueId: row.issue_id,
    probeId: row.probe_id,
    version,
    payload: row.payload as Record<string, unknown>,
  };
}

export async function readFoundationProbe(
  ctx: PluginContext,
  input: { companyId: string; issueId: string; probeId: string },
): Promise<FoundationProbeRecord | null> {
  const rows = await ctx.db.query<ProbeRow>(
    `SELECT company_id, issue_id, probe_id, version, payload FROM ${tableName(ctx)} WHERE company_id = $1 AND issue_id = $2 AND probe_id = $3`,
    [input.companyId, input.issueId, input.probeId],
  );
  return rows[0] ? parseProbe(rows[0]) : null;
}

export async function compareAndSwapFoundationProbe(
  ctx: PluginContext,
  input: {
    companyId: string;
    issueId: string;
    probeId: string;
    expectedVersion: number;
    payload: Record<string, unknown>;
  },
) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx)} (company_id, issue_id, probe_id) VALUES ($1, $2, $3) ON CONFLICT (company_id, issue_id, probe_id) DO NOTHING`,
    [input.companyId, input.issueId, input.probeId],
  );
  const update = await ctx.db.execute(
    `UPDATE ${tableName(ctx)} SET version = version + 1, payload = $1::jsonb, updated_at = now() WHERE company_id = $2 AND issue_id = $3 AND probe_id = $4 AND version = $5`,
    [JSON.stringify(input.payload), input.companyId, input.issueId, input.probeId, input.expectedVersion],
  );
  const probe = await readFoundationProbe(ctx, input);
  if (!probe) throw new Error("Foundation probe disappeared after CAS");
  return update.rowCount === 1
    ? { outcome: "applied" as const, probe }
    : { outcome: "conflict" as const, probe };
}

function commit(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^[a-f0-9]{40}$/.test(parsed)) {
    throw new Error(`${label} must be a lowercase 40-character Git commit`);
  }
  return parsed;
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  return result.stdout.trim();
}

export async function verifyCandidateAttachment(
  ctx: PluginContext,
  input: {
    companyId: string;
    issueId: string;
    attachmentId: string;
    expectedSha256: string;
    baseCommit: string;
    candidateCommit: string;
  },
) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
    throw new Error("expectedSha256 must be a lowercase SHA-256 digest");
  }
  const baseCommit = commit(input.baseCommit, "baseCommit");
  const candidateCommit = commit(input.candidateCommit, "candidateCommit");
  const attachments = await ctx.issues.listAttachments(input.issueId, input.companyId);
  if (!attachments.some((attachment) => attachment.id === input.attachmentId)) {
    throw new Error("Candidate attachment is not attached to this issue");
  }
  const attachment = await ctx.issues.getAttachmentContent(
    input.attachmentId,
    input.companyId,
    { maxBytes: MAX_CANDIDATE_BUNDLE_BYTES },
  );
  if (!attachment) throw new Error("Candidate attachment is unavailable in this company");
  const bytes = Buffer.from(attachment.contentBase64, "base64");
  if (bytes.byteLength !== attachment.byteSize) throw new Error("Candidate attachment byte size mismatch");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== attachment.sha256 || sha256 !== input.expectedSha256) {
    throw new Error("Candidate attachment SHA-256 mismatch");
  }

  const root = await mkdtemp(resolve(tmpdir(), "paperclip-council-candidate-"));
  try {
    const bundlePath = resolve(root, "candidate.bundle");
    const repositoryPath = resolve(root, "repository.git");
    await writeFile(bundlePath, bytes, { mode: 0o600 });
    await git(["init", "--bare", repositoryPath], root);
    await git(["bundle", "verify", bundlePath], repositoryPath);
    await git([
      "fetch",
      bundlePath,
      "refs/heads/candidate:refs/council/candidate",
      "refs/heads/base:refs/council/base",
    ], repositoryPath);
    const observedCandidate = await git(["rev-parse", "refs/council/candidate^{commit}"], repositoryPath);
    const observedBase = await git(["rev-parse", "refs/council/base^{commit}"], repositoryPath);
    if (observedCandidate !== candidateCommit || observedBase !== baseCommit) {
      throw new Error("Candidate bundle refs do not match the declared commits");
    }
    await git(["merge-base", "--is-ancestor", baseCommit, candidateCommit], repositoryPath);
    return {
      attachmentId: attachment.attachmentId,
      byteSize: bytes.byteLength,
      sha256,
      baseCommit,
      candidateCommit,
      relationship: "base-is-ancestor",
      isolatedInspection: true,
    } as const;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function ownerProbe(
  input: PluginApiRequestInput,
  ctx: PluginContext,
  config: CouncilConfig,
  body: Record<string, unknown>,
) {
  const action = requiredString(body.action, "action");
  const issueId = requiredString(input.params.issueId, "issueId");
  if (action === "owner-request") {
    if (input.actor.actorType !== "agent" || input.actor.agentId !== config.councilAgentId) {
      return { status: 403, body: { error: "Configured council identity required" } };
    }
    const interaction = await ctx.issues.requestConfirmation(issueId, {
      addresseeUserId: requiredString(body.ownerUserId, "ownerUserId"),
      resolverPolicy: "human_only",
      idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"),
      sourceRunId: requiredString(input.actor.runId, "council run id"),
      title: "Council owner decision",
      summary: "Council is waiting for an explicitly addressed owner response.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: requiredString(body.prompt, "prompt"),
        acceptLabel: "Continue",
        rejectLabel: "Keep waiting",
        rejectRequiresReason: true,
        allowDeclineReason: true,
      },
    }, input.companyId, { authorAgentId: config.councilAgentId });
    return { status: 201, body: interaction };
  }

  const interactionId = requiredString(body.interactionId, "interactionId");
  const interactions = await ctx.issues.listInteractions(issueId, input.companyId);
  const interaction = interactions.find((item) => item.id === interactionId);
  if (!interaction) return { status: 404, body: { error: "Interaction not found" } };
  if (action === "owner-inspect") {
    const configuredCouncil = input.actor.actorType === "agent"
      && input.actor.agentId === config.councilAgentId;
    const addressedOwner = input.actor.actorType === "user"
      && input.actor.userId === interaction.addresseeUserId;
    if (!configuredCouncil && !addressedOwner) {
      return { status: 403, body: { error: "Council or addressed owner identity required" } };
    }
    return { status: 200, body: interaction };
  }
  if (action === "owner-respond") {
    if (input.actor.actorType !== "user" || !input.actor.userId) {
      return { status: 403, body: { error: "Human board identity required" } };
    }
    if (interaction.addresseeUserId !== input.actor.userId) {
      return { status: 403, body: { error: "Addressed owner identity required" } };
    }
    if (body.decision !== "accept" && body.decision !== "reject") {
      throw new Error("decision must be accept or reject");
    }
    const response = await ctx.issues.respondInteraction(issueId, interactionId, {
      action: body.decision,
      actorUserId: input.actor.userId,
      reason: typeof body.reason === "string" ? body.reason : null,
    }, input.companyId);
    return { status: 200, body: response };
  }
  throw new Error("Unknown owner probe action");
}

export async function handleFoundationProbe(
  input: PluginApiRequestInput,
  ctx: PluginContext,
  config: CouncilConfig,
) {
  const body = bodyRecord(input.body);
  const action = requiredString(body.action, "action");
  if (action === "cas") {
    if (input.actor.actorType !== "user") {
      return { status: 403, body: { error: "Board identity required for foundation CAS probe" } };
    }
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
      throw new Error("expectedVersion must be a non-negative safe integer");
    }
    const result = await compareAndSwapFoundationProbe(ctx, {
      companyId: input.companyId,
      issueId: requiredString(input.params.issueId, "issueId"),
      probeId: requiredString(body.probeId, "probeId"),
      expectedVersion: Number(body.expectedVersion),
      payload: bodyRecord(body.payload),
    });
    return { status: result.outcome === "applied" ? 200 : 409, body: result };
  }
  if (action === "candidate") {
    if (input.actor.actorType !== "user") {
      return { status: 403, body: { error: "Board identity required for candidate probe" } };
    }
    const issueId = requiredString(input.params.issueId, "issueId");
    const result = await verifyCandidateAttachment(ctx, {
      companyId: input.companyId,
      issueId,
      attachmentId: requiredString(body.attachmentId, "attachmentId"),
      expectedSha256: requiredString(body.expectedSha256, "expectedSha256"),
      baseCommit: commit(body.baseCommit, "baseCommit"),
      candidateCommit: commit(body.candidateCommit, "candidateCommit"),
    });
    return { status: 200, body: result };
  }
  return ownerProbe(input, ctx, config, body);
}
