import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { campaignCancellationSummary } from "../src/linear-cancellation-summary.js";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), missionId = randomUUID();
  const leaves = ["A", "B", "C"].map(sourceId => ({ sourceId, nativeId: randomUUID() }));
  const root = { companyId, projectId, missionId, aggregate: { linearContinuity: { publications: [{ payload: { campaignPlan: {
    schema: "council-linear-delivery-plan-v1", campaignRootMissionId: missionId, leaves,
  } } }] } } } as unknown as MissionRecord;
  const members = leaves.slice(0, 2).map(leaf => ({ companyId, projectId, missionId: randomUUID(), rootIssueId: leaf.nativeId,
    aggregate: { schemaVersion: 1, commandReceipts: [], repositoryCampaign: { campaignRootMissionId: missionId } },
  })) as unknown as MissionRecord[];
  const a = members[0]!, b = members[1]!, candidateCommit = "a".repeat(40), integratedCommit = "b".repeat(40), baseCommit = "c".repeat(40);
  const report = { companyId, missionId: a.missionId, candidateCommit, integratedCommit, baseCommit,
    url: "https://github.com/owner/repo/pull/1", state: "merged", baseContainsIntegrated: true,
    mergeParents: [baseCommit, candidateCommit], checks: [{ name: "test", state: "passed" }] };
  a.aggregate.n2 = { activeSubmissionId: "submission", status: "accepted" } as any;
  a.aggregate.n5 = { authority: { repository: "owner/repo", baseRef: "main", contract: { integration: { mergeMethod: "merge", requiredChecks: ["test"] } } },
    publication: { operation: "integrate", settledAt: new Date().toISOString(), submission: { candidateCommit, submissionId: "submission" } },
    integration: { state: "verified", report, reportHash: canonicalPayloadHash(report) } } as any;
  b.aggregate.n5 = { publication: { settledAt: new Date().toISOString(), observation: {
    state: "open", matchesCandidate: true, url: "https://github.com/owner/repo/pull/2",
  } } } as any;
  const ctx = { db: { namespace: "test", query: async (sql: string, params: string[]) =>
    members.filter(member => sql.includes("aggregate->") || member.missionId === params[1]).map(member => ({
      company_id: companyId, project_id: member.projectId, mission_id: member.missionId, root_issue_id: member.rootIssueId,
      aggregate: member.aggregate, version: 1, created_at: new Date(), updated_at: new Date(),
    })) } } as any;
  return { root, members, a, b, leaves, ctx, integratedCommit };
}

it("lists the integrated A result, open B PR and unstarted C from the retained member plan", async () => {
  const f = fixture(), before = structuredClone(f.members);
  const summary = await campaignCancellationSummary(f.ctx, f.root);
  expect(summary).toEqual({ schema: "council-linear-cancellation-summary-v1",
    retainedDeliveries: [{ sourceId: "A", nativeIssueId: f.a.rootIssueId, missionId: f.a.missionId,
      url: "https://github.com/owner/repo/pull/1", integratedCommit: f.integratedCommit, verified: true }],
    remainingWork: [{ sourceId: "B", nativeIssueId: f.b.rootIssueId, missionId: f.b.missionId },
      { sourceId: "C", nativeIssueId: f.leaves[2]!.nativeId, missionId: null }],
    openPullRequests: [{ sourceId: "B", nativeIssueId: f.b.rootIssueId, missionId: f.b.missionId, url: "https://github.com/owner/repo/pull/2" }],
  });
  expect(f.members).toEqual(before);
  expect(f.root.aggregate.n5).toBeUndefined();
});

it("retains an observed merge with failed checks as unfinished work without claiming a verified delivery", async () => {
  const f = fixture(), integration = f.a.aggregate.n5!.integration!;
  integration.state = "failed"; integration.report!.checks[0]!.state = "failed";
  integration.reportHash = canonicalPayloadHash(integration.report);
  const summary = await campaignCancellationSummary(f.ctx, f.root);
  expect(summary.retainedDeliveries[0]).toMatchObject({ integratedCommit: f.integratedCommit, verified: false });
  expect(summary.remainingWork.map(item => item.sourceId)).toEqual(["A", "B", "C"]);
  expect(summary.openPullRequests.map(item => item.sourceId)).toEqual(["B"]);
});

it.each(["foreign member", "changed report", "uncertain merge"])("refuses a cancellation summary with %s", async reason => {
  const f = fixture();
  if (reason === "foreign member") f.b.projectId = randomUUID();
  if (reason === "changed report") f.a.aggregate.n5!.integration!.report!.integratedCommit = "d".repeat(40);
  if (reason === "uncertain merge") f.b.aggregate.n5!.integration = { state: "unknown", mergeClaimedAt: new Date().toISOString() } as any;
  await expect(campaignCancellationSummary(f.ctx, f.root)).rejects.toThrow();
});

it("does not invent a PR link when no exact matching observation exists", async () => {
  const f = fixture(); f.b.aggregate.n5!.publication!.observation!.matchesCandidate = false;
  const summary = await campaignCancellationSummary(f.ctx, f.root);
  expect(summary.openPullRequests).toEqual([]);
  expect(summary.remainingWork.map(item => item.sourceId)).toEqual(["B", "C"]);
});

it("lists prepared but unstarted leaves when cancellation precedes plan publication", async () => {
  const f = fixture(); f.members.length = 0;
  f.root.aggregate.linearContinuity!.publications = [];
  f.root.aggregate.hierarchy = { leaves: f.leaves.map(leaf => ({ issueId: leaf.nativeId })) } as any;
  f.root.aggregate.projectMandate = { linearIntake: { subject: { intakeId: "original-intake" } } } as any;
  const intake = { mission_id: f.root.missionId, state: { linearIntake: { snapshot: {
    subject: f.root.aggregate.projectMandate!.linearIntake!.subject,
    nodes: f.leaves.map(leaf => ({ ...leaf, role: "contribution" })),
  } } } };
  f.ctx.db.query = async (sql: string) => sql.includes("project_task_intakes") ? [intake] : [];
  const summary = await campaignCancellationSummary(f.ctx, f.root);
  expect(summary.retainedDeliveries).toEqual([]); expect(summary.openPullRequests).toEqual([]);
  expect(summary.remainingWork).toEqual(f.leaves.map(leaf => ({ sourceId: leaf.sourceId, nativeIssueId: leaf.nativeId, missionId: null })));
  intake.mission_id = randomUUID();
  await expect(campaignCancellationSummary(f.ctx, f.root)).rejects.toMatchObject({ code: "linear_cancel_plan_unknown" });
});
