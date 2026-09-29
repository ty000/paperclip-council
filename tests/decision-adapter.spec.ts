import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
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
    const result = await emitCouncilDecision(ctx, {
      apiBaseUrl: "http://127.0.0.1:3100",
      councilAgentId: "council-agent",
      councilApiKey: { type: "secret_ref", secretId: "secret-id" },
    }, {
      companyId: "company-id",
      issueId: "issue-id",
      runId: "run-id",
      verdict,
      justification: "Fixture justification",
      resultReference: "fixture://result/v2",
    });

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
    expect(result).toMatchObject({ verdict, requestedIssueStatus: status, nativeStatus: 200 });
  });
});
