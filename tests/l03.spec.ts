import { describe, expect, it } from "vitest";
import { canonicalSha256, initialL03Governance, transitionL03 } from "../src/l03.js";
import type {
  L03Actor,
  L03AuthoritySnapshot,
  L03Governance,
  L03TransitionFacts,
  ReservedConsultationSlot,
} from "../src/l03-types.js";

const H = "a".repeat(64);
const H2 = "b".repeat(64);
const GIT_OID = "c".repeat(40);
const now = "2026-09-30T12:00:00.000Z";

const current: L03AuthoritySnapshot = {
  companyId: "company-1",
  missionId: "mission-1",
  missionVersion: 3,
  mandateRevision: 3,
  ownerUserId: "owner-1",
  executorAgentId: "executor-1",
  finalReviewerAgentId: "reviewer-1",
  councilAgentId: "reviewer-1",
  executivePluginActorId: "private.paperclip-executive",
  expiresAt: "2026-10-01T12:00:00.000Z",
};

const actors = {
  owner: { actorType: "user", actorId: "owner-1", userId: "owner-1", companyId: current.companyId },
  executor: { actorType: "agent", actorId: current.executorAgentId, companyId: current.companyId },
  reviewer: { actorType: "agent", actorId: current.finalReviewerAgentId, companyId: current.companyId },
  council: { actorType: "agent", actorId: current.councilAgentId, companyId: current.companyId },
  executive: { actorType: "plugin", actorId: current.executivePluginActorId, companyId: current.companyId },
} satisfies Record<string, L03Actor>;

function facts(actor: L03Actor, overrides: Partial<L03TransitionFacts> = {}): L03TransitionFacts {
  return { now, actor, current, ...overrides };
}

function initial(): L03Governance {
  return initialL03Governance({
    companyId: current.companyId,
    missionId: current.missionId,
    expectedMissionVersion: current.missionVersion,
    mandateRevision: current.mandateRevision,
    executorAgentId: current.executorAgentId,
    finalReviewerAgentId: current.finalReviewerAgentId,
    councilAgentId: current.councilAgentId,
    executivePluginActorId: current.executivePluginActorId,
    expiresAt: current.expiresAt,
    ticket: {
      issueId: "issue-root",
      sourceRef: "linear:ETY-3@42",
      sourceVersion: "42",
      sourceHash: H,
      suppliedContext: { sourceRef: "attachment:context", sourceHash: H2, content: "Bounded supplied context" },
      criteria: [{ id: "criterion-1", text: "The exact result is verified" }, { id: "criterion-2", text: "The correction is bounded" }],
      exclusions: ["live activation"],
    },
    limits: { envelope: 12, approach: 3, result: 3, consultation: 4, correction: 2 },
  }, facts(actors.owner), ["architecture"]);
}

function submitApproach(state: L03Governance, input: Partial<{
  approachId: string;
  supersedesApproachId: string | null;
  addressesFindingIds: string[];
}> = {}) {
  return transitionL03(state, {
    type: "submit-approach",
    expectedVersion: state.version,
    approach: {
      approachId: input.approachId ?? "approach-1",
      authorAgentId: current.executorAgentId,
      contentRef: "document:approach",
      contentHash: H,
      criterionRefs: ["criterion-1", "criterion-2"],
      evidenceRefs: ["evidence:plan"],
      supersedesApproachId: input.supersedesApproachId ?? null,
      addressesFindingIds: input.addressesFindingIds ?? [],
    },
  }, facts(actors.executor));
}

function reservedSlot(state: L03Governance): ReservedConsultationSlot {
  return {
    companyId: state.companyId,
    missionId: state.missionId,
    missionVersion: state.missionVersion,
    mandateRevision: state.mandateRevision,
    slotId: "slot-1",
    reservationId: "reservation-1",
    reservationVersion: 1,
    status: "reserved",
    reservedExecutiveAgentId: "executive-advisor-1",
    profile: { id: "architecture", version: "2026-09-30", sourceHash: H },
    method: { id: "paperclip-executive.council-reserved-opinion", version: "1.0.0" },
    criterionRefs: ["criterion-1", "criterion-2"],
    evidenceRefs: ["evidence:plan"],
    context: { sourceRef: "document:approach", sourceHash: H, content: "Review this bounded approach" },
    expiresAt: "2026-09-30T12:10:00.000Z",
  };
}

function reserve(state: L03Governance) {
  const slot = reservedSlot(state);
  return transitionL03(state, {
    type: "reserve-consultation",
    expectedVersion: state.version,
    subjectApproachId: state.activeApproachId!,
    reservation: slot,
    required: true,
    reservationEventRef: "event:reservation-1",
    costExposure: { status: "unknown", reference: "exposure:reservation-1" },
  }, facts(actors.council));
}

function contribute(
  state: L03Governance,
  findingEvidenceRefs = ["evidence:plan"],
  recommendation: "proceed" | "revise" | "refuse" | "escalate" = "proceed",
) {
  const slot = state.consultationSlots[0]!.slot;
  const request = {
    schemaVersion: "council-opinion-admission-request.v1" as const,
    requestId: "request-1",
    reservationId: slot.reservationId,
    missionId: slot.missionId,
    slotId: slot.slotId,
    reservationVersion: slot.reservationVersion,
    observedReservationEventId: "event:reservation-1",
    observedReservationHash: canonicalSha256(slot),
    requestedAt: now,
  };
  const granted = transitionL03(state, {
    type: "grant-consultation-admission",
    expectedVersion: state.version,
    request,
    grantId: "grant-1",
    grantExpiresAt: "2026-09-30T12:00:45.000Z",
    slotHash: canonicalSha256(slot),
  }, facts(actors.executive));
  return transitionL03(granted, {
    type: "record-consultation-observation",
    expectedVersion: granted.version,
    observation: {
      schemaVersion: "council-reserved-opinion-observed.v1",
      observedEventRef: "event:opinion-1",
      observedAt: now,
      requestId: request.requestId,
      grantId: "grant-1",
      reservationId: slot.reservationId,
      reservationVersion: slot.reservationVersion,
      missionId: slot.missionId,
      slotId: slot.slotId,
      slotHash: canonicalSha256(slot),
      executiveAgentId: slot.reservedExecutiveAgentId,
      profile: { ...slot.profile, instructionsSource: "package:profiles/architecture", catalogVersion: "1", loadedProfileProof: "not_observed" },
      method: slot.method,
      sessionId: "session-1",
      runId: "run-1",
      status: "completed",
      opinion: {
        schemaVersion: "council-reserved-opinion.v1",
        recommendation,
        summary: "The approach is bounded but one result condition is mandatory.",
        findings: [{ id: "finding-approach-1", class: "must_fix", criterionRef: "criterion-2", evidenceRefs: findingEvidenceRefs, reasons: ["Correction behavior needs an explicit bound."], smallestUsefulAction: "Add the correction stop condition." }],
        limitations: ["No runtime execution observed"],
        dissent: ["One advisor would prefer a smaller artifact set"],
      },
      error: null,
    },
  }, facts(actors.executive));
}

function proceedToExecution(): L03Governance {
  let state = contribute(reserve(submitApproach(initial())));
  state = transitionL03(state, {
    type: "decide-approach",
    expectedVersion: state.version,
    decisionId: "direction-1",
    approachId: state.activeApproachId!,
    verdict: "proceed",
    rationale: "Evidence is sufficient to start bounded execution.",
    findingIds: [],
    receiptRef: "receipt:direction-1",
  }, facts(actors.reviewer));
  state = transitionL03(state, { type: "claim-direction-effect", expectedVersion: state.version, decisionId: "direction-1", attemptId: "attempt-1" }, facts(actors.council));
  return transitionL03(state, { type: "record-direction-effect", expectedVersion: state.version, decisionId: "direction-1" }, facts(actors.council, {
    actualEffectObservation: { decisionId: "direction-1", attemptId: "attempt-1", status: "confirmed", observationRef: "observation:direction-1", receiptRef: "receipt:direction-effect-1", observedAt: now },
  }));
}

function resultInput(resultId: string, candidateCommit: string, overrides: Partial<{ supersedesResultId: string | null; addressesFindingIds: string[] }> = {}) {
  const attachmentId = `attachment-${resultId}`;
  const verifiedEvidenceRef = `attachment:${attachmentId}#sha256:${candidateCommit}`;
  const artifacts = [{ ref: verifiedEvidenceRef, sha256: candidateCommit, byteVerificationRef: verifiedEvidenceRef }];
  return {
    resultId,
    authorAgentId: current.executorAgentId,
    rootIssueId: "issue-root",
    segmentIssueId: "issue-segment",
    repository: "ty000/example",
    baseCommit: GIT_OID,
    candidateCommit,
    attachmentId,
    sha256: candidateCommit,
    artifactSetHash: canonicalSha256(artifacts),
    artifacts,
    evidenceRefs: [verifiedEvidenceRef],
    criterionRefs: ["criterion-1", "criterion-2"],
    supersedesResultId: overrides.supersedesResultId ?? null,
    addressesFindingIds: overrides.addressesFindingIds ?? [],
  };
}

describe("L03 governed aggregate", () => {
  it("binds immutable ticket, authority, expiry and distinct reviewer at admission", () => {
    const state = initial();
    expect(state).toMatchObject({ version: 1, missionVersion: 3, mandateRevision: 3, phase: "awaiting_approach" });
    expect(state.ticket.criteria).toEqual([{ id: "criterion-1", text: "The exact result is verified" }, { id: "criterion-2", text: "The correction is bounded" }]);
    expect(() => initialL03Governance({
      companyId: current.companyId,
      missionId: current.missionId,
      expectedMissionVersion: 3,
      mandateRevision: 3,
      executorAgentId: current.executorAgentId,
      finalReviewerAgentId: current.executorAgentId,
      councilAgentId: current.councilAgentId,
      executivePluginActorId: current.executivePluginActorId,
      expiresAt: current.expiresAt,
      ticket: state.ticket,
      limits: { envelope: 4, approach: 1, result: 1, consultation: 1, correction: 1 },
    }, facts(actors.owner))).toThrowError(expect.objectContaining({ code: "pinned_roles_changed" }));
  });

  it("uses canonical slot hashes, a <=60s one-shot grant, and preserves dissent and unknown exposure", () => {
    let state = reserve(submitApproach(initial()));
    const slot = state.consultationSlots[0]!.slot;
    expect(canonicalSha256({ b: 1, a: [2, 3] })).toBe(canonicalSha256({ a: [2, 3], b: 1 }));
    expect(state.counters).toMatchObject({ envelope: { admitted: 2 }, consultation: { admitted: 1, activeReservations: 1 }, unknownCostExposureRefs: ["exposure:reservation-1"] });
    expect(() => transitionL03(state, {
      type: "grant-consultation-admission",
      expectedVersion: state.version,
      request: { schemaVersion: "council-opinion-admission-request.v1", requestId: "bad", reservationId: slot.reservationId, missionId: slot.missionId, slotId: slot.slotId, reservationVersion: 1, observedReservationEventId: "event:reservation-1", observedReservationHash: canonicalSha256(slot), requestedAt: now },
      grantId: "bad-grant",
      grantExpiresAt: "2026-09-30T12:01:01.000Z",
      slotHash: canonicalSha256(slot),
    }, facts(actors.executive))).toThrowError(expect.objectContaining({ code: "grant_expiry_invalid" }));
    state = contribute(state);
    expect(state.phase).toBe("awaiting_approach_direction");
    expect(state.consultationSlots[0]!.contribution?.opinion.dissent).toEqual(["One advisor would prefer a smaller artifact set"]);
    expect(state.consultationSlots[0]!.admissionGrantConsumedAt).toBe(now);
    expect(state.counters.consultation.activeReservations).toBe(0);
    expect(state.counters.unknownCostExposureRefs).toEqual(["exposure:reservation-1"]);
  });

  it("keeps approach direction closed until every pinned required perspective contributes", () => {
    let state = initial();
    state = { ...state, requiredPerspectives: ["architecture", "quality"] };
    state = contribute(reserve(submitApproach(state)));
    expect(state.phase).toBe("collecting_approach_opinions");
    expect(() => transitionL03({ ...state, phase: "awaiting_approach_direction" }, {
      type: "decide-approach",
      expectedVersion: state.version,
      decisionId: "direction-with-missing-perspective",
      approachId: state.activeApproachId!,
      verdict: "proceed",
      rationale: "Incomplete perspective coverage",
      findingIds: [],
      receiptRef: "receipt:missing-perspective",
    }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "required_perspective_missing" }));
  });

  it("persists outcome_unknown without satisfying the slot and replays the stable event idempotently", () => {
    let state = reserve(submitApproach(initial()));
    const slot = state.consultationSlots[0]!.slot;
    const request = {
      schemaVersion: "council-opinion-admission-request.v1" as const,
      requestId: "request-unknown",
      reservationId: slot.reservationId,
      missionId: slot.missionId,
      slotId: slot.slotId,
      reservationVersion: slot.reservationVersion,
      observedReservationEventId: "host:event:opaque",
      observedReservationHash: canonicalSha256(slot),
      requestedAt: now,
    };
    state = transitionL03(state, { type: "grant-consultation-admission", expectedVersion: state.version, request, grantId: "grant-unknown", grantExpiresAt: "2026-09-30T12:00:45.000Z", slotHash: canonicalSha256(slot) }, facts(actors.executive));
    const granted = state;
    expect(transitionL03(state, { type: "grant-consultation-admission", expectedVersion: state.version, request, grantId: "ignored-new-id", grantExpiresAt: "2026-09-30T12:00:50.000Z", slotHash: canonicalSha256(slot) }, facts(actors.executive))).toBe(granted);
    const observation = {
      schemaVersion: "council-reserved-opinion-observed.v1" as const,
      observedEventRef: "event:unknown-1",
      observedAt: now,
      requestId: request.requestId,
      grantId: "grant-unknown",
      reservationId: slot.reservationId,
      reservationVersion: slot.reservationVersion,
      missionId: slot.missionId,
      slotId: slot.slotId,
      slotHash: canonicalSha256(slot),
      executiveAgentId: slot.reservedExecutiveAgentId,
      profile: null,
      method: slot.method,
      sessionId: "session-unknown",
      runId: "run-unknown",
      status: "outcome_unknown" as const,
      opinion: null,
      error: "Provider response was lost after dispatch",
    };
    state = transitionL03(state, { type: "record-consultation-observation", expectedVersion: state.version, observation }, facts(actors.executive));
    expect(state.phase).toBe("collecting_approach_opinions");
    expect(state.consultationSlots[0]).toMatchObject({ contribution: null, admissionGrantConsumedAt: now, observations: [{ status: "outcome_unknown", error: observation.error }] });
    expect(state.counters.consultation.activeReservations).toBe(1);
    expect(transitionL03(state, { type: "record-consultation-observation", expectedVersion: state.version, observation }, facts(actors.executive))).toBe(state);
    expect(() => transitionL03(state, { type: "record-consultation-observation", expectedVersion: state.version, observation: { ...observation, error: "Different payload" } }, facts(actors.executive))).toThrowError(expect.objectContaining({ code: "observation_identity_conflict" }));
  });

  it("refuses direction while a required contribution is missing", () => {
    const state = reserve(submitApproach(initial()));
    expect(() => transitionL03(state, {
      type: "decide-approach",
      expectedVersion: state.version,
      decisionId: "direction-too-early",
      approachId: state.activeApproachId!,
      verdict: "proceed",
      rationale: "Too early",
      findingIds: [],
      receiptRef: "receipt:early",
    }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "required_contribution_missing" }));
  });

  it("rejects consultation evidence outside the exact active approach", () => {
    const state = submitApproach(initial());
    const slot = reservedSlot(state);
    expect(() => transitionL03(state, {
      type: "reserve-consultation",
      expectedVersion: state.version,
      subjectApproachId: state.activeApproachId!,
      reservation: { ...slot, evidenceRefs: ["evidence:outside"] },
      required: true,
      reservationEventRef: "event:outside",
      costExposure: { status: "known", reference: "cost:known" },
    }, facts(actors.council))).toThrowError(expect.objectContaining({ code: "evidence_reference_out_of_scope" }));
    expect(() => contribute(reserve(state), ["evidence:outside"])).toThrowError(expect.objectContaining({ code: "evidence_reference_out_of_scope" }));
  });

  it("requires one immutable direction attempt and a matching actual effect before execution", () => {
    let state = contribute(reserve(submitApproach(initial())));
    state = transitionL03(state, { type: "decide-approach", expectedVersion: state.version, decisionId: "direction-1", approachId: state.activeApproachId!, verdict: "proceed", rationale: "Proceed", findingIds: [], receiptRef: "receipt:direction-1" }, facts(actors.reviewer));
    state = transitionL03(state, { type: "claim-direction-effect", expectedVersion: state.version, decisionId: "direction-1", attemptId: "attempt-1" }, facts(actors.council));
    expect(state.phase).toBe("awaiting_direction_effect");
    expect(() => transitionL03(state, { type: "claim-direction-effect", expectedVersion: state.version, decisionId: "direction-1", attemptId: "attempt-2" }, facts(actors.council))).toThrowError(expect.objectContaining({ code: "execution_attempt_already_claimed" }));
    expect(() => transitionL03(state, { type: "record-direction-effect", expectedVersion: state.version, decisionId: "direction-1" }, facts(actors.council))).toThrowError(expect.objectContaining({ code: "actual_effect_required" }));
    expect(() => transitionL03(state, { type: "record-direction-effect", expectedVersion: state.version, decisionId: "direction-1" }, facts(actors.council, { actualEffectObservation: { decisionId: "direction-1", attemptId: "attempt-2", status: "confirmed", observationRef: "observation:x", receiptRef: "receipt:x", observedAt: now } }))).toThrowError(expect.objectContaining({ code: "execution_attempt_mismatch" }));
    expect(() => transitionL03(state, { type: "acknowledge-uncertainty", expectedVersion: state.version, reference: "attempt-1", disposition: "acknowledge", note: "Investigate without resending." }, facts(actors.executor))).toThrowError(expect.objectContaining({ code: "actor_not_authorized" }));
    const acknowledged = transitionL03(state, { type: "acknowledge-uncertainty", expectedVersion: state.version, reference: "attempt-1", disposition: "abandon", note: "Operator abandons this uncertain attempt without replacement." }, facts(actors.owner, { now: "2026-10-02T00:00:00.000Z" }));
    expect(acknowledged.phase).toBe("awaiting_direction_effect");
    expect(acknowledged.approachDirections.at(-1)?.actualEffect).toBeNull();
    expect(acknowledged.uncertaintyAcknowledgements).toEqual([expect.objectContaining({ reference: "attempt-1", disposition: "abandon", actorUserId: "owner-1" })]);
  });

  it("creates a fresh approach identity after revise and never carries the old direction", () => {
    let state = contribute(reserve(submitApproach(initial())));
    state = transitionL03(state, { type: "decide-approach", expectedVersion: state.version, decisionId: "direction-revise", approachId: "approach-1", verdict: "revise", rationale: "Bound the correction", findingIds: ["finding-approach-1"], receiptRef: "receipt:revise" }, facts(actors.reviewer));
    expect(state.phase).toBe("approach_revision_required");
    expect(() => submitApproach(state, { approachId: "approach-1", supersedesApproachId: "approach-1", addressesFindingIds: ["finding-approach-1"] })).toThrowError(expect.objectContaining({ code: "approach_identity_reused" }));
    state = submitApproach(state, { approachId: "approach-2", supersedesApproachId: "approach-1", addressesFindingIds: ["finding-approach-1"] });
    expect(state.activeApproachId).toBe("approach-2");
    expect(state.approaches[1]).toMatchObject({ sequence: 2, supersedesApproachId: "approach-1" });
    expect(state.approachDirections).toHaveLength(1);
    expect(state.counters.correction.admitted).toBe(1);
  });

  it("binds exact immutable result bytes and enforces targeted V1 to V2 correction with fresh review", () => {
    let state = proceedToExecution();
    state = transitionL03(state, { type: "submit-result", expectedVersion: state.version, result: resultInput("result-v1", H) }, facts(actors.executor));
    expect(state.results[0]).toMatchObject({ rootIssueId: "issue-root", segmentIssueId: "issue-segment", repository: "ty000/example", baseCommit: GIT_OID, candidateCommit: H, attachmentId: "attachment-result-v1", sha256: H });
    const mustFix = { id: "result-gap-1", class: "must_fix" as const, criterionRef: "criterion-1", evidenceRefs: [`attachment:attachment-result-v1#sha256:${H}`], reasons: ["Verified bytes do not satisfy the criterion."], smallestUsefulAction: "Correct the affected artifact only." };
    expect(() => transitionL03(state, { type: "decide-result", expectedVersion: state.version, decisionId: "bad-evidence", resultId: "result-v1", verdict: "revise", rationale: "Out of scope", findings: [{ ...mustFix, evidenceRefs: [`attachment:other#sha256:${H}`] }], receiptRef: "receipt:bad-evidence" }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "evidence_reference_out_of_scope" }));
    state = transitionL03(state, { type: "decide-result", expectedVersion: state.version, decisionId: "result-decision-v1", resultId: "result-v1", verdict: "revise", rationale: "Targeted correction required", findings: [mustFix], receiptRef: "receipt:result-v1" }, facts(actors.reviewer));
    expect(state.phase).toBe("awaiting_result_effect");
    // Capacity is already reserved before the native correction wake, including an unknown outcome.
    expect(state.counters).toMatchObject({ result: { admitted: 2 }, correction: { admitted: 1 } });
    state = transitionL03(state, { type: "record-result-effect", expectedVersion: state.version, decisionId: "result-decision-v1" }, facts(actors.council, { actualEffectObservation: { decisionId: "result-decision-v1", status: "confirmed", observationRef: "observation:result-v1", receiptRef: "receipt:result-v1-effect", observedAt: now } }));
    expect(state.phase).toBe("result_correction_required");
    expect(() => transitionL03(state, { type: "submit-result", expectedVersion: state.version, result: resultInput("result-v2", H2, { supersedesResultId: "result-v1" }) }, facts(actors.executor))).toThrowError(expect.objectContaining({ code: "must_fix_not_addressed" }));
    state = transitionL03(state, { type: "submit-result", expectedVersion: state.version, result: resultInput("result-v2", H2, { supersedesResultId: "result-v1", addressesFindingIds: ["result-gap-1"] }) }, facts(actors.executor));
    expect(state.results[1]).toMatchObject({ sequence: 2, supersedesResultId: "result-v1", candidateCommit: H2 });
    const exhausted = { ...state, counters: { ...state.counters, correction: { ...state.counters.correction, limit: 1 } } };
    expect(() => transitionL03(exhausted, { type: "decide-result", expectedVersion: exhausted.version, decisionId: "forbidden-correction-2", resultId: "result-v2", verdict: "revise", rationale: "Would wake an unauthorized second correction", findings: [{ ...mustFix, evidenceRefs: state.results.at(-1)!.evidenceRefs }], receiptRef: "receipt:forbidden-2" }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "correction_limit_reached" }));
    expect(exhausted.counters.correction.admitted).toBe(1);
    const optional = { id: "optional-1", class: "defer" as const, criterionRef: "criterion-2", evidenceRefs: [], reasons: ["Useful later."], smallestUsefulAction: "Track separately." };
    expect(() => transitionL03(state, { type: "decide-result", expectedVersion: state.version, decisionId: "bad-optional-revise", resultId: "result-v2", verdict: "revise", rationale: "Optional only", findings: [optional], receiptRef: "receipt:bad" }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "optional_findings_cannot_force_revision" }));
    state = transitionL03(state, { type: "decide-result", expectedVersion: state.version, decisionId: "result-decision-v2", resultId: "result-v2", verdict: "accept", rationale: "All mandatory criteria now pass", findings: [optional], receiptRef: "receipt:result-v2" }, facts(actors.reviewer));
    state = transitionL03(state, { type: "record-result-effect", expectedVersion: state.version, decisionId: "result-decision-v2" }, facts(actors.council, { actualEffectObservation: { decisionId: "result-decision-v2", status: "confirmed", observationRef: "observation:result-v2", receiptRef: "receipt:result-v2-effect", observedAt: now } }));
    expect(state.phase).toBe("accepted");
    expect(state.resultDecisions).toHaveLength(2);
    expect(state.counters).toMatchObject({ result: { admitted: 2 }, correction: { admitted: 1 } });
  });

  it("makes result refusal terminal without fabricating a native effect", () => {
    let state = proceedToExecution();
    state = transitionL03(state, { type: "submit-result", expectedVersion: state.version, result: resultInput("result-refused", H) }, facts(actors.executor));
    expect(() => transitionL03({ ...state, receiptRefs: [...state.receiptRefs, "receipt:refused"] }, { type: "decide-result", expectedVersion: state.version, decisionId: "decision-reused-receipt", resultId: "result-refused", verdict: "refuse", rationale: "Duplicate operation", findings: [], receiptRef: "receipt:refused" }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "receipt_reference_reused" }));
    state = transitionL03(state, { type: "decide-result", expectedVersion: state.version, decisionId: "decision-refused", resultId: "result-refused", verdict: "refuse", rationale: "Result is outside the mandate", findings: [], receiptRef: "receipt:refused" }, facts(actors.reviewer));
    expect(state.phase).toBe("refused");
    expect(state.resultDecisions.at(-1)?.actualEffect).toBeNull();
  });

  it("rejects every mutation after authority drift, expiry or stale aggregate version", () => {
    const state = initial();
    expect(() => transitionL03({ ...state, version: 2 }, { type: "submit-approach", expectedVersion: 1, approach: { approachId: "a", authorAgentId: current.executorAgentId, contentRef: "x", contentHash: H, criterionRefs: ["criterion-1"], evidenceRefs: [], supersedesApproachId: null, addressesFindingIds: [] } }, facts(actors.executor))).toThrowError(expect.objectContaining({ code: "version_conflict" }));
    expect(() => transitionL03(state, { type: "submit-approach", expectedVersion: 1, approach: { approachId: "a", authorAgentId: current.executorAgentId, contentRef: "x", contentHash: H, criterionRefs: ["criterion-1"], evidenceRefs: [], supersedesApproachId: null, addressesFindingIds: [] } }, facts(actors.executor, { current: { ...current, mandateRevision: 4 } }))).toThrowError(expect.objectContaining({ code: "mandate_changed" }));
    expect(() => transitionL03(state, { type: "submit-approach", expectedVersion: 1, approach: { approachId: "a", authorAgentId: current.executorAgentId, contentRef: "x", contentHash: H, criterionRefs: ["criterion-1"], evidenceRefs: [], supersedesApproachId: null, addressesFindingIds: [] } }, facts(actors.executor, { now: "2026-10-02T00:00:00.000Z" }))).toThrowError(expect.objectContaining({ code: "mandate_expired" }));
  });

  it("rejects runtime-invalid command and decision enums before persistence", () => {
    const state = initial();
    expect(() => transitionL03(state, { type: "invented-command", expectedVersion: state.version } as never, facts(actors.owner)))
      .toThrowError(expect.objectContaining({ code: "command_type_invalid" }));

    const collecting = reserve(submitApproach(state));
    expect(() => contribute(collecting, ["evidence:plan"], "invalid" as never))
      .toThrowError(expect.objectContaining({ code: "opinion_recommendation_invalid" }));

    const awaitingDirection = contribute(collecting);
    expect(() => transitionL03(awaitingDirection, {
      type: "decide-approach",
      expectedVersion: awaitingDirection.version,
      decisionId: "bad-direction",
      approachId: awaitingDirection.activeApproachId!,
      verdict: "invalid" as never,
      rationale: "Invalid runtime union",
      findingIds: [],
      receiptRef: "receipt:bad-direction",
    }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "direction_verdict_invalid" }));

    let awaitingResult = proceedToExecution();
    awaitingResult = transitionL03(awaitingResult, { type: "submit-result", expectedVersion: awaitingResult.version, result: resultInput("runtime-invalid", H) }, facts(actors.executor));
    const evidenceRef = awaitingResult.results.at(-1)!.evidenceRefs[0]!;
    expect(() => transitionL03(awaitingResult, {
      type: "decide-result",
      expectedVersion: awaitingResult.version,
      decisionId: "bad-result",
      resultId: "runtime-invalid",
      verdict: "accept",
      rationale: "Invalid finding class",
      findings: [{ id: "bad-finding", class: "invalid" as never, criterionRef: "criterion-1", evidenceRefs: [evidenceRef], reasons: ["Bad enum"], smallestUsefulAction: "Reject it" }],
      receiptRef: "receipt:bad-result",
    }, facts(actors.reviewer))).toThrowError(expect.objectContaining({ code: "finding_class_invalid" }));
  });
});

