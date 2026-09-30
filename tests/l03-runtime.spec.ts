import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { L03GovernanceService } from "../src/l03-store.js";
import { L03Error } from "../src/l03.js";
import type { L03Governance } from "../src/l03-types.js";
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

afterEach(() => vi.restoreAllMocks());
it("persists concurrent host observations by retrying stale CAS without replaying side effects", async () => {
  let version = 1; const persisted = new Set<string>();
  vi.spyOn(L03GovernanceService.prototype, "get").mockImplementation(async () => ({ version } as L03Governance));
  const apply = vi.spyOn(L03GovernanceService.prototype, "apply").mockImplementation(async (_company, _mission, _actor, command) => {
    await Promise.resolve();
    if (command.expectedVersion !== version) throw new L03Error(409, "version_or_mandate_conflict", "Concurrent observation");
    if (command.type !== "record-consultation-observation") throw new Error("Unexpected mutation");
    persisted.add(command.observation.observedEventRef); version += 1;
    return { version } as L03Governance;
  });
  const h = harness();
  await Promise.all(Array.from({ length: 5 }, (_, i) => h.observed({ companyId: "company", actorType: "plugin", actorId: "paperclip-executive.executive", payload: { missionId: "mission", observedEventRef: `event-${i}` } } as unknown as PluginEvent)));
  expect(persisted.size).toBe(5); expect(apply.mock.calls.length).toBeGreaterThan(5); expect(h.wakeup).not.toHaveBeenCalled();
});
it("never retries definitive authority rejection or more than eight persistence conflicts", async () => {
  vi.spyOn(L03GovernanceService.prototype, "get").mockResolvedValue({ version: 1 } as L03Governance);
  const apply = vi.spyOn(L03GovernanceService.prototype, "apply").mockRejectedValue(new L03Error(403, "actor_not_authorized", "Forbidden"));
  const h = harness(); const event = { companyId: "company", actorType: "plugin", actorId: "paperclip-executive.executive", payload: { missionId: "mission" } } as unknown as PluginEvent;
  await expect(h.observed(event)).rejects.toMatchObject({ status: 403 }); expect(apply).toHaveBeenCalledTimes(1);
  apply.mockClear().mockRejectedValue(new L03Error(409, "version_conflict", "Stale"));
  await expect(h.observed(event)).rejects.toMatchObject({ code: "version_conflict" }); expect(apply).toHaveBeenCalledTimes(8);
});
