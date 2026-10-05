import { beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
vi.mock("../src/model-variants.js", () => ({ inspectVariant: vi.fn() }));
vi.mock("../src/g4-native.js", async original => ({ ...await original(), readOrdinaryRun: vi.fn() }));
vi.mock("../src/model-history.js", () => ({ collectInterventionHistory: vi.fn(), publishInterventionHistory: vi.fn() }));
import { inspectVariant } from "../src/model-variants.js";
import { readOrdinaryRun } from "../src/g4-native.js";
import { collectInterventionHistory, publishInterventionHistory } from "../src/model-history.js";
import { MODEL_CATALOGUE } from "../src/model-catalogue.js";
import { contributionModelFamily, bindVariantIssue, claimVariantWake, prepareVariantLaunch, recordVariantWake, observeVariantRun } from "../src/model-runtime.js";
import { modelLaunch, modelMeasurements, physicalAgent } from "../src/model-state.js";

function fixture() {
  let stored = { companyId: "company", missionId: "mission", rootIssueId: "root", version: 1,
    aggregate: { modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [] }, journal: [] } } as unknown as MissionRecord;
  let assigned = "logical"; let description = "";
  const config = { modelProfileMapping: structuredClone(MODEL_CATALOGUE) };
  const timeline: string[] = [];
  const ctx = {
    config: { get: vi.fn(async () => config) },
    db: { namespace: "council", execute: vi.fn(async (_sql: string, p: unknown[]) => {
      if (p[3] !== stored.version) return { rowCount: 0 };
      stored = { ...stored, version: stored.version + 1, aggregate: JSON.parse(String(p[0])) };
      timeline.push("saved"); return { rowCount: 1 };
    }) },
    issues: {
      get: vi.fn(async () => ({ id: "issue", companyId: "company", assigneeAgentId: assigned, description, status: "backlog", checkoutRunId: null, executionRunId: null })),
      summaries: { getOrchestration: vi.fn(async () => ({ runs: [] })) },
      update: vi.fn(async (_id: string, patch: { assigneeAgentId?: string; description?: string }) => {
        if (patch.assigneeAgentId) {
          expect(modelLaunch(stored, "launch-1")?.state).toBe("assignment_claimed");
          timeline.push("assign"); assigned = patch.assigneeAgentId;
        }
        if (patch.description !== undefined) description = patch.description;
        return { id: "issue", assigneeAgentId: assigned, description };
      }), requestWakeup: vi.fn(),
    },
  };
  const input = { taskKey: "root", interventionKey: "lead", launchKey: "launch-1", logicalAgentId: "logical", family: "orchestration" as const, expectedRoles: ["lead"] as const };
  return { ctx: ctx as unknown as PluginContext, mocks: ctx, config, timeline, input, get: () => stored };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logical, profile, revision) => ({
    agentId: `physical-${profile}`, logicalAgentId: logical, roleKey: logical === "reviewer" ? "generalist-reviewer" : "lead", profileId: profile, revision: revision!, ready: true, expected: {}, observed: {}, gaps: [],
  }));
  vi.mocked(readOrdinaryRun).mockImplementation(async (_ctx, input) => ({ id: input.runId, companyId: input.companyId, agentId: input.agentId,
    status: "succeeded", nativeIssueId: "", startedAt: "2026-10-05T10:00:00Z", finishedAt: "2026-10-05T10:00:03Z", contextSnapshot: { issueId: input.issueId },
    usageJson: { usageSource: "per_run", inputTokens: 20, outputTokens: 7 } }));
  vi.mocked(collectInterventionHistory).mockResolvedValue({ cutoff: "2026-10-05T11:00:00Z", parts: [], gaps: [{ source: "comments", reason: "deleted" }] } as never);
  vi.mocked(publishInterventionHistory).mockResolvedValue({ indexKey: "history-index", indexSha256: "hash", parts: [] });
});
async function start(f: ReturnType<typeof fixture>) {
  const prepared = await prepareVariantLaunch(f.ctx, f.get(), f.input);
  let m = await bindVariantIssue(f.ctx, prepared.mission, f.input.launchKey, "issue");
  m = await claimVariantWake(f.ctx, m, f.input.launchKey);
  return recordVariantWake(f.ctx, m, f.input.launchKey, "run-1");
}
it("persists the physical binding before assignment and pins replay independently of new config", async () => {
  const f = fixture();
  const m = await start(f);
  expect(f.timeline.indexOf("saved")).toBeLessThan(f.timeline.indexOf("assign"));
  expect(physicalAgent(m, "logical", { issueId: "issue", runId: "run-1" })).toBe("physical-sol-medium");
  f.config.modelProfileMapping.revision = "2";
  f.config.modelProfileMapping.families.find(r => r.id === "orchestration")!.defaultProfile = "astra-high";
  const replay = await prepareVariantLaunch(f.ctx, m, f.input);
  expect(replay.binding).toMatchObject({ agentId: "physical-sol-medium", mappingRevision: "1", runId: "run-1" });
  expect(f.mocks.issues.update).toHaveBeenCalledTimes(2);
  const fresh = await prepareVariantLaunch(f.ctx, m, { ...f.input, taskKey: "new-task", launchKey: "launch-2" });
  expect(fresh.binding).toMatchObject({ profileId: "astra-high", mappingRevision: "2", ascent: false });
});
it("retains unknown outcomes and refuses replacement identities without another native effect", async () => {
  const f = fixture();
  let m = (await prepareVariantLaunch(f.ctx, f.get(), f.input)).mission;
  m = await bindVariantIssue(f.ctx, m, "launch-1", "issue");
  m = await claimVariantWake(f.ctx, m, "launch-1");
  m = await recordVariantWake(f.ctx, m, "launch-1", null);
  await expect(prepareVariantLaunch(f.ctx, m, f.input)).rejects.toMatchObject({ code: "model_effect_unknown" });
  await expect(prepareVariantLaunch(f.ctx, m, { ...f.input, launchKey: "replacement" })).rejects.toMatchObject({ code: "model_previous_unknown" });
  expect(f.mocks.issues.update).toHaveBeenCalledTimes(2); expect(f.mocks.issues.requestWakeup).not.toHaveBeenCalled();
});
it("replays bound callbacks without a new version and never degrades known results after a lost wake response", async () => {
  const f = fixture(); const m = await start(f); const count = f.mocks.db.execute.mock.calls.length;
  expect(await recordVariantWake(f.ctx, m, "launch-1", "run-1")).toBe(m);
  expect(await recordVariantWake(f.ctx, m, "launch-1", null)).toBe(m);
  await expect(recordVariantWake(f.ctx, m, "launch-1", "run-other")).rejects.toMatchObject({ code: "model_run_conflict" });
  expect(f.mocks.db.execute).toHaveBeenCalledTimes(count);
});
it("shares one ascent across interventions while allowing another intervention's stronger initial profile", async () => {
  const f = fixture(); let m = await start(f);
  m.aggregate.modelSelection!.choices.push({ taskKey: "root", interventionKey: "lead", family: "orchestration", profileId: "sol-high", rationale: "hard correction", authority: "user", actorId: "owner", at: "now" });
  m = (await prepareVariantLaunch(f.ctx, m, { ...f.input, launchKey: "launch-2" })).mission;
  expect(modelLaunch(m, "launch-2")).toMatchObject({ ascent: true, previousLaunchKey: "launch-1" });
  m.aggregate.modelSelection!.choices.push({ taskKey: "root", interventionKey: "reviewer", family: "review", profileId: "sol-high", rationale: "sensitive review", authority: "lead", actorId: "logical", at: "now" });
  m = (await prepareVariantLaunch(f.ctx, m, { ...f.input, logicalAgentId: "reviewer", interventionKey: "reviewer", launchKey: "review-1", expectedRoles: ["generalist-reviewer"] })).mission;
  expect(modelLaunch(m, "review-1")!.ascent).toBe(false);
  const reviewer = modelLaunch(m, "review-1")!; reviewer.state = "bound"; reviewer.runId = "review-run"; reviewer.issueId = "review-issue";
  m.aggregate.modelSelection!.choices.find(c => c.interventionKey === "reviewer")!.profileId = "astra-high";
  m.aggregate.modelSelection!.choices.find(c => c.interventionKey === "reviewer")!.at = "later";
  await expect(prepareVariantLaunch(f.ctx, m, { ...f.input, logicalAgentId: "reviewer", interventionKey: "reviewer", launchKey: "review-2", expectedRoles: ["generalist-reviewer"] })).rejects.toMatchObject({ code: "model_ascent_limit" });
});
it.each(["running", "failed", "cancelled"])("does not ascend after a %s run", async status => {
  const f = fixture(); const m = await start(f);
  vi.mocked(readOrdinaryRun).mockResolvedValue({ status, finishedAt: status === "running" ? null : "now", usageJson: { usageSource: "per_run" } } as never);
  await expect(prepareVariantLaunch(f.ctx, m, { ...f.input, launchKey: "attempt-2" })).rejects.toMatchObject({ code: "model_previous_unsettled" });
});
it("preserves detailed history and gaps before the ascent becomes launchable", async () => {
  const f = fixture(); let m = await start(f);
  m.aggregate.modelSelection!.choices.push({ taskKey: "root", interventionKey: "lead", family: "orchestration", profileId: "sol-high", rationale: "hard correction", authority: "user", actorId: "owner", at: "now" });
  m = (await prepareVariantLaunch(f.ctx, m, { ...f.input, launchKey: "launch-2" })).mission;
  let description = "";
  f.mocks.issues.update.mockImplementation(async (_id, patch) => { description = patch.description ?? description; return { id: "issue", assigneeAgentId: "physical-sol-high", description }; });
  f.mocks.issues.get.mockImplementation(async () => ({ id: "issue", companyId: "company", assigneeAgentId: "physical-sol-high", description, status: "backlog", checkoutRunId: null, executionRunId: null }));
  vi.mocked(publishInterventionHistory).mockRejectedValueOnce(new Error("publication response lost"));
  await expect(bindVariantIssue(f.ctx, m, "launch-2", "issue")).rejects.toThrow("publication response lost");
  expect(modelLaunch(f.get(), "launch-2")!.historyArchive).toBeDefined();
  m = await bindVariantIssue(f.ctx, f.get(), "launch-2", "issue");
  expect(collectInterventionHistory).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ runs: [{ runId: "run-1", issueId: "issue", agentId: "physical-sol-medium" }] }));
  expect(modelLaunch(m, "launch-2")).toMatchObject({ state: "ready", history: { indexKey: "history-index", gapCount: 1 } });
  expect(modelLaunch(m, "launch-2")!.historyArchive).toBeUndefined();
  expect(modelLaunch(m, "launch-2")!.history?.indexSha256).toBe("hash");
  expect(collectInterventionHistory).toHaveBeenCalledTimes(1);
});
it.each(["active", "override"])("blocks %s issue before changing the assignee", async blocker => {
  const f = fixture(); const m = (await prepareVariantLaunch(f.ctx, f.get(), f.input)).mission;
  if (blocker === "active") f.mocks.issues.summaries.getOrchestration.mockResolvedValue({ runs: [{ status: "running" }] } as never);
  else f.mocks.issues.get.mockResolvedValue({ id: "issue", companyId: "company", assigneeAgentId: "logical", assigneeAdapterOverrides: { model: "other" } } as never);
  await expect(bindVariantIssue(f.ctx, m, "launch-1", "issue")).rejects.toMatchObject({ code: blocker === "active" ? "model_issue_active" : "model_override_conflict" });
  expect(f.mocks.issues.update).not.toHaveBeenCalled();
});
it("a concurrent winner blocks a second selection CAS", async () => {
  const f = fixture(); const original = f.get();
  await prepareVariantLaunch(f.ctx, original, f.input);
  await expect(prepareVariantLaunch(f.ctx, original, { ...f.input, launchKey: "racing" })).rejects.toMatchObject({ code: "model_version_conflict" });
  expect(f.mocks.issues.update).not.toHaveBeenCalled();
});
it("records terminal input/output and duration once without affecting admission", async () => {
  const f = fixture(); let m = await start(f);
  m = await observeVariantRun(f.ctx, m, "launch-1");
  expect(modelMeasurements(m)).toEqual([{ taskKey: "root", runCount: 1, inputTokens: 20, outputTokens: 7, durationMs: 3000 }]);
  expect(await observeVariantRun(f.ctx, m, "launch-1")).toBe(m);
});
it("historical missions never read catalogue configuration or provision variants", async () => {
  const f = fixture(); const m = f.get(); delete m.aggregate.modelSelection;
  expect(await prepareVariantLaunch(f.ctx, m, f.input)).toEqual({ mission: m, binding: null });
  expect(await bindVariantIssue(f.ctx, m, "launch-1", "issue")).toBe(m);
  expect(inspectVariant).not.toHaveBeenCalled(); expect(f.mocks.config.get).not.toHaveBeenCalled();
});

it.each(["missing", "paused", "pending_approval", "blocked", "unknown"])("never substitutes a model based on %s configuration state", async availability => {
  const f = fixture();
  f.config.modelProfileMapping.unavailabilityAlternatives = { "sol-medium": "sol-high" };
  vi.mocked(inspectVariant).mockResolvedValue({ agentId: null, roleKey: "lead", ready: false, observed: { availability, accountAvailability: "not_validated_live" }, gaps: [availability] } as never);
  await expect(prepareVariantLaunch(f.ctx, f.get(), f.input)).rejects.toMatchObject({ code: "model_variant_unavailable" });
  expect(inspectVariant).toHaveBeenCalledTimes(1);
  expect(f.mocks.db.execute).not.toHaveBeenCalled();
  expect(f.mocks.issues.update).not.toHaveBeenCalled();
});

it("requires an exact durable binding for an opted-in run or launch, preserving historical identities", () => {
  const f = fixture(); const m = f.get();
  expect(() => physicalAgent(m, "logical", { runId: "unbound" })).toThrow("exact persisted");
  expect(() => physicalAgent(m, "logical", { launchKey: "unbound" })).toThrow("exact persisted");
  expect(physicalAgent(m, "logical", { issueId: "not-started" })).toBe("logical");
  delete m.aggregate.modelSelection;
  expect(physicalAgent(m, "logical", { runId: "old-run" })).toBe("logical");
});
it("rejects a ready variant carrying the wrong charter before recording or assigning it", async () => {
  const f = fixture();
  vi.mocked(inspectVariant).mockResolvedValue({ ready: true, agentId: "reviewer", roleKey: "security-reviewer", observed: {}, gaps: [] } as never);
  await expect(prepareVariantLaunch(f.ctx, f.get(), f.input)).rejects.toMatchObject({ code: "model_role_mismatch" });
  expect(f.mocks.db.execute).not.toHaveBeenCalled(); expect(f.mocks.issues.update).not.toHaveBeenCalled();
});

it("refuses an external callback before the durable wake claim without changing the launch", async () => {
  const f = fixture();
  const prepared = await prepareVariantLaunch(f.ctx, f.get(), f.input);
  const ready = await bindVariantIssue(f.ctx, prepared.mission, f.input.launchKey, "issue");
  const writes = f.mocks.db.execute.mock.calls.length;
  await expect(recordVariantWake(f.ctx, ready, "launch-1", "manually-started-run")).rejects.toMatchObject({ code: "model_launch_not_ready" });
  expect(modelLaunch(f.get(), "launch-1")).toMatchObject({ state: "ready", runId: null });
  expect(f.mocks.db.execute).toHaveBeenCalledTimes(writes);
  const claimed = await claimVariantWake(f.ctx, ready, "launch-1");
  const bound = await recordVariantWake(f.ctx, claimed, "launch-1", "authorized-run");
  expect(modelLaunch(bound, "launch-1")).toMatchObject({ state: "bound", runId: "authorized-run" });
});
it("rejects a chosen family outside the contributor charter even when its physical profile exists", async () => {
  const f = fixture();
  const implementation = f.config.modelProfileMapping.families.find(row => row.id === "implementation")!;
  implementation.allowedProfiles = ["sol-medium"];
  f.get().aggregate.modelSelection!.choices.push({ taskKey: "root", interventionKey: "lead", family: "diagnosis", profileId: "sol-high", rationale: "Incorrect classification", authority: "lead", actorId: "lead", at: "now" });
  vi.mocked(inspectVariant).mockResolvedValue({ ready: true, roleKey: "contributor-1", agentId: "contributor-high", observed: {}, gaps: [] } as never);
  await expect(prepareVariantLaunch(f.ctx, f.get(), { ...f.input, family: "implementation", expectedRoles: ["contributor-1"] }))
    .rejects.toMatchObject({ code: "model_role_family_mismatch" });
  expect(f.mocks.db.execute).not.toHaveBeenCalled(); expect(f.mocks.issues.update).not.toHaveBeenCalled();
});
it("permits a supported explicit classification for a multi-family facilitator", async () => {
  const f = fixture();
  f.get().aggregate.modelSelection!.choices.push({ taskKey: "root", interventionKey: "lead", family: "synthesis", profileId: "terra-low", rationale: "Bounded synthesis", authority: "lead", actorId: "lead", at: "now" });
  vi.mocked(inspectVariant).mockResolvedValue({ ready: true, roleKey: "facilitator", agentId: "facilitator-terra", observed: {}, gaps: [] } as never);
  const result = await prepareVariantLaunch(f.ctx, f.get(), { ...f.input, expectedRoles: ["facilitator"] });
  expect(result.binding).toMatchObject({ family: "synthesis", profileId: "terra-low", roleKey: "facilitator" });
});
it.each([["test", "validation"], ["design", "design"], ["contributor-1", "implementation"], ["executor", "implementation"]] as const)
  ("defaults N1 role %s to %s through its exact managed anchor", async (roleKey, family) => {
    const f = fixture();
    vi.mocked(inspectVariant).mockResolvedValue({ ready: true, roleKey, agentId: "physical", observed: {}, gaps: [] } as never);
    const selectedFamily = await contributionModelFamily(f.ctx, f.get(), "logical");
    expect(selectedFamily).toBe(family);
    expect(inspectVariant).toHaveBeenCalledWith(f.ctx, "company", "logical", "sol-medium", "1");
    const result = await prepareVariantLaunch(f.ctx, f.get(), { ...f.input, family: selectedFamily, expectedRoles: [roleKey] });
    expect(result.binding).toMatchObject({ family, profileId: "sol-medium" });
  });
