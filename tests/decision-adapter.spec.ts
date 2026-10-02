import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CouncilDecisionInput } from "../src/contracts.js";
import { emitCouncilDecision, parseCouncilConfig } from "../src/decision-adapter.js";

afterEach(() => vi.unstubAllGlobals());

describe("council decision adapter", () => {
  it("requires a Paperclip secret reference", () => {
    expect(() => parseCouncilConfig({
      apiBaseUrl: "http://127.0.0.1:3100",
      councilAgentId: "agent-1",
      councilApiKey: "raw-token",
    })).toThrow(/secret_ref/);
  });

  it.each([
    "http://paperclip.example.test:3100",
    "https://paperclip.example.test",
    "http://127.0.0.1:3100/api",
    "http://user:password@127.0.0.1:3100",
    "http://127.0.0.1:3100?target=other",
  ])("rejects an unsafe credential-bearing API origin: %s", (apiBaseUrl) => {
    expect(() => parseCouncilConfig({
      apiBaseUrl,
      councilAgentId: "agent-1",
      councilApiKey: { type: "secret_ref", secretId: "secret-id" },
    })).toThrow(/apiBaseUrl/);
  });

  it.each([
    ["http://localhost:3100", "http://localhost:3100"],
    ["http://127.42.0.7:3100/", "http://127.42.0.7:3100"],
    ["https://[::1]:3100", "https://[::1]:3100"],
  ])("accepts a loopback Paperclip origin: %s", (apiBaseUrl, expected) => {
    expect(parseCouncilConfig({
      apiBaseUrl,
      councilAgentId: "agent-1",
      councilApiKey: { type: "secret_ref", secretId: "secret-id" },
    }).apiBaseUrl).toBe(expected);
  });

  it.each([
    ["changes_requested", "in_progress"],
    ["approved", "done"],
  ] as const)("maps explicit %s to the native %s transition", async (verdict, status) => {
    const resolve = vi.fn().mockResolvedValue("ephemeral-council-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = { secrets: { resolve } } as unknown as PluginContext;
    const decision: CouncilDecisionInput = verdict === "approved"
      ? { companyId: "company-id", issueId: "issue-id", operationId: "operation-id", actorAgentId: "council-agent", runId: "run-id", verdict, approvedCommit: "b".repeat(40), justification: "Fixture justification", resultReference: "fixture://result/v2" }
      : { companyId: "company-id", issueId: "issue-id", operationId: "operation-id", actorAgentId: "council-agent", runId: "run-id", verdict, justification: "Fixture justification", resultReference: "fixture://result/v2" };
    const result = await emitCouncilDecision(ctx, {
      apiBaseUrl: "http://127.0.0.1:3100",
      councilAgentId: "council-agent",
      councilApiKey: { type: "secret_ref", secretId: "secret-id" },
    }, decision);

    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: "secret-id" },
      { companyId: "company-id", configPath: "councilApiKey" },
    );
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3100/api/issues/issue-id", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({
        authorization: "Bearer ephemeral-council-token",
        "x-paperclip-run-id": "run-id",
      }),
    }));
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ status });
    expect(String(request.body)).toContain("Fixture justification");
    expect(String(request.body)).toContain("fixture://result/v2");
    expect(String(request.body)).toContain("Operation ID: operation-id");
    if (verdict === "approved") expect(String(request.body)).toContain("Approved commit: " + "b".repeat(40));
    expect(result).toMatchObject({ verdict, requestedIssueStatus: status, nativeStatus: 200 });
  });
});
