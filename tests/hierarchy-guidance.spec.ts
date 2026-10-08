import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";
import { assertHierarchySources } from "../src/hierarchy-runtime.js";
import { ensureHierarchyLaunchGuidance } from "../src/hierarchy-guidance.js";

function fixture() {
  const issue = { id: "child", companyId: "company", projectId: "project", parentId: "root", title: "Port", description: "Implement the port", assigneeAgentId: "agent" };
  const node = { issueId: issue.id, parentId: issue.parentId, title: issue.title, descriptionHash: canonicalPayloadHash(issue.description), assigneeAgentId: "agent", blockedByIssueIds: [] };
  const leaf = { ...node, contributionId: "contribution", documentRevisionId: "ownership-v1" };
  const m = { missionId: "mission", companyId: "company", projectId: "project", aggregate: { hierarchy: { nodes: [node], leaves: [leaf] } } } as unknown as MissionRecord;
  const document = { body: "Exact Council reporting command", latestRevisionId: "execution-v1" };
  const update = vi.fn(async (_id: string, patch: object) => Object.assign(issue, patch));
  const getDocument = vi.fn(async (_id: string, key: string) => key === "council-work" ? { latestRevisionId: "ownership-v1" } : document);
  const ctx = { issues: { list: async () => [issue], get: async () => issue, update, documents: { get: getDocument }, relations: { get: async () => ({ blockedBy: [] }) } } } as unknown as PluginContext;
  return { ctx, m, issue, document, update };
}

describe("hierarchy assignment carries Council handoff instructions", () => {
  it("exposes the exact document and completion rule in the native issue without changing the pinned product source", async () => {
    const f = fixture();
    await ensureHierarchyLaunchGuidance(f.ctx, f.m, "child");
    expect(f.issue.description).toContain("GET /api/issues/child/documents/council-execution-mission");
    expect(f.issue.description).toContain("Do not mark this issue done yourself");
    expect(f.issue.description).toContain("register the exact commit and Git proof");
    await expect(assertHierarchySources(f.ctx, f.m)).resolves.toBeUndefined();
    await ensureHierarchyLaunchGuidance(f.ctx, f.m, "child");
    expect(f.update).toHaveBeenCalledTimes(1);
    f.issue.description = f.issue.description.replace("Implement the port", "Implement another product");
    await expect(assertHierarchySources(f.ctx, f.m)).rejects.toMatchObject({ code: "hierarchy_source_changed" });
  });

  it("does not direct an agent to an absent reporting document", async () => {
    const f = fixture(); f.document.body = "";
    await expect(ensureHierarchyLaunchGuidance(f.ctx, f.m, "child")).rejects.toMatchObject({ code: "hierarchy_guidance_missing" });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("preserves ordinary non-hierarchy assignments", async () => {
    const f = fixture(); delete f.m.aggregate.hierarchy;
    await ensureHierarchyLaunchGuidance(f.ctx, f.m, "child");
    expect(f.update).not.toHaveBeenCalled();
  });
});
