import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { advanceContinuity, registerContinuityJob } from "../src/continuity-runtime.js";
import { assertContinuityDeparture } from "../src/continuity-policy.js";

const f = vi.hoisted(() => ({ mission: null as unknown as MissionRecord, run: { status: "running" },
  board: vi.fn(), review: vi.fn(), reconcile: vi.fn(), delivery: vi.fn(), inventory: vi.fn(), settle: vi.fn() }));
vi.mock("../src/missions.js", () => ({ getMission: async () => structuredClone(f.mission), canonicalPayloadHash: (value: unknown) => JSON.stringify(value),
  MissionError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
vi.mock("../src/n1-missions.js", () => ({ executeN1BoardCommand: (...args: unknown[]) => f.board(...args) }));
vi.mock("../src/n2-missions.js", () => ({ n2Cas: async (_ctx: unknown, m: MissionRecord, aggregate: MissionRecord["aggregate"]) => {
  f.mission = { ...m, version: m.version + 1, aggregate }; return structuredClone(f.mission);
}, nativeN2Profile: async () => ({ envelope: { version: 1 } }) }));
vi.mock("../src/n2-ordinary-runtime.js", () => ({ executeOrdinaryN2Board: (...args: unknown[]) => f.review(...args),
  reconcileOrdinaryN2: async (_ctx: unknown, m: MissionRecord) => { await f.reconcile(); return m; } }));
vi.mock("../src/n5-runtime.js", () => ({ reconcileN5: (...args: unknown[]) => f.delivery(...args) }));
vi.mock("../src/native-runs.js", () => ({ assertNativeRunInventory: (...args: unknown[]) => f.inventory(...args) }));
vi.mock("../src/g4-native.js", () => ({ readOrdinaryRun: async () => f.run, settleOrdinaryRunUsage: (...args: unknown[]) => f.settle(...args) }));
vi.mock("../src/model-state.js", () => ({ physicalAgent: (_m: unknown, id: string) => id }));

const job = { jobKey: "mission-continuity", runId: "native-job", trigger: "schedule", scheduledAt: new Date().toISOString() } as PluginJobContext;
function context() {
  let callback: (job: PluginJobContext) => Promise<void>;
  let document: { body: string } | null = null;
  let stored: unknown = null;
  const upsert = vi.fn(async (input: { body: string }) => { document = { body: input.body }; return document; });
  const ctx = { state: { get: async () => stored, set: async (_scope: unknown, value: unknown) => { stored = value; } }, companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) },
    issues: { documents: { get: async () => document, upsert } },
    jobs: { register: (_key: string, fn: typeof callback) => { callback = fn; } } } as unknown as PluginContext;
  return { ctx, upsert, runJob: () => callback(job) };
}
beforeEach(() => {
  vi.resetAllMocks(); f.run = { status: "running" };
  f.mission = { companyId: "company", missionId: "mission", rootIssueId: "root", ownerUserId: "owner", version: 3,
    aggregate: { mandate: { objective: "exact mandate" }, control: { status: "active" }, phase: "executing", journal: [],
      responsibilities: { integrationLeadAgentId: "lead" },
      n1: { periodKey: "period", activationReservationId: "original-reservation" },
      continuity: { protocol: "council-continuity-v1", enabled: true, authorizedBy: "owner", mandateHash: JSON.stringify({ objective: "exact mandate" }),
        authorizedAt: new Date().toISOString(), deadline: new Date(Date.now() + 60000).toISOString(), n3Slots: [], commands: {} } } } as unknown as MissionRecord;
});

describe("durable delegated Council progression", () => {
  it("persists a command before execution and retains its payload after a lost response", async () => {
    const { ctx } = context();
    f.board.mockImplementation(async () => { throw new Error("lost response"); });
    await expect(advanceContinuity(ctx, f.mission, job)).rejects.toThrow("lost response");
    const saved = structuredClone(f.mission.aggregate.continuity!.commands["start-lead"]);
    expect(saved?.expectedVersion).toBe(4);
    await expect(advanceContinuity(ctx, f.mission, job)).rejects.toThrow("lost response");
    expect(f.board.mock.calls[0][1].body).toEqual(f.board.mock.calls[1][1].body);
    expect(f.mission.aggregate.continuity!.commands["start-lead"]).toEqual(saved);
    expect(f.mission.version).toBe(4);
  });
  it("observes a previously confirmed wake after restart without executing another lead command", async () => {
    f.mission.aggregate.n1 = { ...f.mission.aggregate.n1, rootDispatchState: "requested", rootDispatchRunId: "original-run" };
    const result = await advanceContinuity(context().ctx, f.mission, job);
    expect(result.code).toBe("native_lead_running"); expect(f.board).not.toHaveBeenCalled();
  });
  it("keeps an uncertain original wake blocked without replacement identity", async () => {
    f.mission.aggregate.n1 = { ...f.mission.aggregate.n1, rootDispatchState: "unknown" };
    await expect(advanceContinuity(context().ctx, f.mission, job)).rejects.toMatchObject({ code: "continuity_lead_effect_unknown" });
    expect(f.board).not.toHaveBeenCalled(); expect(f.mission.aggregate.continuity!.commands).toEqual({});
  });
  it.each(["mandate", "owner", "deadline"])("refuses %s drift before a new departure", async kind => {
    if (kind === "mandate") f.mission.aggregate.mandate.objective = "changed";
    if (kind === "owner") f.mission.ownerUserId = "changed";
    if (kind === "deadline") f.mission.aggregate.continuity!.deadline = new Date(0).toISOString();
    await expect(advanceContinuity(context().ctx, f.mission, job)).rejects.toThrow();
    expect(f.board).not.toHaveBeenCalled();
  });
  it("settles a failed lead's terminal cost without promoting its candidate", async () => {
    f.run = { status: "failed" };
    f.mission.aggregate.n1 = { ...f.mission.aggregate.n1, rootDispatchState: "requested", rootDispatchRunId: "original-run", candidate: { candidate: "preserved" } };
    await expect(advanceContinuity(context().ctx, f.mission, job)).rejects.toMatchObject({ code: "continuity_lead_failed" });
    expect(f.settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ runId: "original-run", reservationId: "original-reservation" }));
    expect(f.board).not.toHaveBeenCalled(); expect(f.mission.aggregate.phase).toBe("executing");
    expect(f.mission.aggregate.n1.candidate).toEqual({ candidate: "preserved" });
  });
  it("does not duplicate an unchanged blocking notification document across jobs", async () => {
    const c = context(); f.inventory.mockRejectedValue(Object.assign(new Error("hold"), { code: "unadmitted_native_run" }));
    registerContinuityJob(c.ctx, async () => [f.mission]);
    await c.runJob(); await c.runJob();
    expect(c.upsert).toHaveBeenCalledTimes(1); expect(f.board).not.toHaveBeenCalled();
    expect(c.upsert.mock.calls[0][0].body).toContain("Décision requise");
    expect(c.upsert.mock.calls[0][0].body).toContain("unadmitted_native_run");
  });
  it("lets terminal observation reconcile an existing review after expiry, while the departure gate still blocks", async () => {
    f.mission.aggregate.phase = "reviewing";
    f.mission.aggregate.n2 = { ordinary: { tasks: [] }, status: "reviewing" } as any;
    f.mission.aggregate.continuity!.deadline = new Date(0).toISOString();
    expect(() => assertContinuityDeparture(f.mission)).toThrow();
    expect((await advanceContinuity(context().ctx, f.mission, job)).state).toBe("waiting");
    expect(f.reconcile).toHaveBeenCalledOnce(); expect(f.review).not.toHaveBeenCalled();
  });
});
