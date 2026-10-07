import { feedbackCorrectionRound } from "./pr-contract.js";
import { isLogicalActor, physicalAgent } from "./model-state.js";
import { N3OpinionError } from "./n3-opinions.js";
import { createHash, randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { AdmissionError, readAdmission, reserveAdmission } from "./admission.js";
import type { DecisionReceipt } from "./decision-receipts.js";
import {
  assertNativeEnvelope,
  readNativeG4Profile,
  readNativeSequentialUsageBaseline,
  settleNativeSequentialRunUsage,
} from "./g4-native.js";
import { verifyIntegratedCandidate, type IntegratedCandidateVerification } from "./integration.js";
import { contributionCountAllowed } from "./hierarchy-contract.js";
import {
  canonicalPayloadHash,
  getMission,
  MissionError,
  type MissionAggregate,
  type MissionRecord,
  type MissionReceipt,
} from "./missions.js";

export type N2Submission = {
  submissionId: string;
  ordinal: 1 | 2 | 3;
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
  reservationId?: string;
  usageSettledAt?: string;
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
  round: 1 | 2 | 3;
  submissionId: string;
  reviewerAgentId: string;
  handoff: N2NativeHandoff;
  verdict: N2Verdict | null;
};

export type N2State = {
  ordinary?: import("./n2-ordinary-state.js").OrdinaryN2State;
  native?: import("./n2-native-runtime.js").N2NativeRuntime;
  schemaVersion: 1;
  correctionLimit: 1;
  correctionsUsed: 0 | 1;
  submissions: N2Submission[];
  rounds: N2ReviewRound[];
  activeSubmissionId: string;
  status: "review_handoff" | "reviewing" | "correction_requested" | "correcting" | "resubmission_prepared" | "application_unknown" | "accepted";
  correction: null | {
    requestedByOperationId: string;
    criteria: string[];
    reasons: string[];
    executorAgentId: string;
    runId: string | null;
    reservationId?: string;
    baselineRunIds?: string[];
    baselineTokenTotal?: number;
    usageSettledAt?: string;
    wakeState?: "claimed" | "requested" | "unknown";
    wakeReason?: string;
    preparedSubmission?: N2Submission;
    correctedPaths?: string[];
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
    ordinal: 1 | 2 | 3; predecessorSubmissionId: string | null; evidenceRevision: number;
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
  input: { baselineRunIds: string[]; baselineTokenTotal: number; reservationId?: string; submissionId?: string; at?: string },
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
        reservationId: input.reservationId,
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
  const observedUnique = new Set(input.observedRunIds);
  const expectedRuns = [...round.handoff.baselineRunIds, input.reviewerRunId].sort();
  const observedRuns = [...input.observedRunIds].sort();
  const exact = expectedRuns.length === observedRuns.length && expectedRuns.every((value, index) => value === observedRuns[index]);
  if (input.status !== "in_review" || input.assigneeAgentId !== reviewer
      || input.currentParticipantAgentId !== reviewer || input.returnAssigneeAgentId !== lead
      || round.handoff.baselineRunIds.includes(input.reviewerRunId)
      || observedUnique.size !== input.observedRunIds.length || !exact) {
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

const MAX_JUSTIFICATION_LENGTH = 8_000;

function boundedList(value: string[], label: string, maximumEntryLength = 1_000): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20
      || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > maximumEntryLength)) {
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
  if (!isLogicalActor(mission, reviewer, input.actorAgentId, input.runId) || input.runId !== round.handoff.reviewerRunId) {
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

function nativeReceiptSubjectMatches(mission: MissionRecord, submission: N2Submission, input: N2DecisionInput): boolean {
    const packet = mission.aggregate.n2!.native!.reviewPackets?.find(p => p.operationId === input.operationId && p.packet.submission.submissionId === submission.submissionId);
    const observation = packet?.observation; const body = input.receipt.requestBody;
    if (!packet || !observation) return false;
    return Boolean(observation.runId === input.runId && observation.report.verdict === input.verdict
      && body.method === "GET" && body.provenance === "native-review-terminal-readback-v1" && body.packetHash === packet.hash
      && body.reportHash === canonicalPayloadHash(observation.report)
      && observation.report.subject.submissionId === submission.submissionId && observation.report.subject.candidateCommit === submission.candidateCommit);
}

function ordinaryReceiptSubjectMatches(mission: MissionRecord, submission: N2Submission, input: N2DecisionInput): boolean {
  const task = mission.aggregate.n2!.ordinary!.tasks.find(task => task.kind === "council" && task.submissionId === submission.submissionId
    && task.taskId === input.operationId && task.runId === input.runId);
  const body = input.receipt.requestBody;
  return Boolean(task?.report && task.settledAt && task.runId === input.runId && isLogicalActor(mission, task.agentId, input.actorAgentId, input.runId)
    && body.provenance === "ordinary-task-terminal-readback-v1" && body.method === "GET"
    && body.issueId === task.issueId && body.runId === task.runId && body.reportHash === canonicalPayloadHash(task.report)
    && body.subjectHash === canonicalPayloadHash(task.report.subject) && task.report.subject.candidateCommit === submission.candidateCommit
    && task.report.subject.submissionId === submission.submissionId && task.report.verdict === input.verdict);
}

function decisionReceiptSubjectMatches(mission: MissionRecord, submission: N2Submission, input: N2DecisionInput): boolean {
  if (mission.aggregate.n2?.ordinary) return ordinaryReceiptSubjectMatches(mission, submission, input);
  if (mission.aggregate.n2?.native?.reviewProtocol === "native-verdict-readback-v1") {
    return nativeReceiptSubjectMatches(mission, submission, input);
  }
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
  if (!decisionReceiptSubjectMatches(mission, submission, input)) {
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
    reasons: boundedList(input.reasons, "reasons", MAX_JUSTIFICATION_LENGTH),
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
    if (state.correctionsUsed >= state.correctionLimit || round.round !== 1 && !feedbackCorrectionRound(mission, round.submissionId)) {
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
  input: {
    actorAgentId: string;
    runId: string;
    reservationId?: string;
    baselineRunIds?: string[];
    baselineTokenTotal?: number;
  },
): N2State {
  if (state.status !== "correction_requested" || !state.correction || state.correction.runId) {
    throw new MissionError(409, "correction_run_unavailable", "No correction run is awaiting binding");
  }
  if (!isLogicalActor(mission, mission.aggregate.responsibilities.integrationLeadAgentId, input.actorAgentId, input.runId)) {
    throw new MissionError(403, "integration_lead_required", "Only the pinned integration lead may execute the correction");
  }
  return {
    ...state,
    status: "correcting",
    correction: {
      ...state.correction,
      runId: input.runId,
      reservationId: input.reservationId,
      baselineRunIds: input.baselineRunIds,
      baselineTokenTotal: input.baselineTokenTotal,
      wakeState: "requested",
      wakeReason: undefined,
    },
  };
}

export function prepareN2Resubmission(
  state: N2State,
  mission: MissionRecord,
  input: {
    actorAgentId: string;
    runId: string;
    candidate: IntegratedCandidateVerification;
    evidenceRevision: number;
    correctedPaths: string[];
    submissionId?: string;
    at?: string;
  },
): N2State {
  if (state.status !== "correcting" || state.correctionsUsed !== 1 || !state.correction?.runId) {
    throw new MissionError(409, "resubmission_unavailable", "A confirmed single correction run is required before V2 submission");
  }
  if (!isLogicalActor(mission, state.correction.executorAgentId, input.actorAgentId, input.runId) || input.runId !== state.correction.runId) {
    throw new MissionError(403, "correction_run_required", "The pinned correction run must submit V2");
  }
  const previous = state.submissions.at(-1)!;
  const candidate = input.candidate;
  const currentMandateHash = mandateHash(mission);
  if (candidate.subject.companyId !== mission.companyId
      || candidate.subject.issueId !== mission.rootIssueId) {
    throw new MissionError(409, "candidate_subject_mismatch", "V2 verification must address this mission root issue and company");
  }
  if (candidate.outcome !== "verified" || candidate.publicationEligible !== true
      || candidate.candidate.candidateCommit === previous.candidateCommit
      || candidate.candidate.sha256 === previous.sha256) {
    throw new MissionError(422, "candidate_unchanged", "V2 must be a newly verified candidate with changed commit and bytes");
  }
  if (candidate.candidate.baseCommit !== previous.baseCommit) {
    throw new MissionError(409, "candidate_lineage_mismatch", "V2 must preserve the reviewed candidate base commit");
  }
  if (currentMandateHash !== previous.mandateHash) {
    throw new MissionError(409, "mandate_changed", "V2 must correct the candidate under the same immutable review mandate");
  }
  if (!Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision <= previous.evidenceRevision) {
    throw new MissionError(422, "evidence_revision_stale", "V2 must bind a newer persisted mission evidence revision");
  }
  if (!Array.isArray(input.correctedPaths) || input.correctedPaths.length === 0
      || input.correctedPaths.some((path) => typeof path !== "string" || !path.trim())) {
    throw new MissionError(422, "correction_evidence_missing", "V2 must identify at least one materially corrected attributed path");
  }
  const submission = submissionFromCandidate(mission, candidate, {
    ordinal: mission.aggregate.n5?.continuation?.delegatedFeedback ? 3 : 2,
    predecessorSubmissionId: previous.submissionId,
    evidenceRevision: input.evidenceRevision,
    submissionId: input.submissionId,
    at: input.at,
  });
  return {
    ...state,
    status: "resubmission_prepared",
    correction: {
      ...state.correction,
      preparedSubmission: submission,
      correctedPaths: [...input.correctedPaths],
    },
  };
}

export function startN2ResubmittedReview(
  state: N2State,
  mission: MissionRecord,
  input: {
    baselineRunIds: string[];
    baselineTokenTotal: number;
    reservationId?: string;
  },
): N2State {
  const correction = state.correction;
  const submission = correction?.preparedSubmission;
  if (state.status !== "resubmission_prepared" || !correction?.runId || (!state.native && !correction.usageSettledAt) || !submission) {
    throw new MissionError(409, "resubmission_handoff_unavailable", "A verified V2 and settled correction run are required before second review");
  }
  if (!Number.isSafeInteger(input.baselineTokenTotal) || input.baselineTokenTotal < 0
      || new Set(input.baselineRunIds).size !== input.baselineRunIds.length) {
    throw new MissionError(422, "g4_baseline_invalid", "Second review baseline is invalid");
  }
  if (!input.baselineRunIds.includes(correction.runId)) {
    throw new MissionError(409, "correction_usage_unattributed", "Second review baseline must retain the exact settled correction run identity");
  }
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  return {
    ...state,
    submissions: [...state.submissions, submission],
    rounds: [...state.rounds, {
      round: mission.aggregate.n5?.continuation?.delegatedFeedback ? 3 : 2,
      submissionId: submission.submissionId,
      reviewerAgentId: reviewer,
      handoff: {
        state: "awaiting_native",
        baselineRunIds: [...input.baselineRunIds].sort(),
        baselineTokenTotal: input.baselineTokenTotal,
        reviewerRunId: null,
        reason: null,
        observedAt: null,
        reservationId: input.reservationId,
      },
      verdict: null,
    }],
    activeSubmissionId: submission.submissionId,
    status: "review_handoff",
    correction: { ...correction, preparedSubmission: undefined },
    application: { state: "none", submissionId: null, operationId: null, receiptState: null, nativeStatus: null },
  };
}

function n2Blockage(state: N2State, round: N2ReviewRound | null) {
  if (state.ordinary) {
    const task = state.ordinary.tasks.find(item => !item.closedAt);
    return task && (task.creation === "claimed" || task.wake === "claimed" && !task.runId)
      ? { code: "ordinary_effect_unknown", message: "Ordinary task effect is claimed without confirmed identity; preserve reservation and reconcile its readback.", nextActorId: null } : null;
  }
  if (state.status === "application_unknown") {
    return { code: "application_unknown", message: "Native decision outcome is uncertain; dependent work remains blocked.", nextActorId: null };
  }
  if (round?.handoff.state === "unknown") {
    return { code: "review_handoff_unknown", message: round.handoff.reason ?? "Native review handoff is uncertain.", nextActorId: null };
  }
  if (state.correction?.wakeState === "unknown") {
    return { code: "correction_wakeup_unknown", message: state.correction.wakeReason ?? "Native correction wakeup is uncertain.", nextActorId: null };
  }
  return null;
}

function nativeN2NextAction(state: N2State) {
  if (state.native?.correctionOwnerAction === "restore_wake_policy" && state.status === "correction_requested") {
    return { actorKind: "operator" as const, actorId: null, label: "Correction reserved after native verdict and exact costs: restore demand wakes on the dedicated lead (timer stays disabled), then release-native-correction once." };
  }
  if (state.native?.reviewProtocol && (state.status === "review_handoff" || state.status === "reviewing")) {
    return { actorKind: "operator" as const, actorId: null, label: "Native reviewer reads the frozen packet, resolves the card and finishes its JSON summary. Reconcile native verdict, packet and all costs before Council acceptance; missing evidence stays blocked." };
  }
  return null;
}

function ordinaryN2NextAction(state: N2State, round: N2ReviewRound | null) {
  const task = state.ordinary!.tasks.find(item => !item.closedAt);
  if (!task) return { actorKind: "operator" as const, actorId: null, label: "Exact candidate accepted after Council terminal report and all admitted usage settled." };
  if (n2Blockage(state, round)) return { actorKind: "operator" as const, actorId: null, label: "Inspect the claimed ordinary effect; do not dispatch a replacement." };
  return { actorKind: "agent" as const, actorId: task.agentId, label: task.settledAt
    ? "Council controller reconciles the settled task before admitting the next action."
    : task.kind === "specialist" ? "Submit this candidate's N3 opinion, then finish the CLI run."
    : task.kind === "council" ? "Submit ordinary-verdict, then finish with the exact returned finishReport JSON. Acceptance waits for terminal usage."
    : "Amend the integration commit, verify and prepare V2, then finish the admitted correction run." };
}

function n2NextAction(state: N2State, round: N2ReviewRound | null) {
  if (state.ordinary) return ordinaryN2NextAction(state, round);
  const nativeAction = nativeN2NextAction(state);
  if (nativeAction) return nativeAction;
  if (round?.handoff.state === "unknown") {
    return { actorKind: "operator" as const, actorId: null, label: "Reconcile the uncertain native handoff; do not retry or confirm from local state." };
  }
  if (state.correction?.wakeState === "unknown") {
    return { actorKind: "operator" as const, actorId: null, label: "Reconcile the uncertain correction wakeup; do not retry." };
  }
  const reviewActions = {
    review_handoff: "Confirm the native review handoff and exact reviewer run.",
    reviewing: "Prepare one immutable verdict for the active submission, then let the reviewer run finish.",
  } as const;
  if (state.status === "review_handoff" || state.status === "reviewing") {
    return { actorKind: "agent" as const, actorId: round?.reviewerAgentId ?? null, label: reviewActions[state.status] };
  }
  const correctionActions = {
    correction_requested: "Execute the one admitted correction through the native return path.",
    correcting: "Verify and prepare changed candidate V2.",
    resubmission_prepared: "Settle the exact correction run, then start the second native review.",
  } as const;
  if (state.status === "correction_requested" || state.status === "correcting" || state.status === "resubmission_prepared") {
    return { actorKind: "agent" as const, actorId: state.correction?.executorAgentId ?? null, label: correctionActions[state.status] };
  }
  if (state.status === "application_unknown") {
    return { actorKind: "operator" as const, actorId: null, label: "Inspect the durable receipt; do not retry or accept." };
  }
  return { actorKind: "operator" as const, actorId: null, label: "Acceptance is applied to the exact active reviewed submission." };
}

export function inspectN2State(mission: MissionRecord) {
  const state = mission.aggregate.n2 as N2State | undefined;
  if (!state) return null;
  const submission = state.submissions.find((item) => item.submissionId === state.activeSubmissionId) ?? null;
  const round = state.rounds.at(-1) ?? null;
  const conflicts = reviewerConflicts(mission);
  const usage = {
    reviews: state.rounds.map((entry) => ({
      round: entry.round,
      runId: entry.handoff.reviewerRunId,
      reservationId: entry.handoff.reservationId ?? null,
      settled: Boolean(entry.handoff.usageSettledAt),
      settledAt: entry.handoff.usageSettledAt ?? null,
    })),
    correction: state.correction?.runId ? {
      runId: state.correction.runId,
      reservationId: state.correction.reservationId ?? null,
      settled: Boolean(state.correction.usageSettledAt),
      settledAt: state.correction.usageSettledAt ?? null,
    } : null,
  };
  const usageComplete = (!state.ordinary || state.ordinary.tasks.every(task => Boolean(task.settledAt))) && usage.reviews.every((entry) => entry.runId && entry.settled)
    && (!usage.correction || usage.correction.settled);
  return {
    runtimeProfile: state.ordinary?.protocol ?? (state.native ? "paperclip-native-runner-v1" : "legacy"),
    ordinaryTasks: state.ordinary?.tasks,
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
    usage: { ...usage, complete: usageComplete },
    blockage: n2Blockage(state, round),
    nextAction: state.status === "accepted" && !usageComplete
      ? { actorKind: "operator" as const, actorId: null, label: "Settle every admitted N2 run before qualification closure." }
      : n2NextAction(state, round),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function runtimeBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionError(400, "malformed_request", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function runtimeString(value: unknown, label: string, max = 1_000): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) {
    throw new MissionError(400, "malformed_request", `${label} must be a bounded nonempty string`);
  }
  return value;
}

export function runtimeUuid(value: unknown, label: string): string {
  const result = runtimeString(value, label, 64);
  if (!UUID.test(result)) throw new MissionError(400, "malformed_request", `${label} must be a UUID`);
  return result;
}

function runtimeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new MissionError(400, "malformed_request", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function missionTable(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return `${ctx.db.namespace}.missions`;
}

export function storedN2(mission: MissionRecord): N2State {
  const state = mission.aggregate.n2;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new MissionError(409, "n2_not_started", "N2 review state is not recorded");
  }
  return state;
}

export async function n2Cas(
  ctx: PluginContext,
  mission: MissionRecord,
  aggregate: MissionAggregate,
): Promise<MissionRecord> {
  const changed = await ctx.db.execute(
    `UPDATE ${missionTable(ctx)} SET aggregate = $1::jsonb, version = version + 1, updated_at = now()
      WHERE company_id = $2 AND mission_id = $3 AND version = $4`,
    [JSON.stringify(aggregate), mission.companyId, mission.missionId, mission.version],
  );
  const after = await getMission(ctx, mission.companyId, mission.missionId);
  if (!after) throw new Error("Mission disappeared after N2 CAS");
  if (changed.rowCount !== 1) {
    throw new MissionError(409, "version_conflict", "Mission changed concurrently", { currentVersion: after.version });
  }
  return after;
}

export function runtimeReceipt(
  mission: MissionRecord,
  commandId: string,
  actorId: string,
  payloadHash: string,
): MissionReceipt | null {
  const prior = mission.aggregate.commandReceipts.find((item) => item.commandId === commandId);
  if (!prior) return null;
  if (prior.actorId !== actorId || prior.payloadHash !== payloadHash) {
    throw new MissionError(409, "command_identity_conflict", "commandId belongs to another actor or payload");
  }
  return prior;
}

export async function n2CommandCas(
  ctx: PluginContext,
  mission: MissionRecord,
  body: Record<string, unknown>,
  actorType: "user" | "agent",
  actorId: string,
  next: MissionAggregate,
) {
  const commandId = runtimeUuid(body.commandId, "commandId");
  const expectedVersion = runtimeInteger(body.expectedVersion, "expectedVersion");
  const payloadHash = canonicalPayloadHash(body);
  const prior = runtimeReceipt(mission, commandId, actorId, payloadHash);
  if (prior) return { outcome: "replayed" as const, mission, receipt: prior };
  if (mission.version !== expectedVersion) {
    throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: mission.version });
  }
  if (mission.aggregate.commandReceipts.length >= 100) {
    throw new MissionError(409, "command_limit_reached", "Mission command receipt limit reached");
  }
  const command = runtimeString(body.command, "command", 80) as MissionReceipt["command"];
  const receipt: MissionReceipt = {
    commandId,
    command,
    actorType,
    actorId,
    payloadHash,
    appliedVersion: mission.version + 1,
    result: { missionId: mission.missionId, version: mission.version + 1 },
    recordedAt: new Date().toISOString(),
  };
  next.commandReceipts = [...mission.aggregate.commandReceipts, receipt];
  return { outcome: "applied" as const, mission: await n2Cas(ctx, mission, next), receipt };
}

async function requireMissionOwner(ctx: PluginContext, mission: MissionRecord, actorUserId: string | null) {
  const company = await ctx.companies.get(mission.companyId);
  if (!company?.defaultResponsibleUserId || !actorUserId
      || actorUserId !== company.defaultResponsibleUserId || actorUserId !== mission.ownerUserId) {
    throw new MissionError(403, "owner_required", "Configured mission owner required");
  }
}

function executionPrincipals(issue: unknown) {
  const record = issue && typeof issue === "object" && !Array.isArray(issue)
    ? issue as Record<string, unknown> : {};
  const execution = record.executionState && typeof record.executionState === "object" && !Array.isArray(record.executionState)
    ? record.executionState as Record<string, unknown> : {};
  const participant = execution.currentParticipant && typeof execution.currentParticipant === "object"
    ? execution.currentParticipant as Record<string, unknown> : {};
  const returning = execution.returnAssignee && typeof execution.returnAssignee === "object"
    ? execution.returnAssignee as Record<string, unknown> : {};
  return {
    status: record.status,
    assigneeAgentId: record.assigneeAgentId ?? null,
    participantAgentId: participant.agentId ?? null,
    returnAgentId: returning.agentId ?? null,
    lastDecisionOutcome: execution.lastDecisionOutcome ?? null,
  };
}

export async function nativeN2Profile(ctx: PluginContext, mission: MissionRecord) {
  const profile = await readNativeG4Profile(ctx, mission.companyId);
  if (!profile || profile.maxCorrections !== 1) {
    throw new MissionError(409, "n2_correction_profile_required", "Native N2 requires maxCorrections=1 in the configured operating profile");
  }
  if (mission.aggregate.n5?.continuation && mission.aggregate.n5.continuation.periodKey !== profile.periodKey) throw new MissionError(409, "n5_continuation_period_changed", "Post-acceptance correction must retain its original budget period");
  const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: profile.periodKey });
  if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
  assertNativeEnvelope(envelope, profile);
  return { profile, envelope };
}

export async function reserveN2Run(
  ctx: PluginContext,
  mission: MissionRecord,
  input: { reservationId: string; effectId: string; kind: "initial" | "correction" | "resume"; ownerReplacementCommandId?: string },
) {
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  const result = await reserveAdmission(ctx, {
    companyId: mission.companyId,
    periodKey: profile.periodKey,
    reservationId: input.reservationId,
    missionId: mission.missionId,
    effectId: input.effectId,
    requestedUnits: profile.runReservationUnits,
    attempt: { kind: input.kind, ordinal: input.kind === "initial" ? 0 : 1 },
    ownerReplacementCommandId: input.ownerReplacementCommandId,
    expectedVersion: envelope.version,
  });
  if (!result.reservation) throw new MissionError(409, "g4_reservation_unavailable", "N2 run reservation is unavailable");
  return result;
}

function n2Effect(
  aggregate: MissionAggregate,
  predicate: (entry: Record<string, unknown>) => boolean,
) {
  return aggregate.effectIntents.find(predicate);
}

function preparedNativeReviewTransition(
  mission: MissionRecord,
  claim: Awaited<ReturnType<typeof n2CommandCas>>,
) {
  if (claim.outcome !== "applied") return claim;
  return {
    outcome: "prepared" as const,
    mission: claim.mission,
    receipt: claim.receipt,
    nativeTransition: {
      method: "PATCH" as const,
      path: `/api/issues/${mission.rootIssueId}`,
      body: { status: "in_review" as const },
    },
  };
}

export async function executeN2BoardCommand(ctx: PluginContext, input: {
  companyId: string;
  missionId: string;
  actorUserId: string | null;
  body: Record<string, unknown>;
}) {
  const mission = await getMission(ctx, input.companyId, input.missionId);
  if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
  await requireMissionOwner(ctx, mission, input.actorUserId);
  if (mission.aggregate.n2?.ordinary || !mission.aggregate.n2 && (mission.aggregate.modelSelection || (await ctx.config.get(input.companyId)).n2RuntimeProfile === "ordinary-cli-v1")) {
    const { executeOrdinaryN2Board } = await import("./n2-ordinary-runtime.js");
    return executeOrdinaryN2Board(ctx, mission, input);
  }
  if (mission.aggregate.n2?.native || !mission.aggregate.n2 && (await ctx.config.get(input.companyId)).n2RuntimeProfile === "paperclip_runner-experimental") {
    const { executeNativeN2Board } = await import("./n2-native-runtime.js");
    return executeNativeN2Board(ctx, mission, input);
  }
  if (input.body.command === "settle-n2-usage") {
    const commandId = runtimeUuid(input.body.commandId, "commandId");
    const payloadHash = canonicalPayloadHash(input.body);
    const prior = runtimeReceipt(mission, commandId, input.actorUserId!, payloadHash);
    if (prior) return { outcome: "replayed" as const, mission, receipt: prior };
    if (mission.version !== runtimeInteger(input.body.expectedVersion, "expectedVersion")) {
      throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: mission.version });
    }
    const state = storedN2(mission);
    const target = runtimeString(input.body.target, "target", 20);
    const settlementCommandId = runtimeUuid(input.body.settlementCommandId, "settlementCommandId");
    const expectedAdmissionVersion = runtimeInteger(input.body.expectedAdmissionVersion, "expectedAdmissionVersion");
    const { profile } = await nativeN2Profile(ctx, mission);
    const settledAt = new Date().toISOString();
    let nextState: N2State;
    if (target === "review") {
      const roundNumber = runtimeInteger(input.body.round, "round");
      const round = state.rounds.find((entry) => entry.round === roundNumber);
      if (!round?.handoff.reviewerRunId || !round.handoff.reservationId) {
        throw new MissionError(409, "review_usage_binding_missing", "Review run and reservation must be confirmed before settlement");
      }
      await settleNativeSequentialRunUsage(ctx, {
        commandId: settlementCommandId,
        companyId: mission.companyId,
        issueId: mission.rootIssueId,
        expectedRunId: round.handoff.reviewerRunId,
        baseline: { runIds: round.handoff.baselineRunIds, tokenTotal: round.handoff.baselineTokenTotal },
        periodKey: profile.periodKey,
        reservationId: round.handoff.reservationId,
        expectedVersion: expectedAdmissionVersion,
      });
      nextState = {
        ...state,
        rounds: state.rounds.map((entry) => entry.round === roundNumber
          ? { ...entry, handoff: { ...entry.handoff, usageSettledAt: settledAt } } : entry),
      };
    } else if (target === "correction") {
      const correction = state.correction;
      if (!correction?.runId || !correction.reservationId || !correction.baselineRunIds
          || !Number.isSafeInteger(correction.baselineTokenTotal)) {
        throw new MissionError(409, "correction_usage_binding_missing", "Correction run and reservation must be bound before settlement");
      }
      await settleNativeSequentialRunUsage(ctx, {
        commandId: settlementCommandId,
        companyId: mission.companyId,
        issueId: mission.rootIssueId,
        expectedRunId: correction.runId,
        baseline: { runIds: correction.baselineRunIds, tokenTotal: correction.baselineTokenTotal! },
        periodKey: profile.periodKey,
        reservationId: correction.reservationId,
        expectedVersion: expectedAdmissionVersion,
      });
      nextState = { ...state, correction: { ...correction, usageSettledAt: settledAt } };
    } else {
      throw new MissionError(400, "unknown_usage_target", "target must be review or correction");
    }
    return n2CommandCas(ctx, mission, input.body, "user", input.actorUserId!, {
      ...mission.aggregate,
      n2: nextState,
      journal: [...mission.aggregate.journal, {
        action: "n2_usage_settled", target, round: target === "review" ? input.body.round : null,
        settlementCommandId, actorUserId: input.actorUserId, at: settledAt,
      }],
    });
  }
  if (input.body.command === "start-correction") {
    const commandId = runtimeUuid(input.body.commandId, "commandId");
    const payloadHash = canonicalPayloadHash(input.body);
    const prior = runtimeReceipt(mission, commandId, input.actorUserId!, payloadHash);
    if (prior) {
      const claimed = n2Effect(mission.aggregate, (entry) => entry.kind === "n2_correction_wakeup"
        && entry.commandId === commandId && entry.state === "claimed");
      if (claimed) {
        const state = storedN2(mission);
        const reason = "Correction wakeup claim was recovered without a confirmed native response";
        const blocked = await n2Cas(ctx, mission, {
          ...mission.aggregate,
          phase: "blocked",
          control: { status: "blocked", reason: "native_correction_wakeup_unknown" },
          n2: { ...state, correction: state.correction ? { ...state.correction, wakeState: "unknown", wakeReason: reason } : null },
          effectIntents: mission.aggregate.effectIntents.map((entry) => entry.kind === "n2_correction_wakeup"
            && entry.commandId === commandId && entry.state === "claimed" ? { ...entry, state: "unknown", reason } : entry),
        });
        return { outcome: "unknown" as const, mission: blocked, receipt: prior };
      }
      return { outcome: "replayed" as const, mission, receipt: prior };
    }
    if (mission.version !== runtimeInteger(input.body.expectedVersion, "expectedVersion")) {
      throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: mission.version });
    }
    const state = storedN2(mission);
    const round = state.rounds[0];
    const correction = state.correction;
    if (state.status !== "correction_requested" || !correction?.reservationId || correction.runId
        || round?.verdict?.verdict !== "changes_requested" || !round.handoff.usageSettledAt) {
      throw new MissionError(409, "correction_wakeup_unavailable", "Settled initial review and admitted correction are required before correction wakeup");
    }
    const issue = await ctx.issues.get(mission.rootIssueId, mission.companyId);
    const native = executionPrincipals(issue);
    const lead = mission.aggregate.responsibilities.integrationLeadAgentId;
    if (!issue || native.status !== "in_progress" || native.assigneeAgentId !== lead
        || native.lastDecisionOutcome !== "changes_requested") {
      throw new MissionError(409, "native_correction_mismatch", "Native issue is not returned to the pinned integration lead after changes requested");
    }
    const baseline = await readNativeSequentialUsageBaseline(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId });
    const claimedState: N2State = {
      ...state,
      correction: {
        ...correction,
        baselineRunIds: baseline.runIds,
        baselineTokenTotal: baseline.tokenTotal,
        wakeState: "claimed",
        wakeReason: undefined,
      },
    };
    const claim = await n2CommandCas(ctx, mission, input.body, "user", input.actorUserId!, {
      ...mission.aggregate,
      n2: claimedState,
      effectIntents: [...mission.aggregate.effectIntents, {
        kind: "n2_correction_wakeup", state: "claimed", commandId,
        reservationId: correction.reservationId, assigneeAgentId: lead,
        baselineRunIds: baseline.runIds, baselineTokenTotal: baseline.tokenTotal,
        actorUserId: input.actorUserId, at: new Date().toISOString(),
      }],
      journal: [...mission.aggregate.journal, {
        action: "n2_correction_wakeup_claimed", reservationId: correction.reservationId,
        actorUserId: input.actorUserId, at: new Date().toISOString(),
      }],
    });
    if (claim.outcome !== "applied") return claim;
    let wake: { queued: boolean; runId: string | null } | null = null;
    try {
      wake = await ctx.issues.requestWakeup(mission.rootIssueId, mission.companyId, {
        idempotencyKey: `council:n2:correction:${correction.reservationId}`,
        reason: "council_n2_correction",
        actorUserId: input.actorUserId!,
      });
    } catch {
      // A lost response cannot authorize a second correction wakeup.
    }
    const afterClaim = await getMission(ctx, mission.companyId, mission.missionId);
    if (!afterClaim) throw new Error("Mission disappeared after N2 correction wakeup");
    const afterState = storedN2(afterClaim);
    const confirmed = Boolean(wake?.queued && wake.runId);
    const reason = confirmed ? undefined : "Native correction wakeup response was unavailable or unconfirmed";
    const nextState = confirmed
      ? bindN2CorrectionRun(afterState, afterClaim, {
        actorAgentId: lead,
        runId: wake!.runId!,
        reservationId: correction.reservationId,
        baselineRunIds: baseline.runIds,
        baselineTokenTotal: baseline.tokenTotal,
      })
      : {
        ...afterState,
        correction: afterState.correction ? { ...afterState.correction, wakeState: "unknown" as const, wakeReason: reason } : null,
      };
    const finalMission = await n2Cas(ctx, afterClaim, {
      ...afterClaim.aggregate,
      phase: confirmed ? "correcting" : "blocked",
      control: confirmed ? { status: "active" } : { status: "blocked", reason: "native_correction_wakeup_unknown" },
      n2: nextState,
      effectIntents: afterClaim.aggregate.effectIntents.map((entry) => entry.kind === "n2_correction_wakeup"
        && entry.commandId === commandId ? { ...entry, state: confirmed ? "requested" : "unknown", runId: wake?.runId ?? null, reason: reason ?? null } : entry),
    });
    return { outcome: confirmed ? "requested" as const : "unknown" as const, mission: finalMission, receipt: claim.receipt };
  }
  if (input.body.command === "start-resubmitted-review") {
    const commandId = runtimeUuid(input.body.commandId, "commandId");
    const payloadHash = canonicalPayloadHash(input.body);
    const prior = runtimeReceipt(mission, commandId, input.actorUserId!, payloadHash);
    if (prior) {
      const claimed = n2Effect(mission.aggregate, (entry) => entry.kind === "n2_review_handoff"
        && entry.commandId === commandId && entry.state === "claimed");
      if (claimed) {
        return preparedNativeReviewTransition(mission, {
          outcome: "applied",
          mission,
          receipt: prior,
        });
      }
      return { outcome: "replayed" as const, mission, receipt: prior };
    }
    if (mission.version !== runtimeInteger(input.body.expectedVersion, "expectedVersion")) {
      throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: mission.version });
    }
    const state = storedN2(mission);
    const prepared = state.correction?.preparedSubmission;
    if (state.status !== "resubmission_prepared" || !prepared || !state.correction?.usageSettledAt) {
      throw new MissionError(409, "resubmission_handoff_unavailable", "Verified V2 and settled correction usage are required");
    }
    const issue = await ctx.issues.get(mission.rootIssueId, mission.companyId);
    const native = executionPrincipals(issue);
    if (!issue || native.status !== "in_progress"
        || native.assigneeAgentId !== physicalAgent(mission, mission.aggregate.responsibilities.integrationLeadAgentId, { issueId: mission.rootIssueId })) {
      throw new MissionError(409, "native_review_entry_mismatch", "Root issue must remain under the pinned integration lead before V2 review");
    }
    const reservationId = runtimeUuid(input.body.reservationId, "reservationId");
    const baseline = await readNativeSequentialUsageBaseline(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId });
    await reserveN2Run(ctx, mission, { reservationId, effectId: prepared.submissionId, kind: "initial" });
    const nextState = startN2ResubmittedReview(state, mission, {
      baselineRunIds: baseline.runIds,
      baselineTokenTotal: baseline.tokenTotal,
      reservationId,
    });
    const claim = await n2CommandCas(ctx, mission, input.body, "user", input.actorUserId!, {
      ...mission.aggregate,
      phase: "review_handoff",
      control: { status: "active" },
      n2: nextState,
      effectIntents: [...mission.aggregate.effectIntents, {
        kind: "n2_review_handoff", state: "claimed", commandId,
        submissionId: prepared.submissionId, reservationId,
        actorUserId: input.actorUserId, at: new Date().toISOString(),
      }],
      journal: [...mission.aggregate.journal, {
        action: "n2_candidate_resubmitted", submissionId: prepared.submissionId,
        candidateCommit: prepared.candidateCommit, reservationId,
        actorUserId: input.actorUserId, at: new Date().toISOString(),
      }],
    });
    return preparedNativeReviewTransition(mission, claim);
  }
  if (input.body.command !== "start-review") {
    throw new MissionError(400, "unknown_command", "Unknown N2 board command");
  }
  const commandId = runtimeUuid(input.body.commandId, "commandId");
  const payloadHash = canonicalPayloadHash(input.body);
  const prior = runtimeReceipt(mission, commandId, input.actorUserId!, payloadHash);
  if (prior) {
    const claimed = n2Effect(mission.aggregate, (entry) => entry.kind === "n2_review_handoff" && entry.commandId === commandId && entry.state === "claimed");
    if (claimed) {
      return preparedNativeReviewTransition(mission, {
        outcome: "applied",
        mission,
        receipt: prior,
      });
    }
    return { outcome: "replayed" as const, mission, receipt: prior };
  }
  if (mission.aggregate.n2) throw new MissionError(409, "n2_already_started", "N2 review is already recorded");
  const submissionId = runtimeUuid(input.body.submissionId, "submissionId");
  const reservationId = runtimeUuid(input.body.reservationId, "reservationId");
  const issue = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  const native = executionPrincipals(issue);
  if (!issue || native.status !== "in_progress"
      || native.assigneeAgentId !== physicalAgent(mission, mission.aggregate.responsibilities.integrationLeadAgentId, { issueId: mission.rootIssueId })) {
    throw new MissionError(409, "native_review_entry_mismatch", "Root issue must still be in progress under the pinned integration lead");
  }
  const baseline = await readNativeSequentialUsageBaseline(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId });
  await reserveN2Run(ctx, mission, { reservationId, effectId: submissionId, kind: "initial" });
  const state = startN2Review(mission, {
    baselineRunIds: baseline.runIds,
    baselineTokenTotal: baseline.tokenTotal,
    reservationId,
    submissionId,
  });
  const claimedAggregate: MissionAggregate = {
    ...mission.aggregate,
    phase: "review_handoff",
    control: { status: "active" },
    n2: state,
    effectIntents: [...mission.aggregate.effectIntents, {
      kind: "n2_review_handoff", state: "claimed", commandId, submissionId, reservationId,
      actorUserId: input.actorUserId, at: new Date().toISOString(),
    }],
    journal: [...mission.aggregate.journal, { action: "n2_review_handoff_claimed", submissionId, reservationId, actorUserId: input.actorUserId, at: new Date().toISOString() }],
  };
  const claim = await n2CommandCas(ctx, mission, input.body, "user", input.actorUserId!, claimedAggregate);
  return preparedNativeReviewTransition(mission, claim);
}

async function confirmReviewCommand(
  ctx: PluginContext,
  mission: MissionRecord,
  input: PluginApiRequestInput,
  body: Record<string, unknown>,
) {
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  if (input.actor.actorType !== "agent" || input.actor.agentId !== reviewer || !input.actor.runId) {
    throw new MissionError(403, "reviewer_run_required", "Pinned reviewer run required");
  }
  if (input.params.issueId !== mission.rootIssueId) throw new MissionError(403, "root_issue_required", "N2 command must address the mission root issue");
  const issue = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  const native = executionPrincipals(issue);
  const observed = await readNativeSequentialUsageBaseline(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId });
  const nextState = confirmN2ReviewHandoff(storedN2(mission), mission, {
    status: String(native.status ?? ""),
    assigneeAgentId: typeof native.assigneeAgentId === "string" ? native.assigneeAgentId : null,
    currentParticipantAgentId: typeof native.participantAgentId === "string" ? native.participantAgentId : null,
    returnAssigneeAgentId: typeof native.returnAgentId === "string" ? native.returnAgentId : null,
    observedRunIds: observed.runIds,
    reviewerRunId: input.actor.runId,
  });
  const aggregate: MissionAggregate = {
    ...mission.aggregate,
    phase: "reviewing",
    control: { status: "active" },
    n2: nextState,
    effectIntents: mission.aggregate.effectIntents.map((entry) =>
      entry.kind === "n2_review_handoff" && entry.state === "claimed"
        ? { ...entry, state: "confirmed", reviewerRunId: input.actor.runId, confirmedAt: new Date().toISOString() }
        : entry),
    journal: [...mission.aggregate.journal, { action: "n2_review_handoff_confirmed", actorAgentId: reviewer, runId: input.actor.runId, at: new Date().toISOString() }],
  };
  return n2CommandCas(ctx, mission, body, "agent", reviewer, aggregate);
}

async function inspectN2Agent(
  ctx: PluginContext,
  mission: MissionRecord,
  input: PluginApiRequestInput,
) {
  if (input.params.issueId !== mission.rootIssueId) {
    throw new MissionError(403, "root_issue_required", "N2 inspection must address the mission root issue");
  }
  if (input.actor.actorType !== "agent" || !input.actor.agentId || !input.actor.runId) {
    throw new MissionError(403, "n2_agent_run_required", "A pinned N2 agent and native run are required");
  }

  const state = storedN2(mission);
  const issue = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  const native = executionPrincipals(issue);
  const observed = await readNativeSequentialUsageBaseline(ctx, {
    companyId: mission.companyId,
    issueId: mission.rootIssueId,
  });
  const actorId = input.actor.agentId;
  const runId = input.actor.runId;

  if (state.status === "review_handoff" || state.status === "reviewing") {
    const round = currentRound(state);
    if (actorId !== round.reviewerAgentId) {
      throw new MissionError(403, "reviewer_run_required", "Pinned reviewer run required");
    }
    const expectedRuns = [...round.handoff.baselineRunIds, runId].sort();
    const observedRuns = [...observed.runIds].sort();
    const exactRuns = expectedRuns.length === observedRuns.length
      && expectedRuns.every((value, index) => value === observedRuns[index]);
    const recordedRunMatches = state.status === "reviewing"
      ? round.handoff.reviewerRunId === runId
      : round.handoff.reviewerRunId === null;
    if (native.status !== "in_review" || native.assigneeAgentId !== actorId
        || native.participantAgentId !== actorId
        || native.returnAgentId !== mission.aggregate.responsibilities.integrationLeadAgentId
        || round.handoff.baselineRunIds.includes(runId) || !exactRuns || !recordedRunMatches) {
      throw new MissionError(409, "native_review_inspection_mismatch", "Native review stage or run does not match the active N2 round", {
        expectedReviewerAgentId: round.reviewerAgentId,
        expectedRunIds: expectedRuns,
        observedRunIds: observedRuns,
      });
    }
  } else if (state.status === "correcting" || state.status === "resubmission_prepared") {
    const correction = state.correction;
    if (actorId !== physicalAgent(mission, mission.aggregate.responsibilities.integrationLeadAgentId, { issueId: mission.rootIssueId, runId: input.actor.runId })) {
      throw new MissionError(403, "integration_lead_required", "Pinned integration lead correction run required");
    }
    if (!correction?.runId || correction.runId !== runId) {
      throw new MissionError(409, "correction_run_required", "The bound correction run is required for N2 inspection");
    }
    const expectedRuns = [...(correction.baselineRunIds ?? []), runId].sort();
    const observedRuns = [...observed.runIds].sort();
    const exactRuns = expectedRuns.length === observedRuns.length
      && expectedRuns.every((value, index) => value === observedRuns[index]);
    if (native.status !== "in_progress" || native.assigneeAgentId !== actorId || !exactRuns) {
      throw new MissionError(409, "native_correction_inspection_mismatch", "Native correction stage or run does not match the active N2 correction", {
        expectedLeadAgentId: actorId,
        expectedRunIds: expectedRuns,
        observedRunIds: observedRuns,
      });
    }
  } else {
    throw new MissionError(409, "n2_agent_inspection_unavailable", "N2 agent inspection is unavailable in the current mission state");
  }

  return {
    missionId: mission.missionId,
    version: mission.version,
    phase: mission.aggregate.phase,
    n2: inspectN2State(mission),
  };
}

export async function prepareResubmissionCommand(
  ctx: PluginContext,
  mission: MissionRecord,
  input: PluginApiRequestInput,
  body: Record<string, unknown>,
) {
  const lead = mission.aggregate.responsibilities.integrationLeadAgentId;
  if (input.actor.actorType !== "agent" || (!input.actor.runId || !isLogicalActor(mission, lead, input.actor.agentId ?? "", input.actor.runId)) || !input.actor.runId) {
    throw new MissionError(403, "integration_lead_required", "Pinned integration lead correction run required");
  }
  const state = storedN2(mission);
  if (state.correction?.runId !== input.actor.runId) throw new MissionError(409, "correction_run_required", "The bound correction run must resubmit V2");
  return prepareResubmission(ctx, mission, body, {
    actorType: "agent",
    actorId: input.actor.agentId!,
    executorAgentId: input.actor.agentId!,
    runId: input.actor.runId,
    journalAction: "n2_resubmission_prepared",
  });
}

export async function prepareResubmission(
  ctx: PluginContext,
  mission: MissionRecord,
  body: Record<string, unknown>,
  authority: {
    actorType: "user" | "agent";
    actorId: string;
    executorAgentId: string;
    logicalExecutorAgentId?: string;
    runId: string;
    journalAction: "n2_resubmission_prepared" | "owner_recovered_terminal_resubmission";
    correctionTaskId?: string;
  },
) {
  const state = storedN2(mission);
  const n1 = mission.aggregate.n1 as { candidate?: IntegratedCandidateVerification; contributions?: Array<{ contributionId?: string; commit?: string; ownedPaths?: string[] }> } | undefined;
  if (!n1?.contributions || !contributionCountAllowed(mission, n1.contributions.length) || n1.contributions.some((entry) => !entry.contributionId || !entry.commit || !entry.ownedPaths)) {
    throw new MissionError(409, "n1_evidence_unavailable", "N1 contribution evidence is unavailable for V2 verification");
  }
  const attachmentId = runtimeUuid(body.attachmentId, "attachmentId");
  const baseCommit = runtimeString(body.baseCommit, "baseCommit", 40);
  const candidateCommit = runtimeString(body.candidateCommit, "candidateCommit", 40);
  const expectedSha256 = runtimeString(body.expectedSha256, "expectedSha256", 64);
  const correctedPaths = Array.isArray(body.correctedPaths)
    ? body.correctedPaths.map((path, index) => runtimeString(path, `correctedPaths[${index}]`, 512))
    : [];
  if (!COMMIT.test(baseCommit) || !COMMIT.test(candidateCommit) || !DIGEST.test(expectedSha256)) {
    throw new MissionError(422, "invalid_candidate_identity", "V2 Git and digest identity is malformed");
  }
  if (correctedPaths.length === 0 || new Set(correctedPaths).size !== correctedPaths.length) {
    throw new MissionError(422, "correction_evidence_missing", "V2 must identify distinct materially corrected attributed paths");
  }
  const verified = await verifyIntegratedCandidate(ctx, {
    companyId: mission.companyId,
    issueId: mission.rootIssueId,
    attachmentId,
    baseCommit,
    candidateCommit,
    expectedSha256,
    correctedPaths,
    integrationAdjustedPaths: n1.candidate?.integrationAdjustedPaths,
    ...(mission.aggregate.hierarchy ? { contributionPolicy: mission.aggregate.hierarchy } : {}),
    contributions: n1.contributions.map((entry) => ({
      contributionId: entry.contributionId!, commit: entry.commit!, ownedPaths: entry.ownedPaths!,
    })) as [
      { contributionId: string; commit: string; ownedPaths: string[] },
      { contributionId: string; commit: string; ownedPaths: string[] },
    ],
  });
  const submissionId = runtimeUuid(body.submissionId, "submissionId");
  const nextState = prepareN2Resubmission(state, mission, {
    actorAgentId: authority.executorAgentId,
    runId: authority.runId,
    candidate: verified,
    evidenceRevision: mission.version + 1,
    correctedPaths,
    submissionId,
  });
  const aggregate: MissionAggregate = {
    ...mission.aggregate,
    phase: "correcting",
    n2: nextState,
    journal: [...mission.aggregate.journal, {
      action: authority.journalAction, submissionId, candidate: verified.candidate,
      correctedPaths, executorAgentId: authority.executorAgentId, runId: authority.runId,
      ...(authority.logicalExecutorAgentId ? { logicalExecutorAgentId: authority.logicalExecutorAgentId } : {}),
      ...(authority.actorType === "agent" ? { actorAgentId: authority.actorId } : { actorUserId: authority.actorId }),
      ...(authority.correctionTaskId ? { correctionTaskId: authority.correctionTaskId } : {}), at: new Date().toISOString(),
    }],
  };
  return n2CommandCas(ctx, mission, body, authority.actorType, authority.actorId, aggregate);
}

export async function handleN2AgentApi(input: PluginApiRequestInput, ctx: PluginContext) {
  try {
    const body = runtimeBody(input.body);
    const missionId = runtimeUuid(body.missionId, "missionId");
    const mission = await getMission(ctx, input.companyId, missionId);
    if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
    if (mission.aggregate.n2?.ordinary) {
      const { executeOrdinaryN2Agent } = await import("./n2-ordinary-agent.js");
      return { status: 200, body: await executeOrdinaryN2Agent(ctx, mission, input, body) };
    }
    if (input.params.issueId !== mission.rootIssueId) throw new MissionError(404, "mission_issue_not_found", "N2 commands address the mission root issue");
    if (mission.aggregate.n2?.native) {
      const { executeNativeN2Agent } = await import("./n2-native-runtime.js");
      return { status: 200, body: await executeNativeN2Agent(ctx, mission, input, body) };
    }
    if (body.command === "inspect") {
      return { status: 200, body: await inspectN2Agent(ctx, mission, input) };
    }
    if (body.command === "confirm-review-handoff") {
      const result = await confirmReviewCommand(ctx, mission, input, body);
      return { status: 200, body: result };
    }
    if (body.command === "prepare-resubmission") {
      const result = await prepareResubmissionCommand(ctx, mission, input, body);
      return { status: 200, body: result };
    }
    throw new MissionError(400, "unknown_command", "Unknown N2 agent command");
  } catch (error) {
    if (error instanceof N3OpinionError) return { status: 409, body: { error: error.message, code: error.code, details: error.details } };
    if (error instanceof MissionError || error instanceof AdmissionError) {
      return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
    }
    throw error;
  }
}

export type N2DecisionContext = {
  operationId: string;
  verdict: "changes_requested" | "approved";
  actorAgentId: string;
  runId: string;
  resultReference: string;
  approvedCommit?: string;
  justification: string;
};

export type N2PreparedDecision = N2DecisionContext & {
  submissionId: string;
  decisionHash: string;
  settlementCommandId: string;
  correctionReservationId?: string;
};

function n2DecisionPayload(decision: N2DecisionContext): N2DecisionContext {
  return {
    operationId: decision.operationId,
    verdict: decision.verdict,
    actorAgentId: decision.actorAgentId,
    runId: decision.runId,
    resultReference: decision.resultReference,
    ...(decision.verdict === "approved" ? { approvedCommit: decision.approvedCommit } : {}),
    justification: decision.justification,
  };
}

function preparedDecisionFromIntent(intent: Record<string, unknown>): N2PreparedDecision {
  const decision = record(intent.decision, "prepared N2 decision");
  const verdict = decision.verdict;
  if (verdict !== "changes_requested" && verdict !== "approved") {
    throw new MissionError(409, "n2_decision_intent_invalid", "Prepared N2 decision verdict is malformed");
  }
  const prepared: N2PreparedDecision = {
    operationId: runtimeString(decision.operationId, "operationId", 128),
    verdict,
    actorAgentId: runtimeUuid(decision.actorAgentId, "actorAgentId"),
    runId: runtimeUuid(decision.runId, "runId"),
    resultReference: runtimeString(decision.resultReference, "resultReference", 2_048),
    justification: runtimeString(decision.justification, "justification", MAX_JUSTIFICATION_LENGTH),
    submissionId: runtimeUuid(intent.submissionId, "submissionId"),
    decisionHash: runtimeString(intent.decisionHash, "decisionHash", 64),
    settlementCommandId: runtimeUuid(intent.settlementCommandId, "settlementCommandId"),
  };
  if (verdict === "approved") {
    prepared.approvedCommit = runtimeString(decision.approvedCommit, "approvedCommit", 40);
  }
  if (typeof intent.reservationId === "string") prepared.correctionReservationId = runtimeUuid(intent.reservationId, "correctionReservationId");
  if (prepared.decisionHash !== canonicalPayloadHash(n2DecisionPayload(prepared))) {
    throw new MissionError(409, "n2_decision_intent_invalid", "Prepared N2 decision content hash does not match its payload");
  }
  return prepared;
}

export function findPreparedN2Decision(
  mission: MissionRecord,
  identity: { runId: string; actorAgentId: string },
): N2PreparedDecision | null {
  const state = storedN2(mission);
  const round = state.rounds.at(-1);
  if (!round || state.status !== "reviewing" || round.handoff.reviewerRunId !== identity.runId
      || round.reviewerAgentId !== identity.actorAgentId || round.verdict) return null;
  const intent = n2Effect(mission.aggregate, (entry) => entry.kind === "n2_decision"
    && entry.state === "prepared" && entry.submissionId === round.submissionId
    && entry.actorRunId === identity.runId && entry.actorAgentId === identity.actorAgentId);
  if (!intent) return null;
  const prepared = preparedDecisionFromIntent(intent);
  if (prepared.submissionId !== state.activeSubmissionId) {
    throw new MissionError(409, "n2_decision_target_mismatch", "Prepared N2 decision no longer targets the active submission");
  }
  return prepared;
}

export async function prepareN2Decision(
  ctx: PluginContext,
  mission: MissionRecord,
  decision: N2DecisionContext,
  correctionReservationId?: string,
): Promise<MissionRecord> {
  const state = storedN2(mission);
  const round = state.rounds.at(-1);
  const submission = state.submissions.find((item) => item.submissionId === state.activeSubmissionId);
  if (!round || !submission || state.status !== "reviewing" || round.handoff.reviewerRunId !== decision.runId
      || !isLogicalActor(mission, round.reviewerAgentId, decision.actorAgentId, decision.runId)
      || decision.resultReference !== n2SubmissionResultReference(submission.submissionId)
      || (decision.verdict === "approved" && decision.approvedCommit !== submission.candidateCommit)) {
    throw new MissionError(409, "n2_decision_target_mismatch", "Decision does not target the active N2 submission and confirmed reviewer run");
  }
  if (decision.verdict === "changes_requested" && (round.round !== 1 && !feedbackCorrectionRound(mission, round.submissionId) || state.correctionsUsed >= state.correctionLimit)) {
    throw new MissionError(409, "correction_limit_exceeded", "Only one ordinary correction is supported");
  }
  if (decision.verdict === "approved") {
    // N2 already verified the bundle bytes, base, candidate and attributed paths
    // when creating this immutable submission. Recheck its native attachment
    // binding, rather than requiring an unrelated legacy delivery manifest.
    const attachments = await ctx.issues.listAttachments(mission.rootIssueId, mission.companyId);
    const attachment = attachments.find((entry) => entry.id === submission.attachmentId);
    if (!attachment || attachment.companyId !== mission.companyId || attachment.issueId !== mission.rootIssueId
        || attachment.sha256 !== submission.sha256 || attachment.byteSize !== submission.byteSize) {
      throw new MissionError(409, "n2_approval_attachment_mismatch", "Approval attachment no longer matches the verified immutable N2 submission");
    }
  }
  const prior = n2Effect(mission.aggregate, (entry) => entry.kind === "n2_decision" && entry.operationId === decision.operationId);
  const payload = n2DecisionPayload(decision);
  const decisionHash = canonicalPayloadHash(payload);
  if (prior) {
    if (prior.decisionHash !== decisionHash) {
      throw new MissionError(409, "operation_content_conflict", "operationId is already bound to different N2 decision content");
    }
    return mission;
  }
  const competing = n2Effect(mission.aggregate, (entry) => entry.kind === "n2_decision"
    && entry.submissionId === submission.submissionId);
  if (competing) {
    throw new MissionError(409, "n2_decision_already_prepared", "The active N2 submission already has an immutable prepared decision");
  }
  let correctionAdmission: Record<string, unknown> = {};
  if (decision.verdict === "changes_requested") {
    const reservationId = runtimeUuid(correctionReservationId, "correctionReservationId");
    if (!state.native && !state.ordinary) await reserveN2Run(ctx, mission, { reservationId, effectId: decision.operationId, kind: "correction" });
    correctionAdmission = { reservationId };
  }
  return n2Cas(ctx, mission, {
    ...mission.aggregate,
    effectIntents: [...mission.aggregate.effectIntents, {
      kind: "n2_decision", state: "prepared", operationId: decision.operationId,
      decisionHash,
      submissionId: submission.submissionId, verdict: decision.verdict,
      actorAgentId: decision.actorAgentId, actorRunId: decision.runId,
      decision: payload, settlementCommandId: randomUUID(),
      ...correctionAdmission, at: new Date().toISOString(),
    }],
  });
}

export async function settlePreparedN2ReviewUsage(
  ctx: PluginContext,
  mission: MissionRecord,
  prepared: N2PreparedDecision,
): Promise<MissionRecord> {
  const state = storedN2(mission);
  const round = state.rounds.at(-1);
  const current = findPreparedN2Decision(mission, {
    runId: prepared.runId,
    actorAgentId: prepared.actorAgentId,
  });
  if (!round || !current || current.operationId !== prepared.operationId
      || current.decisionHash !== prepared.decisionHash) {
    throw new MissionError(409, "n2_decision_target_mismatch", "Prepared N2 decision identity changed before usage settlement");
  }
  if (round.handoff.usageSettledAt) return mission;
  if (!round.handoff.reviewerRunId || !round.handoff.reservationId) {
    throw new MissionError(409, "review_usage_binding_missing", "Review run and reservation must be confirmed before settlement");
  }
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  const reservation = envelope.reservations.find((entry) => entry.reservationId === round.handoff.reservationId);
  const settledByPreparedCommand = reservation?.settlementReceipts.some(
    (receipt) => receipt.commandId === prepared.settlementCommandId,
  );
  if (reservation?.status === "settled" && !settledByPreparedCommand) {
    throw new MissionError(409, "n2_usage_settlement_conflict", "Review reservation was settled by another command identity");
  }
  if (!settledByPreparedCommand) {
    await settleNativeSequentialRunUsage(ctx, {
      commandId: prepared.settlementCommandId,
      companyId: mission.companyId,
      issueId: mission.rootIssueId,
      expectedRunId: round.handoff.reviewerRunId,
      baseline: { runIds: round.handoff.baselineRunIds, tokenTotal: round.handoff.baselineTokenTotal },
      periodKey: profile.periodKey,
      reservationId: round.handoff.reservationId,
      expectedVersion: envelope.version,
    });
  }
  const afterSettlement = await getMission(ctx, mission.companyId, mission.missionId);
  if (!afterSettlement) throw new Error("Mission disappeared after prepared N2 usage settlement");
  const afterState = storedN2(afterSettlement);
  const afterRound = afterState.rounds.at(-1);
  if (afterRound?.handoff.usageSettledAt) return afterSettlement;
  const stillPrepared = findPreparedN2Decision(afterSettlement, {
    runId: prepared.runId,
    actorAgentId: prepared.actorAgentId,
  });
  if (!afterRound || !stillPrepared || stillPrepared.operationId !== prepared.operationId) {
    throw new MissionError(409, "n2_decision_target_mismatch", "Prepared N2 decision changed during usage settlement");
  }
  const settledAt = new Date().toISOString();
  return n2Cas(ctx, afterSettlement, {
    ...afterSettlement.aggregate,
    n2: {
      ...afterState,
      rounds: afterState.rounds.map((entry) => entry.round === afterRound.round
        ? { ...entry, handoff: { ...entry.handoff, usageSettledAt: settledAt } }
        : entry),
    },
    journal: [...afterSettlement.aggregate.journal, {
      action: "n2_usage_settled", target: "review", round: afterRound.round,
      settlementCommandId: prepared.settlementCommandId,
      actorAgentId: prepared.actorAgentId, runId: prepared.runId, at: settledAt,
    }],
  });
}

export async function recordN2Decision(
  ctx: PluginContext,
  missionId: string,
  decision: N2DecisionContext,
  receipt: DecisionReceipt,
): Promise<MissionRecord> {
  const mission = await getMission(ctx, receipt.companyId, missionId);
  if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found while recording N2 decision");
  const state = storedN2(mission);
  const priorRound = state.rounds.find((round) => round.verdict?.operationId === decision.operationId);
  if (priorRound) return mission;
  const intent = n2Effect(mission.aggregate, (entry) => entry.kind === "n2_decision" && entry.operationId === decision.operationId);
  if (!intent) throw new MissionError(409, "n2_decision_intent_missing", "N2 decision has no durable pre-effect intent");
  if (intent.decisionHash !== canonicalPayloadHash(n2DecisionPayload(decision))) {
    throw new MissionError(409, "operation_content_conflict", "Persisted N2 decision intent does not match the receipt operation content");
  }
  let nextState = applyN2Decision(state, mission, {
    submissionId: state.activeSubmissionId,
    actorAgentId: decision.actorAgentId,
    runId: decision.runId,
    operationId: decision.operationId,
    verdict: decision.verdict,
    criteria: mission.aggregate.mandate.acceptanceCriteria.length > 0
      ? mission.aggregate.mandate.acceptanceCriteria : ["Bounded mission mandate"],
    reasons: [decision.justification],
    receipt,
  });
  if (nextState.correction && typeof intent.reservationId === "string") {
    nextState = {
      ...nextState,
      correction: {
        ...nextState.correction,
        reservationId: intent.reservationId,
      },
    };
  }
  const unknown = nextState.status === "application_unknown";
  const accepted = nextState.status === "accepted";
  return n2Cas(ctx, mission, {
    ...mission.aggregate,
    phase: unknown ? "application_unknown" : accepted ? "accepted" : "correction_requested",
    control: unknown
      ? { status: "blocked", reason: "native_decision_outcome_unknown" }
      : accepted ? { status: "inactive", reason: "mission_accepted" } : { status: "active" },
    n2: nextState,
    effectIntents: mission.aggregate.effectIntents.map((entry) => entry.kind === "n2_decision" && entry.operationId === decision.operationId
      ? { ...entry, state: unknown ? "unknown" : "requested", receiptState: receipt.state, nativeStatus: receipt.nativeObservation?.status ?? null }
      : entry),
    journal: [...mission.aggregate.journal, {
      action: "n2_decision_recorded", operationId: decision.operationId, verdict: decision.verdict,
      receiptState: receipt.state, submissionId: state.activeSubmissionId,
      actorAgentId: decision.actorAgentId, runId: decision.runId, at: new Date().toISOString(),
    }],
  });
}
