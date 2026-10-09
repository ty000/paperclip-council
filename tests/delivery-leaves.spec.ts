import { expect, it, vi } from "vitest";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { assertPreviousDelivery, deliveryCampaignRoot, isIntegratedLeaf, reconcileCampaignDeliveries } from "../src/delivery-leaves.js";
import { sourceBase } from "../src/contribution-proof.js";

const campaign = vi.hoisted(() => ({ queue: vi.fn(async (_ctx: unknown, m: any) => m), departure: vi.fn(async () => undefined), root: null as any, members: [] as any[] }));
vi.mock("../src/repository-campaign.js", () => ({ campaignRoot: async () => campaign.root, listCampaignMembers: async () => campaign.members }));
vi.mock("../src/linear-continuity-transport.js", () => ({ queueLinearPublication: (...args: any[]) => campaign.queue(...args) }));
vi.mock("../src/linear-continuity-control.js", () => ({ assertLinearContinuityDeparture: (...args: any[]) => campaign.departure(...args) }));

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
  const source = { mission_id: "mission-a", project_id: "project", version: 1, created_at: new Date(), updated_at: new Date(), aggregate: { schemaVersion: 1, commandReceipts: [], integrated: false, completion: { state: "closed" } } };
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
