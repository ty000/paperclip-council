import { beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { reconcileCompletion } from "../src/completion-runtime.js";
import { completionEvidence } from "../src/completion-evidence.js";
import { parseCompletionPolicy } from "../src/completion-contract.js";
import { assertContributionClosure } from "../src/contribution-closure.js";

const f = vi.hoisted(() => ({ m: null as any, reservations: [] as any[], delivery: null as any, guard: vi.fn() }));
vi.mock("../src/n2-missions.js", () => ({ nativeN2Profile: async () => ({ envelope: { reservations: f.reservations } }),
  n2Cas: async (_ctx: unknown, m: any, aggregate: any) => (f.m = { ...m, version: m.version + 1, aggregate }) }));
vi.mock("../src/n5-preflight.js", () => ({ acceptedN5Submission: (m: any) => m.aggregate.n2.submissions.at(-1) }));
vi.mock("../src/n5-state.js", () => ({ inspectN5: () => f.delivery }));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: (...args: unknown[]) => f.guard(...args) }));
vi.mock("../src/model-state.js", () => ({ physicalAgent: (_m: unknown, agent: string) => agent }));

const hierarchy = { protocol: "council-hierarchy-v1", execution: "sequential", adoptExistingChildren: true, maxContributions: 3 };
beforeEach(() => {
  vi.resetAllMocks();
  f.m = { companyId: "company", projectId: "project", missionId: "mission", rootIssueId: "root", version: 1,
    aggregate: { mandate: { acceptanceCriteria: ["explicit result"] }, responsibilities: { finalReviewerAgentId: "reviewer", integrationLeadAgentId: "lead" },
      projectMandate: { completion: { protocol: "council-proof-close-v1", result: "draft-pr" } },
      hierarchy: { ...hierarchy, nodes: [{ issueId: "root", parentId: null, assigneeAgentId: "lead" }, { issueId: "group", parentId: "root", assigneeAgentId: null }, { issueId: "child", parentId: "group", assigneeAgentId: "contributor" }] },
      n1: { periodKey: "period", sourceBaseCommit: "b".repeat(40), coordination: { issueId: "coordinator" }, contributions: [{ contributionId: "slot", childIssueId: "child", assigneeAgentId: "contributor", commit: "c".repeat(40),
        authorRunId: "run", dispatchRunId: "run", dispatchReservationId: "reservation", proof: { commit: "c".repeat(40), segmentRootCommit: "b".repeat(40), closedAt: "observed", checks: [{ status: "passed" }] } }] },
      n2: { submissions: [{ submissionId: "accepted", candidateCommit: "a".repeat(40), baseCommit: "b".repeat(40) }], rounds: [{ verdict: { operationId: "decision", verdict: "approved" }, handoff: { reviewerRunId: "review-run" } }] }, n5: {} } };
  f.reservations = [{ reservationId: "reservation", missionId: "mission", status: "settled", usage: { status: "known", units: 150 }, remainingExposure: { status: "known", units: 0 } }];
  f.delivery = { publicationReady: true, authority: { contract: { result: "draft-pr" } }, publication: { observation: { url: "https://github.com/test/repo/pull/1", draft: true } } };
});
function context() {
  const issues: Record<string, any> = Object.fromEntries(f.m.aggregate.hierarchy.nodes.map((node: any) => [node.issueId, {
    id: node.issueId, companyId: "company", projectId: "project", parentId: node.parentId, assigneeAgentId: node.assigneeAgentId, status: node.issueId === "child" ? "done" : "blocked",
  }]));
  issues.coordinator = { id: "coordinator", companyId: "company", projectId: "project", parentId: null, assigneeAgentId: "lead", status: "blocked" };
  let document: any = null;
  const comments: any[] = [];
  const update = vi.fn(async (id: string, body: any) => Object.assign(issues[id], body));
  const upsert = vi.fn(async (body: any) => { document = { ...body, latestRevisionId: "proof-revision" }; });
  const createComment = vi.fn(async (_id: string, body: string, _company: string, options: any) => { const comment = { id: "comment", body, ...options }; comments.push(comment); return comment; });
  const relations = vi.fn(async () => ({ blockedBy: [] }));
  const ctx = { issues: { get: async (id: string) => issues[id], update, relations: { get: relations }, documents: { get: async () => document, upsert }, listComments: async () => comments, createComment } } as unknown as PluginContext;
  return { ctx, issues, comments, update, upsert, createComment, relations };
}
it("requires explicit matching result and adoption authority, never inferring deployment or Linear", () => {
  expect(parseCompletionPolicy(undefined, null, hierarchy)).toBeUndefined();
  expect(parseCompletionPolicy({ protocol: "council-proof-close-v1", result: "accepted-candidate" }, null, hierarchy)?.result).toBe("accepted-candidate");
  for (const value of [{ protocol: "council-proof-close-v1", result: "deployed" }, { protocol: "council-proof-close-v1", result: "accepted-candidate", linear: true }]) expect(() => parseCompletionPolicy(value, null, hierarchy)).toThrow();
  expect(() => parseCompletionPolicy({ protocol: "council-proof-close-v1", result: "draft-pr" }, null, hierarchy)).toThrow();
  expect(() => parseCompletionPolicy({ protocol: "council-proof-close-v1", result: "accepted-candidate" }, null, { ...hierarchy, adoptExistingChildren: false })).toThrow();
});
it.each(["proof", "run", "usage", "exposure"])("succeeded without exact %s cannot close the child", kind => {
  const slot = f.m.aggregate.n1.contributions[0];
  if (kind === "proof") delete slot.proof;
  if (kind === "run") slot.authorRunId = "other-run";
  if (kind === "usage") f.reservations[0].usage.status = "unknown";
  if (kind === "exposure") f.reservations[0].remainingExposure.units = 1;
  expect(() => assertContributionClosure(f.m, "slot", { reservations: f.reservations } as any, "succeeded")).toThrow();
});
it("holds the child while its proved run is still running", () => {
  expect(() => assertContributionClosure(f.m, "slot", { reservations: f.reservations } as any, "running")).toThrow();
  expect(assertContributionClosure(f.m, "slot", { reservations: f.reservations } as any, "succeeded").childIssueId).toBe("child");
});
it("a draft PR cannot satisfy a reviewed PR result or absent terminal child proof", () => {
  f.m.aggregate.projectMandate.completion.result = "reviewed-pr";
  expect(() => completionEvidence(f.m)).toThrow();
  f.m.aggregate.projectMandate.completion.result = "draft-pr";
  delete f.m.aggregate.n1.contributions[0].proof.closedAt;
  expect(() => completionEvidence(f.m)).toThrow();
});
it("closes parents bottom-up only after proof, then confirms one agent-attributed notification", async () => {
  const c = context(); const result = await reconcileCompletion(c.ctx, f.m);
  expect(c.update.mock.calls.map(call => call[0])).toEqual(["group", "root", "coordinator"]);
  expect(result.aggregate.completion?.state).toBe("closed");
  expect(c.createComment.mock.calls[0]?.[3]).toEqual({ authorAgentId: "reviewer" });
  expect(result.aggregate.completion?.proofId).toBe(canonicalPayloadHash(completionEvidence(result)));
  await reconcileCompletion(c.ctx, result);
  expect(c.createComment).toHaveBeenCalledOnce(); expect(c.upsert).toHaveBeenCalledOnce();
});
it.each(["child", "blocker", "cost"])("preserves the parent and notification with pending %s", async kind => {
  const c = context();
  if (kind === "child") c.issues.child.status = "blocked";
  if (kind === "blocker") c.relations.mockResolvedValue({ blockedBy: [{ status: "blocked" }] } as any);
  if (kind === "cost") f.reservations[0].status = "reserved";
  await expect(reconcileCompletion(c.ctx, f.m)).rejects.toThrow();
  expect(c.issues.root.status).toBe("blocked"); expect(c.createComment).not.toHaveBeenCalled();
});
it("recovers an observed document after a lost response without overwriting or creating another key", async () => {
  const c = context(); const original = c.upsert.getMockImplementation()!;
  c.upsert.mockImplementationOnce(async body => { await original(body); throw new Error("lost document response"); });
  await expect(reconcileCompletion(c.ctx, f.m)).rejects.toThrow("lost document response");
  expect(f.m.aggregate.completion.documentKey).toBe("council-completion-mission");
  expect((await reconcileCompletion(c.ctx, f.m)).aggregate.completion?.state).toBe("closed");
  expect(c.upsert).toHaveBeenCalledOnce();
});
it("recovers a delivered final notification by readback after a lost response, never sending twice", async () => {
  const c = context(); const original = c.createComment.getMockImplementation()!;
  c.createComment.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("lost comment response"); });
  await expect(reconcileCompletion(c.ctx, f.m)).rejects.toThrow("lost comment response");
  expect(f.m.aggregate.completion.notification.state).toBe("claimed");
  expect((await reconcileCompletion(c.ctx, f.m)).aggregate.completion?.state).toBe("closed");
  expect(c.createComment).toHaveBeenCalledOnce();
});
it("an unobserved claimed notification remains unknown without a second effect", async () => {
  const c = context(); c.createComment.mockRejectedValue(new Error("unknown effect"));
  await expect(reconcileCompletion(c.ctx, f.m)).rejects.toThrow();
  await expect(reconcileCompletion(c.ctx, f.m)).rejects.toMatchObject({ code: "completion_notification_unknown" });
  expect(c.createComment).toHaveBeenCalledOnce();
});
it("a changed accepted candidate cannot consume a retained proof closure", async () => {
  const c = context(); c.upsert.mockRejectedValueOnce(new Error("transport"));
  await expect(reconcileCompletion(c.ctx, f.m)).rejects.toThrow();
  f.m.aggregate.n2.submissions[0].candidateCommit = "f".repeat(40);
  await expect(reconcileCompletion(c.ctx, f.m)).rejects.toMatchObject({ code: "completion_subject_changed" });
  expect(c.update).not.toHaveBeenCalled(); expect(c.createComment).not.toHaveBeenCalled();
});
