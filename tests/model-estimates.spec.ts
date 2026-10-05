import { expect, it } from "vitest";
import { modelEstimates } from "../src/model-estimates.js";
import type { ModelLaunch } from "../src/model-state.js";

function launch(runId: string, changes: Partial<ModelLaunch> = {}): ModelLaunch {
  return { taskKey: "task-1", interventionKey: "review-1", launchKey: `launch-${runId}`, logicalAgentId: "logical-1", agentId: "physical-1", roleKey: "generalist-reviewer",
    family: "review", profileId: "sol-high", requestedProfileId: "sol-high", rationale: "fixture", authority: "lead", mappingRevision: "1", variantRevision: "1",
    selectedAt: "2026-10-05T00:00:00Z", state: "bound", issueId: "issue-1", runId, ascent: false,
    measurement: { runId, status: "succeeded", inputTokens: 100, outputTokens: 20, durationMs: 1000, observedAt: "2026-10-05T00:01:00Z" }, ...changes };
}

it("averages successful comparable runs once without mutating the supplied history", () => {
  const first = launch("run-1");
  const second = launch("run-2", { measurement: { ...first.measurement!, runId: "run-2", inputTokens: 300, outputTokens: 60, durationMs: 3000 } });
  const history = [first, second, structuredClone(first)]; const before = structuredClone(history);
  expect(modelEstimates(history)).toEqual([{ roleKey: "generalist-reviewer", family: "review", profileId: "sol-high", mappingRevision: "1", variantRevision: "1",
    sampleCount: 2, inputTokens: 200, outputTokens: 40, durationMs: 2000 }]);
  expect(history).toEqual(before);
});

it.each([
  { roleKey: "security-reviewer" }, { family: "diagnosis" }, { profileId: "astra-high" }, { mappingRevision: "2" }, { variantRevision: "2" },
] satisfies Partial<ModelLaunch>[])("does not mix a changed comparison dimension %j", dimension => {
  const estimates = modelEstimates([launch("run-1"), launch("run-2", dimension)]);
  expect(estimates).toHaveLength(2); expect(estimates.every(row => row.sampleCount === 1)).toBe(true);
});

it("leaves a group uncalibrated when no known successful bound run is comparable", () => {
  const failed = launch("failed"); failed.measurement!.status = "failed";
  const running = launch("running"); running.measurement!.status = "running";
  const mismatch = launch("actual"); mismatch.measurement!.runId = "foreign";
  const result = modelEstimates([failed, running, mismatch, launch("unknown", { state: "unknown" }), launch("no-measurement", { measurement: undefined })]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ sampleCount: 0, inputTokens: null, outputTokens: null, durationMs: null });
  expect(modelEstimates([])).toEqual([]);
});

it("keeps absent or invalid metrics null rather than imputing zero", () => {
  const incomplete = launch("run-2"); incomplete.measurement!.outputTokens = null; incomplete.measurement!.durationMs = Number.NaN;
  expect(modelEstimates([launch("run-1"), incomplete])[0]).toMatchObject({ sampleCount: 2, inputTokens: 100, outputTokens: null, durationMs: null });
  const zeros = launch("zeros"); zeros.measurement = { ...zeros.measurement!, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  expect(modelEstimates([zeros])[0]).toMatchObject({ sampleCount: 1, inputTokens: 0, outputTokens: 0, durationMs: 0 });
});

it("excludes contradictory duplicate run identities or measurements independent of ordering", () => {
  const first = launch("run-1");
  const otherRole = launch("run-1", { roleKey: "security-reviewer" });
  const changedMetric = launch("run-1"); changedMetric.measurement!.inputTokens = 999;
  const changedStatus = launch("run-1"); changedStatus.measurement!.status = "failed";
  for (const conflict of [otherRole, changedMetric, changedStatus, launch("run-1", { state: "unknown" })]) {
    const rows = [first, conflict, first];
    expect(modelEstimates(rows)).toEqual(modelEstimates([...rows].reverse()));
    expect(modelEstimates(rows).every(row => row.sampleCount === 0)).toBe(true);
  }
});
