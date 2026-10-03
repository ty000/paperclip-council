import { afterEach, expect, it, vi } from "vitest";
import { councilNativeRequest } from "../src/decision-adapter.js";

const path = "/api/heartbeat-runs/run1";
function fixture() {
  let config = { apiBaseUrl: "http://localhost:3100", councilAgentId: "reviewer", councilApiKey: { type: "secret_ref", secretId: "secret-1", version: "latest" } };
  const resolve = vi.fn(async () => "test-token");
  const ctx = { config: { get: async () => config }, secrets: { resolve } };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "run1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return { ctx: ctx as never, resolve, fetch, change: () => { config = { ...config, councilApiKey: { ...config.councilApiKey, secretId: "secret-2" } }; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("reuses only the credential for five seconds while every run read reaches the host", async () => {
  vi.useFakeTimers(); const { ctx, resolve, fetch } = fixture();
  await councilNativeRequest(ctx, "company-1", path);
  await councilNativeRequest(ctx, "company-1", path);
  expect(resolve).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5_001);
  await councilNativeRequest(ctx, "company-1", path);
  expect(resolve).toHaveBeenCalledTimes(2);
});
it("separates companies, config rotation and write requests", async () => {
  const { ctx, resolve, change } = fixture();
  await councilNativeRequest(ctx, "company-1", path);
  await councilNativeRequest(ctx, "company-2", path);
  change(); await councilNativeRequest(ctx, "company-2", path);
  await councilNativeRequest(ctx, "company-2", "/api/issues/issue1", { method: "POST" });
  expect(resolve).toHaveBeenCalledTimes(4);
});
it("invalidates a rejected credential without replaying the failed HTTP request", async () => {
  const { ctx, resolve, fetch } = fixture();
  fetch.mockImplementationOnce(async () => new Response("{}", { status: 401 }));
  expect((await councilNativeRequest(ctx, "company-1", path)).status).toBe(401);
  expect(fetch).toHaveBeenCalledTimes(1);
  await councilNativeRequest(ctx, "company-1", path);
  expect(resolve).toHaveBeenCalledTimes(2);
});
