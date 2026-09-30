import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CouncilDecisionInput } from "../src/contracts.js";
import {
  executeCouncilDecision,
  recordDecisionHumanDisposition,
} from "../src/decision-receipts.js";

type Row = Record<string, any>;

function harness() {
  const rows: Row[] = [];
  const db = {
    namespace: "plugin_private_paperclip_council_270061461e",
    query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("operation_id = $3")) {
        return rows.filter((row) => row.company_id === params[0] && row.issue_id === params[1] && row.operation_id === params[2]);
      }
      if (sql.includes("state = 'indeterminate'")) {
        return rows.filter((row) => row.company_id === params[0] && row.issue_id === params[1] && row.state === "indeterminate").slice(0, 1);
      }
      if (sql.includes("operation_id = $2")) {
        return rows.filter((row) => row.company_id === params[0] && row.operation_id === params[1]);
      }
      return rows.filter((row) => row.company_id === params[0]);
    }),
    execute: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("INSERT INTO")) {
        if (rows.some((row) => row.company_id === params[0] && row.operation_id === params[2])) return { rowCount: 0 };
        if (rows.some((row) => row.company_id === params[0] && row.issue_id === params[1] && row.state === "indeterminate")) {
          throw new Error("unique unresolved issue");
        }
        const now = new Date().toISOString();
        rows.push({
          company_id: params[0], issue_id: params[1], operation_id: params[2], content_sha256: params[3],
          verdict: params[4], target_url: params[5], request_body: JSON.parse(String(params[6])),
          actor_agent_id: params[7], run_id: params[8], attempt_id: params[9], state: "indeterminate",
          block_reason: "native_outcome_pending", native_status: null, native_body: null,
          native_observed_at: null, human_decisions: [], claimed_at: now, updated_at: now,
        });
        return { rowCount: 1 };
      }
      if (sql.includes("native_outcome_unknown")) {
        const row = rows.find((entry) => entry.company_id === params[0] && entry.issue_id === params[1]
          && entry.operation_id === params[2] && entry.attempt_id === params[3] && entry.native_observed_at === null);
        if (!row) return { rowCount: 0 };
        row.block_reason = "native_outcome_unknown";
        row.updated_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      if (sql.includes("native_observed_at")) {
        const row = rows.find((entry) => entry.company_id === params[4] && entry.issue_id === params[5]
          && entry.operation_id === params[6] && entry.attempt_id === params[7] && entry.native_observed_at === null);
        if (!row) return { rowCount: 0 };
        const now = new Date().toISOString();
        Object.assign(row, { state: params[0], block_reason: params[1], native_status: params[2],
          native_body: JSON.parse(String(params[3])), native_observed_at: now, updated_at: now });
        return { rowCount: 1 };
      }
      if (sql.includes("human_decisions =")) {
        const row = rows.find((entry) => entry.company_id === params[3] && entry.operation_id === params[4]);
        if (!row) return { rowCount: 0 };
        const now = new Date().toISOString();
        row.human_decisions.push({ action: params[0], userId: params[1], note: params[2], at: now });
        row.updated_at = now;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }),
  };
  const resolve = vi.fn().mockResolvedValue("ephemeral-token");
  const ctx = {
    db,
    secrets: { resolve },
    companies: { get: vi.fn().mockResolvedValue({ defaultResponsibleUserId: "owner-user" }) },
  } as unknown as PluginContext;
  return { ctx, db, rows, resolve };
}

const config = {
  apiBaseUrl: "http://127.0.0.1:3100",
  councilAgentId: "council-agent",
  councilApiKey: { type: "secret_ref" as const, secretId: "secret-id" },
};

function input(overrides: Partial<CouncilDecisionInput> = {}): CouncilDecisionInput {
  return {
    companyId: "22222222-2222-4222-8222-222222222222",
    issueId: "11111111-1111-4111-8111-111111111111",
    operationId: "decision-operation-1",
    actorAgentId: "council-agent",
    runId: "original-run",
    verdict: "changes_requested",
    justification: "Correct the bounded candidate.",
    resultReference: "fixture://candidate/v1",
    ...overrides,
  } as CouncilDecisionInput;
}

function nativeIssue(decision: CouncilDecisionInput, status = "in_progress") {
  return {
    id: decision.issueId,
    companyId: decision.companyId,
    status,
    executionState: { lastDecisionId: "native-decision-id", lastDecisionOutcome: decision.verdict },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("durable council decision receipts", () => {
  it("returns the original attributed receipt for an exact replay in a new run", async () => {
    const h = harness();
    const firstInput = input();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(nativeIssue(firstInput)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await executeCouncilDecision(h.ctx, config, firstInput);
    const replay = await executeCouncilDecision(h.ctx, config, input({ runId: "new-run" }));

    expect(first.receipt.state).toBe("native_observed");
    expect(replay).toMatchObject({ replayed: true, receipt: { runId: "original-run", actorAgentId: "council-agent" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(h.resolve).toHaveBeenCalledOnce();
  });

  it("rejects changed content under the same company operation identity", async () => {
    const h = harness();
    const firstInput = input();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(nativeIssue(firstInput)), { status: 200 })));
    await executeCouncilDecision(h.ctx, config, firstInput);

    await expect(executeCouncilDecision(h.ctx, config, input({ justification: "Different content" })))
      .rejects.toMatchObject({ status: 409, code: "operation_content_conflict" });
  });

  it("keeps a transport failure indeterminate and blocks a new key for the issue", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));
    const first = await executeCouncilDecision(h.ctx, config, input());
    expect(first.receipt).toMatchObject({ state: "indeterminate", blockReason: "native_outcome_unknown", nativeObservation: null });

    await expect(executeCouncilDecision(h.ctx, config, input({ operationId: "decision-operation-2" })))
      .rejects.toMatchObject({ status: 409, code: "issue_decision_indeterminate" });
  });

  it("accepts a contract-backed native decision even when Paperclip chooses a different stage status", async () => {
    const h = harness();
    const decision = input();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(nativeIssue(decision, "in_review")), { status: 200 })));
    const result = await executeCouncilDecision(h.ctx, config, decision);
    expect(result.receipt).toMatchObject({ state: "native_observed", blockReason: null });
    expect(result.receipt.nativeObservation?.body).toMatchObject({ status: "in_review" });
  });

  it("does not qualify a plain status response without native decision identity", async () => {
    const h = harness();
    const decision = input();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: decision.issueId, companyId: decision.companyId, status: "in_progress",
    }), { status: 200 })));
    const result = await executeCouncilDecision(h.ctx, config, decision);
    expect(result.receipt).toMatchObject({ state: "indeterminate", blockReason: "native_response_mismatch" });
    expect(result.receipt.nativeObservation).toMatchObject({ usable: false, status: 200 });
  });

  it("appends owner disposition without clearing native uncertainty", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));
    await executeCouncilDecision(h.ctx, config, input());
    const receipt = await recordDecisionHumanDisposition(h.ctx, {
      companyId: input().companyId,
      operationId: input().operationId,
      action: "acknowledge",
      note: "Operator has seen the hold.",
      actorUserId: "owner-user",
    });
    expect(receipt.state).toBe("indeterminate");
    expect(receipt.humanDecisions).toEqual([expect.objectContaining({
      action: "acknowledge", userId: "owner-user", note: "Operator has seen the hold.",
    })]);
  });
});
