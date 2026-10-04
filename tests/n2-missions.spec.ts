import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DecisionReceipt } from "../src/decision-receipts.js";
import type { IntegratedCandidateVerification } from "../src/integration.js";
import { canonicalPayloadHash, type MissionAggregate, type MissionRecord } from "../src/missions.js";
import {
  applyN2Decision,
  bindN2CorrectionRun,
  confirmN2ReviewHandoff,
  inspectN2State,
  markN2ReviewHandoffUnknown,
  n2SubmissionResultReference,
  prepareN2Resubmission,
  startN2Review,
  startN2ResubmittedReview,
} from "../src/n2-missions.js";

const ids = {
  company: randomUUID(), mission: randomUUID(), root: randomUUID(), project: randomUUID(), owner: randomUUID(),
  lead: randomUUID(), reviewer: randomUUID(), contributorA: randomUUID(), contributorB: randomUUID(),
  reviewerRun1: randomUUID(), reviewerRun2: randomUUID(), correctionRun: randomUUID(),
  submission1: randomUUID(), submission2: randomUUID(), operation1: randomUUID(), operation2: randomUUID(),
};

function candidate(
  commit = "c".repeat(40),
  sha = "d".repeat(64),
  baseCommit = "a".repeat(40),
): IntegratedCandidateVerification {
  return {
    outcome: "verified",
    publicationEligible: true,
    subject: { companyId: ids.company, issueId: ids.root },
    candidate: {
      attachmentId: randomUUID(), byteSize: 120, sha256: sha,
      baseCommit, candidateCommit: commit,
    },
    contributions: [
      { contributionId: randomUUID(), commit: "1".repeat(40), ownedPaths: ["src/a/"], changedPaths: ["src/a/a.ts"] },
      { contributionId: randomUUID(), commit: "2".repeat(40), ownedPaths: ["src/b/"], changedPaths: ["src/b/b.ts"] },
    ],
    checks: [{ name: "fixture", status: "passed", detail: "verified" }],
  };
}

function mission(): MissionRecord {
  const aggregate: MissionAggregate = {
    schemaVersion: 1,
    missionId: ids.mission,
    companyId: ids.company,
    rootIssueId: ids.root,
    projectId: ids.project,
    ownerUserId: ids.owner,
    mandate: {
      objective: "Review one corrected integrated candidate",
      acceptanceCriteria: ["V2 receives an independent review"],
      commitments: ["No uncertain decision passes"],
      limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 1, elapsedMinutes: 60 },
    },
    compositions: {
      status: "pinned",
      team: {
        rosterId: randomUUID(), revision: randomUUID(), kind: "team", name: "team", projectId: ids.project,
        members: [ids.lead, ids.contributorA, ids.contributorB].map((agentId) => ({ agentId, responsibilities: [] })),
      },
      council: {
        rosterId: randomUUID(), revision: randomUUID(), kind: "council", name: "council", projectId: ids.project,
        members: [{ agentId: ids.reviewer, responsibilities: ["final_reviewer"] }],
      },
    },
    responsibilities: { integrationLeadAgentId: ids.lead, finalReviewerAgentId: ids.reviewer, requiredPerspectives: [] },
    phase: "ready_for_review",
    control: { status: "inactive", reason: "candidate_ready_for_review" },
    readiness: { mission: "recorded", compositions: "pinned", execution: "blocked", blockers: [] },
    journal: [], commandReceipts: [], effectIntents: [],
    n1: {
      candidate: candidate(),
      contributions: [
        { assigneeAgentId: ids.contributorA, authorRunId: randomUUID() },
        { assigneeAgentId: ids.contributorB, authorRunId: randomUUID() },
      ],
    },
  };
  return {
    companyId: ids.company, missionId: ids.mission, rootIssueId: ids.root, projectId: ids.project,
    ownerUserId: ids.owner, teamRosterId: aggregate.compositions.team.rosterId, teamRevision: aggregate.compositions.team.revision,
    councilRosterId: aggregate.compositions.council.rosterId, councilRevision: aggregate.compositions.council.revision,
    version: 12, aggregate, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function observedReceipt(input: {
  operationId: string; verdict: "changes_requested" | "approved"; runId: string; state?: "native_observed" | "indeterminate";
  submissionId?: string; candidateCommit?: string;
}): DecisionReceipt {
  const state = input.state ?? "native_observed";
  const submissionId = input.submissionId ?? ids.submission1;
  const candidateCommit = input.candidateCommit ?? "c".repeat(40);
  return {
    companyId: ids.company, issueId: ids.root, operationId: input.operationId, verdict: input.verdict,
    state, blockReason: state === "indeterminate" ? "native_outcome_unknown" : null,
    targetUrl: `http://127.0.0.1/api/issues/${ids.root}`,
    requestBody: {
      status: input.verdict === "changes_requested" ? "in_progress" : "done",
      comment: [
        `Council decision: ${input.verdict === "changes_requested" ? "changes requested" : "approved"}.`,
        "Justification: bounded review",
        `Result reference: ${n2SubmissionResultReference(submissionId)}`,
        `Operation ID: ${input.operationId}`,
        ...(input.verdict === "approved" ? [`Approved commit: ${candidateCommit}`] : []),
      ].join("\n"),
    },
    actorAgentId: ids.reviewer,
    runId: input.runId, claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nativeObservation: state === "native_observed"
      ? { status: 200, body: { id: ids.root }, observedAt: new Date().toISOString(), usable: true }
      : null,
    humanDecisions: [],
  };
}

function reviewingRound1() {
  const source = mission();
  const started = startN2Review(source, { baselineRunIds: [randomUUID()], baselineTokenTotal: 100, submissionId: ids.submission1 });
  const baseline = started.rounds[0].handoff.baselineRunIds;
  const reviewing = confirmN2ReviewHandoff(started, source, {
    status: "in_review", assigneeAgentId: ids.reviewer, currentParticipantAgentId: ids.reviewer,
    returnAssigneeAgentId: ids.lead, observedRunIds: [...baseline, ids.reviewerRun1], reviewerRunId: ids.reviewerRun1,
  });
  return { source, reviewing };
}

describe("N2 ordinary correction and confirmed acceptance", () => {
  it("starts only from a verified candidate with one explicit correction and an independent reviewer", () => {
    const source = mission();
    const state = startN2Review(source, { baselineRunIds: [], baselineTokenTotal: 0, submissionId: ids.submission1 });
    expect(state).toMatchObject({ status: "review_handoff", correctionLimit: 1, correctionsUsed: 0, activeSubmissionId: ids.submission1 });
    source.aggregate.mandate.limits.correctionLimit = 0;
    expect(() => startN2Review(source, { baselineRunIds: [], baselineTokenTotal: 0 })).toThrowError(/exactly one correction/);
  });

  it("rejects author/reviewer conflicts and mismatched native handoff evidence", () => {
    const source = mission();
    source.aggregate.responsibilities.finalReviewerAgentId = ids.contributorA;
    expect(() => startN2Review(source, { baselineRunIds: [], baselineTokenTotal: 0 })).toThrowError(/not independent/);
    const clean = mission();
    const state = startN2Review(clean, { baselineRunIds: [], baselineTokenTotal: 0 });
    expect(() => confirmN2ReviewHandoff(state, clean, {
      status: "in_review", assigneeAgentId: ids.reviewer, currentParticipantAgentId: ids.reviewer,
      returnAssigneeAgentId: ids.lead, observedRunIds: [ids.reviewerRun1, randomUUID()], reviewerRunId: ids.reviewerRun1,
    })).toThrowError(/do not match/);
    const baselineRun = randomUUID();
    const duplicate = startN2Review(clean, { baselineRunIds: [baselineRun], baselineTokenTotal: 100 });
    expect(() => confirmN2ReviewHandoff(duplicate, clean, {
      status: "in_review", assigneeAgentId: ids.reviewer, currentParticipantAgentId: ids.reviewer,
      returnAssigneeAgentId: ids.lead, observedRunIds: [baselineRun, baselineRun], reviewerRunId: baselineRun,
    })).toThrowError(/do not match/);
  });

  it("preserves an uncertain handoff and blocks confirmation or a duplicate transition", () => {
    const source = mission();
    const started = startN2Review(source, { baselineRunIds: [], baselineTokenTotal: 0 });
    const unknown = markN2ReviewHandoffUnknown(started, { reason: "Native PATCH response was lost" });
    const persisted = mission(); persisted.aggregate.n2 = JSON.parse(JSON.stringify(unknown));
    expect(inspectN2State(persisted)).toMatchObject({
      review: { handoff: { state: "unknown", reason: "Native PATCH response was lost" } },
      blockage: { code: "review_handoff_unknown" },
      nextAction: { actorKind: "operator", label: expect.stringContaining("do not retry") },
    });
    expect(() => confirmN2ReviewHandoff(unknown, source, {
      status: "in_review", assigneeAgentId: ids.reviewer, currentParticipantAgentId: ids.reviewer,
      returnAssigneeAgentId: ids.lead, observedRunIds: [ids.reviewerRun1], reviewerRunId: ids.reviewerRun1,
    })).toThrowError(/awaiting confirmation/);
  });

  it("binds one changes-requested receipt to the exact reviewer run and preserves criteria", () => {
    const { source, reviewing } = reviewingRound1();
    const corrected = applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun1,
      operationId: ids.operation1, verdict: "changes_requested", criteria: ["Tests pass"], reasons: ["Add the missing regression"],
      receipt: observedReceipt({ operationId: ids.operation1, verdict: "changes_requested", runId: ids.reviewerRun1 }),
    });
    expect(corrected).toMatchObject({
      status: "correction_requested", correctionsUsed: 1,
      correction: { requestedByOperationId: ids.operation1, criteria: ["Tests pass"], reasons: ["Add the missing regression"], executorAgentId: ids.lead },
    });
    expect(() => applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: randomUUID(), operationId: ids.operation1,
      verdict: "changes_requested", criteria: ["x"], reasons: ["y"],
      receipt: observedReceipt({ operationId: ids.operation1, verdict: "changes_requested", runId: ids.reviewerRun1 }),
    })).toThrowError(/confirmed native review run/);
    const wrongSubject = observedReceipt({ operationId: ids.operation1, verdict: "changes_requested", runId: ids.reviewerRun1 });
    wrongSubject.requestBody.comment = String(wrongSubject.requestBody.comment).replace(ids.submission1, randomUUID());
    expect(() => applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun1, operationId: ids.operation1,
      verdict: "changes_requested", criteria: ["x"], reasons: ["y"], receipt: wrongSubject,
    })).toThrowError(/active submission and candidate/);
  });

  it("keeps an indeterminate verdict blocked and never presents it as accepted", () => {
    const { source, reviewing } = reviewingRound1();
    const unknown = applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun1,
      operationId: ids.operation1, verdict: "approved", criteria: ["x"], reasons: ["y"],
      receipt: observedReceipt({ operationId: ids.operation1, verdict: "approved", runId: ids.reviewerRun1, state: "indeterminate" }),
    });
    expect(unknown).toMatchObject({ status: "application_unknown", application: { state: "unknown", receiptState: "indeterminate" } });
    const persisted = mission(); persisted.aggregate.n2 = unknown; persisted.aggregate.phase = "application_unknown";
    expect(inspectN2State(persisted)).toMatchObject({ blockage: { code: "application_unknown" } });
  });

  it.each(["No correction is needed", "r".repeat(1_455), "r".repeat(8_000)])("accepts a conforming candidate with the complete bounded justification", reason => {
    const { source, reviewing } = reviewingRound1();
    const accepted = applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun1,
      operationId: ids.operation1, verdict: "approved", criteria: ["V1 conforms"], reasons: [reason],
      receipt: observedReceipt({ operationId: ids.operation1, verdict: "approved", runId: ids.reviewerRun1 }),
    });
    expect(accepted).toMatchObject({
      status: "accepted", correctionsUsed: 0,
      application: { state: "observed", submissionId: ids.submission1, receiptState: "native_observed" },
    });
    expect(accepted.rounds[0]!.verdict!.reasons).toEqual([reason]);
    accepted.rounds[0]!.handoff.usageSettledAt = "2026-10-01T00:00:00.000Z";
    const persisted = mission(); persisted.aggregate.n2 = accepted; persisted.aggregate.phase = "accepted";
    expect(inspectN2State(persisted)).toMatchObject({
      submission: { ordinal: 1, submissionId: ids.submission1 },
      nextAction: { label: expect.stringContaining("active reviewed submission") },
    });
  });

  it.each([
    { criteria: ["Criterion"], reasons: ["r".repeat(8_001)] },
    { criteria: ["c".repeat(1_001)], reasons: ["Valid reason"] },
  ])("retains separate reason and criterion limits", lists => {
    const { source, reviewing } = reviewingRound1();
    expect(() => applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun1,
      operationId: ids.operation1, verdict: "approved", ...lists,
      receipt: observedReceipt({ operationId: ids.operation1, verdict: "approved", runId: ids.reviewerRun1 }),
    })).toThrow(/bounded entries/);
  });

  it("requires the exact correction run and a changed verified V2 candidate", () => {
    const { source, reviewing } = reviewingRound1();
    const requested = applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun1,
      operationId: ids.operation1, verdict: "changes_requested", criteria: ["x"], reasons: ["y"],
      receipt: observedReceipt({ operationId: ids.operation1, verdict: "changes_requested", runId: ids.reviewerRun1 }),
    });
    const correcting = bindN2CorrectionRun(requested, source, { actorAgentId: ids.lead, runId: ids.correctionRun });
    const validResubmission = {
      actorAgentId: ids.lead, runId: ids.correctionRun,
      candidate: candidate("e".repeat(40), "f".repeat(64)),
      evidenceRevision: 13, correctedPaths: ["src/a.ts"],
    };
    expect(() => prepareN2Resubmission(correcting, source, {
      ...validResubmission, candidate: {
        ...validResubmission.candidate,
        subject: { companyId: ids.company, issueId: randomUUID() },
      },
    })).toThrowError(/mission root issue and company/);
    expect(() => prepareN2Resubmission(correcting, source, {
      ...validResubmission, candidate: candidate("e".repeat(40), "f".repeat(64), "b".repeat(40)),
    })).toThrowError(/base commit/);
    source.aggregate.mandate.objective = "Different mandate";
    expect(() => prepareN2Resubmission(correcting, source, validResubmission)).toThrowError(/same immutable review mandate/);
    source.aggregate.mandate.objective = "Review one corrected integrated candidate";
    expect(() => prepareN2Resubmission(correcting, source, {
      actorAgentId: ids.lead, runId: ids.correctionRun, candidate: candidate(),
      evidenceRevision: 13, correctedPaths: ["src/a.ts"],
    })).toThrowError(/changed commit and bytes/);
    const prepared = prepareN2Resubmission(correcting, source, {
      ...validResubmission, submissionId: ids.submission2,
    });
    expect(prepared).toMatchObject({ status: "resubmission_prepared", correction: { preparedSubmission: { submissionId: ids.submission2 } } });
    expect(() => startN2ResubmittedReview(prepared, source, {
      baselineRunIds: [ids.reviewerRun1, ids.correctionRun], baselineTokenTotal: 300,
    })).toThrowError(/settled correction run/);
    const settled = {
      ...prepared,
      correction: { ...prepared.correction!, usageSettledAt: "2026-10-02T00:00:00.000Z" },
    };
    expect(() => startN2ResubmittedReview(settled, source, {
      baselineRunIds: [ids.reviewerRun1], baselineTokenTotal: 200,
    })).toThrowError(/exact settled correction run identity/);
    const resubmitted = startN2ResubmittedReview(settled, source, {
      baselineRunIds: [ids.reviewerRun1, ids.correctionRun], baselineTokenTotal: 300,
    });
    expect(resubmitted).toMatchObject({ status: "review_handoff", activeSubmissionId: ids.submission2, submissions: [{ ordinal: 1 }, { ordinal: 2, predecessorSubmissionId: ids.submission1 }] });
  });

  it("accepts corrected V2 after a fresh second native review and exact observed approval", () => {
    const { source, reviewing } = reviewingRound1();
    const requested = applyN2Decision(reviewing, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun1,
      operationId: ids.operation1, verdict: "changes_requested", criteria: ["x"], reasons: ["y"],
      receipt: observedReceipt({ operationId: ids.operation1, verdict: "changes_requested", runId: ids.reviewerRun1 }),
    });
    const correcting = bindN2CorrectionRun(requested, source, { actorAgentId: ids.lead, runId: ids.correctionRun });
    const prepared = prepareN2Resubmission(correcting, source, {
      actorAgentId: ids.lead, runId: ids.correctionRun, candidate: candidate("e".repeat(40), "f".repeat(64)),
      evidenceRevision: 13, correctedPaths: ["src/a.ts"], submissionId: ids.submission2,
    });
    const round2 = startN2ResubmittedReview({
      ...prepared,
      correction: { ...prepared.correction!, usageSettledAt: "2026-10-02T00:00:00.000Z" },
    }, source, {
      baselineRunIds: [ids.reviewerRun1, ids.correctionRun], baselineTokenTotal: 300,
    });
    const reviewing2 = confirmN2ReviewHandoff(round2, source, {
      status: "in_review", assigneeAgentId: ids.reviewer, currentParticipantAgentId: ids.reviewer,
      returnAssigneeAgentId: ids.lead, observedRunIds: [...round2.rounds[1].handoff.baselineRunIds, ids.reviewerRun2],
      reviewerRunId: ids.reviewerRun2,
    });
    const accepted = applyN2Decision(reviewing2, source, {
      submissionId: ids.submission2, actorAgentId: ids.reviewer, runId: ids.reviewerRun2,
      operationId: ids.operation2, verdict: "approved", criteria: ["Regression covered"], reasons: ["V2 satisfies the request"],
      receipt: observedReceipt({
        operationId: ids.operation2, verdict: "approved", runId: ids.reviewerRun2,
        submissionId: ids.submission2, candidateCommit: "e".repeat(40),
      }),
    });
    expect(accepted).toMatchObject({ status: "accepted", application: { state: "observed", submissionId: ids.submission2, receiptState: "native_observed" } });
    expect(() => applyN2Decision(reviewing2, source, {
      submissionId: ids.submission1, actorAgentId: ids.reviewer, runId: ids.reviewerRun2,
      operationId: randomUUID(), verdict: "approved", criteria: ["x"], reasons: ["y"],
      receipt: observedReceipt({ operationId: randomUUID(), verdict: "approved", runId: ids.reviewerRun2 }),
    })).toThrowError(/active immutable submission/);
  });
});


it("binds native GET receipts to the persisted reviewer report and rejects legacy-shaped substitutes", () => {
  const { source, reviewing } = reviewingRound1(); const submission = reviewing.submissions[0]!;
  const report = { schema: "council-native-review-v1", packetHash: "f".repeat(64), subject: { submissionId: submission.submissionId,
    candidateCommit: submission.candidateCommit, bundleSha256: submission.sha256, evidenceRevision: submission.evidenceRevision, mandateHash: submission.mandateHash },
    verdict: "approved", rationale: "Exact reviewed candidate", dispositions: [] };
  source.aggregate.n2 = { ...reviewing, native: { reviewProtocol: "native-verdict-readback-v1", reviewPackets: [{ operationId: ids.operation1,
    hash: report.packetHash, packet: { submission }, observation: { runId: ids.reviewerRun1, report } }] } } as never;
  const receipt = observedReceipt({ operationId: ids.operation1, verdict: "approved", runId: ids.reviewerRun1 });
  const apply = () => applyN2Decision(reviewing, source, { submissionId: submission.submissionId, actorAgentId: ids.reviewer, runId: ids.reviewerRun1,
    operationId: ids.operation1, verdict: "approved", criteria: ["Exact candidate"], reasons: [report.rationale], receipt });
  expect(apply).toThrow(/receipt content/);
  receipt.requestBody = { method: "GET", provenance: "native-review-terminal-readback-v1", packetHash: report.packetHash, reportHash: canonicalPayloadHash(report) };
  expect(apply().status).toBe("accepted");
  receipt.requestBody.reportHash = "0".repeat(64); expect(apply).toThrow(/receipt content/);
  receipt.requestBody.reportHash = canonicalPayloadHash(report); receipt.requestBody.packetHash = "0".repeat(64); expect(apply).toThrow(/receipt content/);
});
