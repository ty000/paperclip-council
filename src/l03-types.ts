export type Sha256 = string;

export type L03Actor = {
  actorType: "user" | "agent" | "plugin";
  actorId: string;
  userId?: string | null;
  companyId: string;
};

export type L03AuthoritySnapshot = {
  companyId: string;
  missionId: string;
  missionVersion: number;
  mandateRevision: number;
  ownerUserId: string;
  executorAgentId: string;
  finalReviewerAgentId: string;
  councilAgentId: string;
  executivePluginActorId: string;
  expiresAt: string;
};

export type L03TicketContext = {
  issueId: string;
  sourceRef: string;
  sourceVersion: string;
  sourceHash: Sha256;
  suppliedContext: {
    sourceRef: string;
    sourceHash: Sha256;
    content: string;
  };
  criteria: Array<{ id: string; text: string }>;
  exclusions: string[];
};

export type L03AdmissionLimits = {
  envelope: number;
  approach: number;
  result: number;
  consultation: number;
  correction: number;
};

export type L03AdmissionCounters = {
  envelope: { admitted: number; limit: number };
  approach: { admitted: number; limit: number };
  result: { admitted: number; limit: number };
  consultation: { admitted: number; limit: number; activeReservations: number };
  correction: { admitted: number; limit: number };
  unknownCostExposureRefs: string[];
};

export type ReservationLocator = {
  reservationId: string;
  missionId: string;
  slotId: string;
  reservationVersion: number;
  councilAgentId: string;
};

export type ReservedConsultationSlot = {
  companyId: string;
  missionId: string;
  missionVersion: number;
  mandateRevision: number;
  slotId: string;
  reservationId: string;
  reservationVersion: number;
  status: "reserved";
  reservedExecutiveAgentId: string;
  profile: { id: string; version: string; sourceHash: Sha256 };
  method: { id: string; version: string };
  criterionRefs: string[];
  evidenceRefs: string[];
  context: { sourceRef: string; sourceHash: Sha256; content: string };
  expiresAt: string;
};

export type CouncilOpinionAdmissionRequest = {
  schemaVersion: "council-opinion-admission-request.v1";
  requestId: string;
  reservationId: string;
  missionId: string;
  slotId: string;
  reservationVersion: number;
  observedReservationEventId: string;
  observedReservationHash: Sha256;
  requestedAt: string;
};

export type CouncilOpinionAdmissionGrant = {
  schemaVersion: "council-opinion-admission-grant.v1";
  requestId: string;
  grantId: string;
  grantedAt: string;
  expiresAt: string;
  slot: ReservedConsultationSlot;
  slotHash: Sha256;
};

export type CouncilOpinionFinding = {
  id: string;
  class: "must_fix" | "useful_now" | "defer";
  criterionRef: string;
  evidenceRefs: string[];
  reasons: string;
  smallestUsefulAction: string;
};

export type CouncilOpinion = {
  schemaVersion: "council-reserved-opinion.v1";
  recommendation: "proceed" | "revise" | "refuse" | "escalate";
  summary: string;
  findings: CouncilOpinionFinding[];
  limitations: string[];
  dissent: string[];
};

export type CouncilOpinionObservation = {
  schemaVersion: "council-reserved-opinion-observed.v1";
  observedEventRef: string;
  observedAt: string;
  requestId: string;
  grantId: string;
  reservationId: string;
  reservationVersion: number;
  missionId: string;
  slotId: string;
  slotHash: Sha256;
  executiveAgentId: string;
  profile: ReservedConsultationSlot["profile"] | null;
  method: ReservedConsultationSlot["method"];
  sessionId: string | null;
  runId: string | null;
  status: "completed" | "failed" | "outcome_unknown";
  opinion: CouncilOpinion | null;
  error: string | null;
};

export type ConsultationSlot = {
  slot: ReservedConsultationSlot;
  subjectApproachId: string;
  required: boolean;
  reservationEventRef: string;
  costExposure: { status: "known"; reference: string } | { status: "unknown"; reference: string };
  admissionGrant: CouncilOpinionAdmissionGrant | null;
  admissionGrantConsumedAt: string | null;
  observations: CouncilOpinionObservation[];
  contribution: {
    requestId: string;
    grantId: string;
    executiveAgentId: string;
    observedEventRef: string;
    opinion: CouncilOpinion;
    recordedAt: string;
  } | null;
};

export type L03Approach = {
  approachId: string;
  sequence: number;
  authorAgentId: string;
  contentRef: string;
  contentHash: Sha256;
  criterionRefs: string[];
  evidenceRefs: string[];
  supersedesApproachId: string | null;
  addressesFindingIds: string[];
  submittedAt: string;
};

export type L03Direction = {
  decisionId: string;
  approachId: string;
  reviewerAgentId: string;
  verdict: "proceed" | "revise" | "refuse" | "escalate";
  rationale: string;
  findingIds: string[];
  receiptRef: string;
  decidedAt: string;
  executionAttempt: { attemptId: string; claimedAt: string } | null;
  actualEffect: L03ActualEffect | null;
};

export type L03Artifact = {
  ref: string;
  sha256: Sha256;
  byteVerificationRef: string;
};

export type L03Result = {
  resultId: string;
  sequence: number;
  authorAgentId: string;
  rootIssueId: string;
  segmentIssueId: string;
  repository: string;
  baseCommit: Sha256;
  candidateCommit: Sha256;
  attachmentId: string;
  sha256: Sha256;
  artifactSetHash: Sha256;
  artifacts: L03Artifact[];
  evidenceRefs: string[];
  criterionRefs: string[];
  supersedesResultId: string | null;
  addressesFindingIds: string[];
  submittedAt: string;
};

export type L03ResultDecision = {
  decisionId: string;
  resultId: string;
  reviewerAgentId: string;
  verdict: "accept" | "revise" | "refuse" | "escalate";
  rationale: string;
  findings: CouncilOpinionFinding[];
  receiptRef: string;
  decidedAt: string;
  actualEffect: L03ActualEffect | null;
};

export type L03ActualEffect = {
  decisionId: string;
  attemptId?: string;
  status: "confirmed";
  observationRef: string;
  receiptRef: string;
  observedAt: string;
};

export type L03Phase =
  | "awaiting_approach"
  | "collecting_approach_opinions"
  | "awaiting_approach_direction"
  | "approach_revision_required"
  | "awaiting_direction_effect"
  | "executing"
  | "awaiting_result_review"
  | "result_correction_required"
  | "awaiting_result_effect"
  | "accepted"
  | "refused"
  | "escalated"
  | "limit_exhausted";

export type L03Governance = {
  schemaVersion: 1;
  version: number;
  companyId: string;
  missionId: string;
  missionVersion: number;
  mandateRevision: number;
  authority: L03AuthoritySnapshot;
  ticket: L03TicketContext;
  phase: L03Phase;
  counters: L03AdmissionCounters;
  approaches: L03Approach[];
  activeApproachId: string | null;
  consultationSlots: ConsultationSlot[];
  approachDirections: L03Direction[];
  results: L03Result[];
  resultDecisions: L03ResultDecision[];
  openMustFixFindingIds: string[];
  receiptRefs: string[];
  journal: Array<{ action: string; actorId: string; at: string; ref?: string }>;
};

export type L03CreateInput = {
  companyId: string;
  missionId: string;
  expectedMissionVersion: number;
  mandateRevision: number;
  executorAgentId: string;
  finalReviewerAgentId: string;
  councilAgentId: string;
  executivePluginActorId: string;
  expiresAt: string;
  ticket: L03TicketContext;
  limits: L03AdmissionLimits;
};

type CommandBase = { expectedVersion: number };

export type L03Command =
  | (CommandBase & { type: "submit-approach"; approach: Omit<L03Approach, "sequence" | "submittedAt"> })
  | (CommandBase & { type: "reserve-consultation"; subjectApproachId: string; reservation: ReservedConsultationSlot; required: boolean; reservationEventRef: string; costExposure: ConsultationSlot["costExposure"] })
  | (CommandBase & { type: "grant-consultation-admission"; request: CouncilOpinionAdmissionRequest; grantId: string; grantExpiresAt: string; slotHash: Sha256 })
  | (CommandBase & { type: "record-consultation-observation"; observation: CouncilOpinionObservation })
  | (CommandBase & { type: "record-opinion"; slotId: string; reservationId: string; reservationVersion: number; requestId: string; grantId: string; executiveAgentId: string; observedEventRef: string; opinion: CouncilOpinion })
  | (CommandBase & { type: "decide-approach"; decisionId: string; approachId: string; verdict: L03Direction["verdict"]; rationale: string; findingIds: string[]; receiptRef: string })
  | (CommandBase & { type: "claim-direction-effect"; decisionId: string; attemptId: string })
  | (CommandBase & { type: "record-direction-effect"; decisionId: string })
  | (CommandBase & { type: "submit-result"; result: Omit<L03Result, "sequence" | "submittedAt"> })
  | (CommandBase & { type: "decide-result"; decisionId: string; resultId: string; verdict: L03ResultDecision["verdict"]; rationale: string; findings: CouncilOpinionFinding[]; receiptRef: string })
  | (CommandBase & { type: "record-result-effect"; decisionId: string });

export type L03TransitionFacts = {
  now: string;
  actor: L03Actor;
  current: L03AuthoritySnapshot;
  actualEffectObservation?: L03ActualEffect;
};

