import { randomUUID } from "node:crypto";
import type { MissionRecord, MissionAggregate } from "./missions.js";
import type { N2Submission } from "./n2-missions.js";
import { ordinaryRound, reviewTasks } from "./ordinary-review-tasks.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { feedbackCorrectionRound } from "./pr-contract.js";

/** Pure candidate/evidence rebinding. Historical receipts and cumulative costs are retained. */
export function prepareFeedbackReview(m: MissionRecord): MissionAggregate {
  const n5 = m.aggregate.n5!, p = n5.publication!, n2 = m.aggregate.n2!;
  const report = p.controllerFeedbackReport ?? p.feedbackReport;
  if (!n5.authority.contract || !report || !p.settledAt || !p.observation?.matchesCandidate || p.observation.state !== "open"
      || p.observation.draft !== n5.authority.contract.draftOnly || n2.status !== "accepted" || !n2.ordinary
      || n2.activeSubmissionId !== p.submission.submissionId || n2.ordinary.tasks.some(t => !t.closedAt)
      || n2.correctionsUsed >= n2.correctionLimit || n2.rounds.length !== 1 || n5.continuation || n5.feedback?.state === "reviewing") {
    throw new MissionError(409, "pr_feedback_not_admissible", "Exact settled conformant PR, independent acceptance and remaining cumulative correction required; no reset or replacement effect");
  }
  const submission: N2Submission = { ...p.submission, submissionId: randomUUID(), ordinal: 2, predecessorSubmissionId: p.submission.submissionId,
    evidenceRevision: m.version + 1, verifiedAt: new Date().toISOString() };
  const round = ordinaryRound(m, submission, m.aggregate.n3!.slots), tasks = reviewTasks(m, round);
  return { ...m.aggregate, phase: "review_handoff", control: { status: "active" },
    n5: { ...n5, feedback: { report, reportHash: canonicalPayloadHash(report), state: "reviewing",
      reviewSubmissionId: submission.submissionId, previousPublication: structuredClone(p), previousApplication: structuredClone(n2.application) },
      ...(n5.feedback ? { feedbackHistory: [...n5.feedbackHistory ?? [], structuredClone(n5.feedback)] } : {}) },
    n2: { ...n2, submissions: [...n2.submissions, submission], activeSubmissionId: submission.submissionId, status: "review_handoff",
      application: { state: "none", submissionId: null, operationId: null, receiptState: null, nativeStatus: null },
      ordinary: { ...n2.ordinary, tasks: [...n2.ordinary.tasks, ...tasks] }, rounds: [...n2.rounds, { round: 2, submissionId: submission.submissionId,
        reviewerAgentId: m.aggregate.responsibilities.finalReviewerAgentId, handoff: { state: "awaiting_native", baselineRunIds: [p.runId!], baselineTokenTotal: 0,
          reviewerRunId: null, reason: null, observedAt: null, reservationId: tasks.at(-1)!.reservationId }, verdict: null }] },
    n3: { ...m.aggregate.n3!, rounds: [...m.aggregate.n3!.rounds, round] },
    journal: [...m.aggregate.journal, { action: "pr_feedback_independent_review", submissionId: submission.submissionId,
      previousSubmissionId: p.submission.submissionId, reportHash: canonicalPayloadHash(report), at: new Date().toISOString() }] };
}

/** Only the independent Council verdict can authorize the existing sole correction. */
export function prepareFeedbackContinuation(m: MissionRecord, verdict: "approved" | "changes_requested", operationId: string): MissionAggregate {
  const n5 = m.aggregate.n5, n2 = m.aggregate.n2!;
  if (!feedbackCorrectionRound(m, n2.activeSubmissionId)) return m.aggregate;
  const feedback = n5!.feedback!;
  if (verdict === "approved") return { ...m.aggregate, n5: { ...n5!, feedback: { ...feedback, state: "resolved" } } };
  if (n5!.continuation || n2.correctionsUsed !== 1 || !n2.correction?.reservationId || !feedback.previousPublication?.settledAt) {
    throw new MissionError(409, "pr_feedback_correction_binding", "Only the exact Council-admitted cumulative correction may update this PR");
  }
  const n1 = m.aggregate.n1 as { periodKey: string };
  return { ...m.aggregate, n5: { ...n5!, feedback: { ...feedback, state: "correction_requested" }, continuation: {
    delegatedFeedback: true, requestId: operationId, reason: n2.correction.reasons.join("\n"), criteria: n2.correction.criteria,
    requestedBy: m.ownerUserId, requestedAt: new Date().toISOString(), periodKey: n1.periodKey,
    previousApplication: feedback.previousApplication!, previousPlan: structuredClone(n5!.plan), previousPublication: feedback.previousPublication,
    reopen: { state: "claimed", reservationId: n2.correction.reservationId } } } };
}
