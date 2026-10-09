import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { assertPreviousDelivery, deliveryCampaignRoot, isIntegratedLeaf, reconcileCampaignDeliveries } from "../src/delivery-leaves.js";
import { sourceBase } from "../src/contribution-proof.js";

const campaign = vi.hoisted(() => ({ queue: vi.fn(async (_ctx: unknown, m: any, _kind: string, _payload: Record<string, unknown>) => m), departure: vi.fn(async () => undefined), root: null as any, members: [] as any[] }));
vi.mock("../src/repository-campaign.js", () => ({ campaignRoot: async () => campaign.root, listCampaignMembers: async () => campaign.members }));
vi.mock("../src/linear-continuity-transport.js", () => ({ queueLinearPublication: campaign.queue }));
vi.mock("../src/linear-continuity-control.js", () => ({ assertLinearContinuityDeparture: campaign.departure }));
beforeEach(() => { vi.clearAllMocks(); campaign.root = null; campaign.members = []; });

const result = { protocol: "integrated-result-v1", repository: "ty000/repo", baseRef: "main", url: "https://github.com/ty000/repo/pull/1", candidateCommit: "a".repeat(40), integratedCommit: "c".repeat(40), reportHash: "d".repeat(64) };
vi.mock("../src/integration-contract.js", () => ({ integratedResult: (m: any) => { if (!m.aggregate.integrated) throw new Error("Integration unverified"); return result; } }));
function fixture() {
  const issues = [
    { id: "parent", parentId: null, originKind: "manual", status: "blocked", assigneeAgentId: "lead", createdAt: new Date(1) },
    { id: "a", parentId: "parent", originKind: "manual", status: "blocked", assigneeAgentId: "contributor-a", createdAt: new Date(2) },
    { id: "b", parentId: "parent", originKind: "manual", status: "backlog", assigneeAgentId: "contributor-b", createdAt: new Date(3) },
    { id: "publisher", parentId: "a", originKind: "plugin:private.paperclip-council", status: "done", createdAt: new Date(4) },
  ];
  const policy = { content: { leadAgentId: "lead", baselineRootIds: [], publication: { contract: { integration: {} } } } } as any;
  const source = { mission_id: "mission-a", project_id: "project", version: 1, created_at: new Date(), updated_at: new Date(), aggregate: { schemaVersion: 1, commandReceipts: [], integrated: false, completion: { state: "closed", proofId: "fixture-proof" } } };
  const ctx = { db: { namespace: "test", query: vi.fn(async () => [source]) }, issues: { relations: { get: vi.fn(async (id: string) => ({ blockedBy: id === "b" ? [issues[1]] : [] })) } } } as any;
  return { issues, policy, source, ctx, m: { companyId: "company", projectId: "project", rootIssueId: "b", aggregate: {} } as any };
}
it("admits existing code leaves including a standalone task, without treating operational PR tasks as product children", () => {
  const f = fixture();
  expect(isIntegratedLeaf(f.issues[0] as any, f.policy, f.issues as any)).toBe(false);
  expect(isIntegratedLeaf(f.issues[1] as any, f.policy, f.issues as any)).toBe(true);
  f.issues[1]!.parentId = null as any;
  expect(isIntegratedLeaf(f.issues[1] as any, f.policy, f.issues as any)).toBe(true);
  f.policy.content.baselineRootIds = ["a"];
  expect(isIntegratedLeaf(f.issues[1] as any, f.policy, f.issues as any)).toBe(false);
});
it("does not release the second PR from candidate acceptance, failed integration or an unclosed predecessor", async () => {
  const f = fixture();
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow();
  f.issues[1]!.status = "done";
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow("unverified");
  f.source.aggregate.integrated = true; f.source.aggregate.completion.state = "closing";
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow();
  f.source.aggregate.completion.state = "closed";
  expect(await assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).toEqual({ sourceMissionId: "mission-a", result });
});
it("requires downstream Git base to be the integrated commit, preserving original candidate proof", () => {
  const f = fixture(); f.m.aggregate.projectMandate = { completion: { result: "integrated-verified" } }; f.m.aggregate.deliveryPredecessor = { result };
  const before = canonicalPayloadHash(result);
  expect(() => sourceBase(f.m, result.candidateCommit)).toThrow();
  expect(sourceBase(f.m, result.integratedCommit)).toBe(result.integratedCommit);
  expect(canonicalPayloadHash(result)).toBe(before);
});
it("retains external blockers and rejects missing or cyclic native campaign ancestry", async () => {
  const f = fixture(); f.ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "external", status: "blocked" }] });
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow();
  f.issues[0]!.parentId = "b" as any;
  expect(() => deliveryCampaignRoot("a", f.issues as any)).toThrow();
  f.issues[0]!.parentId = "missing" as any;
  expect(() => deliveryCampaignRoot("a", f.issues as any)).toThrow();
});
it("serializes fixed Linear leaves and requires root publication readback before the next distinct PR", async () => {
  const f = fixture();
  Object.assign(f.policy.content, { linearContinuity: { mode: "milestone-fixed-v1" } });
  for (const issue of f.issues.slice(0, 3)) issue.originKind = "plugin:ty000.linear-intake";
  f.issues[1]!.status = "done";
  f.source.aggregate.integrated = true; f.source.aggregate.completion = { state: "closed", proofId: "proof-a" };
  f.m.aggregate.repositoryCampaign = { campaignRootMissionId: "campaign-root" };
  campaign.root = { companyId: "company", projectId: "project", missionId: "campaign-root", aggregate: { linearContinuity: {} } };
  f.ctx.db.query.mockImplementation(async (sql: string) => sql.includes("project_task_intakes")
    ? [{ state: { repositoryCampaign: { campaignRootMissionId: "campaign-root", sourceId: "00000000-0000-4000-8000-000000000001" } } }]
    : [f.source]);
  campaign.departure.mockRejectedValueOnce(new Error("publication readback pending"));
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow("readback pending");
  expect(campaign.queue).toHaveBeenCalledTimes(1);
  expect(campaign.queue.mock.calls[0]![3]).toMatchObject({ statusUpdates: [{ sourceId: "00000000-0000-4000-8000-000000000001", state: "completed" }],
    campaignDelivery: { sourceMissionId: "mission-a", proofId: "proof-a" } });
  campaign.departure.mockResolvedValue(undefined);
  expect(await assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).toEqual({ sourceMissionId: "mission-a", result });
  expect(isIntegratedLeaf(f.issues[2] as any, f.policy, f.issues as any)).toBe(true);
});
it("does not skip a planned contribution marked terminal outside Council and publishes the final closed leaf from the root job", async () => {
  const f = fixture(); Object.assign(f.policy.content, { linearContinuity: { mode: "milestone-fixed-v1" } });
  for (const issue of f.issues.slice(0, 3)) issue.originKind = "plugin:ty000.linear-intake";
  f.issues[1]!.status = "done"; f.m.aggregate.repositoryCampaign = { campaignRootMissionId: "campaign-root" };
  campaign.root = { companyId: "company", projectId: "project", missionId: "campaign-root",
    aggregate: { linearContinuity: {}, hierarchy: { leaves: [{ issueId: "a" }] } } };
  f.ctx.db.query.mockImplementation(async (sql: string) => sql.includes("project_task_intakes")
    ? [{ state: { repositoryCampaign: { campaignRootMissionId: "campaign-root", sourceId: "00000000-0000-4000-8000-000000000001" } } }] : []);
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow("cannot be skipped");
  f.source.aggregate.integrated = true; f.source.aggregate.completion = { state: "closed", proofId: "proof-final" };
  campaign.members = [{ ...f.m, missionId: "mission-final", rootIssueId: "b", aggregate: f.source.aggregate }];
  await reconcileCampaignDeliveries(f.ctx, campaign.root);
  expect(campaign.queue).toHaveBeenLastCalledWith(f.ctx, campaign.root, "progress", expect.objectContaining({
    campaignDelivery: expect.objectContaining({ sourceMissionId: "mission-final", proofId: "proof-final" }) }));
});

function reversedCampaign(order: "created first" | "same timestamp", status = "done") {
  const f = fixture(), a = f.issues[1]!, b = f.issues[2]!;
  a.id = "d39fa848-84e7-4c9d-a972-92e4b2fc2a9f"; b.id = "b641cc19-86c5-4b16-95dc-82b46f9e7e98";
  a.createdAt = new Date(order === "created first" ? 3 : 2); b.createdAt = new Date(2);
  a.status = status; f.issues[3]!.parentId = a.id;
  f.m.rootIssueId = b.id; f.m.aggregate.repositoryCampaign = { campaignRootMissionId: "campaign-root" };
  f.policy.content.linearContinuity = { mode: "milestone-fixed-v1" };
  for (const issue of f.issues.slice(0, 3)) issue.originKind = "plugin:ty000.linear-intake";
  f.source.aggregate.integrated = true;
  Object.assign(f.source, { company_id: "company", root_issue_id: a.id });
  const plan = { schema: "council-linear-delivery-plan-v1", campaignRootMissionId: "campaign-root", leaves: [
    { nativeId: a.id, sourceId: "source-a", blockedByNativeIds: [] },
    { nativeId: b.id, sourceId: "source-b", blockedByNativeIds: [a.id] },
  ] };
  campaign.root = { companyId: "company", projectId: "project", missionId: "campaign-root",
    aggregate: { linearContinuity: { publications: [{ payload: { campaignPlan: plan }, acknowledgement: {} }] },
      hierarchy: { leaves: [{ issueId: a.id }, { issueId: b.id }] } } };
  f.ctx.db.query.mockImplementation(async (sql: string) => sql.includes("project_task_intakes")
    ? [{ state: { repositoryCampaign: { campaignRootMissionId: "campaign-root", sourceId: "source-a" } } }] : [f.source]);
  f.ctx.issues.relations.get.mockImplementation(async (id: string) => ({ blockedBy: id === b.id ? [a] : [] }));
  return { ...f, a, b, plan };
}

it.each(["created first", "same timestamp"] as const)("keeps the fixed A→B predecessor when B sorts first: %s", async order => {
  const f = reversedCampaign(order), originalPlan = structuredClone(f.plan);
  const predecessor = await assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any);
  expect(predecessor).toEqual({ sourceMissionId: "mission-a", result });
  expect(campaign.queue).toHaveBeenCalledExactlyOnceWith(f.ctx, campaign.root, "progress", expect.objectContaining({
    campaignDelivery: expect.objectContaining({ sourceMissionId: "mission-a", sourceIssueId: f.a.id, proofId: "fixture-proof", result }),
  }));
  expect(campaign.departure).toHaveBeenCalledTimes(1);
  expect(f.plan).toEqual(originalPlan);
  f.m.aggregate.projectMandate = { completion: { result: "integrated-verified" } };
  f.m.aggregate.deliveryPredecessor = predecessor;
  expect(sourceBase(f.m, result.integratedCommit)).toBe(result.integratedCommit);
  expect(() => sourceBase(f.m, result.candidateCommit)).toThrow();
});

it.each(["created first", "same timestamp"] as const)("retains integration and closure gates when B sorts first: %s", async order => {
  const f = reversedCampaign(order);
  f.source.aggregate.integrated = false;
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow("Integration unverified");
  expect(campaign.queue).not.toHaveBeenCalled();
  f.source.aggregate.integrated = true; f.source.aggregate.completion.state = "closing";
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toMatchObject({ code: "previous_delivery_pending" });
  expect(campaign.queue).not.toHaveBeenCalled();
  expect(campaign.departure).not.toHaveBeenCalled();
});

it("does not skip an internal terminal dependency or its Linear ACK when creation order puts B first", async () => {
  const f = reversedCampaign("created first", "cancelled");
  campaign.departure.mockRejectedValueOnce(new Error("publication readback pending"));
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toThrow("readback pending");
  expect(campaign.queue).toHaveBeenCalledTimes(1);
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).resolves.toEqual({ sourceMissionId: "mission-a", result });
  expect(campaign.queue.mock.calls[1]![3]).toEqual(campaign.queue.mock.calls[0]![3]);
});

it.each(["done", "cancelled", "blocked"])("preserves the external blocker contract when its state is %s", async status => {
  const f = reversedCampaign("same timestamp");
  f.ctx.issues.relations.get.mockImplementation(async (id: string) => ({ blockedBy: id === f.b.id
    ? [f.a, { id: "external", status }] : [] }));
  const checked = assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any);
  if (status === "blocked") {
    await expect(checked).rejects.toMatchObject({ code: "delivery_dependency_pending" });
    expect(campaign.queue).not.toHaveBeenCalled();
  } else await expect(checked).resolves.toEqual({ sourceMissionId: "mission-a", result });
});

it("rejects internal dependency cycles even when their native issues are already terminal", async () => {
  const f = reversedCampaign("same timestamp"); f.b.status = "done";
  f.ctx.issues.relations.get.mockImplementation(async (id: string) => ({ blockedBy: [id === f.a.id ? f.b : f.a] }));
  await expect(assertPreviousDelivery(f.ctx, f.m, f.policy, f.issues as any)).rejects.toMatchObject({ code: "delivery_dependency_pending" });
  expect(campaign.queue).not.toHaveBeenCalled();
});
