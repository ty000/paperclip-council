import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";
import { validateCampaignReviewReport, type CampaignClosureSubject } from "../src/campaign-closure-contract.js";
import { controlFixedCampaign } from "../src/linear-campaign-control.js";

const hash = (value: unknown) => canonicalPayloadHash(value);
function subject(): CampaignClosureSubject {
  const coverage = [
    { criterionId: "criterion:1", kind: "criterion" as const, label: "Ship the exact milestone scope", sourceSha256: hash("criterion") },
    { criterionId: "reference:prd", kind: "prd" as const, label: "PRD v1", sourceSha256: hash("prd") },
  ];
  const results = [{ resultId: `delivery:${randomUUID()}`, sourceId: randomUUID(), missionId: randomUUID(), issueId: randomUUID(),
    proofId: hash("proof"), completionDocument: { key: "completion", revisionId: randomUUID(), bodySha256: hash("body") },
    integratedResult: { url: "https://example.test/pull/1", integratedCommit: "a".repeat(40) }, integratedResultSha256: hash("result") }];
  return { schema: "council-linear-campaign-review-subject-v1", campaignRootMissionId: randomUUID(),
    sourceSha256: hash("source"), mandateSha256: hash("mandate"), coverageSha256: hash(coverage), resultsSha256: hash(results),
    coverage, results, priorPublicationSha256s: [hash("plan")], allowedProofIds: [results[0]!.proofId, results[0]!.resultId] };
}
function report(s: CampaignClosureSubject) {
  return { schema: "council-linear-campaign-review-report-v1" as const, campaignRootMissionId: s.campaignRootMissionId,
    taskId: randomUUID(), sourceSha256: s.sourceSha256, mandateSha256: s.mandateSha256,
    coverageSha256: s.coverageSha256, resultsSha256: s.resultsSha256, verdict: "approved" as const,
    rows: s.coverage.map(item => ({ criterionId: item.criterionId, sourceSha256: item.sourceSha256,
      deliveryOrObligationIds: [s.results[0]!.resultId], verification: { environment: "isolated native host", method: "Read exact integrated proof" },
      result: "satisfied" as const, proofIds: [s.results[0]!.proofId], remainder: null })) };
}

it("accepts one exact current coverage row per source and no free-form proof authority", () => {
  const s = subject(), r = report(s);
  expect(validateCampaignReviewReport(s, r.taskId, r)).toEqual(r);
  expect(() => validateCampaignReviewReport(s, r.taskId, { ...r,
    rows: r.rows.map((row, index) => index ? row : { ...row, proofIds: [hash("untrusted")] }) })).toThrowError(/pinned sources/);
});

it("blocks missing, stale or incomplete global coverage", () => {
  const s = subject(), r = report(s);
  expect(() => validateCampaignReviewReport(s, r.taskId, { ...r, rows: r.rows.slice(1) })).toThrowError(/exactly once/);
  expect(() => validateCampaignReviewReport(s, r.taskId, { ...r, resultsSha256: hash("stale") })).toThrowError(/exact current/);
  expect(() => validateCampaignReviewReport(s, r.taskId, { ...r, rows: r.rows.map((row, index) => index ? row : {
    ...row, result: "unknown", proofIds: [], remainder: "Native publication is unknown" }) })).toThrowError(/Approval requires/);
});

it("retains a valid negative verdict as an explicit terminal review result", () => {
  const s = subject(), r = report(s);
  const blocked = { ...r, verdict: "blocked" as const, rows: r.rows.map((row, index) => index ? row : {
    ...row, result: "unsatisfied" as const, proofIds: [], remainder: "Parent obligation has no current proof" }) };
  expect(validateCampaignReviewReport(s, r.taskId, blocked)).toEqual(blocked);
});

it("rejects a competing cancellation after the terminal publication CAS claim", async () => {
  const s = subject(), taskId = randomUUID();
  const mission = { companyId: randomUUID(), projectId: randomUUID(), missionId: s.campaignRootMissionId,
    rootIssueId: randomUUID(), ownerUserId: "owner", version: 7, aggregate: { completion: undefined,
      linearContinuity: { mode: "milestone-fixed-v1", control: "running" },
      campaignClosure: { protocol: "council-linear-campaign-closure-v1", phase: "publishing", subject: s,
        task: { taskId, agentId: randomUUID(), issueId: randomUUID(), creation: "confirmed", reservationId: randomUUID(),
          settlementCommandId: randomUUID(), runId: randomUUID(), wake: "claimed" }, proofDocument: { key: "proof", body: "{}" }, nativeClosures: [] } } } as unknown as MissionRecord;
  await expect(controlFixedCampaign({} as never, mission, { command: "cancel-linear-campaign", reason: "Stop", commandId: randomUUID(), expectedVersion: 7 }, "owner"))
    .rejects.toMatchObject({ code: "linear_campaign_terminal_claimed" });
});
