import { beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { ordinaryTask } from "../src/n2-ordinary-state.js";

vi.mock("../src/missions.js", async original => ({ ...await original(), getMission: vi.fn() }));
vi.mock("../src/model-runtime.js", () => ({ prepareVariantLaunch: vi.fn(), bindVariantIssue: vi.fn(), claimVariantWake: vi.fn(), recordVariantWake: vi.fn(), observeVariantRun: vi.fn() }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2Cas: vi.fn(), reserveN2Run: vi.fn(), nativeN2Profile: vi.fn() }));
vi.mock("../src/n3-state.js", async original => ({ ...await original(), n3Round: vi.fn(() => ({ review: { slots: [] } })) }));

import { getMission } from "../src/missions.js";
import { bindVariantIssue, claimVariantWake, prepareVariantLaunch, recordVariantWake } from "../src/model-runtime.js";
import { n2Cas, reserveN2Run } from "../src/n2-missions.js";
import { reconcileOrdinaryN2 } from "../src/n2-ordinary-runtime.js";

function fixture(optedIn = true) {
  const task = { ...ordinaryTask("council", "submission", "reviewer"), issueId: "review-issue", creation: "confirmed" as const };
  const launch = { taskKey: "root", interventionKey: "reviewer", launchKey: task.reservationId, logicalAgentId: "reviewer",
    agentId: "physical-reviewer", roleKey: "generalist-reviewer", profileId: "sol-medium", requestedProfileId: "sol-medium",
    family: "review", rationale: "default", authority: "default", mappingRevision: "1", variantRevision: "1", selectedAt: "now",
    state: "ready", issueId: task.issueId, runId: null, ascent: false };
  const mission = { companyId: "company", projectId: "project", missionId: "mission", rootIssueId: "root", ownerUserId: "owner", version: 1,
    aggregate: { journal: [], effectIntents: [], commandReceipts: [], responsibilities: { integrationLeadAgentId: "lead", finalReviewerAgentId: "reviewer" },
      n2: { ordinary: { protocol: "ordinary-cli-v1", tasks: [task] }, activeSubmissionId: "submission", status: "review_handoff", rounds: [], submissions: [] },
      ...(optedIn ? { modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [{ taskKey: "root", variantRevision: "1", mapping: {}, launches: [launch] }] } } : {}) } } as unknown as MissionRecord;
  return { mission, task };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prepareVariantLaunch).mockImplementation(async (_ctx, mission) => ({ mission, binding: mission.aggregate.modelSelection ? { agentId: "physical-reviewer" } : null }) as never);
  vi.mocked(bindVariantIssue).mockImplementation(async (_ctx, mission) => mission);
  vi.mocked(recordVariantWake).mockImplementation(async (_ctx, mission, _key, runId, persist) =>
    persist ? persist(mission, mission.aggregate, runId) : mission);
});

it("does not orphan a model wake claim when the combined task CAS fails", async () => {
  const { mission, task } = fixture();
  vi.mocked(getMission).mockResolvedValue(mission);
  vi.mocked(n2Cas).mockRejectedValue(new Error("combined CAS lost"));
  vi.mocked(claimVariantWake).mockImplementation(async (_ctx, ready, key, persist) => {
    const state = ready.aggregate.modelSelection!;
    const aggregate = { ...ready.aggregate, modelSelection: { ...state, tasks: state.tasks.map(modelTask => ({ ...modelTask,
      launches: modelTask.launches.map(launch => launch.launchKey === key ? { ...launch, state: "wake_claimed" as const } : launch) })) } };
    return persist!(ready, aggregate);
  });
  const requestWakeup = vi.fn();
  const ctx = { agents: { get: vi.fn().mockResolvedValue({ adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }) },
    issues: { requestWakeup, update: vi.fn() } } as unknown as PluginContext;

  await expect(reconcileOrdinaryN2(ctx, mission)).rejects.toThrow("combined CAS lost");
  expect(n2Cas).toHaveBeenCalledTimes(1);
  const combined = vi.mocked(n2Cas).mock.calls[0]![2];
  expect(combined.n2!.ordinary!.tasks[0]).toMatchObject({ taskId: task.taskId, wake: "claimed", runId: null });
  expect(combined.modelSelection!.tasks[0]!.launches[0]).toMatchObject({ launchKey: task.reservationId, state: "wake_claimed", runId: null });
  expect(mission.aggregate.n2!.ordinary!.tasks[0]!.wake).toBe("pending");
  expect(mission.aggregate.modelSelection!.tasks[0]!.launches[0]!.state).toBe("ready");
  expect(requestWakeup).not.toHaveBeenCalled();
});

it("keeps the historical path and records its workflow claim before wake", async () => {
  const { mission, task } = fixture(false); let current = mission; const timeline: string[] = [];
  vi.mocked(getMission).mockImplementation(async () => current);
  vi.mocked(n2Cas).mockImplementation(async (_ctx, before, aggregate) => {
    timeline.push(`cas:${aggregate.n2!.ordinary!.tasks[0]!.wake}`);
    current = { ...before, version: before.version + 1, aggregate }; return current;
  });
  vi.mocked(claimVariantWake).mockImplementation(async (_ctx, ready, _key, persist) => persist!(ready, ready.aggregate));
  const requestWakeup = vi.fn(async () => { timeline.push("wake"); return { runId: "historical-run" }; });
  const ctx = { agents: { get: vi.fn().mockResolvedValue({ adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }) },
    issues: { update: vi.fn(), requestWakeup } } as unknown as PluginContext;

  const result = await reconcileOrdinaryN2(ctx, mission);
  expect(result.aggregate).not.toHaveProperty("modelSelection");
  expect(result.aggregate.n2!.ordinary!.tasks[0]).toMatchObject({ taskId: task.taskId, wake: "claimed", runId: "historical-run" });
  expect(timeline).toEqual(["cas:claimed", "wake", "cas:claimed"]);
  expect(reserveN2Run).toHaveBeenCalledTimes(1); expect(recordVariantWake).toHaveBeenCalledTimes(1);
});

it("preserves a historical callback run when the original wake readback is null", async () => {
  const { mission, task } = fixture(false); let current = mission; const callbackRun = "callback-run";
  vi.mocked(getMission).mockImplementation(async () => current);
  vi.mocked(n2Cas).mockImplementation(async (_ctx, before, aggregate) => {
    current = { ...before, version: before.version + 1, aggregate }; return current;
  });
  vi.mocked(claimVariantWake).mockImplementation(async (_ctx, ready, _key, persist) => persist!(ready, ready.aggregate));
  const requestWakeup = vi.fn(async () => {
    const state = current.aggregate.n2!;
    current = { ...current, version: current.version + 1, aggregate: { ...current.aggregate, n2: { ...state,
      ordinary: { ...state.ordinary!, tasks: state.ordinary!.tasks.map(item => item.taskId === task.taskId ? { ...item, runId: callbackRun } : item) } } } };
    return { runId: null };
  });
  const ctx = { agents: { get: vi.fn().mockResolvedValue({ adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }) },
    issues: { update: vi.fn(), requestWakeup } } as unknown as PluginContext;

  const result = await reconcileOrdinaryN2(ctx, mission);

  expect(result.aggregate).not.toHaveProperty("modelSelection");
  expect(result.aggregate.n2!.ordinary!.tasks[0]).toMatchObject({ taskId: task.taskId, runId: callbackRun });
});

it("finishes a persisted settled operational correction without another dispatch after interrupted handoff", async () => {
  const { mission, task } = fixture(false);
  Object.assign(task, { kind: "correction", agentId: "lead", issueId: "correction-issue", runId: "correction-run", settledAt: "settled", closedAt: "verified-handoff" });
  vi.mocked(getMission).mockResolvedValue(mission);
  const update = vi.fn(); const requestWakeup = vi.fn();
  const ctx = { issues: { get: vi.fn().mockResolvedValue({ id: task.issueId, projectId: mission.projectId, assigneeAgentId: "lead", status: "blocked" }), update, requestWakeup } } as unknown as PluginContext;
  await reconcileOrdinaryN2(ctx, mission);
  expect(update).toHaveBeenCalledWith(task.issueId, { status: "done" }, mission.companyId);
  expect(requestWakeup).not.toHaveBeenCalled(); expect(reserveN2Run).not.toHaveBeenCalled();
});
it.each(["unsettled", "foreign-assignee"])("refuses operational correction closure with %s state", async kind => {
  const { mission, task } = fixture(false);
  Object.assign(task, { kind: "correction", agentId: "lead", issueId: "correction-issue", runId: "run", closedAt: "handoff", ...(kind === "unsettled" ? {} : { settledAt: "settled" }) });
  vi.mocked(getMission).mockResolvedValue(mission);
  const update = vi.fn();
  const ctx = { issues: { get: vi.fn().mockResolvedValue({ id: task.issueId, projectId: mission.projectId, assigneeAgentId: "other", status: "blocked" }), update } } as unknown as PluginContext;
  await expect(reconcileOrdinaryN2(ctx, mission)).rejects.toMatchObject({ code: "ordinary_correction_closure" });
  expect(update).not.toHaveBeenCalled();
});
