import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2CommandCas: vi.fn() }));
vi.mock("../src/g4-native.js", async original => ({ ...await original(), readNativeRun: vi.fn() }));
import { executeNativeN2Board } from "../src/n2-native-runtime.js";
import { n2CommandCas } from "../src/n2-missions.js";
import { readNativeRun } from "../src/g4-native.js";
import type { MissionRecord } from "../src/missions.js";
function fixture() {
  const mission = { companyId: "company", rootIssueId: "root", version: 10, aggregate: { commandReceipts: [], responsibilities: { integrationLeadAgentId: "lead" },
    n2: { status: "correction_requested", correction: { runId: null, reservationId: randomUUID() }, native: {
      profile: "paperclip_runner-experimental", reviewProtocol: "native-verdict-readback-v1", releaseState: "claimed", correctionOwnerAction: "restore_wake_policy" } } } } as unknown as MissionRecord;
  const ctx = { agents: { get: vi.fn(async () => ({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } })) },
    issues: { requestWakeup: vi.fn(), summaries: { getOrchestration: vi.fn(async () => ({ runs: [{ id: "recovery-run", issueId: "root", agentId: "lead", status: "running" }] })) } } };
  vi.mocked(readNativeRun).mockResolvedValue({ id: "recovery-run" } as never);
  vi.mocked(n2CommandCas).mockImplementation(async (_ctx, m, _body, _type, _actor, aggregate) => ({ outcome: "applied", mission: { ...m, aggregate } }) as never);
  const input = { actorUserId: "owner", body: { command: "release-native-correction", commandId: randomUUID(), expectedVersion: 10 } };
  return { ctx, mission, input };
}
beforeEach(() => vi.resetAllMocks());
it("adopts the already running native recovery correction without emitting another wake", async () => {
  const f = fixture(); const result = await executeNativeN2Board(f.ctx as never, f.mission, f.input);
  expect(result.outcome).toBe("observed");
  expect(result.mission.aggregate.n2?.correction?.runId).toBe("recovery-run");
  expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled();
});
it("observes a correction already bound by the lead even if its owner command version is stale", async () => {
  const f = fixture(); f.mission.aggregate.n2!.correction!.runId = "recovery-run"; f.mission.version++;
  expect((await executeNativeN2Board(f.ctx as never, f.mission, f.input)).outcome).toBe("observed");
  expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled(); expect(n2CommandCas).not.toHaveBeenCalled();
});
it("does not release a held lead or buy another wake after an uncertain claim", async () => {
  const f = fixture(); f.ctx.agents.get.mockResolvedValue({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
  await expect(executeNativeN2Board(f.ctx as never, f.mission, f.input)).rejects.toMatchObject({ code: "native_lead_wake_policy" });
  f.mission.aggregate.n2!.native!.correctionOwnerAction = "wake_claimed";
  await expect(executeNativeN2Board(f.ctx as never, f.mission, f.input)).rejects.toMatchObject({ code: "native_correction_not_reserved" });
  expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled(); expect(n2CommandCas).not.toHaveBeenCalled();
});
