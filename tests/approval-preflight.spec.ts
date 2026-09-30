import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { handleDecision } from "../src/worker.js";

vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/plugin-sdk")>();
  return { ...actual, runWorker: vi.fn() };
});

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const councilId = "33333333-3333-4333-8333-333333333333";
const bundleId = "44444444-4444-4444-8444-444444444444";
const head = "b".repeat(40);
const sha = "c".repeat(64);
const manifest = {
  repository: "https://github.com/owner/repository.git",
  branch: "codex/candidate",
  baseCommit: "a".repeat(40),
  approvedCommit: head,
  bundleAttachmentId: bundleId,
  bundleSha256: sha,
  deliveryWorkspacePath: "/home/davy-lp/workspace/candidate",
  assigneeAgentId: "55555555-5555-4555-8555-555555555555",
};

function fixture(options: {
  body?: string | null;
  attachment?: Record<string, unknown> | null;
  workProducts?: readonly unknown[];
  verdict?: "approved" | "changes_requested";
  approvedCommit?: string;
} = {}) {
  let receipt: Record<string, unknown> | null = null;
  const resolve = vi.fn().mockResolvedValue("ephemeral-token");
  const getDocument = vi.fn().mockResolvedValue(options.body === null ? null : { body: options.body ?? JSON.stringify(manifest) });
  const listAttachments = vi.fn().mockResolvedValue(options.attachment === null ? [] : [{
    id: bundleId, issueId, companyId, sha256: sha, ...options.attachment,
  }]);
  const ctx = {
    config: { get: vi.fn().mockResolvedValue({
      apiBaseUrl: "http://127.0.0.1:3100", councilAgentId: councilId,
      councilApiKey: { type: "secret_ref", secretId: "secret-id" },
    }) },
    issues: {
      get: vi.fn().mockResolvedValue({
        id: issueId, companyId, status: "in_review", assigneeAgentId: councilId,
        ...(options.workProducts ? { workProducts: options.workProducts } : {}),
      }),
      documents: { get: getDocument },
      listAttachments,
    },
    secrets: { resolve },
    db: {
      namespace: "plugin_private_paperclip_council_270061461e",
      query: vi.fn().mockImplementation(async (sql: string) => sql.includes("mission_governance") ? [] : receipt ? [receipt] : []),
      execute: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("INSERT INTO")) {
          const now = new Date().toISOString();
          receipt = {
            company_id: params[0], issue_id: params[1], operation_id: params[2], content_sha256: params[3],
            verdict: params[4], target_url: params[5], request_body: JSON.parse(String(params[6])),
            actor_agent_id: params[7], run_id: params[8], attempt_id: params[9], state: "indeterminate",
            block_reason: "native_outcome_pending", native_status: null, native_body: null,
            native_observed_at: null, human_decisions: [], claimed_at: now, updated_at: now,
          };
          return { rowCount: 1 };
        }
        if (sql.includes("native_observed_at")) {
          const now = new Date().toISOString();
          receipt = { ...receipt!, state: params[0], block_reason: params[1], native_status: params[2],
            native_body: JSON.parse(String(params[3])), native_observed_at: now, updated_at: now };
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }),
    },
  } as unknown as PluginContext;
  const input = {
    routeKey: "decision", method: "POST", path: `/issues/${issueId}/decision`,
    params: { issueId }, query: {}, companyId, headers: {},
    actor: { actorType: "agent", actorId: councilId, agentId: councilId, runId: "run-id" },
    body: {
      verdict: options.verdict ?? "approved", approvedCommit: options.approvedCommit ?? head,
      operationId: "operation-id",
      justification: "Reviewed structured candidate", resultReference: "fixture://candidate",
    },
  } satisfies PluginApiRequestInput;
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: issueId, companyId, status: options.verdict === "changes_requested" ? "in_progress" : "done",
    executionState: { lastDecisionId: "decision-id", lastDecisionOutcome: options.verdict ?? "approved" },
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return { input, ctx, resolve, getDocument, listAttachments, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("approval preflight", () => {
  it.each([
    ["missing structured head", { approvedCommit: "" }, /approvedCommit must be/],
    ["missing document", { body: null }, /Add a delivery-manifest/],
    ["invalid JSON", { body: "{" }, /valid JSON/],
    ["missing field", { body: JSON.stringify({ ...manifest, bundleSha256: undefined }) }, /bundleSha256/],
    ["different approved hash", { approvedCommit: "d".repeat(40) }, /approvedCommit does not match/],
    ["foreign bundle", { attachment: { issueId: "66666666-6666-4666-8666-666666666666" } }, /does not belong/],
    ["different bundle digest", { attachment: { sha256: "d".repeat(64) } }, /bundleSha256/],
    ["different candidate work product", { workProducts: [{ type: "commit", metadata: { repo: "owner/repository", branch: "codex/candidate", sha: "d".repeat(40), baseCommit: manifest.baseCommit } }] }, /Candidate work product/],
    ["different candidate repository", { workProducts: [{ type: "commit", metadata: { repo: "other/repository", branch: manifest.branch, sha: head, baseCommit: manifest.baseCommit } }] }, /Candidate work product/],
    ["different candidate branch", { workProducts: [{ type: "commit", metadata: { repo: "owner/repository", branch: "codex/other", sha: head, baseCommit: manifest.baseCommit } }] }, /Candidate work product/],
    ["different candidate base", { workProducts: [{ type: "commit", metadata: { repo: "owner/repository", branch: manifest.branch, sha: head, baseCommit: "d".repeat(40) } }] }, /Candidate work product/],
  ] as const)("refuses %s before secret resolution or PATCH", async (_label, options, message) => {
    const f = fixture(options);
    const result = await handleDecision(f.input, f.ctx);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.error).toMatch(message);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("permits a valid manifest, bundle and candidate work product", async () => {
    const f = fixture({ workProducts: [{ type: "commit", metadata: {
      repo: "owner/repository", branch: manifest.branch, sha: head, baseCommit: manifest.baseCommit,
    } }] });
    const result = await handleDecision(f.input, f.ctx);
    expect(result.status).toBe(200);
    expect(f.getDocument).toHaveBeenCalledWith(issueId, "delivery-manifest", companyId);
    expect(f.listAttachments).toHaveBeenCalledWith(issueId, companyId);
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a conflicting primary candidate despite a matching archived work product", async () => {
    const f = fixture({ workProducts: [
      {
        type: "commit", status: "archived", isPrimary: false,
        metadata: { repo: "owner/repository", branch: manifest.branch, sha: head, baseCommit: manifest.baseCommit },
      },
      {
        type: "commit", status: "ready_for_review", isPrimary: true,
        metadata: { repo: "owner/repository", branch: manifest.branch, sha: "d".repeat(40), baseCommit: manifest.baseCommit },
      },
    ] });
    const result = await handleDecision(f.input, f.ctx);
    expect(result.status).toBe(422);
    expect(result.body.error).toMatch(/Candidate work product/);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("permits changes_requested without a manifest or bundle read", async () => {
    const f = fixture({ verdict: "changes_requested", body: null, attachment: null });
    const result = await handleDecision(f.input, f.ctx);
    expect(result.status).toBe(200);
    expect(f.getDocument).not.toHaveBeenCalled();
    expect(f.listAttachments).not.toHaveBeenCalled();
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });
});
