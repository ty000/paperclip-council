import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";
import { assertHierarchySources } from "../src/hierarchy-runtime.js";
import { ensureHierarchyLaunchGuidance } from "../src/hierarchy-guidance.js";
import { linearContextGuidance } from "../src/linear-context-guidance.js";
import { modelLaunchGuidance } from "../src/model-state.js";

const campaign = vi.hoisted(() => ({ members: [] as MissionRecord[] }));
vi.mock("../src/repository-campaign.js", async original => ({ ...await original<any>(),
  listCampaignMembers: async () => campaign.members,
}));

function fixture() {
  campaign.members = [];
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

function campaignFixture() {
  const f = fixture();
  const operations = ["publisher-current", "publisher-previous", "publisher-integration"].map(id => ({
    ...f.issue, id, parentId: f.issue.id, title: "Council publisher",
  }));
  const member = { ...f.m, missionId: "leaf-mission", rootIssueId: f.issue.id, aggregate: { ...f.m.aggregate,
    repositoryCampaign: { campaignRootMissionId: f.m.missionId }, n5: {
      publication: { issueId: operations[0]!.id }, continuation: { previousPublication: { issueId: operations[1]!.id } },
      integration: { previousPublication: { issueId: operations[2]!.id } },
    } } } as unknown as MissionRecord;
  campaign.members = [member];
  f.m.aggregate.campaignClosure = { phase: "reviewing" } as never;
  f.m.aggregate.linearContinuity = { publications: [{ payload: { campaignPlan: { schema: "council-linear-delivery-plan-v1",
    campaignRootMissionId: f.m.missionId, leaves: [{ sourceId: "source", nativeId: f.issue.id }] } } }] } as never;
  f.ctx.issues.list = async () => [f.issue, ...operations] as never;
  return { ...f, member, operations };
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
  it("accepts exact targeted context suffixes while retaining product source verification", async () => {
    const f = fixture();
    f.m.aggregate.linearContinuity = { contextAnnotations: [{ commandId: "command", sequence: 1,
      affectedNativeIds: ["child"], context: "Preserve this interface", evidence: { key: "source", documentId: "doc", revisionId: "rev" } }] } as any;
    f.issue.description += `\n\n${linearContextGuidance(f.m, "child")[0]}`;
    await expect(assertHierarchySources(f.ctx, f.m)).resolves.toBeUndefined();
    f.issue.description = f.issue.description.replace("Preserve this interface", "Changed annotation");
    await expect(assertHierarchySources(f.ctx, f.m)).rejects.toMatchObject({ code: "hierarchy_source_changed" });
  });
  it("validates a campaign leaf through its exact member model binding", async () => {
    const f = fixture(), physical = "physical-agent", launchKey = "leaf-launch";
    const launch = { taskKey: "leaf", interventionKey: "lead", launchKey, logicalAgentId: "agent", agentId: physical,
      roleKey: "implementation", profileId: "sol-medium", requestedProfileId: "sol-medium", family: "implementation",
      rationale: "Pinned leaf profile", authority: "default", mappingRevision: "1", variantRevision: "1",
      selectedAt: new Date().toISOString(), state: "bound", issueId: "child", runId: "leaf-run", ascent: false } as const;
    const member = { ...f.m, missionId: "leaf-mission", rootIssueId: "child", aggregate: { ...f.m.aggregate,
      repositoryCampaign: { campaignRootMissionId: "mission" }, modelSelection: { protocol: "native-variants-v1", choices: [],
        tasks: [{ taskKey: "leaf", mapping: {} as never, variantRevision: "1", launches: [launch] }] } } } as MissionRecord;
    campaign.members = [member];
    f.m.aggregate.campaignClosure = {} as never;
    f.m.aggregate.linearContinuity = { publications: [{ payload: { campaignPlan: { schema: "council-linear-delivery-plan-v1",
      campaignRootMissionId: f.m.missionId, leaves: [{ sourceId: "source", nativeId: "child" }] } } }] } as never;
    f.issue.assigneeAgentId = physical;
    f.issue.description += `\n\n${modelLaunchGuidance(member, launch, "child")}`;
    await expect(assertHierarchySources(f.ctx, f.m)).resolves.toBeUndefined();
  });
  it("allows only recorded publisher identities from exact planned members during global review", async () => {
    const f = campaignFixture();
    expect(f.m.aggregate.n5).toBeUndefined();
    await expect(assertHierarchySources(f.ctx, f.m)).resolves.toBeUndefined();
    f.operations.push({ ...f.operations[0]!, id: "unrecorded-publisher" });
    await expect(assertHierarchySources(f.ctx, f.m)).rejects.toMatchObject({ code: "hierarchy_source_changed" });
    expect(f.update).not.toHaveBeenCalled();
  });
  it("does not borrow a recorded publisher from a member outside the pinned delivery plan", async () => {
    const f = campaignFixture(); f.member.rootIssueId = "other-leaf";
    await expect(assertHierarchySources(f.ctx, f.m)).rejects.toMatchObject({ code: "hierarchy_source_changed" });
    expect(f.update).not.toHaveBeenCalled();
  });
  it("retains existing single-mission publisher exclusions without enabling campaign ownership", async () => {
    const f = fixture(), publisher = { ...f.issue, id: "publisher", parentId: f.issue.id };
    f.m.aggregate.n5 = { publication: { issueId: publisher.id } } as never;
    f.ctx.issues.list = async () => [f.issue, publisher] as never;
    await expect(assertHierarchySources(f.ctx, f.m)).resolves.toBeUndefined();
    publisher.id = "unrecorded-publisher";
    await expect(assertHierarchySources(f.ctx, f.m)).rejects.toMatchObject({ code: "hierarchy_source_changed" });
  });
});
