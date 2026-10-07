import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import type { ProjectMandate } from "../src/project-mandate-state.js";
import { parseHierarchyPolicy } from "../src/hierarchy-contract.js";
import { prepareHierarchy } from "../src/hierarchy-intake.js";
import { assertHierarchySources, assertHierarchyDependencies } from "../src/hierarchy-runtime.js";
import { prepareHierarchyCoordinator, type N1Coordination } from "../src/hierarchy-coordinator.js";
vi.mock("../src/rosters.js", () => ({ validateRosterPair: async () => ({ eligible: true,
  team: { head: { publishedRevision: "team-v1" }, revision: { content: { members: ["lead", "a", "b", "c"].map(agentId => ({ agentId })) } } } }) }));

function fixture() {
  const policy = { companyId: "company", projectId: "project", content: { teamRevision: "team-v1", leadAgentId: "lead", allowedPaths: ["src"],
    hierarchy: { protocol: "council-hierarchy-v1", maxContributions: 3, execution: "sequential", adoptExistingChildren: true } } } as ProjectMandate;
  const issues: any[] = [
    { id: "root", parentId: null, assigneeAgentId: "lead", title: "Result", description: "Product result", status: "blocked" },
    { id: "group", parentId: "root", assigneeAgentId: "lead", title: "Group", description: "Product group", status: "blocked" },
    ...["c", "b", "a"].map(id => ({ id, parentId: "group", assigneeAgentId: id, title: id, description: `Result ${id}`, status: id === "b" ? "blocked" : "backlog" })),
  ].map(issue => ({ ...issue, companyId: "company", projectId: "project" }));
  const documents = new Map(["a", "b", "c"].map(id => [id, { latestRevisionId: `${id}-v1`, body: JSON.stringify({ ownedPaths: [`src/${id}`] }) }]));
  const blockers = new Map<string, any[]>([["root", [{ id: "group", status: "blocked" }]], ["b", [{ id: "a", status: "backlog" }]]]);
  const ctx = { issues: { list: async () => issues, get: async (id: string) => issues.find(issue => issue.id === id), documents: { get: async (id: string) => documents.get(id) },
    relations: { get: async (id: string) => ({ blockedBy: blockers.get(id) ?? [], blocks: [] }) } } } as unknown as PluginContext;
  return { ctx, policy, issues, documents, blockers };
}

describe("explicit native hierarchy contract", () => {
  it("keeps legacy absence and rejects implicit parallel or unbounded authority", () => {
    expect(parseHierarchyPolicy(undefined)).toBeUndefined();
    expect(() => parseHierarchyPolicy({ protocol: "council-hierarchy-v1", maxContributions: 13, execution: "sequential", adoptExistingChildren: true })).toThrow();
    expect(() => parseHierarchyPolicy({ protocol: "council-hierarchy-v1", maxContributions: 3, execution: "parallel", adoptExistingChildren: true })).toThrow();
  });
  it("pins nested leaves and orders native predecessors without altering original tasks", async () => {
    const f = fixture(), before = structuredClone(f.issues);
    const hierarchy = (await prepareHierarchy(f.ctx, f.policy, "root", f.issues))!;
    expect(hierarchy.leaves).toHaveLength(3);
    const ids = hierarchy.leaves!.map(leaf => leaf.issueId);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(hierarchy.ancestorIds).toEqual(["group"]);
    expect(hierarchy.leaves!.find(leaf => leaf.issueId === "b")!.blockedByIssueIds).toEqual(["a"]);
    expect(f.issues).toEqual(before);
    const m = { companyId: "company", projectId: "project", aggregate: { hierarchy } } as MissionRecord;
    await expect(assertHierarchySources(f.ctx, m)).resolves.toBeUndefined();
    await expect(assertHierarchyDependencies(f.ctx, m, "b")).rejects.toMatchObject({ code: "hierarchy_dependency_pending" });
    f.blockers.get("b")![0].status = "done";
    await expect(assertHierarchyDependencies(f.ctx, m, "b")).resolves.toBeUndefined();
    await expect(assertHierarchySources(f.ctx, m)).resolves.toBeUndefined();
  });
  it.each(["ownership", "new-child", "description", "relations"])("stops new departure on %s drift while preserving the tree", async mutation => {
    const f = fixture(), hierarchy = await prepareHierarchy(f.ctx, f.policy, "root", f.issues);
    if (mutation === "ownership") f.documents.get("a")!.latestRevisionId = "a-v2";
    if (mutation === "new-child") f.issues.push({ id: "new", parentId: "root", companyId: "company", projectId: "project" });
    if (mutation === "description") f.issues.find(issue => issue.id === "b").description = "Changed result";
    if (mutation === "relations") f.blockers.set("b", []);
    await expect(assertHierarchySources(f.ctx, { companyId: "company", projectId: "project", aggregate: { hierarchy } } as MissionRecord))
      .rejects.toMatchObject({ code: "hierarchy_source_changed" });
  });
  it("retains cyclic and external pending dependencies for owner resolution", async () => {
    const f = fixture(); f.blockers.set("a", [{ id: "b", status: "blocked" }]);
    await expect(prepareHierarchy(f.ctx, f.policy, "root", f.issues)).rejects.toMatchObject({ code: "hierarchy_dependency_cycle" });
    f.blockers.set("a", [{ id: "external", status: "blocked" }]);
    await expect(prepareHierarchy(f.ctx, f.policy, "root", f.issues)).rejects.toMatchObject({ code: "hierarchy_external_dependency" });
  });
  it("pins full task sources rather than the truncated list preview", async () => {
    const f = fixture(); f.issues.find(issue => issue.id === "a").description = "A full result ".repeat(200);
    const previews = f.issues.map(issue => ({ ...issue, description: issue.description.slice(0, 1200) }));
    const hierarchy = await prepareHierarchy(f.ctx, f.policy, "root", previews);
    f.ctx.issues.list = vi.fn(async () => previews);
    await expect(assertHierarchySources(f.ctx, { companyId: "company", projectId: "project", aggregate: { hierarchy } } as MissionRecord)).resolves.toBeUndefined();
  });
});

describe("durable operational coordinator", () => {
  it("correlates a lost create response after restart with no second create or reservation", async () => {
    const body = { commandId: randomUUID(), expectedVersion: 1 };
    let m = { missionId: randomUUID(), companyId: "company", projectId: "project", rootIssueId: "root", ownerUserId: "owner", version: 1,
      aggregate: { hierarchy: { leaves: [{ issueId: "child" }] }, responsibilities: { integrationLeadAgentId: "lead" }, n1: {}, mandate: {} } } as MissionRecord;
    let issue: any;
    const create = vi.fn(async (input: any) => { issue = { ...input, id: "coordinator", parentId: null }; throw new Error("lost response"); });
    const list = vi.fn().mockResolvedValueOnce([]).mockImplementation(async () => [{ ...issue, description: "List preview only" }]);
    const ctx = { issues: { create, list, get: async () => issue } } as unknown as PluginContext;
    const persist = async (before: MissionRecord, coordination: N1Coordination) => m = { ...before, version: before.version + 1,
      aggregate: { ...before.aggregate, n1: { ...before.aggregate.n1, coordination } } };
    await expect(prepareHierarchyCoordinator(ctx, m, body, persist)).rejects.toMatchObject({ code: "hierarchy_coordinator_unknown" });
    const claimed = structuredClone(m);
    m = await prepareHierarchyCoordinator(ctx, claimed, body, persist);
    expect(m.aggregate.n1!.coordination).toMatchObject({ state: "confirmed", issueId: "coordinator" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(issue.parentId).toBeNull(); expect(issue.inheritExecutionWorkspaceFromIssueId).toBe("root");
    await expect(prepareHierarchyCoordinator(ctx, m, { ...body, commandId: randomUUID() }, persist)).rejects.toMatchObject({ code: "hierarchy_coordinator_command" });
  });
});
