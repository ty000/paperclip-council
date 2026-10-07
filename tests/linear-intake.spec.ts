import { describe, expect, it, vi } from "vitest";
import { linearFixture } from "./linear-intake-fixture.js";
import { readLinearIntake } from "../src/linear-intake-validation.js";
import { linearMissionObjective, prepareLinearTasks } from "../src/linear-intake-preparation.js";
import { parseLinearIntakePolicy, type LinearPreparation } from "../src/linear-intake-contract.js";
import { prepareHierarchy } from "../src/hierarchy-intake.js";
import { assertHierarchySources } from "../src/hierarchy-runtime.js";
import type { MissionRecord } from "../src/missions.js";

const roster = vi.hoisted(() => ({ ids: {} as Record<string, string> }));
vi.mock("../src/rosters.js", () => ({ validateRosterPair: async () => ({ eligible: true,
  team: { head: { publishedRevision: "team-v1" }, revision: { content: { members: [roster.ids.lead, roster.ids.a, roster.ids.b].map(agentId => ({ agentId })) } } } }) }));

async function setup() {
  const f = linearFixture(); roster.ids = f.ids;
  const snapshot = await readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory());
  let state: LinearPreparation = { snapshot, effects: {} };
  const persist = vi.fn(async (next: LinearPreparation) => { state = structuredClone(next); });
  const guard = vi.fn(async () => {});
  return { ...f, snapshot, persist, guard, state: () => structuredClone(state) };
}
describe("strict Linear readiness receiver", () => {
  it("uses supported company-scoped originId reads while the host rejects a foreign plugin origin filter", async () => {
    const f = linearFixture();
    await expect(f.ctx.issues.list({ companyId: f.ids.company!, originKind: "plugin:ty000.linear-intake", limit: 2 }))
      .rejects.toThrow("Plugin may only use originKind values under plugin:private.paperclip-council");
    f.list.mockClear();
    await expect(readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory())).resolves.toHaveProperty("subject.nativeRootId", f.ids.root);
    expect(f.list).toHaveBeenCalledTimes(f.issues.size);
    for (const [input] of f.list.mock.calls) expect(input).toEqual({ companyId: f.ids.company,
      originId: expect.stringMatching(/^linear:/), includePluginOperations: true, limit: 2 });
  });
  it("keeps an originId collision in another project ambiguous instead of limiting uniqueness to this project", async () => {
    const f = linearFixture();
    const duplicate = { ...f.issues.get(f.ids.alpha!)!, id: f.ids.catalog, projectId: f.ids.sourceProject };
    f.issues.set(duplicate.id, duplicate);
    const projectInventory = f.inventory().filter(issue => issue.projectId === f.ids.project);
    await expect(readLinearIntake(f.ctx, f.policy, f.ids.root!, projectInventory)).rejects.toMatchObject({ code: "linear_origin_ambiguous" });
    expect(f.update).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it("requires explicit project scope, mapped actors and safe paths without enabling legacy mandates", () => {
    const f = linearFixture(), policy = f.policy.content, actors = [f.ids.a!, f.ids.b!];
    expect(parseLinearIntakePolicy(undefined, policy, actors)).toBeUndefined();
    expect(parseLinearIntakePolicy(policy.linearIntake, policy, actors)).toEqual(policy.linearIntake);
    const invalid = structuredClone(policy.linearIntake!); invalid.work[f.ids["source-alpha"]!]!.ownedPaths = ["../outside"];
    expect(() => parseLinearIntakePolicy(invalid, policy, actors)).toThrow();
    expect(() => parseLinearIntakePolicy(policy.linearIntake, policy, [f.ids.lead!])).toThrow();
    expect(() => parseLinearIntakePolicy(policy.linearIntake, { ...policy, criteriaSource: "task-document" }, actors)).toThrow();
  });
  it("reads complete source documents, selected subtree and historical nodes with exact effect/plan digests", async () => {
    const f = await setup();
    expect(f.snapshot.nodes.map(node => node.role)).toEqual(["root", "contribution", "contribution", "historical", "historical"]);
    expect(f.snapshot.nodes[0]!.parentId).toBeNull();
    expect(f.snapshot.nodes[0]!.description.length).toBeGreaterThan(30_000);
    const objective = linearMissionObjective(f.state());
    expect(objective.length).toBeLessThanOrEqual(4000); expect(objective).toContain(f.snapshot.nodes[0]!.sourceRevisionId);
    expect(f.snapshot.subject.readinessRevisionId).toBe(f.readinessDocument.latestRevisionId);
    expect(f.update).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it.each(["company", "project", "origin", "description", "assignment", "lock", "archive"])("refuses native %s drift before effects", async kind => {
    const f = linearFixture(), issue = f.issues.get(f.ids.alpha!)!;
    if (kind === "company") issue.companyId = f.ids.organization;
    if (kind === "project") issue.projectId = f.ids.sourceProject;
    if (kind === "origin") issue.originKind = "manual";
    if (kind === "description") issue.description += "changed";
    if (kind === "assignment") issue.assigneeAgentId = f.ids.a;
    if (kind === "lock") issue.executionRunId = f.ids.a;
    if (kind === "archive") issue.archivedAt = new Date().toISOString();
    await expect(readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory())).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();
  });
  it.each(["digest", "missing-effect", "duplicate-effect", "missing-issue", "extra-child", "external-blocker", "document-revision", "mapping"])("refuses incomplete or inconsistent %s", async kind => {
    const f = linearFixture();
    if (kind === "digest") f.readiness.planSha256 = "a".repeat(64);
    if (kind === "missing-effect") f.readiness.effects.pop();
    if (kind === "duplicate-effect") f.readiness.effects[1] = f.readiness.effects[0];
    if (kind === "missing-issue") f.issues.delete(f.ids.beta!);
    if (kind === "extra-child") f.issues.set("extra", { id: "extra", parentId: f.ids.root });
    if (kind === "external-blocker") f.readiness.externalBlockers.push({ reference: "outside" });
    if (kind === "document-revision") f.documents.get(f.docKey(f.ids.alpha!, "linear-source-v1")).latestRevisionNumber++;
    if (kind === "mapping") delete f.policy.content.linearIntake!.work[f.ids["source-alpha"]!];
    f.refreshReadiness();
    await expect(readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory())).rejects.toThrow();
  });
  it("rejects a terminal parent with active descendants and a family with no executable descendant", async () => {
    const terminal = linearFixture([{ name: "root", parent: null, status: "blocked", blockers: [] },
      { name: "history", parent: "root", status: "cancelled", blockers: [] }, { name: "alpha", parent: "history", status: "blocked", blockers: [] }]);
    await expect(readLinearIntake(terminal.ctx, terminal.policy, terminal.ids.root!, terminal.inventory())).rejects.toMatchObject({ code: "linear_terminal_parent_active_child" });
    const empty = linearFixture([{ name: "root", parent: null, status: "blocked", blockers: [] }, { name: "history", parent: "root", status: "done", blockers: [] }]);
    await expect(readLinearIntake(empty.ctx, empty.policy, empty.ids.root!, empty.inventory())).rejects.toMatchObject({ code: "linear_no_executable_descendant" });
  });
  it("rejects cyclic native blockers before assigning tasks", async () => {
    const f = linearFixture([{ name: "root", parent: null, status: "blocked", blockers: [] },
      { name: "alpha", parent: "root", status: "blocked", blockers: ["beta"] }, { name: "beta", parent: "root", status: "blocked", blockers: ["alpha"] }]);
    await expect(readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory())).rejects.toMatchObject({ code: "linear_dependency_pending" });
  });
});

describe("durable Council-only preparation", () => {
  it("accepts omitted native archive enrichment without treating it as an execution lock", async () => {
    const f = await setup();
    expect(await f.ctx.issues.get(f.ids.root!, f.ids.company!)).not.toHaveProperty("archivedAt");
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).resolves.toHaveProperty("effects");
    expect(f.update).toHaveBeenCalledTimes(3); expect(f.upsert).toHaveBeenCalledTimes(2);
  });
  it.each(["assigneeUserId", "checkoutRunId", "executionRunId", "executionLockedAt", "archivedAt"])("rejects a newly present %s before any preparation intent or native effect", async field => {
    const f = await setup(); f.issues.get(f.ids.root!)![field] = f.ids.a;
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).rejects.toMatchObject({ code: "linear_preparation_execution" });
    expect(f.persist).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it.each(["assigneeUserId", "checkoutRunId", "executionRunId", "executionLockedAt"])("refuses missing required native %s rather than broadening execution guards", async field => {
    const f = await setup(); delete f.issues.get(f.ids.root!)![field];
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).rejects.toMatchObject({ code: "linear_preparation_execution" });
    expect(f.persist).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it("persists claims before atomic backlog/assignment and preserves full source plus historical state", async () => {
    const f = await setup(), original = structuredClone([...f.documents]);
    const dispatch = f.update.getMockImplementation()!;
    f.update.mockImplementation(async (id, body) => { expect(f.state().effects[`assignment:${id}`]?.state).toBe("claimed"); return dispatch(id, body); });
    const prepared = await prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard);
    expect(f.update.mock.calls.map(call => call[1])).toEqual([
      { status: "backlog", assigneeAgentId: f.ids.lead }, { status: "backlog", assigneeAgentId: f.ids.a }, { status: "backlog", assigneeAgentId: f.ids.b }]);
    expect(f.issues.get(f.ids.history!)!.status).toBe("cancelled"); expect(f.issues.get(f.ids.completed!)!.status).toBe("done");
    expect(f.issues.get(f.ids.history!)!.assigneeAgentId).toBeNull();
    for (const [key, value] of original) expect(f.documents.get(key)).toEqual(value);
    await expect(readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory(), prepared)).resolves.toEqual(f.snapshot);
    await prepareLinearTasks(f.ctx, prepared, f.persist, f.guard);
    expect(f.update).toHaveBeenCalledTimes(3); expect(f.upsert).toHaveBeenCalledTimes(2);
  });
  it.each(["assignment", "document"])("reconciles a lost %s response without a second native write", async kind => {
    const f = await setup();
    if (kind === "assignment") { const dispatch = f.update.getMockImplementation()!; f.update.mockImplementationOnce(async (...args) => { await dispatch(...args); throw new Error("lost response"); }); }
    else { const dispatch = f.upsert.getMockImplementation()!; f.upsert.mockImplementationOnce(async (...args) => { await dispatch(...args); throw new Error("lost response"); }); }
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).rejects.toThrow("lost response");
    await prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard);
    expect(f.update).toHaveBeenCalledTimes(3); expect(f.upsert).toHaveBeenCalledTimes(2);
  });
  it.each(["assignment", "document"])("keeps absent claimed %s unresolved and never redispatches", async kind => {
    const f = await setup();
    if (kind === "assignment") f.update.mockRejectedValue(new Error("unknown outcome"));
    else f.upsert.mockRejectedValue(new Error("unknown outcome"));
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).rejects.toThrow();
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).rejects.toMatchObject({ code: "linear_preparation_unknown" });
    expect(kind === "assignment" ? f.update : f.upsert).toHaveBeenCalledTimes(1);
  });
  it("stops before any native write when the durable claim or current authority fails", async () => {
    const f = await setup(); f.persist.mockRejectedValueOnce(new Error("CAS conflict"));
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).rejects.toThrow("CAS conflict");
    f.guard.mockRejectedValueOnce(new Error("source expired"));
    await expect(prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard)).rejects.toThrow("source expired");
    expect(f.update).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it("pins historical branches and immutable source revisions throughout the reused hierarchy", async () => {
    const f = await setup(); await prepareLinearTasks(f.ctx, f.state(), f.persist, f.guard);
    const hierarchy = await prepareHierarchy(f.ctx, f.policy, f.ids.root!, f.inventory(), f.snapshot);
    expect(hierarchy!.leaves!.map(node => node.issueId)).toEqual([f.ids.alpha, f.ids.beta]);
    expect(hierarchy!.nodes!.find(node => node.issueId === f.ids.history)!.historicalStatus).toBe("cancelled");
    const m = { companyId: f.ids.company, projectId: f.ids.project, rootIssueId: f.ids.root,
      aggregate: { hierarchy, projectMandate: { linearIntake: { subject: f.snapshot.subject, bodySha256: f.snapshot.bodySha256 } } } } as MissionRecord;
    await expect(assertHierarchySources(f.ctx, m)).resolves.toBeUndefined();
    f.issues.get(f.ids.history!)!.status = "blocked";
    await expect(assertHierarchySources(f.ctx, m)).rejects.toMatchObject({ code: "hierarchy_history_changed" });
    f.issues.get(f.ids.history!)!.status = "cancelled";
    f.documents.get(f.docKey(f.ids.alpha!, "linear-source-v1")).body += " ";
    await expect(assertHierarchySources(f.ctx, m)).rejects.toMatchObject({ code: "linear_source_document_changed" });
  });
});
