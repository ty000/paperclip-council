export const N3_SPECIALIST_PERSPECTIVES = [
  "product",
  "development",
  "architecture",
  "ux_accessibility",
  "quality",
  "security",
  "operations",
] as const;

export type N3SpecialistPerspective = (typeof N3_SPECIALIST_PERSPECTIVES)[number];

export type N3CandidateSubject = {
  submissionId: string;
  candidateCommit: string;
  bundleSha256: string;
  evidenceRevision: number;
  mandateHash: string;
};

export type N3OpinionSlot = {
  slotId: string;
  perspective: N3SpecialistPerspective;
  specialistAgentId: string;
  question: string;
  required: boolean;
};

export type N3Finding = {
  findingId: string;
  classification: "blocking_defect" | "decisive_uncertainty" | "deferrable_improvement";
  criterionOrRisk: string;
  evidenceRefs: string[];
  evidenceLimits: string[];
  consequence: string;
  recommendedAction: string;
};

export type N3Opinion = {
  opinionId: string;
  slotId: string;
  perspective: N3SpecialistPerspective;
  specialistAgentId: string;
  specialistRunId: string;
  subject: N3CandidateSubject;
  outcome: "support" | "changes_requested" | "insufficient_evidence";
  rationale: string;
  findings: N3Finding[];
  unresolvedQuestions: string[];
  recordedAt: string;
};

export type N3ObjectionDisposition = {
  findingId: string;
  disposition: "upheld_with_correction" | "resolved_by_evidence" | "rejected_with_reason" | "escalated";
  reason: string;
  evidenceRefs: string[];
};

export type N3Synthesis = {
  finalReviewerAgentId: string;
  finalReviewerRunId: string;
  subject: N3CandidateSubject;
  verdict: "approved" | "changes_requested" | "waiting";
  rationale: string;
  dispositions: N3ObjectionDisposition[];
  recordedAt: string;
};

export type N3ReviewRound = {
  schemaVersion: 1;
  subject: N3CandidateSubject;
  authorAgentIds: string[];
  finalReviewerAgentId: string;
  slots: N3OpinionSlot[];
  opinions: N3Opinion[];
  synthesis: N3Synthesis | null;
  status: "collecting_opinions" | "ready_for_synthesis" | "synthesized";
};

export class N3OpinionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "N3OpinionError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_1 = /^[0-9a-f]{40}$/i;
const SHA_256 = /^[0-9a-f]{64}$/i;

function bounded(value: string, label: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new N3OpinionError("invalid_n3_input", `${label} must be non-empty and at most ${max} characters`);
  }
  return value.trim();
}

function identifier(value: string, label: string): string {
  const result = bounded(value, label, 128);
  if (!UUID.test(result)) throw new N3OpinionError("invalid_n3_input", `${label} must be a UUID`);
  return result;
}

function boundedList(value: string[], label: string, options: { min?: number; max?: number } = {}): string[] {
  const min = options.min ?? 0;
  const max = options.max ?? 20;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new N3OpinionError("invalid_n3_input", `${label} must contain ${min}-${max} entries`);
  }
  const result = value.map((entry, index) => bounded(entry, `${label}[${index}]`, 1_000));
  if (new Set(result).size !== result.length) {
    throw new N3OpinionError("invalid_n3_input", `${label} must not contain duplicates`);
  }
  return result;
}

function validateSubject(subject: N3CandidateSubject): N3CandidateSubject {
  if (!Number.isSafeInteger(subject.evidenceRevision) || subject.evidenceRevision < 1) {
    throw new N3OpinionError("invalid_n3_subject", "evidenceRevision must be a positive safe integer");
  }
  if (!SHA_1.test(subject.candidateCommit) || !SHA_256.test(subject.bundleSha256) || !SHA_256.test(subject.mandateHash)) {
    throw new N3OpinionError("invalid_n3_subject", "candidate commit, bundle digest, and mandate hash are required");
  }
  return {
    submissionId: identifier(subject.submissionId, "subject.submissionId"),
    candidateCommit: subject.candidateCommit.toLowerCase(),
    bundleSha256: subject.bundleSha256.toLowerCase(),
    evidenceRevision: subject.evidenceRevision,
    mandateHash: subject.mandateHash.toLowerCase(),
  };
}

function sameSubject(left: N3CandidateSubject, right: N3CandidateSubject): boolean {
  return left.submissionId === right.submissionId
    && left.candidateCommit === right.candidateCommit
    && left.bundleSha256 === right.bundleSha256
    && left.evidenceRevision === right.evidenceRevision
    && left.mandateHash === right.mandateHash;
}

function materialFindings(opinion: N3Opinion): N3Finding[] {
  return opinion.findings.filter((finding) => finding.classification !== "deferrable_improvement");
}

function nextStatus(round: N3ReviewRound): N3ReviewRound["status"] {
  const recorded = new Set(round.opinions.map((opinion) => opinion.slotId));
  return round.slots.every((slot) => !slot.required || recorded.has(slot.slotId))
    ? "ready_for_synthesis"
    : "collecting_opinions";
}

function validateSynthesisActor(
  round: N3ReviewRound,
  input: { subject: N3CandidateSubject; authenticatedAgentId: string },
): { subject: N3CandidateSubject; authenticatedAgentId: string } {
  const subject = validateSubject(input.subject);
  if (!sameSubject(round.subject, subject)) {
    throw new N3OpinionError("stale_n3_subject", "The synthesis does not target the active candidate and evidence tuple");
  }
  const authenticatedAgentId = identifier(input.authenticatedAgentId, "authenticatedAgentId");
  if (authenticatedAgentId !== round.finalReviewerAgentId || round.authorAgentIds.includes(authenticatedAgentId)) {
    throw new N3OpinionError("final_reviewer_required", "Only the independent assigned final reviewer can synthesize the round");
  }
  return { subject, authenticatedAgentId };
}

function requiredMaterialFindingIds(round: N3ReviewRound): Set<string> {
  const received = new Set(round.opinions.map((opinion) => opinion.slotId));
  const missingRequiredSlots = round.slots.filter((slot) => slot.required && !received.has(slot.slotId));
  if (missingRequiredSlots.length > 0) {
    throw new N3OpinionError("required_opinion_missing", "A missing required opinion cannot be treated as agreement", {
      missingSlotIds: missingRequiredSlots.map((slot) => slot.slotId),
    });
  }
  const material = round.opinions.flatMap(materialFindings);
  const findingIds = new Set(material.map((finding) => finding.findingId));
  if (findingIds.size !== material.length) {
    throw new N3OpinionError("duplicate_n3_finding", "Finding identities must be unique across attributed opinions");
  }
  return findingIds;
}

function normalizeDispositions(
  values: N3ObjectionDisposition[],
  requiredFindingIds: Set<string>,
): N3ObjectionDisposition[] {
  if (!Array.isArray(values) || values.length !== requiredFindingIds.size) {
    throw new N3OpinionError("material_objection_undisposed", "Every material objection requires exactly one disposition");
  }
  const allowed = new Set<N3ObjectionDisposition["disposition"]>([
    "upheld_with_correction", "resolved_by_evidence", "rejected_with_reason", "escalated",
  ]);
  const dispositions = values.map((disposition, index): N3ObjectionDisposition => {
    if (!allowed.has(disposition.disposition)) {
      throw new N3OpinionError("material_objection_undisposed", "Every disposition must use a supported reasoned outcome");
    }
    return {
      findingId: identifier(disposition.findingId, `dispositions[${index}].findingId`),
      disposition: disposition.disposition,
      reason: bounded(disposition.reason, `dispositions[${index}].reason`, 2_000),
      evidenceRefs: boundedList(disposition.evidenceRefs, `dispositions[${index}].evidenceRefs`, {
        min: disposition.disposition === "resolved_by_evidence" ? 1 : 0,
        max: 20,
      }),
    };
  });
  const dispositionIds = dispositions.map((disposition) => disposition.findingId);
  if (new Set(dispositionIds).size !== dispositionIds.length
      || dispositionIds.some((findingId) => !requiredFindingIds.has(findingId))) {
    throw new N3OpinionError("material_objection_undisposed", "Dispositions must cover only the material objections exactly once");
  }
  return dispositions;
}

function validateSynthesisVerdict(
  verdict: N3Synthesis["verdict"],
  dispositions: N3ObjectionDisposition[],
): void {
  if (!["approved", "changes_requested", "waiting"].includes(verdict)) {
    throw new N3OpinionError("invalid_n3_verdict", "The synthesis verdict must be approved, changes_requested or waiting");
  }
  const hasUpheld = dispositions.some((item) => item.disposition === "upheld_with_correction");
  const hasEscalated = dispositions.some((item) => item.disposition === "escalated");
  if ((verdict === "approved" && (hasUpheld || hasEscalated))
      || (verdict === "changes_requested" && hasEscalated)) {
    throw new N3OpinionError("inconsistent_n3_verdict", "The final verdict conflicts with the recorded objection dispositions");
  }
}

export function startN3ReviewRound(input: {
  subject: N3CandidateSubject;
  authorAgentIds: string[];
  finalReviewerAgentId: string;
  slots: N3OpinionSlot[];
}): N3ReviewRound {
  const subject = validateSubject(input.subject);
  const authorAgentIds = boundedList(input.authorAgentIds, "authorAgentIds", { min: 1, max: 20 })
    .map((agentId) => identifier(agentId, "authorAgentId"));
  const finalReviewerAgentId = identifier(input.finalReviewerAgentId, "finalReviewerAgentId");
  if (authorAgentIds.includes(finalReviewerAgentId)) {
    throw new N3OpinionError("reviewer_conflict", "The final reviewer cannot be an author of the candidate");
  }
  if (!Array.isArray(input.slots) || input.slots.length < 2 || input.slots.length > N3_SPECIALIST_PERSPECTIVES.length) {
    throw new N3OpinionError("invalid_n3_slots", "N3 requires two to seven selected specialist slots");
  }
  const slots = input.slots.map((slot, index): N3OpinionSlot => {
    if (!N3_SPECIALIST_PERSPECTIVES.includes(slot.perspective)) {
      throw new N3OpinionError("invalid_n3_slots", `slots[${index}].perspective is not prepared`);
    }
    const specialistAgentId = identifier(slot.specialistAgentId, `slots[${index}].specialistAgentId`);
    if (authorAgentIds.includes(specialistAgentId)) {
      throw new N3OpinionError("reviewer_conflict", "An author cannot supply an independent specialist opinion");
    }
    if (specialistAgentId === finalReviewerAgentId) {
      throw new N3OpinionError("reviewer_conflict", "The final reviewer cannot occupy a specialist slot in the same round");
    }
    return {
      slotId: identifier(slot.slotId, `slots[${index}].slotId`),
      perspective: slot.perspective,
      specialistAgentId,
      question: bounded(slot.question, `slots[${index}].question`, 1_000),
      required: slot.required === true,
    };
  });
  if (new Set(slots.map((slot) => slot.slotId)).size !== slots.length
      || new Set(slots.map((slot) => slot.perspective)).size !== slots.length
      || new Set(slots.map((slot) => slot.specialistAgentId)).size !== slots.length) {
    throw new N3OpinionError("invalid_n3_slots", "Slot, perspective, and specialist identities must be distinct");
  }
  if (slots.filter((slot) => slot.required).length < 2) {
    throw new N3OpinionError("invalid_n3_slots", "The representative N3 round requires at least two required perspectives");
  }
  return {
    schemaVersion: 1,
    subject,
    authorAgentIds,
    finalReviewerAgentId,
    slots,
    opinions: [],
    synthesis: null,
    status: "collecting_opinions",
  };
}

export function recordN3Opinion(
  round: N3ReviewRound,
  input: {
    subject: N3CandidateSubject;
    slotId: string;
    authenticatedAgentId: string;
    authenticatedRunId: string;
    opinionId: string;
    outcome: N3Opinion["outcome"];
    rationale: string;
    findings: N3Finding[];
    unresolvedQuestions: string[];
    at?: string;
  },
): N3ReviewRound {
  if (round.status === "synthesized") {
    throw new N3OpinionError("n3_round_finalized", "A finalized round cannot accept another opinion");
  }
  const subject = validateSubject(input.subject);
  if (!sameSubject(round.subject, subject)) {
    throw new N3OpinionError("stale_n3_subject", "The opinion does not target the active candidate and evidence tuple");
  }
  const slotId = identifier(input.slotId, "slotId");
  const slot = round.slots.find((candidate) => candidate.slotId === slotId);
  if (!slot) throw new N3OpinionError("unknown_n3_slot", "The specialist slot is not selected for this round");
  const authenticatedAgentId = identifier(input.authenticatedAgentId, "authenticatedAgentId");
  if (authenticatedAgentId !== slot.specialistAgentId || round.authorAgentIds.includes(authenticatedAgentId)) {
    throw new N3OpinionError("reviewer_conflict", "The authenticated specialist is not independent and assigned to this slot");
  }
  if (round.opinions.some((opinion) => opinion.slotId === slotId || opinion.opinionId === input.opinionId)) {
    throw new N3OpinionError("duplicate_n3_opinion", "The slot or opinion identity is already recorded");
  }
  if (!["support", "changes_requested", "insufficient_evidence"].includes(input.outcome)) {
    throw new N3OpinionError("invalid_n3_outcome", "The opinion outcome must be support, changes_requested or insufficient_evidence");
  }
  if (!Array.isArray(input.findings) || input.findings.length > 30) {
    throw new N3OpinionError("invalid_n3_opinion", "findings must contain at most 30 entries");
  }
  const findings = input.findings.map((finding, index): N3Finding => ({
    findingId: identifier(finding.findingId, `findings[${index}].findingId`),
    classification: finding.classification,
    criterionOrRisk: bounded(finding.criterionOrRisk, `findings[${index}].criterionOrRisk`, 1_000),
    evidenceRefs: boundedList(finding.evidenceRefs, `findings[${index}].evidenceRefs`, { min: 1, max: 20 }),
    evidenceLimits: boundedList(finding.evidenceLimits, `findings[${index}].evidenceLimits`, { max: 20 }),
    consequence: bounded(finding.consequence, `findings[${index}].consequence`, 1_000),
    recommendedAction: bounded(finding.recommendedAction, `findings[${index}].recommendedAction`, 1_000),
  }));
  if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length
      || findings.some((finding) => !["blocking_defect", "decisive_uncertainty", "deferrable_improvement"].includes(finding.classification))) {
    throw new N3OpinionError("invalid_n3_opinion", "Finding identities and classifications must be valid");
  }
  if (input.outcome !== "support" && !findings.some((finding) => finding.classification !== "deferrable_improvement")) {
    throw new N3OpinionError("invalid_n3_opinion", "A non-supporting opinion requires a material evidence-backed finding");
  }
  const opinion: N3Opinion = {
    opinionId: identifier(input.opinionId, "opinionId"),
    slotId,
    perspective: slot.perspective,
    specialistAgentId: authenticatedAgentId,
    specialistRunId: identifier(input.authenticatedRunId, "authenticatedRunId"),
    subject,
    outcome: input.outcome,
    rationale: bounded(input.rationale, "rationale", 4_000),
    findings,
    unresolvedQuestions: boundedList(input.unresolvedQuestions, "unresolvedQuestions", { max: 20 }),
    recordedAt: input.at ?? new Date().toISOString(),
  };
  const updated = { ...round, opinions: [...round.opinions, opinion] };
  return { ...updated, status: nextStatus(updated) };
}

export function synthesizeN3Review(
  round: N3ReviewRound,
  input: {
    subject: N3CandidateSubject;
    authenticatedAgentId: string;
    authenticatedRunId: string;
    verdict: N3Synthesis["verdict"];
    rationale: string;
    dispositions: N3ObjectionDisposition[];
    at?: string;
  },
): N3ReviewRound {
  if (round.status === "synthesized" || round.synthesis) {
    throw new N3OpinionError("n3_round_finalized", "The round already has a final synthesis");
  }
  const { subject, authenticatedAgentId } = validateSynthesisActor(round, input);
  const dispositions = normalizeDispositions(input.dispositions, requiredMaterialFindingIds(round));
  validateSynthesisVerdict(input.verdict, dispositions);
  const synthesis: N3Synthesis = {
    finalReviewerAgentId: authenticatedAgentId,
    finalReviewerRunId: identifier(input.authenticatedRunId, "authenticatedRunId"),
    subject,
    verdict: input.verdict,
    rationale: bounded(input.rationale, "rationale", 4_000),
    dispositions,
    recordedAt: input.at ?? new Date().toISOString(),
  };
  return { ...round, synthesis, status: "synthesized" };
}
