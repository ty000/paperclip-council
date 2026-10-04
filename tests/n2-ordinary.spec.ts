import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/missions.js", async original => ({ ...await original(), getMission: vi.fn() }));
import { getMission, type MissionRecord, canonicalPayloadHash } from "../src/missions.js";
import { ordinaryTask, validateOrdinaryReport } from "../src/n2-ordinary-state.js";
import { reconcileOrdinaryN2 } from "../src/n2-ordinary-runtime.js";
import { inspectN2State } from "../src/n2-missions.js";
import { n3Subject } from "../src/n3-runtime.js";

function fixture() {
  const task = ordinaryTask("council", "submission", "reviewer");
  const submission = { submissionId: "submission", candidateCommit: "a".repeat(40), sha256: "b".repeat(64), evidenceRevision: 1, mandateHash: "c".repeat(64) };
  const mission = { companyId: "company", missionId: "mission", aggregate: { n2: { ordinary: { protocol: "ordinary-cli-v1", tasks: [task] },
    submissions: [submission], activeSubmissionId: "submission", rounds: [], status: "reviewing" },
    responsibilities: { finalReviewerAgentId: "reviewer", integrationLeadAgentId: "lead" }, compositions: { team: { members: [] }, council: { members: [{ agentId: "reviewer" }] } } } } as unknown as MissionRecord;
  return { mission, task, submission };
}
beforeEach(() => vi.resetAllMocks());
it.each(["creation", "wake"])("does not replace an unknown %s effect or release its exposure", async stage => {
  const { mission, task } = fixture();
  task.creation = stage === "creation" ? "claimed" : "confirmed";
  task.issueId = stage === "creation" ? null : "issue";
  task.wake = stage === "wake" ? "claimed" : "pending";
  vi.mocked(getMission).mockResolvedValue(mission);
  const create = vi.fn(); const requestWakeup = vi.fn(); const execute = vi.fn();
  const ctx = { agents: { get: vi.fn().mockResolvedValue({ adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }) },
    issues: { create, requestWakeup }, db: { execute } };
  await expect(reconcileOrdinaryN2(ctx as never, mission)).rejects.toMatchObject({ code: "ordinary_effect_unknown" });
  expect(create).not.toHaveBeenCalled(); expect(requestWakeup).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});
it("requires the exact prepared candidate-bound terminal JSON and exposes ordinary next action", () => {
  const { mission, task, submission } = fixture();
  task.report = { schema: "council-ordinary-result-v1", missionId: "mission", taskId: task.taskId,
    subject: n3Subject(submission as never), verdict: "approved", rationale: "bounded evidence", synthesisHash: canonicalPayloadHash({}) };
  expect(validateOrdinaryReport(mission, task, JSON.stringify(task.report))).toEqual(task.report);
  expect(() => validateOrdinaryReport(mission, task, JSON.stringify({ ...task.report, taskId: "other" }))).toThrow();
  expect(() => validateOrdinaryReport(mission, task, "done")).toThrow();
  expect(inspectN2State(mission)).toMatchObject({ runtimeProfile: "ordinary-cli-v1", nextAction: { actorId: "reviewer" } });
  expect(inspectN2State(mission)!.nextAction.label).toContain("ordinary-verdict");
});
