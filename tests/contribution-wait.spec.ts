import { expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { ensureContributionWait, finishContributionWait } from "../src/contribution-wait.js";

function fixture() {
  const m = { missionId: "mission", companyId: "company", projectId: "project", aggregate: { n1: { contributions: [
    { contributionId: "slot", childIssueId: "child", dispatchRunId: "run", authorRunId: "run", commit: "commit", proof: {} },
  ] } } } as unknown as MissionRecord;
  let wait: any = null, status = "in_progress", blockers = [{ id: "predecessor", status: "done" }];
  const trace: string[] = [];
  const create = vi.fn(async (input: any) => { trace.push("create"); wait = { ...input, id: "wait" }; return wait; });
  const update = vi.fn(async (id: string, patch: any) => { trace.push(`update:${id}:${patch.status}`); wait = { ...wait, ...patch }; return wait; });
  const addBlockers = vi.fn(async (_id, ids: string[]) => { trace.push("dependency"); blockers.push(...ids.map(id => ({ id, status: "backlog" }))); });
  const removeBlockers = vi.fn(async (_id, ids: string[]) => { trace.push("remove-dependency"); blockers = blockers.filter(b => !ids.includes(b.id)); });
  const ctx = { issues: { create, update, get: async (id: string) => id === "child" ? { id, status } : wait,
    list: async () => wait ? [wait] : [], relations: { get: async () => ({ blockedBy: blockers }), addBlockers, removeBlockers } } } as unknown as PluginContext;
  const persist = vi.fn(async (current, aggregate) => { trace.push("persist"); Object.assign(m, current, { aggregate }); return m; });
  return { m, ctx, persist, trace, create, update, addBlockers, done: () => { status = "done"; trace.push("child:done"); }, lose: () => { wait = null; } };
}

it("persists one settlement task, preserves the predecessor, and closes it only after the child", async () => {
  const f = fixture();
  await ensureContributionWait(f.ctx, f.m, "slot", f.persist);
  await ensureContributionWait(f.ctx, f.m, "slot", f.persist);
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.addBlockers).toHaveBeenCalledTimes(1);
  expect(f.trace).toEqual(["persist", "create", "dependency", "persist"]);
  expect(f.create.mock.calls[0]![0]).toMatchObject({ status: "backlog" });
  expect(f.create.mock.calls[0]![0].assigneeAgentId).toBeUndefined();
  expect((await f.ctx.issues.relations.get("child", "company")).blockedBy.map(b => b.id)).toEqual(["predecessor", "wait"]);
  await expect(finishContributionWait(f.ctx, f.m, "slot")).rejects.toThrow("Close the verified contribution");
  expect(f.update).not.toHaveBeenCalled();
  f.done();
  await finishContributionWait(f.ctx, f.m, "slot");
  await finishContributionWait(f.ctx, f.m, "slot");
  expect(f.update).toHaveBeenCalledTimes(1);
  expect(f.trace.slice(-3)).toEqual(["child:done", "remove-dependency", "update:wait:done"]);
  expect((await f.ctx.issues.relations.get("child", "company")).blockedBy.map(b => b.id)).toEqual(["predecessor"]);
});

it("correlates a lost creation response without creating another task", async () => {
  const f = fixture(), create = f.create.getMockImplementation()!;
  f.create.mockImplementationOnce(async input => { await create(input); throw new Error("lost response"); });
  await ensureContributionWait(f.ctx, f.m, "slot", f.persist);
  expect(f.m.aggregate.n1).toMatchObject({ contributions: [{ nativeWait: { issueId: "wait" } }] });
  expect(f.create).toHaveBeenCalledTimes(1);
});

it("retains an unknown creation rather than recreating a vanished wait", async () => {
  const f = fixture();
  f.create.mockImplementationOnce(async () => { throw new Error("unobserved create"); });
  await expect(ensureContributionWait(f.ctx, f.m, "slot", f.persist)).rejects.toThrow("original Council settlement task");
  await expect(ensureContributionWait(f.ctx, f.m, "slot", f.persist)).rejects.toThrow("original Council settlement task");
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.addBlockers).not.toHaveBeenCalled();
});

it("does not introduce a wait into previously delivered missions during closure", async () => {
  const f = fixture();
  await finishContributionWait(f.ctx, f.m, "slot");
  expect(f.create).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
});
