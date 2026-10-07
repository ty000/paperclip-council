import { describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { finishN1Disposition } from "../src/native-wake-policy.js";

function fixture() {
  const m = { companyId: "company", projectId: "project", rootIssueId: "root", aggregate: {
    nativeWakePolicy: { protocol: "council-native-wake-v1" }, responsibilities: { integrationLeadAgentId: "lead" },
    n1: { rootDispatchRunId: "root-run", candidate: { candidate: "a".repeat(40) }, contributions: [
      { contributionId: "slot", childIssueId: "child", assigneeAgentId: "contributor", commit: "b".repeat(40), authorRunId: "child-run" }] },
  } } as unknown as MissionRecord;
  let issue = { id: "child", parentId: "root" as string | null, companyId: "company", projectId: "project", assigneeAgentId: "contributor", status: "in_progress" };
  const get = vi.fn(async () => ({ ...issue }));
  const update = vi.fn(async (_id, patch) => { issue = { ...issue, ...patch }; return issue; });
  const ctx = { issues: { get, update } } as unknown as PluginContext;
  const input = { params: { issueId: "child" }, actor: { actorType: "agent", agentId: "contributor", runId: "child-run" } } as unknown as PluginApiRequestInput;
  const body = { command: "record-contribution", contributionId: "slot", commit: "b".repeat(40) };
  return { m, ctx, input, body, get, update, issue: (patch: Partial<typeof issue>) => { issue = { ...issue, ...patch }; } };
}

describe("Council native waiting dispositions", () => {
  it("closes a recorded child once without a wake or cost reset, including report replay", async () => {
    const f = fixture(); const before = structuredClone(f.m);
    await finishN1Disposition(f.ctx, f.m, f.input, f.body);
    await finishN1Disposition(f.ctx, f.m, f.input, f.body);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledWith("child", { status: "done" }, "company");
    expect(f.m).toEqual(before);
  });
  it("reconciles a lost status response from readback without another mutation", async () => {
    const f = fixture();
    f.update.mockImplementationOnce(async () => { f.issue({ status: "done" }); throw new Error("lost response"); });
    await expect(finishN1Disposition(f.ctx, f.m, f.input, f.body)).rejects.toThrow("lost response");
    await finishN1Disposition(f.ctx, f.m, f.input, f.body);
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it.each(["run", "commit", "assignee", "project"])("refuses %s drift before changing status", async drift => {
    const f = fixture();
    if (drift === "run") f.input.actor.runId = "other";
    if (drift === "commit") f.body.commit = "c".repeat(40);
    if (drift === "assignee") f.issue({ assigneeAgentId: "other" });
    if (drift === "project") f.issue({ projectId: "other" });
    await expect(finishN1Disposition(f.ctx, f.m, f.input, f.body)).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("parks only the verified candidate from the exact admitted lead", async () => {
    const f = fixture();
    f.issue({ id: "root", parentId: null, assigneeAgentId: "lead" });
    f.input.params.issueId = "root"; f.input.actor.agentId = "lead"; f.input.actor.runId = "root-run";
    await finishN1Disposition(f.ctx, f.m, f.input, { command: "publish" });
    expect(f.update).toHaveBeenCalledWith("root", { status: "blocked" }, "company");
    expect(f.m.aggregate.n1!.candidate).toBeDefined();
  });
  it("does not alter historical missions", async () => {
    const f = fixture(); delete f.m.aggregate.nativeWakePolicy;
    await finishN1Disposition(f.ctx, f.m, f.input, f.body);
    expect(f.get).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
});
