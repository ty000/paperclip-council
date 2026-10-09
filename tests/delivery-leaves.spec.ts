import { expect, it, vi } from "vitest";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { assertPreviousDelivery, deliveryCampaignRoot, isIntegratedLeaf } from "../src/delivery-leaves.js";
import { sourceBase } from "../src/contribution-proof.js";

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
