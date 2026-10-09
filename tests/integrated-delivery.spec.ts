import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import type { MissionRecord } from "../src/missions.js";
import { integratedResult, integrationReportState, parseIntegrationContract, validateIntegrationReport } from "../src/integration-contract.js";
import { parsePrContract } from "../src/pr-contract.js";
import { handleIntegrationAgent } from "../src/integration-runtime.js";

const f = vi.hoisted(() => ({ m: null as any, native: null as any, departure: vi.fn(), inventory: vi.fn(), accepted: vi.fn() }));
vi.mock("../src/n5-runtime.js", () => ({ bindPublisher: async (_ctx: unknown, m: unknown) => m, resumeN5Creation: async (_ctx: unknown, m: unknown) => m }));
vi.mock("../src/n5-preflight.js", () => ({ acceptedN5Submission: () => f.accepted() }));
vi.mock("../src/n5-native.js", () => ({ assertCurrentN5Plan: async () => {}, observeN5Native: async () => f.native }));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: (...args: unknown[]) => f.departure(...args) }));
vi.mock("../src/continuity-policy.js", () => ({ assertContinuityDeparture: () => {} }));
vi.mock("../src/native-runs.js", () => ({ assertNativeRunInventory: () => f.inventory() }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2CommandCas: async (_ctx: unknown, m: any, body: any, _type: string, actorId: string, aggregate: any) => {
  if (m.version !== body.expectedVersion) throw new Error("version conflict");
  const receipt = { commandId: body.commandId, actorId, payloadHash: canonicalPayloadHash(body) };
  f.m = { ...m, version: m.version + 1, aggregate: { ...aggregate, commandReceipts: [...aggregate.commandReceipts, receipt] } };
  return { outcome: "applied", mission: f.m, receipt };
} }));
const contract = { protocol: "council-integrated-delivery-v1" as const, mergeMethod: "merge" as const, requiredChecks: ["integrated-ci"], parentObligations: ["Parent smoke test"] };
beforeEach(() => {
  vi.resetAllMocks();
  const submission = { submissionId: randomUUID(), candidateCommit: "a".repeat(40), baseCommit: "b".repeat(40), evidenceRevision: 1 };
  const previousPublication = { intentId: randomUUID(), submission, issueId: randomUUID(), runId: randomUUID(), settledAt: new Date().toISOString() };
  f.m = { companyId: randomUUID(), missionId: randomUUID(), version: 1, aggregate: { mandate: {}, commandReceipts: [],
    n2: { status: "accepted", activeSubmissionId: submission.submissionId }, n5: { authority: { publisherAgentId: "publisher", repository: "ty000/repo", baseRef: "main", headRef: "codex/leaf",
      contract: { protocol: "council-pr-contract-v1", result: "integrated-verified", draftOnly: false, requiredChecks: ["candidate-ci"], feedback: "review-and-correct", integration: contract } },
      publication: { ...previousPublication, operation: "integrate", intentId: randomUUID(), issueId: randomUUID(), runId: randomUUID(),
        settledAt: undefined, createdAt: new Date(Date.now() - 1000).toISOString(), targetUrl: "https://github.com/ty000/repo/pull/1" },
      integration: { previousPublication, state: "pending" } } } };
  f.native = { matchesCandidate: true, state: "open", draft: false, url: f.m.aggregate.n5.publication.targetUrl, headSha: submission.candidateCommit };
  f.accepted.mockImplementation(() => f.m.aggregate.n5.publication.submission);
});
function report(state: "open" | "merged" = "open") {
  const m = f.m as MissionRecord, p = m.aggregate.n5!.publication!;
  return { protocol: "publisher-integration-report-v1" as const, provenance: "publisher_run_report" as const,
    companyId: m.companyId, missionId: m.missionId, intentId: p.intentId, issueId: p.issueId!, runId: p.runId!, observedAt: new Date().toISOString(),
    repository: "ty000/repo", url: p.targetUrl!, candidateCommit: p.submission.candidateCommit, baseRef: "main", baseCommit: p.submission.baseCommit,
    state, integratedCommit: state === "merged" ? "c".repeat(40) : null, baseContainsIntegrated: state === "merged",
    mergeParents: state === "merged" ? [p.submission.baseCommit, p.submission.candidateCommit] : [],
    checks: state === "merged" ? [{ name: "integrated-ci", state: "passed" as const, evidenceUrl: p.targetUrl! }] : [] };
}
function feedback() {
  const r = report(), p = f.m.aggregate.n5.publication;
  return { ...r, protocol: "publisher-github-feedback-v1", provenance: "publisher_run_report", headSha: r.candidateCommit,
    headRef: "codex/leaf", draft: false, checks: [{ name: "candidate-ci", state: "passed", evidenceUrl: r.url }],
    reviews: [{ id: 1, author: "reviewer", headSha: p.submission.candidateCommit, state: "APPROVED", body: "Bounded approval", url: r.url + "#pullrequestreview-1", submittedAt: r.observedAt }] };
}
function input() { return { actor: { actorType: "agent", agentId: "publisher", runId: f.m.aggregate.n5.publication.runId } } as any; }
const ctx = { issues: { update: vi.fn() } } as any;
function command(kind = "n5-claim-merge") { return { command: kind, commandId: randomUUID(), expectedVersion: f.m.version, integrationReport: report(kind === "n5-claim-merge" ? "open" : "merged"), feedbackReport: feedback() }; }

it("preserves legacy draft contracts and requires explicit integrated authority", () => {
  expect(parsePrContract({ protocol: "council-pr-contract-v1", result: "draft-pr", draftOnly: true, feedback: "review-and-correct", requiredChecks: ["ci"] })?.integration).toBeUndefined();
  expect(() => parsePrContract({ ...f.m.aggregate.n5.authority.contract, integration: undefined })).toThrow();
  expect(() => parsePrContract({ ...f.m.aggregate.n5.authority.contract, result: "reviewed-pr" })).toThrow();
  expect(parseIntegrationContract(contract)).toEqual(contract);
});
it.each(["runId", "intentId", "companyId", "url", "candidateCommit", "baseCommit", "observedAt"])("rejects stale/foreign integration %s", field => {
  const r = { ...report(), [field]: field === "observedAt" ? new Date(Date.now() - 400000).toISOString() : "foreign" };
  expect(() => validateIntegrationReport(f.m, r, f.m.aggregate.n5.publication.runId)).toThrow();
});
it.each(["failed", "missing", "wrong-parents", "not-in-base"])("keeps the next delivery blocked after %s post-merge evidence", kind => {
  const r = report("merged");
  if (kind === "failed") r.checks[0]!.state = "failed" as any;
  if (kind === "missing") r.checks = [];
  if (kind === "wrong-parents") r.mergeParents = ["d".repeat(40), r.candidateCommit];
  if (kind === "not-in-base") r.baseContainsIntegrated = false;
  expect(integrationReportState(contract, r)).not.toBe("verified");
});
it("distinguishes squash commit checks from candidate checks", () => {
  const r = report("merged"); r.mergeParents = [r.baseCommit];
  expect(integrationReportState({ ...contract, mergeMethod: "squash" }, r)).toBe("verified");
  r.checks[0]!.name = "candidate-ci";
  expect(integrationReportState({ ...contract, mergeMethod: "squash" }, r)).toBe("pending");
});
it("persists a one-shot merge before granting execute and recovers a lost reply without another permission", async () => {
  const body = command();
  expect((await handleIntegrationAgent(ctx, f.m, input(), body)).effectPermission).toBe("execute");
  expect(f.m.aggregate.n5.integration.mergeCommandId).toBe(body.commandId);
  expect((await handleIntegrationAgent(ctx, structuredClone(f.m), input(), body)).effectPermission).toBe("none");
  await expect(handleIntegrationAgent(ctx, f.m, input(), command())).rejects.toMatchObject({ code: "merge_effect_claimed" });
});
it.each(["changed-candidate", "changed-head", "review-request", "failed-ci", "paused"])("does not claim a merge with %s", async condition => {
  const body = command();
  if (condition === "changed-candidate") f.accepted.mockReturnValue({ ...f.m.aggregate.n5.publication.submission, evidenceRevision: 2 });
  if (condition === "changed-head") f.native.matchesCandidate = false;
  if (condition === "review-request") body.feedbackReport.reviews[0]!.state = "CHANGES_REQUESTED";
  if (condition === "failed-ci") body.feedbackReport.checks[0]!.state = "failed";
  if (condition === "paused") f.departure.mockRejectedValue(new Error("paused"));
  await expect(handleIntegrationAgent(ctx, f.m, input(), body)).rejects.toThrow();
  expect(f.m.aggregate.n5.integration.mergeClaimedAt).toBeUndefined();
});
it("reconciles the original PR after an uncertain merge and waits for terminal accounting", async () => {
  await handleIntegrationAgent(ctx, f.m, input(), command());
  await handleIntegrationAgent(ctx, f.m, input(), command("n5-observe-integration"));
  expect(() => integratedResult(f.m)).toThrow();
  f.m.aggregate.n5.publication.settledAt = new Date().toISOString();
  expect(integratedResult(f.m).integratedCommit).toBe("c".repeat(40));
  f.m.aggregate.n2.activeSubmissionId = randomUUID();
  expect(() => integratedResult(f.m)).toThrow();
});
