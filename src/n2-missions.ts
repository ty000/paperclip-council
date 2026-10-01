import { createHash, randomUUID } from "node:crypto";
import type { DecisionReceipt } from "./decision-receipts.js";
import type { IntegratedCandidateVerification } from "./integration.js";
import { MissionError, type MissionRecord } from "./missions.js";

export type N2Submission = {
  submissionId: string;
  ordinal: 1 | 2;
  predecessorSubmissionId: string | null;
  attachmentId: string;
  byteSize: number;
  sha256: string;
  baseCommit: string;
  candidateCommit: string;
  evidenceRevision: number;
  mandateHash: string;
  verifiedAt: string;
};

export type N2NativeHandoff = {
  state: "awaiting_native" | "confirmed" | "unknown";
  baselineRunIds: string[];
  baselineTokenTotal: number;
  reviewerRunId: string | null;
  reason: string | null;
  observedAt: string | null;
};

export type N2Verdict = {
  verdict: "changes_requested" | "approved";
  operationId: string;
  actorAgentId: string;
  runId: string;
  criteria: string[];
  reasons: string[];
  receiptState: "indeterminate" | "native_observed";
  nativeStatus: number | null;
  decidedAt: string;
};

export type N2ReviewRound = {
  round: 1 | 2;
  submissionId: string;
  reviewerAgentId: string;
  handoff: N2NativeHandoff;
  verdict: N2Verdict | null;
};

export type N2State = {
  schemaVersion: 1;
  correctionLimit: 1;
  correctionsUsed: 0 | 1;
  submissions: N2Submission[];
  rounds: N2ReviewRound[];
  activeSubmissionId: string;
  status: "review_handoff" | "reviewing" | "correction_requested" | "correcting" | "application_unknown" | "accepted";
  correction: null | {
    requestedByOperationId: string;
    criteria: string[];
    reasons: string[];
    executorAgentId: string;
    runId: string | null;
  };
  application: {
    state: "none" | "observed" | "unknown";
    submissionId: string | null;
    operationId: string | null;
    receiptState: "indeterminate" | "native_observed" | null;
    nativeStatus: number | null;
  };
};

export function n2SubmissionResultReference(submissionId: string): string {
  return `council:n2:submission:${submissionId}`;
}

type N1Candidate = IntegratedCandidateVerification;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionError(409, "n2_state_invalid", `${label} is unavailable or malformed`);
  }
  return value as Record<string, unknown>;
}

function n1Candidate(mission: MissionRecord): N1Candidate {
  const n1 = record(mission.aggregate.n1, "N1 state");
  const candidate = record(n1.candidate, "verified N1 candidate") as unknown as N1Candidate;
  if (candidate.outcome !== "verified" || candidate.publicationEligible !== true) {
    throw new MissionError(409, "verified_n1_candidate_required", "N2 requires the exact verified N1 candidate");
  }
  return candidate;
}

function mandateHash(mission: MissionRecord): string {
  return createHash("sha256").update(JSON.stringify(mission.aggregate.mandate)).digest("hex");
}

function submissionFromCandidate(
  mission: MissionRecord,
  candidate: IntegratedCandidateVerification,
  input: {
    ordinal: 1 | 2; predecessorSubmissionId: string | null; evidenceRevision: number;
    submissionId?: string; at?: string;
  },
): N2Submission {
  return {
    submissionId: input.submissionId ?? randomUUID(),
    ordinal: input.ordinal,
    predecessorSubmissionId: input.predecessorSubmissionId,
    attachmentId: candidate.candidate.attachmentId,
    byteSize: candidate.candidate.byteSize,
    sha256: candidate.candidate.sha256,
    baseCommit: candidate.candidate.baseCommit,
    candidateCommit: candidate.candidate.candidateCommit,
    evidenceRevision: input.evidenceRevision,
    mandateHash: mandateHash(mission),
    verifiedAt: input.at ?? new Date().toISOString(),
  };
}

function reviewerConflicts(mission: MissionRecord): string[] {
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  const conflicts: string[] = [];
  if (reviewer === mission.aggregate.responsibilities.integrationLeadAgentId) conflicts.push("integration_lead");
  const n1 = mission.aggregate.n1 as { contributions?: Array<{ assigneeAgentId?: string; authorRunId?: string }> } | undefined;
  if (n1?.contributions?.some((entry) => entry.assigneeAgentId === reviewer)) conflicts.push("contributor");
  if (!mission.aggregate.compositions.council.members.some((member) => member.agentId === reviewer)) conflicts.push("not_pinned_council_member");
  return conflicts;
}

export function startN2Review(
  mission: MissionRecord,
  input: { baselineRunIds: string[]; baselineTokenTotal: number; submissionId?: string; at?: string },
): N2State {
  if (mission.aggregate.phase !== "ready_for_review") {
    throw new MissionError(409, "n2_entry_unavailable", "N2 starts only from a candidate ready for review");
  }
  if (mission.aggregate.mandate.limits.correctionLimit !== 1) {
    throw new MissionError(409, "n2_correction_profile_required", "N2 requires a mission mandate allowing exactly one correction");
  }
  if (!Number.isSafeInteger(input.baselineTokenTotal) || input.baselineTokenTotal < 0
      || new Set(input.baselineRunIds).size !== input.baselineRunIds.length) {
    throw new MissionError(422, "g4_baseline_invalid", "N2 native usage baseline is invalid");
  }
  const conflicts = reviewerConflicts(mission);
  if (conflicts.length > 0) {
    throw new MissionError(422, "reviewer_conflict", "Final reviewer is not independent and eligible", { conflicts });
  }
  const submission = submissionFromCandidate(mission, n1Candidate(mission), {
    ordinal: 1,
    predecessorSubmissionId: null,
    evidenceRevision: mission.version,
    submissionId: input.submissionId,
    at: input.at,
  });
  return {
    schemaVersion: 1,
    correctionLimit: 1,
    correctionsUsed: 0,
    submissions: [submission],
    rounds: [{
      round: 1,
      submissionId: submission.submissionId,
      reviewerAgentId: mission.aggregate.responsibilities.finalReviewerAgentId,
      handoff: {
        state: "awaiting_native",
        baselineRunIds: [...input.baselineRunIds].sort(),
        baselineTokenTotal: input.baselineTokenTotal,
        reviewerRunId: null,
        reason: null,
        observedAt: null,
      },
      verdict: null,
    }],
    activeSubmissionId: submission.submissionId,
    status: "review_handoff",
    correction: null,
    application: { state: "none", submissionId: null, operationId: null, receiptState: null, nativeStatus: null },
  };
}

function currentRound(state: N2State): N2ReviewRound {
  const round = state.rounds.at(-1);
  if (!round || round.submissionId !== state.activeSubmissionId) {
    throw new MissionError(409, "n2_state_invalid", "Active submission and review round are inconsistent");
  }
  return round;
}

export function confirmN2ReviewHandoff(
  state: N2State,
  mission: MissionRecord,
  input: {
    status: string;
    assigneeAgentId: string | null;
    currentParticipantAgentId: string | null;
    returnAssigneeAgentId: string | null;
    observedRunIds: string[];
    reviewerRunId: string;
    at?: string;
  },
): N2State {
  const round = currentRound(state);
  if (state.status !== "review_handoff" || round.handoff.state !== "awaiting_native") {
    throw new MissionError(409, "review_handoff_unavailable", "No native review handoff is awaiting confirmation");
  }
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  const lead = mission.aggregate.responsibilities.integrationLeadAgentId;
  const expectedRuns = [...round.handoff.baselineRunIds, input.reviewerRunId].sort();
  const observedRuns = [...input.observedRunIds].sort();
  const exact = expectedRuns.length === observedRuns.length && expectedRuns.every((value, index) => value === observedRuns[index]);
  if (input.status !== "in_review" || input.assigneeAgentId !== reviewer
      || input.currentParticipantAgentId !== reviewer || input.returnAssigneeAgentId !== lead || !exact) {
    throw new MissionError(409, "native_review_handoff_mismatch", "Native review stage, actors, or run identity do not match the pinned mission", {
      expectedReviewerAgentId: reviewer,
      expectedReturnAssigneeAgentId: lead,
      expectedRunIds: expectedRuns,
      observedRunIds: observedRuns,
    });
  }
  return {
    ...state,
    status: "reviewing",
    rounds: state.rounds.map((item) => item.round === round.round ? {
      ...item,
      handoff: { ...item.handoff, state: "confirmed", reviewerRunId: input.reviewerRunId, observedAt: input.at ?? new Date().toISOString() },
    } : item),
  };
}

export function markN2ReviewHandoffUnknown(
  state: N2State,
  input: { reason: string; at?: string },
): N2State {
  const round = currentRound(state);
  if (state.status !== "review_handoff" || round.handoff.state !== "awaiting_native") {
    throw new MissionError(409, "review_handoff_unavailable", "No native review handoff is awaiting reconciliation");
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 1_000) {
    throw new MissionError(422, "malformed_handoff_observation", "Unknown native handoff requires a bounded reason");
  }
  return {
    ...state,
    rounds: state.rounds.map((item) => item.round === round.round ? {
      ...item,
      handoff: {
        ...item.handoff,
        state: "unknown",
        reason,
        observedAt: input.at ?? new Date().toISOString(),
      },
    } : item),
  };
}

function boundedList(value: string[], label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20
      || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 1_000)) {
    throw new MissionError(422, "malformed_review", `${label} must contain 1-20 bounded entries`);
  }
  return value.map((entry) => entry.trim());
}

type N2DecisionInput = {
  submissionId: string;
  actorAgentId: string;
  runId: string;
  operationId: string;
  verdict: "changes_requested" | "approved";
  criteria: string[];
  reasons: string[];
  receipt: DecisionReceipt;
  at?: string;
};

function validateDecisionTarget(
  state: N2State,
  mission: MissionRecord,
  round: N2ReviewRound,
  input: N2DecisionInput,
): N2Submission {
  if (state.status !== "reviewing" || round.handoff.state !== "confirmed" || round.verdict) {
    throw new MissionError(409, "review_decision_unavailable", "The active round cannot accept another verdict");
  }
  if (input.submissionId !== state.activeSubmissionId || round.submissionId !== input.submissionId) {
    throw new MissionError(409, "stale_submission", "Verdict does not target the active immutable submission");
  }
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  if (input.actorAgentId !== reviewer || input.runId !== round.handoff.reviewerRunId) {
    throw new MissionError(403, "reviewer_run_required", "Pinned reviewer and confirmed native review run required");
  }
  return state.submissions.find((item) => item.submissionId === input.submissionId)!;
}

function decisionReceiptMetadataMatches(mission: MissionRecord, input: N2DecisionInput): boolean {
  const receipt = input.receipt;
  return receipt.companyId === mission.companyId
    && receipt.issueId === mission.rootIssueId
    && receipt.operationId === input.operationId
    && receipt.verdict === input.verdict
    && receipt.actorAgentId === input.actorAgentId
    && receipt.runId === input.runId;
}

function decisionReceiptSubjectMatches(submission: N2Submission, input: N2DecisionInput): boolean {
  const receipt = input.receipt;
  const requestStatus = input.verdict === "changes_requested" ? "in_progress" : "done";
  const lines = typeof receipt.requestBody.comment === "string"
    ? receipt.requestBody.comment.split("\n")
    : [];
  const requiredLines = [
    `Result reference: ${n2SubmissionResultReference(input.submissionId)}`,
    `Operation ID: ${input.operationId}`,
  ];
  if (input.verdict === "approved") requiredLines.push(`Approved commit: ${submission.candidateCommit}`);
  return receipt.requestBody.status === requestStatus && requiredLines.every((line) => lines.includes(line));
}

function validateDecisionReceipt(mission: MissionRecord, submission: N2Submission, input: N2DecisionInput): void {
  if (!decisionReceiptMetadataMatches(mission, input)) {
    throw new MissionError(409, "decision_receipt_mismatch", "Decision receipt is not bound to this mission, actor, run, operation, and verdict");
  }
  if (!decisionReceiptSubjectMatches(submission, input)) {
    throw new MissionError(409, "decision_receipt_subject_mismatch", "Decision receipt content is not bound to the active submission and candidate");
  }
}

function recordedVerdict(input: N2DecisionInput): N2Verdict {
  return {
    verdict: input.verdict,
    operationId: input.operationId,
    actorAgentId: input.actorAgentId,
    runId: input.runId,
    criteria: boundedList(input.criteria, "criteria"),
    reasons: boundedList(input.reasons, "reasons"),
    receiptState: input.receipt.state,
    nativeStatus: input.receipt.nativeObservation?.status ?? null,
    decidedAt: input.at ?? new Date().toISOString(),
  };
}

function unknownApplication(state: N2State, rounds: N2ReviewRound[], input: N2DecisionInput): N2State {
  return {
    ...state,
    rounds,
    status: "application_unknown",
    application: {
      state: "unknown",
      submissionId: input.submissionId,
      operationId: input.operationId,
      receiptState: input.receipt.state,
      nativeStatus: input.receipt.nativeObservation?.status ?? null,
    },
  };
}

function observedApplication(input: N2DecisionInput) {
  return {
    state: "observed" as const,
    submissionId: input.submissionId,
    operationId: input.operationId,
    receiptState: "native_observed" as const,
    nativeStatus: input.receipt.nativeObservation!.status,
  };
}

export function applyN2Decision(
  state: N2State,
  mission: MissionRecord,
  input: N2DecisionInput,
): N2State {
  const round = currentRound(state);
  const submission = validateDecisionTarget(state, mission, round, input);
  validateDecisionReceipt(mission, submission, input);
  const verdict = recordedVerdict(input);
  const rounds = state.rounds.map((item) => item.round === round.round ? { ...item, verdict } : item);
  if (input.receipt.state !== "native_observed" || !input.receipt.nativeObservation?.usable) {
    return unknownApplication(state, rounds, input);
  }
  if (input.verdict === "changes_requested") {
    if (state.correctionsUsed >= state.correctionLimit || round.round !== 1) {
      throw new MissionError(409, "correction_limit_exceeded", "Only one ordinary correction is supported");
    }
    return {
      ...state,
      rounds,
      correctionsUsed: 1,
      status: "correction_requested",
      correction: {
        requestedByOperationId: input.operationId,
        criteria: verdict.criteria,
        reasons: verdict.reasons,
        executorAgentId: mission.aggregate.responsibilities.integrationLeadAgentId,
        runId: null,
      },
      application: observedApplication(input),
    };
  }
  if (round.round !== 2 || state.correctionsUsed !== 1) {
    throw new MissionError(409, "ordinary_correction_required", "This N2 lot accepts only the corrected V2 submission after a fresh second review");
  }
  return {
    ...state,
    rounds,
    status: "accepted",
    application: observedApplication(input),
  };
}

export function bindN2CorrectionRun(
  state: N2State,
  mission: MissionRecord,
  input: { actorAgentId: string; runId: string },
): N2State {
  if (state.status !== "correction_requested" || !state.correction || state.correction.runId) {
    throw new MissionError(409, "correction_run_unavailable", "No correction run is awaiting binding");
  }
  if (input.actorAgentId !== mission.aggregate.responsibilities.integrationLeadAgentId) {
    throw new MissionError(403, "integration_lead_required", "Only the pinned integration lead may execute the correction");
  }
  return { ...state, status: "correcting", correction: { ...state.correction, runId: input.runId } };
}

export function resubmitN2Candidate(
  state: N2State,
  mission: MissionRecord,
  input: {
    actorAgentId: string;
    runId: string;
    candidate: IntegratedCandidateVerification;
    baselineRunIds: string[];
    baselineTokenTotal: number;
    evidenceRevision: number;
    submissionId?: string;
    at?: string;
  },
): N2State {
  if (state.status !== "correcting" || state.correctionsUsed !== 1 || !state.correction?.runId) {
    throw new MissionError(409, "resubmission_unavailable", "A confirmed single correction run is required before V2 submission");
  }
  if (input.actorAgentId !== state.correction.executorAgentId || input.runId !== state.correction.runId) {
    throw new MissionError(403, "correction_run_required", "The pinned correction run must submit V2");
  }
  const previous = state.submissions.at(-1)!;
  const candidate = input.candidate;
  if (candidate.outcome !== "verified" || candidate.publicationEligible !== true
      || candidate.candidate.candidateCommit === previous.candidateCommit
      || candidate.candidate.sha256 === previous.sha256) {
    throw new MissionError(422, "candidate_unchanged", "V2 must be a newly verified candidate with changed commit and bytes");
  }
  if (!Number.isSafeInteger(input.baselineTokenTotal) || input.baselineTokenTotal < 0
      || new Set(input.baselineRunIds).size !== input.baselineRunIds.length) {
    throw new MissionError(422, "g4_baseline_invalid", "Second review baseline is invalid");
  }
  if (!Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision <= previous.evidenceRevision) {
    throw new MissionError(422, "evidence_revision_stale", "V2 must bind a newer persisted mission evidence revision");
  }
  if (!input.baselineRunIds.includes(state.correction.runId)) {
    throw new MissionError(409, "correction_usage_unattributed", "Second review baseline must retain the exact correction run identity");
  }
  const submission = submissionFromCandidate(mission, candidate, {
    ordinal: 2,
    predecessorSubmissionId: previous.submissionId,
    evidenceRevision: input.evidenceRevision,
    submissionId: input.submissionId,
    at: input.at,
  });
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  return {
    ...state,
    submissions: [...state.submissions, submission],
    rounds: [...state.rounds, {
      round: 2,
      submissionId: submission.submissionId,
      reviewerAgentId: reviewer,
      handoff: {
        state: "awaiting_native",
        baselineRunIds: [...input.baselineRunIds].sort(),
        baselineTokenTotal: input.baselineTokenTotal,
        reviewerRunId: null,
        reason: null,
        observedAt: null,
      },
      verdict: null,
    }],
    activeSubmissionId: submission.submissionId,
    status: "review_handoff",
    application: { state: "none", submissionId: null, operationId: null, receiptState: null, nativeStatus: null },
  };
}

function n2Blockage(state: N2State, round: N2ReviewRound | null) {
  if (state.status === "application_unknown") {
    return { code: "application_unknown", message: "Native decision outcome is uncertain; dependent work remains blocked.", nextActorId: null };
  }
  if (round?.handoff.state === "unknown") {
    return { code: "review_handoff_unknown", message: round.handoff.reason ?? "Native review handoff is uncertain.", nextActorId: null };
  }
  return null;
}

function n2NextAction(state: N2State, round: N2ReviewRound | null) {
  const reviewActions = {
    review_handoff: "Confirm the native review handoff and exact reviewer run.",
    reviewing: "Review the active immutable submission and record one receipt-backed verdict.",
  } as const;
  if (state.status === "review_handoff" || state.status === "reviewing") {
    return { actorKind: "agent" as const, actorId: round?.reviewerAgentId ?? null, label: reviewActions[state.status] };
  }
  const correctionActions = {
    correction_requested: "Execute the one admitted correction through the native return path.",
    correcting: "Verify and submit changed candidate V2.",
  } as const;
  if (state.status === "correction_requested" || state.status === "correcting") {
    return { actorKind: "agent" as const, actorId: state.correction?.executorAgentId ?? null, label: correctionActions[state.status] };
  }
  if (state.status === "application_unknown") {
    return { actorKind: "operator" as const, actorId: null, label: "Inspect the durable receipt; do not retry or accept." };
  }
  return { actorKind: "operator" as const, actorId: null, label: "Acceptance is applied to the exact reviewed V2 submission." };
}

export function inspectN2State(mission: MissionRecord) {
  const state = mission.aggregate.n2 as N2State | undefined;
  if (!state) return null;
  const submission = state.submissions.find((item) => item.submissionId === state.activeSubmissionId) ?? null;
  const round = state.rounds.at(-1) ?? null;
  const conflicts = reviewerConflicts(mission);
  return {
    submission,
    submissions: state.submissions,
    reviewer: {
      agentId: mission.aggregate.responsibilities.finalReviewerAgentId,
      eligible: conflicts.length === 0,
      independent: conflicts.length === 0,
      conflictReasons: conflicts,
    },
    review: round,
    status: state.status,
    correction: state.correction,
    application: state.application,
    blockage: n2Blockage(state, round),
    nextAction: n2NextAction(state, round),
  };
}
