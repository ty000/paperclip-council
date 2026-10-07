import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { readAdmission, recordUnadmittedRun } from "../src/admission.js";
import { readNativeG4Profile } from "../src/g4-native.js";
import { assertNativeRunInventory, initialNativeWakePolicy } from "../src/native-runs.js";
import { prepareVariantLaunch } from "../src/model-runtime.js";

vi.mock("../src/admission.js", async original => ({ ...await original(), readAdmission: vi.fn(), recordUnadmittedRun: vi.fn() }));
vi.mock("../src/g4-native.js", async original => ({ ...await original(), readNativeG4Profile: vi.fn() }));

function fixture() {
  const ids = { company: randomUUID(), mission: randomUUID(), project: randomUUID(), root: randomUUID(), lead: randomUUID(),
    run: randomUUID(), reservation: randomUUID(), foreign: randomUUID() };
  const m = { companyId: ids.company, missionId: ids.mission, projectId: ids.project, rootIssueId: ids.root, aggregate: {
    nativeWakePolicy: { protocol: "council-native-wake-v2", rootBaseline: [] }, responsibilities: { integrationLeadAgentId: ids.lead },
    n1: { periodKey: "period", activationReservationId: ids.reservation, rootDispatchRunId: ids.run, rootDispatchState: "requested", contributions: [] },
  } } as unknown as MissionRecord;
  let summaries = [{ id: ids.run, issueId: ids.root, agentId: ids.lead, status: "succeeded" }];
  const getOrchestration = vi.fn(async () => ({ companyId: ids.company, issueId: ids.root, runs: summaries }));
  const create = vi.fn(), requestWakeup = vi.fn();
  const ctx = { issues: { summaries: { getOrchestration }, create, requestWakeup }, secrets: { resolve: async () => "synthetic-test-key" },
    config: { get: async () => ({ apiBaseUrl: "http://127.0.0.1:3210", councilAgentId: ids.lead, councilApiKey: { type: "secret_ref", secretId: randomUUID() } }) } } as unknown as PluginContext;
  const envelope = { reservations: [{ reservationId: ids.reservation, missionId: ids.mission }], unadmittedRuns: [] as any[] };
  vi.mocked(readAdmission).mockImplementation(async () => envelope as never);
  vi.mocked(readNativeG4Profile).mockResolvedValue({ periodKey: "period" } as never);
  vi.mocked(recordUnadmittedRun).mockImplementation(async (_ctx, fact) => { envelope.unadmittedRuns.push(fact); return envelope as never; });
  const native = { id: ids.foreign, companyId: ids.company, agentId: ids.lead, status: "succeeded", startedAt: new Date(0).toISOString(), finishedAt: new Date(1000).toISOString(),
    contextSnapshot: { issueId: ids.root }, usageJson: { usageSource: "per_run", inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(native), { status: 200 })));
  return { ids, m, ctx, envelope, native, create, requestWakeup, summaries: (runs: typeof summaries) => { summaries = runs; } };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("native inventory and departure gate", () => {
  it("requires an actual reservation as well as the exact stored run binding", async () => {
    const f = fixture(); await assertNativeRunInventory(f.ctx, f.m);
    expect(recordUnadmittedRun).not.toHaveBeenCalled();
    f.envelope.reservations = [];
    await expect(assertNativeRunInventory(f.ctx, f.m)).rejects.toMatchObject({ code: "unadmitted_native_run" });
    expect(recordUnadmittedRun).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ runId: f.ids.run, usage: { status: "unknown", reason: expect.any(String) } }));
  });
  it("records a foreign cost then refuses before selecting an agent, creating a child or waking", async () => {
    const f = fixture(); f.summaries([{ id: f.ids.foreign, issueId: f.ids.root, agentId: f.ids.lead, status: "succeeded" }]);
    await expect(prepareVariantLaunch(f.ctx, f.m, { taskKey: "root", interventionKey: "lead", launchKey: randomUUID(), logicalAgentId: f.ids.lead, family: "diagnosis", expectedRoles: [] })).rejects.toMatchObject({ code: "unadmitted_native_run" });
    expect(recordUnadmittedRun).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ runId: f.ids.foreign, usage: { status: "known", source: expect.any(String), units: 120 } }));
    expect(f.create).not.toHaveBeenCalled(); expect(f.requestWakeup).not.toHaveBeenCalled();
  });
  it("retains a hold when native readback fails instead of treating the run as free", async () => {
    const f = fixture(); f.summaries([{ id: f.ids.foreign, issueId: f.ids.root, agentId: f.ids.lead, status: "succeeded" }]);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("unavailable"));
    await expect(assertNativeRunInventory(f.ctx, f.m)).rejects.toMatchObject({ code: "unadmitted_native_run" });
    expect(recordUnadmittedRun).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ usage: { status: "unknown", reason: expect.any(String) }, remainingExposure: { status: "unknown", reason: expect.any(String) } }));
  });
  it("keeps an uncertain admitted wake bound to its existing reservation without relabeling it as foreign", async () => {
    const f = fixture(); Object.assign(f.m.aggregate.n1!, { rootDispatchRunId: null, rootDispatchState: "unknown" });
    await expect(assertNativeRunInventory(f.ctx, f.m)).rejects.toMatchObject({ code: "native_wake_binding_unknown" });
    expect(recordUnadmittedRun).not.toHaveBeenCalled(); expect(f.requestWakeup).not.toHaveBeenCalled();
  });
  it("pins a total run limit without blocking settlement at that limit", async () => {
    const f = fixture(); Object.assign(f.m.aggregate.nativeWakePolicy!, { runLimit: 1 });
    await assertNativeRunInventory(f.ctx, f.m);
    await expect(assertNativeRunInventory(f.ctx, f.m, true)).rejects.toMatchObject({ code: "native_run_limit_exceeded" });
  });
  it("captures only completed historical root identities and refuses active adoption", async () => {
    const f = fixture(); const policy = await initialNativeWakePolicy(f.ctx, f.ids.company, f.ids.root, 12);
    expect(policy).toEqual({ protocol: "council-native-wake-v2", runLimit: 12, rootBaseline: [{ runId: f.ids.run, agentId: f.ids.lead }] });
    f.summaries([{ id: f.ids.run, issueId: f.ids.root, agentId: f.ids.lead, status: "running" }]);
    await expect(initialNativeWakePolicy(f.ctx, f.ids.company, f.ids.root)).rejects.toMatchObject({ code: "native_root_already_running" });
  });
});
