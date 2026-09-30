import { describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { createL03Runtime } from "../src/l03-runtime.js";

function harness() {
  const db = { namespace: "plugin_council_test", query: vi.fn(async () => [{ aggregate: { schemaVersion: 1, version: 1, approaches: [], consultationSlots: [], results: [], receiptRefs: [] } }]), execute: vi.fn() };
  const wakeup = vi.fn(); const callbacks = new Map<string, (event: PluginEvent) => Promise<void>>();
  const ctx = { db, issues: { requestWakeup: wakeup }, data: { register: vi.fn() }, events: { on: vi.fn((name, fn) => callbacks.set(name, fn)), emit: vi.fn() } } as unknown as PluginContext;
  return { ...createL03Runtime(ctx), db, wakeup, callbacks };
}
const input = (body: unknown, overrides = {}): PluginApiRequestInput => ({ routeKey: "l03-command", method: "POST", path: "/companies/company/l03/mission/commands", params: { companyId: "company", missionId: "mission" }, query: {}, headers: {}, companyId: "company", actor: { actorType: "agent", actorId: "reviewer", agentId: "reviewer", runId: "native-run" }, body, ...overrides });

describe("L03 authenticated runtime boundaries", () => {
  it("refuses public callers supplying native effects, admission grants or imported opinions", async () => {
    const h = harness();
    for (const type of ["record-opinion", "record-consultation-observation", "grant-consultation-admission", "claim-direction-effect", "record-direction-effect", "record-result-effect"]) {
      expect(await h.api(input({ type, actualEffectObservation: { status: "confirmed" } }))).toMatchObject({ status: 403, body: { code: "internal_observation_only" } });
    }
    expect(h.db.execute).not.toHaveBeenCalled(); expect(h.wakeup).not.toHaveBeenCalled();
  });
  it("rejects foreign company and missing authenticated run before reading or mutating", async () => {
    const h = harness();
    expect(await h.api(input({}, { companyId: "foreign" }))).toMatchObject({ status: 403 });
    expect(await h.api(input({}, { actor: { actorType: "agent", actorId: "reviewer", agentId: "reviewer" } }))).toMatchObject({ status: 403, body: { code: "run_required" } });
    expect(h.db.query).not.toHaveBeenCalled(); expect(h.db.execute).not.toHaveBeenCalled();
  });
  it("rejects events with spoofed Executive payload but a different host actor", async () => {
    const h = harness(); h.register();
    for (const fn of h.callbacks.values()) await expect(fn({ actorType: "plugin", actorId: "another.plugin", companyId: "company", payload: { actorId: "paperclip-executive.executive" } } as unknown as PluginEvent)).rejects.toMatchObject({ status: 403, code: "executive_plugin_required" });
    expect(h.callbacks.size).toBe(2); expect(h.db.query).not.toHaveBeenCalled();
  });
});
