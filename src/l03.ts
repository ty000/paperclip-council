import { createHash } from "node:crypto";
import type {
  CouncilOpinionFinding,
  L03ActualEffect,
  L03AdmissionCounters,
  L03Approach,
  L03Command,
  L03CreateInput,
  L03Governance,
  L03Result,
  L03TransitionFacts,
  ReservedConsultationSlot,
} from "./l03-types.js";

const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_EXECUTIVE_METHOD = { id: "paperclip-executive.council-reserved-opinion", version: "1.0.0" } as const;

export class L03Error extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "L03Error";
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function assert(condition: unknown, status: number, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new L03Error(status, code, message, details);
}

function validDate(value: string, label: string): number {
  const result = Date.parse(value);
  assert(Number.isFinite(result), 422, "invalid_timestamp", `${label} must be an ISO timestamp`);
  return result;
}

function unique(values: string[], label: string): void {
  assert(values.length === new Set(values).size, 422, "duplicate_reference", `${label} contains duplicate references`);
}

function requireHash(value: string, label: string): void {
  assert(SHA256.test(value), 422, "invalid_hash", `${label} must be a lowercase SHA-256 hex digest`);
}

function validateAuthority(state: L03Governance, facts: L03TransitionFacts, expectedVersion: number): void {
  assert(state.version === expectedVersion, 409, "version_conflict", "L03 governance version is stale", { currentVersion: state.version });
  assert(facts.actor.companyId === state.companyId, 403, "company_scope_mismatch", "Actor company does not match governance company");
  const current = facts.current;
  assert(current.companyId === state.companyId && current.missionId === state.missionId, 409, "mission_identity_changed", "Current mission identity no longer matches governance state");
  assert(current.missionVersion === state.missionVersion && current.mandateRevision === state.mandateRevision, 409, "mandate_changed", "Mission or mandate revision changed; a fresh governance admission is required");
  assert(current.ownerUserId === state.authority.ownerUserId, 409, "owner_changed", "Configured owner changed");
  assert(current.executorAgentId === state.authority.executorAgentId, 409, "executor_changed", "Configured executor changed");
  assert(current.finalReviewerAgentId === state.authority.finalReviewerAgentId, 409, "reviewer_changed", "Pinned final reviewer changed");
  assert(current.councilAgentId === state.authority.councilAgentId, 409, "council_actor_changed", "Pinned Council actor changed");
  assert(current.executivePluginActorId === state.authority.executivePluginActorId, 409, "executive_actor_changed", "Pinned Executive plugin actor changed");
  assert(current.expiresAt === state.authority.expiresAt, 409, "expiry_changed", "Governance expiry changed");
  assert(validDate(facts.now, "now") <= validDate(state.authority.expiresAt, "authority.expiresAt"), 409, "mandate_expired", "Governance mandate has expired");
}

function requireActor(state: L03Governance, facts: L03TransitionFacts, role: "owner" | "executor" | "reviewer" | "council" | "executive-plugin"): void {
  const actor = facts.actor;
  const ok = role === "owner"
    ? actor.actorType === "user" && (actor.userId ?? actor.actorId) === state.authority.ownerUserId
    : role === "executor"
      ? actor.actorType === "agent" && actor.actorId === state.authority.executorAgentId
      : role === "reviewer"
        ? actor.actorType === "agent" && actor.actorId === state.authority.finalReviewerAgentId
        : role === "council"
          ? actor.actorType === "agent" && actor.actorId === state.authority.councilAgentId
          : actor.actorType === "plugin" && actor.actorId === state.authority.executivePluginActorId;
  assert(ok, 403, "actor_not_authorized", `Current actor is not the pinned ${role}`);
}

function consumeCounter(state: L03Governance, kind: "approach" | "result" | "consultation"): L03AdmissionCounters {
  const counter = state.counters[kind];
  assert(counter.admitted < counter.limit, 409, `${kind}_limit_reached`, `${kind} admission limit is exhausted`);
  assert(state.counters.envelope.admitted < state.counters.envelope.limit, 409, "admission_envelope_exhausted", "Shared mission admission envelope is exhausted");
  return {
    ...state.counters,
    envelope: { ...state.counters.envelope, admitted: state.counters.envelope.admitted + 1 },
    [kind]: { ...counter, admitted: counter.admitted + 1 },
  } as L03AdmissionCounters;
}

function journal(state: L03Governance, facts: L03TransitionFacts, action: string, ref?: string) {
  return [...state.journal, { action, actorId: facts.actor.actorId, at: facts.now, ...(ref ? { ref } : {}) }];
}

function next(state: L03Governance, facts: L03TransitionFacts, patch: Partial<L03Governance>, action: string, ref?: string): L03Governance {
  return { ...state, ...patch, version: state.version + 1, journal: journal(state, facts, action, ref) };
}

function assertCriterionRefs(state: L03Governance, refs: string[], label: string): void {
  unique(refs, label);
  const criteria = new Set(state.ticket.criteria.map((criterion) => criterion.id));
  assert(refs.length > 0 && refs.every((ref) => criteria.has(ref)), 422, "criterion_reference_invalid", `${label} must be a non-empty subset of ticket criteria`);
}

function activeApproach(state: L03Governance): L03Approach {
  const approach = state.approaches.find((entry) => entry.approachId === state.activeApproachId);
  assert(approach, 409, "active_approach_missing", "Active approach is missing");
  return approach;
}

function verifySlot(state: L03Governance, slot: ReservedConsultationSlot): void {
  assert(slot.companyId === state.companyId && slot.missionId === state.missionId, 422, "reservation_subject_mismatch", "Reservation company or mission does not match governance state");
  assert(slot.missionVersion === state.missionVersion && slot.mandateRevision === state.mandateRevision, 422, "reservation_mandate_mismatch", "Reservation is not bound to the current mission and mandate revision");
  assert(slot.status === "reserved", 422, "reservation_status_invalid", "New consultation slot must be reserved");
  assert(slot.reservedExecutiveAgentId.length > 0, 422, "reservation_agent_missing", "Reserved Executive agent is required");
  requireHash(slot.profile.sourceHash, "reservation.profile.sourceHash");
  assert(slot.method.id === REQUIRED_EXECUTIVE_METHOD.id && slot.method.version === REQUIRED_EXECUTIVE_METHOD.version, 422, "reservation_method_invalid", "Reservation must use the pinned Council reserved-opinion method");
  assertCriterionRefs(state, slot.criterionRefs, "reservation.criterionRefs");
  unique(slot.evidenceRefs, "reservation.evidenceRefs");
  requireHash(slot.context.sourceHash, "reservation.context.sourceHash");
  assert(validDate(slot.expiresAt, "reservation.expiresAt") <= validDate(state.authority.expiresAt, "authority.expiresAt"), 422, "reservation_expiry_invalid", "Reservation cannot outlive the governance mandate");
}

function validateFindings(state: L03Governance, findings: CouncilOpinionFinding[]): void {
  unique(findings.map((finding) => finding.id), "findings[].id");
  for (const finding of findings) {
    assertCriterionRefs(state, [finding.criterionRef], "finding.criterionRef");
    unique(finding.evidenceRefs, `finding ${finding.id} evidenceRefs`);
    assert(finding.reasons.trim().length > 0 && finding.smallestUsefulAction.trim().length > 0, 422, "finding_incomplete", "Each finding requires reasons and a smallest useful action");
  }
}

function validateResult(state: L03Governance, result: Omit<L03Result, "sequence" | "submittedAt">): void {
  assert(result.authorAgentId === state.authority.executorAgentId, 403, "result_author_invalid", "Result author must be the pinned executor");
  assert(result.rootIssueId === state.ticket.issueId, 422, "result_root_issue_mismatch", "Result root issue must match the governed ticket");
  assert(result.segmentIssueId.length > 0 && result.repository.length > 0 && result.attachmentId.length > 0, 422, "result_subject_incomplete", "Result requires segment issue, repository and attachment identities");
  requireHash(result.baseCommit, "result.baseCommit");
  requireHash(result.candidateCommit, "result.candidateCommit");
  requireHash(result.sha256, "result.sha256");
  requireHash(result.artifactSetHash, "result.artifactSetHash");
  assert(result.artifacts.length > 0, 422, "result_artifacts_missing", "Result requires at least one byte-verified artifact");
  for (const artifact of result.artifacts) {
    requireHash(artifact.sha256, "artifact.sha256");
    assert(artifact.ref.length > 0 && artifact.byteVerificationRef.length > 0, 422, "artifact_verification_missing", "Each artifact requires a reference and byte-verification reference");
  }
  assertCriterionRefs(state, result.criterionRefs, "result.criterionRefs");
  unique(result.evidenceRefs, "result.evidenceRefs");
}

function matchingEffect(decisionId: string, facts: L03TransitionFacts, attemptId?: string): L03ActualEffect {
  const effect = facts.actualEffectObservation;
  assert(effect?.status === "confirmed" && effect.decisionId === decisionId, 409, "actual_effect_required", "A matching confirmed actual-effect observation is required before advancing");
  if (attemptId) assert(effect.attemptId === attemptId, 409, "execution_attempt_mismatch", "Actual effect does not match the claimed execution attempt");
  assert(effect.observationRef.length > 0 && effect.receiptRef.length > 0, 422, "actual_effect_reference_missing", "Actual effect requires observation and retained receipt references");
  return effect;
}

export function initialL03Governance(input: L03CreateInput, facts: L03TransitionFacts): L03Governance {
  assert(input.companyId === facts.current.companyId && input.missionId === facts.current.missionId, 422, "mission_identity_mismatch", "Admission input does not match the current mission");
  assert(input.expectedMissionVersion === facts.current.missionVersion && input.mandateRevision === facts.current.mandateRevision, 409, "mandate_changed", "Admission requires the exact current mission and mandate revision");
  assert(input.executorAgentId === facts.current.executorAgentId && input.finalReviewerAgentId === facts.current.finalReviewerAgentId, 409, "pinned_roles_changed", "Admission roles do not match current mission authority");
  assert(input.councilAgentId === facts.current.councilAgentId && input.executivePluginActorId === facts.current.executivePluginActorId, 409, "plugin_actor_changed", "Admission plugin actors do not match current authority");
  assert(input.executorAgentId !== input.finalReviewerAgentId, 422, "reviewer_must_be_distinct", "Final reviewer must be distinct from executor");
  assert(facts.actor.actorType === "user" && (facts.actor.userId ?? facts.actor.actorId) === facts.current.ownerUserId, 403, "owner_required", "Configured owner must admit L03 governance");
  assert(input.ticket.issueId.length > 0 && input.ticket.criteria.length > 0, 422, "ticket_context_incomplete", "Ticket identity and criteria are required");
  unique(input.ticket.criteria.map((criterion) => criterion.id), "ticket.criteria[].id");
  unique(input.ticket.exclusions, "ticket.exclusions");
  requireHash(input.ticket.sourceHash, "ticket.sourceHash");
  requireHash(input.ticket.suppliedContext.sourceHash, "ticket.suppliedContext.sourceHash");
  assert(input.expiresAt === facts.current.expiresAt && validDate(facts.now, "now") < validDate(input.expiresAt, "expiresAt"), 422, "expiry_invalid", "Admission expiry must be current and in the future");
  for (const [name, value] of Object.entries(input.limits)) {
    assert(Number.isSafeInteger(value) && value > 0, 422, "limit_invalid", `${name} limit must be a positive safe integer`);
  }
  assert(input.limits.envelope >= Math.max(input.limits.approach, input.limits.result, input.limits.consultation), 422, "envelope_limit_invalid", "Shared envelope cannot be smaller than a category limit");
  const counters: L03AdmissionCounters = {
    envelope: { admitted: 0, limit: input.limits.envelope },
    approach: { admitted: 0, limit: input.limits.approach },
    result: { admitted: 0, limit: input.limits.result },
    consultation: { admitted: 0, limit: input.limits.consultation, activeReservations: 0 },
    correction: { admitted: 0, limit: input.limits.correction },
    unknownCostExposureRefs: [],
  };
  return {
    schemaVersion: 1,
    version: 1,
    companyId: input.companyId,
    missionId: input.missionId,
    missionVersion: input.expectedMissionVersion,
    mandateRevision: input.mandateRevision,
    authority: { ...facts.current },
    ticket: structuredClone(input.ticket),
    phase: "awaiting_approach",
    counters,
    approaches: [],
    activeApproachId: null,
    consultationSlots: [],
    approachDirections: [],
    results: [],
    resultDecisions: [],
    openMustFixFindingIds: [],
    receiptRefs: [],
    journal: [{ action: "l03_governance_admitted", actorId: facts.actor.actorId, at: facts.now }],
  };
}

export function transitionL03(state: L03Governance, command: L03Command, facts: L03TransitionFacts): L03Governance {
  validateAuthority(state, facts, command.expectedVersion);
  if (command.type === "submit-approach") {
    requireActor(state, facts, "executor");
    assert(state.phase === "awaiting_approach" || state.phase === "approach_revision_required", 409, "phase_conflict", "Approach cannot be submitted in the current phase");
    assert(!state.approaches.some((entry) => entry.approachId === command.approach.approachId), 409, "approach_identity_reused", "Approach identity is immutable and already exists");
    requireHash(command.approach.contentHash, "approach.contentHash");
    assert(command.approach.authorAgentId === state.authority.executorAgentId, 403, "approach_author_invalid", "Approach author must be the pinned executor");
    assertCriterionRefs(state, command.approach.criterionRefs, "approach.criterionRefs");
    const prior = state.approaches.at(-1) ?? null;
    if (state.phase === "approach_revision_required") {
      assert(prior && command.approach.supersedesApproachId === prior.approachId, 422, "approach_supersession_invalid", "Revised approach must use a new identity and supersede the preceding approach");
      assert(state.openMustFixFindingIds.every((id) => command.approach.addressesFindingIds.includes(id)), 422, "must_fix_not_addressed", "Revised approach must address every mandatory finding");
      assert(state.counters.correction.admitted < state.counters.correction.limit, 409, "correction_limit_reached", "Correction limit is exhausted");
    } else {
      assert(command.approach.supersedesApproachId === null && command.approach.addressesFindingIds.length === 0, 422, "initial_approach_identity_invalid", "Initial approach cannot supersede or address a prior finding");
    }
    const approach: L03Approach = { ...structuredClone(command.approach), sequence: state.approaches.length + 1, submittedAt: facts.now };
    let counters = consumeCounter(state, "approach");
    if (state.phase === "approach_revision_required") counters = { ...counters, correction: { ...counters.correction, admitted: counters.correction.admitted + 1 } };
    return next(state, facts, { counters, approaches: [...state.approaches, approach], activeApproachId: approach.approachId, phase: "collecting_approach_opinions", openMustFixFindingIds: [] }, "approach_submitted", approach.approachId);
  }

  if (command.type === "reserve-consultation") {
    requireActor(state, facts, "council");
    assert(state.phase === "collecting_approach_opinions" && command.subjectApproachId === activeApproach(state).approachId, 409, "consultation_subject_invalid", "Consultation must target the active approach while opinions are collected");
    verifySlot(state, command.reservation);
    assert(!state.consultationSlots.some((entry) => entry.slot.slotId === command.reservation.slotId || entry.slot.reservationId === command.reservation.reservationId), 409, "reservation_identity_reused", "Slot and reservation identities must be unique");
    assert(validDate(command.reservation.expiresAt, "reservation.expiresAt") > validDate(facts.now, "now"), 422, "reservation_expired", "Reservation must expire in the future");
    let counters = consumeCounter(state, "consultation");
    counters = { ...counters, consultation: { ...counters.consultation, activeReservations: counters.consultation.activeReservations + 1 } };
    if (command.costExposure.status === "unknown") {
      assert(command.costExposure.reference.length > 0, 422, "unknown_exposure_reference_missing", "Unknown cost exposure requires a durable reference");
      counters = { ...counters, unknownCostExposureRefs: [...counters.unknownCostExposureRefs, command.costExposure.reference] };
    }
    return next(state, facts, { counters, consultationSlots: [...state.consultationSlots, { slot: structuredClone(command.reservation), subjectApproachId: command.subjectApproachId, required: command.required, reservationEventRef: command.reservationEventRef, costExposure: structuredClone(command.costExposure), admissionGrant: null, admissionGrantConsumedAt: null, observations: [], contribution: null }] }, "consultation_reserved", command.reservation.reservationId);
  }

  if (command.type === "grant-consultation-admission") {
    requireActor(state, facts, "executive-plugin");
    assert(state.phase === "collecting_approach_opinions", 409, "phase_conflict", "Consultation admission is closed");
    const index = state.consultationSlots.findIndex((entry) => entry.slot.slotId === command.request.slotId && entry.slot.reservationId === command.request.reservationId);
    assert(index >= 0, 404, "reservation_not_found", "Consultation reservation was not found");
    const entry = state.consultationSlots[index]!;
    assert(entry.subjectApproachId === activeApproach(state).approachId && entry.slot.reservationVersion === command.request.reservationVersion, 409, "reservation_stale", "Consultation reservation is stale or targets another approach");
    assert(entry.reservationEventRef === command.request.observedReservationEventId, 422, "reservation_event_mismatch", "Admission request did not observe the canonical reservation event");
    assert(canonicalSha256(entry.slot) === command.request.observedReservationHash && command.slotHash === command.request.observedReservationHash, 422, "reservation_hash_mismatch", "Admission request does not match the canonical reserved slot bytes");
    assert(!entry.contribution && !entry.admissionGrant, 409, "reservation_already_admitted", "Reservation already has an admission grant or contribution");
    assert(validDate(command.request.requestedAt, "request.requestedAt") <= validDate(facts.now, "now"), 422, "admission_request_from_future", "Admission request cannot be from the future");
    const grantLifetime = validDate(command.grantExpiresAt, "grantExpiresAt") - validDate(facts.now, "now");
    assert(grantLifetime > 0 && grantLifetime <= 60_000, 422, "grant_expiry_invalid", "Admission grant must be fresh and expire within 60 seconds");
    assert(validDate(command.grantExpiresAt, "grantExpiresAt") <= validDate(entry.slot.expiresAt, "slot.expiresAt"), 422, "grant_outlives_reservation", "Admission grant cannot outlive its reservation");
    const admissionGrant = { schemaVersion: "council-opinion-admission-grant.v1" as const, requestId: command.request.requestId, grantId: command.grantId, grantedAt: facts.now, expiresAt: command.grantExpiresAt, slot: structuredClone(entry.slot), slotHash: command.slotHash };
    const consultationSlots = state.consultationSlots.with(index, { ...entry, admissionGrant });
    return next(state, facts, { consultationSlots }, "consultation_admission_granted", command.grantId);
  }

  if (command.type === "record-consultation-observation") {
    requireActor(state, facts, "executive-plugin");
    assert(state.phase === "collecting_approach_opinions", 409, "phase_conflict", "Consultation observations are not accepted in the current phase");
    const observation = command.observation;
    const index = state.consultationSlots.findIndex((entry) => entry.slot.slotId === observation.slotId && entry.slot.reservationId === observation.reservationId);
    assert(index >= 0, 404, "reservation_not_found", "Consultation reservation was not found");
    const entry = state.consultationSlots[index]!;
    const replay = entry.observations.find((item) => item.observedEventRef === observation.observedEventRef);
    if (replay) {
      assert(canonicalSha256(replay) === canonicalSha256(observation), 409, "observation_identity_conflict", "observedEventRef was reused with different observation content");
      return state;
    }
    assert(!entry.admissionGrantConsumedAt && !entry.contribution, 409, "admission_grant_consumed", "Admission grant already reached a terminal observation");
    const grant = entry.admissionGrant;
    assert(grant && grant.requestId === observation.requestId && grant.grantId === observation.grantId, 409, "admission_grant_mismatch", "Observation does not match the persisted admission grant");
    assert(observation.missionId === state.missionId && observation.reservationVersion === entry.slot.reservationVersion, 409, "reservation_binding_mismatch", "Observation does not match the exact mission and reservation version");
    assert(observation.executiveAgentId === entry.slot.reservedExecutiveAgentId, 409, "reservation_agent_mismatch", "Observation does not match the reserved Executive agent");
    assert(observation.slotHash === canonicalSha256(entry.slot), 422, "reservation_hash_mismatch", "Observation does not match the canonical reserved slot bytes");
    assert(canonicalSha256(observation.method) === canonicalSha256(entry.slot.method), 422, "reservation_method_mismatch", "Observation method does not match the reserved method");
    assert(validDate(observation.observedAt, "observation.observedAt") <= validDate(facts.now, "now"), 422, "observation_from_future", "Observation cannot be from the future");
    if (observation.status === "completed") {
      assert(observation.opinion && observation.profile && observation.sessionId && observation.runId && observation.error === null, 422, "completed_observation_incomplete", "Completed observation requires profile, session, run and opinion with no error");
      assert(canonicalSha256(observation.profile) === canonicalSha256(entry.slot.profile), 422, "reservation_profile_mismatch", "Completed observation profile does not match the reserved packaged profile");
      validateFindings(state, observation.opinion.findings);
      assert(observation.opinion.findings.every((finding) => entry.slot.criterionRefs.includes(finding.criterionRef)), 422, "opinion_reference_out_of_scope", "Opinion finding references a criterion outside its reserved slot");
    } else {
      assert(observation.opinion === null && observation.error?.trim(), 422, "noncompleted_observation_invalid", "Failed or unknown observation must carry an error and no opinion");
    }
    const contribution = observation.status === "completed" ? {
      requestId: observation.requestId,
      grantId: observation.grantId,
      executiveAgentId: observation.executiveAgentId,
      observedEventRef: observation.observedEventRef,
      opinion: structuredClone(observation.opinion!),
      recordedAt: facts.now,
    } : null;
    const consultationSlots = state.consultationSlots.with(index, {
      ...entry,
      admissionGrantConsumedAt: facts.now,
      observations: [...entry.observations, structuredClone(observation)],
      contribution,
    });
    const requiredForApproach = consultationSlots.filter((slot) => slot.subjectApproachId === activeApproach(state).approachId && slot.required);
    const ready = requiredForApproach.length > 0 && requiredForApproach.every((slot) => slot.contribution);
    const releasesReservation = observation.status !== "outcome_unknown";
    const counters = releasesReservation
      ? { ...state.counters, consultation: { ...state.counters.consultation, activeReservations: state.counters.consultation.activeReservations - 1 } }
      : state.counters;
    return next(state, facts, { counters, consultationSlots, phase: ready ? "awaiting_approach_direction" : state.phase }, `consultation_${observation.status}`, observation.observedEventRef);
  }

  if (command.type === "record-opinion") {
    requireActor(state, facts, "executive-plugin");
    assert(state.phase === "collecting_approach_opinions", 409, "phase_conflict", "Opinions are not accepted in the current phase");
    const index = state.consultationSlots.findIndex((entry) => entry.slot.slotId === command.slotId && entry.slot.reservationId === command.reservationId);
    assert(index >= 0, 404, "reservation_not_found", "Consultation reservation was not found");
    const entry = state.consultationSlots[index]!;
    assert(entry.slot.reservationVersion === command.reservationVersion && entry.slot.reservedExecutiveAgentId === command.executiveAgentId, 409, "reservation_binding_mismatch", "Opinion does not match the exact reservation version and Executive agent");
    const grant = entry.admissionGrant;
    assert(grant && grant.requestId === command.requestId && grant.grantId === command.grantId, 409, "admission_grant_mismatch", "Opinion does not match the persisted admission grant");
    assert(!entry.admissionGrantConsumedAt && !entry.contribution, 409, "admission_grant_consumed", "Admission grant is one-shot and was already consumed");
    assert(validDate(facts.now, "now") <= validDate(grant.expiresAt, "grant.expiresAt"), 409, "admission_grant_expired", "Admission grant expired before opinion recording");
    validateFindings(state, command.opinion.findings);
    assert(command.opinion.findings.every((finding) => entry.slot.criterionRefs.includes(finding.criterionRef)), 422, "opinion_reference_out_of_scope", "Opinion finding references a criterion outside its reserved slot");
    const consultationSlots = state.consultationSlots.with(index, { ...entry, admissionGrantConsumedAt: facts.now, contribution: { requestId: command.requestId, grantId: command.grantId, executiveAgentId: command.executiveAgentId, observedEventRef: command.observedEventRef, opinion: structuredClone(command.opinion), recordedAt: facts.now } });
    const requiredForApproach = consultationSlots.filter((slot) => slot.subjectApproachId === activeApproach(state).approachId && slot.required);
    const ready = requiredForApproach.length > 0 && requiredForApproach.every((slot) => slot.contribution);
    const counters = { ...state.counters, consultation: { ...state.counters.consultation, activeReservations: state.counters.consultation.activeReservations - 1 } };
    return next(state, facts, { counters, consultationSlots, phase: ready ? "awaiting_approach_direction" : state.phase }, "opinion_recorded", command.observedEventRef);
  }

  if (command.type === "decide-approach") {
    requireActor(state, facts, "reviewer");
    assert(command.approachId === activeApproach(state).approachId, 409, "approach_subject_stale", "Direction must target the active approach");
    const required = state.consultationSlots.filter((slot) => slot.subjectApproachId === command.approachId && slot.required);
    assert(required.length > 0 && required.every((slot) => slot.contribution), 409, "required_contribution_missing", "Every required consultation slot must contribute before direction");
    assert(state.phase === "awaiting_approach_direction", 409, "phase_conflict", "Approach direction is not open in the current phase");
    assert(!state.approachDirections.some((decision) => decision.decisionId === command.decisionId), 409, "decision_identity_reused", "Decision identity is immutable and already exists");
    const findings = required.flatMap((slot) => slot.contribution?.opinion.findings ?? []);
    const knownIds = new Set(findings.map((finding) => finding.id));
    unique(command.findingIds, "direction.findingIds");
    assert(command.findingIds.every((id) => knownIds.has(id)), 422, "direction_finding_unknown", "Direction references an unknown attributed finding");
    if (command.verdict === "revise") assert(command.findingIds.some((id) => findings.find((finding) => finding.id === id)?.class === "must_fix"), 422, "revision_requires_must_fix", "Approach revision requires at least one must-fix finding");
    const decision = { decisionId: command.decisionId, approachId: command.approachId, reviewerAgentId: facts.actor.actorId, verdict: command.verdict, rationale: command.rationale, findingIds: [...command.findingIds], receiptRef: command.receiptRef, decidedAt: facts.now, executionAttempt: null, actualEffect: null };
    return next(state, facts, { approachDirections: [...state.approachDirections, decision], receiptRefs: [...state.receiptRefs, command.receiptRef], phase: "awaiting_direction_effect" }, "approach_direction_recorded", command.decisionId);
  }

  if (command.type === "claim-direction-effect") {
    requireActor(state, facts, "council");
    assert(state.phase === "awaiting_direction_effect", 409, "phase_conflict", "No approach direction is awaiting effect execution");
    const index = state.approachDirections.findIndex((decision) => decision.decisionId === command.decisionId);
    assert(index >= 0, 404, "decision_not_found", "Approach direction was not found");
    const decision = state.approachDirections[index]!;
    assert(!decision.executionAttempt && !decision.actualEffect, 409, "execution_attempt_already_claimed", "Direction effect already has an immutable execution attempt");
    assert(command.attemptId.trim().length > 0, 422, "execution_attempt_missing", "Direction effect attempt identity is required");
    const directions = state.approachDirections.with(index, { ...decision, executionAttempt: { attemptId: command.attemptId, claimedAt: facts.now } });
    return next(state, facts, { approachDirections: directions }, "direction_effect_claimed", command.attemptId);
  }

  if (command.type === "record-direction-effect") {
    requireActor(state, facts, "council");
    assert(state.phase === "awaiting_direction_effect", 409, "phase_conflict", "No approach direction is awaiting actual-effect observation");
    const index = state.approachDirections.findIndex((decision) => decision.decisionId === command.decisionId);
    assert(index >= 0, 404, "decision_not_found", "Approach direction was not found");
    const decision = state.approachDirections[index]!;
    assert(!decision.actualEffect, 409, "actual_effect_already_recorded", "Approach direction already has an actual-effect observation");
    assert(decision.executionAttempt, 409, "execution_attempt_required", "Direction effect must be claimed before the native call");
    const effect = matchingEffect(command.decisionId, facts, decision.executionAttempt.attemptId);
    const directions = state.approachDirections.with(index, { ...decision, actualEffect: effect });
    const phase = decision.verdict === "proceed" ? "executing" : decision.verdict === "revise" ? "approach_revision_required" : decision.verdict === "refuse" ? "refused" : "escalated";
    const findings = state.consultationSlots.flatMap((slot) => slot.contribution?.opinion.findings ?? []);
    const openMustFixFindingIds = decision.verdict === "revise" ? decision.findingIds.filter((id) => findings.find((finding) => finding.id === id)?.class === "must_fix") : [];
    return next(state, facts, { approachDirections: directions, receiptRefs: [...state.receiptRefs, effect.receiptRef], openMustFixFindingIds, phase }, "approach_direction_effect_confirmed", effect.observationRef);
  }

  if (command.type === "submit-result") {
    requireActor(state, facts, "executor");
    assert(state.phase === "executing" || state.phase === "result_correction_required", 409, "phase_conflict", "Result cannot be submitted in the current phase");
    validateResult(state, command.result);
    assert(!state.results.some((result) => result.resultId === command.result.resultId || result.candidateCommit === command.result.candidateCommit), 409, "result_identity_reused", "Result and candidate identities are immutable and already exist");
    const prior = state.results.at(-1) ?? null;
    if (state.phase === "result_correction_required") {
      assert(prior && command.result.supersedesResultId === prior.resultId, 422, "result_supersession_invalid", "Corrected result must supersede the preceding result");
      assert(state.openMustFixFindingIds.every((id) => command.result.addressesFindingIds.includes(id)), 422, "must_fix_not_addressed", "Corrected result must address every mandatory finding");
      assert(state.counters.correction.admitted < state.counters.correction.limit, 409, "correction_limit_reached", "Correction limit is exhausted");
    } else {
      assert(command.result.supersedesResultId === null && command.result.addressesFindingIds.length === 0, 422, "initial_result_identity_invalid", "Initial result cannot supersede or address a prior finding");
    }
    const result: L03Result = { ...structuredClone(command.result), sequence: state.results.length + 1, submittedAt: facts.now };
    let counters = consumeCounter(state, "result");
    if (state.phase === "result_correction_required") counters = { ...counters, correction: { ...counters.correction, admitted: counters.correction.admitted + 1 } };
    return next(state, facts, { counters, results: [...state.results, result], openMustFixFindingIds: [], phase: "awaiting_result_review" }, "result_submitted", result.resultId);
  }

  if (command.type === "decide-result") {
    requireActor(state, facts, "reviewer");
    assert(state.phase === "awaiting_result_review", 409, "phase_conflict", "Result review is not open");
    const result = state.results.at(-1);
    assert(result && result.resultId === command.resultId, 409, "result_subject_stale", "Decision must target the latest immutable result");
    assert(!state.resultDecisions.some((decision) => decision.decisionId === command.decisionId), 409, "decision_identity_reused", "Decision identity is immutable and already exists");
    validateFindings(state, command.findings);
    const mustFix = command.findings.filter((finding) => finding.class === "must_fix");
    assert(command.verdict !== "revise" || mustFix.length > 0, 422, "optional_findings_cannot_force_revision", "Optional findings cannot force a correction cycle");
    const decision = { decisionId: command.decisionId, resultId: command.resultId, reviewerAgentId: facts.actor.actorId, verdict: command.verdict, rationale: command.rationale, findings: structuredClone(command.findings), receiptRef: command.receiptRef, decidedAt: facts.now, actualEffect: null };
    return next(state, facts, { resultDecisions: [...state.resultDecisions, decision], receiptRefs: [...state.receiptRefs, command.receiptRef], phase: "awaiting_result_effect" }, "result_decision_recorded", command.decisionId);
  }

  requireActor(state, facts, "council");
  assert(command.type === "record-result-effect" && state.phase === "awaiting_result_effect", 409, "phase_conflict", "No result decision is awaiting actual-effect observation");
  const index = state.resultDecisions.findIndex((decision) => decision.decisionId === command.decisionId);
  assert(index >= 0, 404, "decision_not_found", "Result decision was not found");
  const decision = state.resultDecisions[index]!;
  assert(!decision.actualEffect, 409, "actual_effect_already_recorded", "Result decision already has an actual-effect observation");
  const effect = matchingEffect(command.decisionId, facts);
  const decisions = state.resultDecisions.with(index, { ...decision, actualEffect: effect });
  let phase: L03Governance["phase"];
  let openMustFixFindingIds: string[] = [];
  if (decision.verdict === "accept") phase = "accepted";
  else if (decision.verdict === "refuse") phase = "refused";
  else if (decision.verdict === "escalate") phase = "escalated";
  else {
    openMustFixFindingIds = decision.findings.filter((finding) => finding.class === "must_fix").map((finding) => finding.id);
    phase = state.counters.correction.admitted >= state.counters.correction.limit ? "limit_exhausted" : "result_correction_required";
  }
  return next(state, facts, { resultDecisions: decisions, receiptRefs: [...state.receiptRefs, effect.receiptRef], openMustFixFindingIds, phase }, "result_decision_effect_confirmed", effect.observationRef);
}

