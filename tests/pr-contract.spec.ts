import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";
import { parsePrContract, validateGithubFeedback, githubFeedbackStates, feedbackCorrectionRound, type GithubFeedback } from "../src/pr-contract.js";
import { prepareFeedbackReview, prepareFeedbackContinuation } from "../src/pr-feedback.js";
import { inspectN5 } from "../src/n5-state.js";

function fixture() {
  const at = new Date().toISOString(), actor = { agentId: randomUUID(), runId: randomUUID() };
  const contract = parsePrContract({ protocol: "council-pr-contract-v1", draftOnly: true, result: "draft-pr", feedback: "review-and-correct", requiredChecks: ["ci"] })!;
  const submission = { submissionId: randomUUID(), candidateCommit: "a".repeat(40), sha256: "d".repeat(64), mandateHash: canonicalPayloadHash({}), evidenceRevision: 3 };
  const m = { missionId: randomUUID(), version: 4, ownerUserId: randomUUID(), aggregate: { mandate: {}, phase: "accepted", effectIntents: [], journal: [],
    responsibilities: { integrationLeadAgentId: randomUUID(), finalReviewerAgentId: randomUUID() },
    n1: { periodKey: "current" }, n2: { status: "accepted", submissions: [submission], activeSubmissionId: submission.submissionId, correctionLimit: 1, correctionsUsed: 0,
      ordinary: { protocol: "ordinary-cli-v1", tasks: [] }, rounds: [{ round: 1, verdict: { verdict: "approved" } }], application: { state: "observed", submissionId: submission.submissionId } },
    n3: { slots: ["product", "quality"].map(perspective => ({ slotId: randomUUID(), perspective, specialistAgentId: randomUUID(), required: true, question: "Inspect exact candidate" })), rounds: [] },
    n5: { authority: { contract, repository: "ty000/paperclip-council", baseRef: "main", headRef: "codex/test" }, plan: {},
      publication: { intentId: randomUUID(), issueId: randomUUID(), runId: actor.runId, claimedAt: at, settledAt: at, submission,
        observation: { matchesCandidate: true, draft: true, state: "open", url: "https://github.com/ty000/paperclip-council/pull/1", headSha: submission.candidateCommit,
          baseRef: "main", headRef: "codex/test", lastResolvedAt: at } } } } } as unknown as MissionRecord;
  const p = m.aggregate.n5!.publication!;
  const report: GithubFeedback = { protocol: "publisher-github-feedback-v1", provenance: "publisher_run_report", missionId: m.missionId,
    intentId: p.intentId, issueId: p.issueId!, runId: actor.runId, observedAt: at, url: p.observation!.url, repository: "ty000/paperclip-council",
    headSha: submission.candidateCommit, baseRef: "main", headRef: "codex/test", draft: true,
    checks: [{ name: "ci", state: "passed", evidenceUrl: p.observation!.url }], reviews: [{ id: 1, author: "reviewer", headSha: submission.candidateCommit,
      state: "CHANGES_REQUESTED", body: "A material defect", url: p.observation!.url + "#pullrequestreview-1", submittedAt: at }] };
  p.feedbackReport = report; const states = githubFeedbackStates(contract, report);
  const common = { headSha: report.headSha, observedAt: at, evidenceRefs: [report.url], agentId: actor.agentId, runId: actor.runId };
  p.checks = { ...common, state: states.checks }; p.reviews = { ...common, state: states.reviews };
  return { m, report, actor, contract, p };
}
it("preserves legacy contracts and rejects inconsistent draft authority", () => {
  expect(parsePrContract(undefined)).toBeUndefined();
  expect(() => parsePrContract({ ...fixture().contract, result: "reviewed-pr" })).toThrow();
  expect(() => parsePrContract({ ...fixture().contract, requiredChecks: [] })).toThrow();
});
it("delivers a fresh checked exact draft without requiring approval or treating it as merge-ready", () => {
  const { m, p } = fixture();
  expect(inspectN5(m)).toMatchObject({ ready: true, publicationReady: true, mergeReady: false, contractConformant: true });
  p.feedbackReport!.checks[0]!.state = "pending";
  p.checks!.state = "pending";
  expect(inspectN5(m)?.publicationReady).toBe(false);
  p.feedbackReport!.checks[0]!.state = "passed";
  p.checks!.state = "passed";
  p.feedbackReport!.observedAt = new Date(Date.now() - 400_000).toISOString();
  expect(inspectN5(m)).toMatchObject({ publicationReady: false, mergeReady: false, nativeReadbackFresh: true });
  p.feedbackReport!.observedAt = new Date().toISOString();
  p.observation!.lastResolvedAt = new Date(Date.now() - 400_000).toISOString();
  expect(inspectN5(m)?.publicationReady).toBe(false);
  p.observation!.lastResolvedAt = new Date().toISOString();
  p.observation!.draft = false;
  expect(inspectN5(m)).toMatchObject({ publicationReady: false, contractConformant: false });
});
it("retains passed checks and approval for reviewed delivery only while feedback is fresh", () => {
  const { m, p } = fixture();
  m.aggregate.n5!.authority.contract = parsePrContract({ ...m.aggregate.n5!.authority.contract!, result: "reviewed-pr", draftOnly: false });
  p.observation!.draft = false;
  p.feedbackReport!.draft = false;
  expect(inspectN5(m)).toMatchObject({ publicationReady: false, mergeReady: false });
  p.feedbackReport!.reviews[0]!.state = "APPROVED";
  p.reviews!.state = "approved";
  p.feedbackReport!.observedAt = new Date(Date.now() - 400_000).toISOString();
  expect(inspectN5(m)).toMatchObject({ publicationReady: false, mergeReady: false, nativeReadbackFresh: true });
  p.feedbackReport!.observedAt = new Date().toISOString();
  expect(inspectN5(m)).toMatchObject({ publicationReady: true, mergeReady: true, nativeReadbackFresh: true });
});
it("keeps historical objections until the same author supersedes or dismisses them", () => {
  const { contract, report } = fixture(); report.reviews[0]!.headSha = "b".repeat(40);
  report.reviews.push({ ...report.reviews[0]!, id: 2, author: "other", headSha: report.headSha, state: "APPROVED" });
  expect(githubFeedbackStates(contract, report).reviews).toBe("changes_requested");
  report.reviews.push({ ...report.reviews[0]!, id: 3, headSha: report.headSha, state: "APPROVED" });
  expect(githubFeedbackStates(contract, report).reviews).toBe("approved");
  report.checks = []; expect(githubFeedbackStates(contract, report).checks).toBe("pending");
});
it.each(["intent", "run", "head", "draft", "stale", "duplicate", "truncated"])("rejects an unbound %s report", kind => {
  const { m, report, actor, p } = fixture();
  if (kind === "intent") report.intentId = randomUUID();
  if (kind === "run") report.runId = randomUUID();
  if (kind === "head") report.headSha = "b".repeat(40);
  if (kind === "draft") report.draft = false;
  if (kind === "stale") report.observedAt = new Date(Date.now() - 400000).toISOString();
  if (kind === "duplicate") report.reviews.push(report.reviews[0]!);
  if (kind === "truncated") report.reviews[0]!.body = "x".repeat(8001);
  expect(() => validateGithubFeedback(m, report, actor, p.observation!)).toThrow();
});
it("changes the evidence tuple while retaining accepted candidate, history and cumulative correction count", () => {
  const { m, p } = fixture(); const before = structuredClone(m.aggregate);
  const next = prepareFeedbackReview(m); const n2 = next.n2!;
  expect(n2.submissions[0]).toEqual(before.n2!.submissions[0]); expect(n2.rounds[0]).toEqual(before.n2!.rounds[0]);
  expect(n2.submissions[1]!.candidateCommit).toBe(p.submission.candidateCommit);
  expect(n2.submissions[1]!.evidenceRevision).toBeGreaterThan(p.submission.evidenceRevision);
  expect(n2.activeSubmissionId).not.toBe(p.submission.submissionId);
  expect(n2.correctionsUsed).toBe(0); expect(n2.ordinary!.tasks.map(t => t.kind)).toEqual(["specialist", "specialist", "council"]);
  m.aggregate = next; expect(feedbackCorrectionRound(m, n2.activeSubmissionId)).toBe(true);
  n2.correctionsUsed = 1; n2.correction = { reservationId: randomUUID(), requestedByOperationId: randomUUID(), criteria: ["fix"], reasons: ["independent material finding"], executorAgentId: randomUUID(), runId: null };
  const corrected = prepareFeedbackContinuation(m, "changes_requested", n2.correction.requestedByOperationId);
  expect(corrected.n5!.continuation).toMatchObject({ delegatedFeedback: true, previousPublication: p });
  expect(corrected.n2!.correctionsUsed).toBe(1);
});
it.each(["exhausted", "unsettled", "draft-violation", "task-active", "unknown"])("refuses a feedback departure with %s evidence", kind => {
  const { m, p } = fixture();
  if (kind === "exhausted") m.aggregate.n2!.correctionsUsed = 1;
  if (kind === "unsettled") delete p.settledAt;
  if (kind === "draft-violation") p.observation!.draft = false;
  if (kind === "task-active") m.aggregate.n2!.ordinary!.tasks.push({ closedAt: undefined } as never);
  if (kind === "unknown") m.aggregate.n2!.status = "application_unknown";
  expect(() => prepareFeedbackReview(m)).toThrow();
});

it("preserves the historical N2 mandate digest over its exact persisted JSON ordering", () => {
  const { m, p } = fixture();
  Object.assign(m.aggregate.mandate, { objective: "Ordered native mandate", acceptanceCriteria: ["bounded result"], commitments: ["preserve history"], limits: { correctionLimit: 1 } });
  p.submission.mandateHash = createHash("sha256").update(JSON.stringify(m.aggregate.mandate)).digest("hex");
  expect(p.submission.mandateHash).not.toBe(canonicalPayloadHash(m.aggregate.mandate));
  p.reviews!.state = "approved"; p.feedbackReport!.reviews[0]!.state = "APPROVED";
  expect(inspectN5(m)?.publicationReady).toBe(true);
});
