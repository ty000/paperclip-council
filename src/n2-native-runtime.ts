import { inspectN3, n3Round } from "./n3-state.js";
import { assertN3Decision, attestN3Transmission, bindN3Transmission, freshN3Round, prepareN3Collection, reconcileN3, selectN3, synthesizeN3 } from "./n3-runtime.js";
import type { N3OpinionSlot } from "./n3-opinions.js";
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import type { CouncilDecisionInput, NativeReviewBinding } from "./contracts.js";
import { parseCouncilConfig } from "./decision-adapter.js";
import { executeCouncilDecision, recordCouncilNativeReadback } from "./decision-receipts.js";
import { readNativeRun, readNativeSequentialUsageBaseline, settleNativeExactRunUsage } from "./g4-native.js";
import { verifyIntegratedCandidate } from "./integration.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import {
  inspectN2State, n2Cas, n2CommandCas, n2SubmissionResultReference, nativeN2Profile, prepareN2Decision,
  prepareResubmissionCommand, recordN2Decision, reserveN2Run, runtimeReceipt,
  runtimeUuid, startN2Review, startN2ResubmittedReview, storedN2,
} from "./n2-missions.js";

export type N2NativeRuntime = {
  profile: "paperclip_runner-experimental";
  reviewProtocol?: "native-verdict-readback-v1";
  reviewPackets?: import("./n2-native-report.js").NativeReviewPacketRecord[];
  correctionOwnerAction?: "restore_wake_policy" | "wake_claimed";
  transmission: { reservationId: string; runId: string | null; settlementCommandId: string; attestedAt?: string; settledAt?: string };
  reviewCards: Array<NativeReviewBinding & { round: number; settlementCommandId: string }>;
  correctionSettlementCommandId: string;
  blockerIssueId?: string;
  releaseState?: "claimed" | "released";
};

function requireNative(mission: MissionRecord): N2NativeRuntime {
  const native = storedN2(mission).native;
  if (!native) throw new MissionError(409, "native_n2_required", "Experimental native N2 state required");
  return native;
}
async function fresh(ctx: PluginContext, mission: MissionRecord) {
  const found = await getMission(ctx, mission.companyId, mission.missionId);
  if (!found) throw new Error("N2 mission disappeared");
  return found;
}
function identity(mission: MissionRecord, input: PluginApiRequestInput, agentId: string) {
  if (input.actor.actorType !== "agent" || input.actor.agentId !== agentId || !input.actor.runId) {
    throw new MissionError(403, "native_n2_actor_required", "Pinned native N2 actor and active run required");
  }
  return { companyId: mission.companyId, issueId: mission.rootIssueId, agentId, runId: input.actor.runId };
}
async function bindLead(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput) {
  const who = identity(mission, input, mission.aggregate.responsibilities.integrationLeadAgentId);
  const run = await readNativeRun(ctx, who);
  if (run.status !== "running" || !run.startedAt || run.finishedAt) throw new MissionError(409, "native_run_not_running", "Lead run must be running");
  const state = storedN2(mission);
  const native = requireNative(mission);
  const transmission = !native.transmission.attestedAt;
  const bound = transmission ? native.transmission.runId : state.correction?.runId;
  if (bound && bound !== who.runId) throw new MissionError(409, "native_run_binding_mismatch", "Lead run differs from the reserved execution");
  if (!transmission && (state.status !== "correction_requested" && state.status !== "correcting" && state.status !== "resubmission_prepared"
      || native.releaseState !== "released" && native.releaseState !== "claimed")) {
    throw new MissionError(409, "correction_not_released", "Correction was not admitted after reviewer settlement");
  }
  if (bound) return mission;
  return n2Cas(ctx, mission, { ...mission.aggregate, n2: transmission
    ? { ...state, native: { ...native, transmission: { ...native.transmission, runId: who.runId } } }
    : { ...state, status: "correcting", correction: { ...state.correction!, runId: who.runId, wakeState: "requested" } } });
}

export async function executeNativeN2Board(ctx: PluginContext, mission: MissionRecord, input: {
  actorUserId: string | null; body: Record<string, unknown>;
}) {
  const body = input.body;
  if (body.command === "release-native-correction") return releaseNativeCorrection(ctx, mission, input);
  if (body.command === "reconcile-native-n2") {
    await reconcileNativeN2(ctx, mission);
    return { outcome: "reconciled", mission: await fresh(ctx, mission) };
  }
  if (body.command !== "start-review") throw new MissionError(400, "native_n2_command", "Native N2 supports start-review and reconcile-native-n2 owner commands");
  const commandId = runtimeUuid(body.commandId, "commandId");
  const prior = runtimeReceipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission, receipt: prior };
  if (mission.version !== body.expectedVersion || mission.aggregate.n2) throw new MissionError(409, "native_n2_start_conflict", "Fresh ready-for-review mission version required");
  const lead = mission.aggregate.responsibilities.integrationLeadAgentId;
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  for (const agentId of [lead, reviewer]) {
    const agent = await ctx.agents.get(agentId, mission.companyId);
    if (agent?.adapterType !== "paperclip_runner") throw new MissionError(422, "native_runner_profile_required", "Both N2 lead and reviewer require the explicit paperclip_runner experimental profile");
  }
  const issue = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  if (issue?.status !== "in_progress" || issue.assigneeAgentId !== lead) throw new MissionError(409, "native_transmission_entry", "Existing N1 root must be in progress under its integration lead");
  const baseline = await readNativeSequentialUsageBaseline(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId });
  const submissionId = runtimeUuid(body.submissionId, "submissionId");
  const reservationId = runtimeUuid(body.reservationId, "reservationId");
  const transmissionReservationId = runtimeUuid(body.transmissionReservationId, "transmissionReservationId");
  const state = startN2Review(mission, { baselineRunIds: baseline.runIds, baselineTokenTotal: baseline.tokenTotal, submissionId, reservationId });
  const n3 = body.n3Slots ? await selectN3(ctx, mission, state.submissions[0]!, body.n3Slots as N3OpinionSlot[]) : undefined;
  await reserveN2Run(ctx, mission, { reservationId: transmissionReservationId, effectId: transmissionReservationId, kind: "initial" });
  if (!n3) await reserveN2Run(ctx, mission, { reservationId, effectId: submissionId, kind: "initial" });
  state.native = { profile: "paperclip_runner-experimental", reviewProtocol: "native-verdict-readback-v1", reviewPackets: [], transmission: { reservationId: transmissionReservationId, runId: null,
    settlementCommandId: randomUUID() }, reviewCards: [], correctionSettlementCommandId: randomUUID() };
  const claim = await n2CommandCas(ctx, mission, body, "user", input.actorUserId!, {
    ...mission.aggregate, phase: "review_handoff", control: { status: "active" }, n2: state, ...(n3 ? { n3 } : {}),
    journal: [...mission.aggregate.journal, { action: "n2_native_transmission_admitted", commandId, submissionId, transmissionReservationId, reviewerReservationId: reservationId }],
  });
  // The durable command owns this single wake. Ambiguous responses are retained;
  // replay never emits a replacement wake. The authenticated lead can bind it.
  const wake = await ctx.issues.requestWakeup(mission.rootIssueId, mission.companyId, {
    idempotencyKey: `council:n2:transmission:${transmissionReservationId}`, reason: "council_n2_transmission", actorUserId: input.actorUserId!,
  });
  const after = await fresh(ctx, mission);
  const afterState = storedN2(after);
  if (!afterState.native!.transmission.runId && wake.runId) {
    await n2Cas(ctx, after, { ...after.aggregate, n2: { ...afterState, native: { ...afterState.native!, transmission: { ...afterState.native!.transmission, runId: wake.runId } } } });
  }
  return { ...claim, outcome: wake.runId ? "requested" : "unknown", mission: await fresh(ctx, mission) };
}

async function reviewBinding(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput) {
  const who = identity(mission, input, mission.aggregate.responsibilities.finalReviewerAgentId);
  const run = await readNativeRun(ctx, who);
  const state = storedN2(mission);
  const native = requireNative(mission);
  const round = state.rounds.at(-1)!;
  const n3 = n3Round(mission);
  const sourceRunId = n3 ? n3.transmission.runId : round.round === 1 ? native.transmission.runId : state.correction?.runId;
  const interactionId = run.contextSnapshot.nativeReviewInteractionId;
  const decisionId = run.contextSnapshot.nativeReviewDecisionId;
  const card = (await ctx.issues.listInteractions(mission.rootIssueId, mission.companyId)).find(entry => entry.id === interactionId);
  const target = (card?.payload as { target?: { key?: string; revisionId?: string } } | undefined)?.target;
  if (run.status !== "running" || !run.startedAt || run.finishedAt || !sourceRunId || !native.transmission.attestedAt
      || n3 && !n3.attestedAt
      || !card || card.status !== "pending" || card.sourceRunId !== sourceRunId || card.addresseeAgentId !== who.agentId
      || target?.key !== "native_completion_review" || target.revisionId !== decisionId
      || typeof interactionId !== "string" || typeof decisionId !== "string"
      || round.handoff.reviewerRunId && round.handoff.reviewerRunId !== who.runId) {
    throw new MissionError(409, "native_review_binding_mismatch", "Native card, decision, source and active reviewer run must match the Council submission");
  }
  return { interactionId, decisionId, sourceRunId };
}

export async function executeNativeN2Agent(ctx: PluginContext, initial: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  let mission = initial;
  const lead = mission.aggregate.responsibilities.integrationLeadAgentId;
  if (input.actor.agentId === lead) mission = await bindN3Transmission(ctx, mission, input) ?? await bindLead(ctx, mission, input);
  if (body.command === "inspect") {
    if (input.actor.agentId !== lead) await reviewBinding(ctx, mission, input);
    return { missionId: mission.missionId, version: mission.version, phase: mission.aggregate.phase,
      n2: inspectN2State(mission), n3: inspectN3(mission), native: requireNative(mission), reviewerAgentId: mission.aggregate.responsibilities.finalReviewerAgentId };
  }
  if (requireNative(mission).reviewProtocol && input.actor.agentId !== lead) {
    throw new MissionError(409, "native_reviewer_tools_required", "Use native read tools, resolve_review and terminal summary; Council validates the readback after finish");
  }
  if (body.command === "n3-synthesize") {
    await reviewBinding(ctx, mission, input);
    return synthesizeN3(ctx, mission, input, body);
  }
  if (body.command === "attest-n3-transmission") {
    const attested = await attestN3Transmission(ctx, mission, input, body);
    const { freezeNativeReviewPacket } = await import("./n2-native-report.js");
    return { ...attested, mission: await freezeNativeReviewPacket(ctx, attested.mission, input.actor.runId!) };
  }
  if (body.command === "attest-transmission") {
    identity(mission, input, lead);
    const current = storedN2(mission);
    const native = requireNative(mission);
    if (native.transmission.runId !== input.actor.runId) throw new MissionError(409, "transmission_run_required", "Reserved transmission run required");
    const submission = current.submissions[0]!;
    const contributions = (mission.aggregate.n1 as { contributions: Array<{ contributionId: string; commit: string; ownedPaths: string[] }> }).contributions;
    await verifyIntegratedCandidate(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId,
      attachmentId: submission.attachmentId, expectedSha256: submission.sha256, baseCommit: submission.baseCommit,
      candidateCommit: submission.candidateCommit, contributions: contributions as [typeof contributions[number], typeof contributions[number]] });
    const attested = await n2CommandCas(ctx, mission, body, "agent", lead, { ...mission.aggregate,
      n2: { ...current, native: { ...native, transmission: { ...native.transmission, attestedAt: new Date().toISOString() } } },
      journal: [...mission.aggregate.journal, { action: "n2_transmission_candidate_verified", runId: input.actor.runId, submissionId: submission.submissionId, candidateCommit: submission.candidateCommit }],
    });
    const { freezeNativeReviewPacket } = await import("./n2-native-report.js");
    return { ...attested, mission: mission.aggregate.n3 ? await prepareN3Collection(ctx, attested.mission)
      : await freezeNativeReviewPacket(ctx, attested.mission, input.actor.runId!) };
  }
  if (body.command === "confirm-review-handoff") {
    const binding = await reviewBinding(ctx, mission, input);
    const current = storedN2(mission);
    const round = current.rounds.at(-1)!;
    const native = requireNative(mission);
    const old = native.reviewCards.find(entry => entry.round === round.round);
    return n2CommandCas(ctx, mission, body, "agent", input.actor.agentId!, { ...mission.aggregate, phase: "reviewing",
      n2: { ...current, status: "reviewing", rounds: current.rounds.map(entry => entry.round === round.round
        ? { ...entry, handoff: { ...entry.handoff, reviewerRunId: input.actor.runId!, state: "confirmed", observedAt: new Date().toISOString() } } : entry),
      native: { ...native, reviewCards: old ? native.reviewCards : [...native.reviewCards, { ...binding, round: round.round, settlementCommandId: randomUUID() }] } } });
  }
  if (body.command === "prepare-resubmission") {
    const prepared = await prepareResubmissionCommand(ctx, mission, input, body);
    mission = prepared.mission;
    const current = storedN2(mission);
    const submission = current.correction!.preparedSubmission!;
    const reservationId = runtimeUuid(body.reviewReservationId, "reviewReservationId");
    if (!mission.aggregate.n3) await reserveN2Run(ctx, mission, { reservationId, effectId: submission.submissionId, kind: mission.aggregate.n5?.continuation ? "correction" : "initial" });
    const baseline = await readNativeSequentialUsageBaseline(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId });
    // V2 is verified before this individual reviewer reservation; native finish
    // now produces its card and outbox without waiting on aggregate issue usage.
    const next = startN2ResubmittedReview(current, mission, { baselineRunIds: baseline.runIds, baselineTokenTotal: baseline.tokenTotal, reservationId });
    const n3 = mission.aggregate.n3;
    mission = await n2Cas(ctx, mission, { ...mission.aggregate, phase: "review_handoff", n2: next,
      ...(n3 ? { n3: { ...n3, rounds: [...n3.rounds, freshN3Round(mission, submission, n3.slots)] } } : {}) });
    const { freezeNativeReviewPacket } = await import("./n2-native-report.js");
    return { ...prepared, mission: n3 ? await prepareN3Collection(ctx, mission)
      : await freezeNativeReviewPacket(ctx, mission, input.actor.runId!) };
  }
  throw new MissionError(400, "native_n2_command", `Unknown native N2 agent command: ${String(body.command)}`);
}

export async function decideNativeN2(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput, decision: CouncilDecisionInput) {
  if (mission.aggregate.n2?.native?.reviewProtocol) throw new MissionError(409, "native_reviewer_tools_required", "Native verdict and terminal report must be read back after reviewer finish");
  assertN3Decision(mission, decision);
  const binding = await reviewBinding(ctx, mission, input);
  const prepared = await prepareN2Decision(ctx, mission, decision,
    typeof (input.body as Record<string, unknown>).correctionReservationId === "string" ? (input.body as Record<string, unknown>).correctionReservationId as string : undefined);
  mission = prepared;
  if (decision.verdict === "changes_requested") {
    let native = requireNative(mission);
    if (!native.blockerIssueId) {
      const blocker = await ctx.issues.create({ companyId: mission.companyId, title: `Council N2 accounting wait ${mission.missionId}`, status: "todo" });
      mission = await n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...storedN2(mission), native: { ...native, blockerIssueId: blocker.id } } });
      native = requireNative(mission);
    }
    await ctx.issues.relations.addBlockers(mission.rootIssueId, [native.blockerIssueId!], mission.companyId);
    // The supported dependency mutation must preserve the native card/run identity.
    await reviewBinding(ctx, mission, input);
  }
  const result = await executeCouncilDecision(ctx, parseCouncilConfig(await ctx.config.get(mission.companyId)), { ...decision, nativeReview: binding });
  await recordN2Decision(ctx, mission.missionId, decision, result.receipt);
  return { status: result.receipt.state === "native_observed" ? 200 : 202,
    body: { integration: "Council candidate check -> native completion review -> terminal accounting gate", operationId: decision.operationId,
      receipt: result.receipt, nativeReview: binding } };
}

async function settle(ctx: PluginContext, mission: MissionRecord, binding: { runId: string; reservationId: string; commandId: string; agentId: string }) {
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  const reservation = envelope.reservations.find(entry => entry.reservationId === binding.reservationId);
  if (reservation?.settlementReceipts.some(receipt => receipt.commandId === binding.commandId)) return;
  await settleNativeExactRunUsage(ctx, { ...binding, companyId: mission.companyId, issueId: mission.rootIssueId,
    periodKey: profile.periodKey, expectedVersion: envelope.version });
}

/** Deterministic event/recovery continuation; no accounting agent or replacement scheduler. */
export async function reconcileNativeN2(ctx: PluginContext, initial: MissionRecord) {
  let mission = initial;
  let state = storedN2(mission);
  let native = requireNative(mission);
  const lead = mission.aggregate.responsibilities.integrationLeadAgentId;
  if (native.transmission.runId && !native.transmission.settledAt) {
    await settle(ctx, mission, { runId: native.transmission.runId, agentId: lead, reservationId: native.transmission.reservationId, commandId: native.transmission.settlementCommandId });
    mission = await fresh(ctx, mission); state = storedN2(mission); native = requireNative(mission);
    mission = await n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...state, native: { ...native,
      transmission: { ...native.transmission, settledAt: new Date().toISOString() } } } });
  }
  state = storedN2(mission); native = requireNative(mission);
  if (state.correction?.runId && !state.correction.usageSettledAt) {
    await settle(ctx, mission, { runId: state.correction.runId, agentId: lead, reservationId: state.correction.reservationId!, commandId: native.correctionSettlementCommandId });
    mission = await fresh(ctx, mission); state = storedN2(mission);
    mission = await n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...state, correction: { ...state.correction!, usageSettledAt: new Date().toISOString() } } });
  }
  state = storedN2(mission); native = requireNative(mission);
  for (const round of state.rounds) {
    const binding = native.reviewCards.find(entry => entry.round === round.round);
    if (!binding || !round.verdict || !round.handoff.reviewerRunId || round.handoff.usageSettledAt) continue;
    await settle(ctx, mission, { runId: round.handoff.reviewerRunId, agentId: round.reviewerAgentId, reservationId: round.handoff.reservationId!, commandId: binding.settlementCommandId });
    mission = await fresh(ctx, mission); state = storedN2(mission);
    mission = await n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...state, rounds: state.rounds.map(entry => entry.round === round.round
      ? { ...entry, handoff: { ...entry.handoff, usageSettledAt: new Date().toISOString() } } : entry) } });
  }
  state = storedN2(mission); native = requireNative(mission);
  if (mission.aggregate.n3) await reconcileN3(ctx, mission);
  mission = await fresh(ctx, mission); state = storedN2(mission); native = requireNative(mission);
  if (native.reviewProtocol) {
    mission = await reconcileNativeVerdict(ctx, mission);
    state = storedN2(mission); native = requireNative(mission);
  }
  if (state.status !== "correction_requested" || !state.rounds[0]?.handoff.usageSettledAt || !native.transmission.settledAt || native.releaseState) return;
  const correction = state.correction!;
  await reserveN2Run(ctx, mission, { reservationId: correction.reservationId!, effectId: correction.requestedByOperationId, kind: "correction" });
  mission = await n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...state, native: { ...native, releaseState: "claimed", ...(native.reviewProtocol ? { correctionOwnerAction: "restore_wake_policy" as const } : {}) } } });
  if (native.reviewProtocol) return;
  await ctx.issues.relations.removeBlockers(mission.rootIssueId, [native.blockerIssueId!], mission.companyId);
  await ctx.issues.update(native.blockerIssueId!, { status: "done" }, mission.companyId);
  const wake = await ctx.issues.requestWakeup(mission.rootIssueId, mission.companyId, {
    idempotencyKey: `council:n2:correction:${correction.reservationId}`, reason: "council_n2_settled_correction",
  });
  mission = await fresh(ctx, mission); state = storedN2(mission); native = requireNative(mission);
  await n2Cas(ctx, mission, { ...mission.aggregate, phase: wake.runId && state.status === "correction_requested" ? "correcting" : mission.aggregate.phase,
    n2: { ...state, status: wake.runId && state.status === "correction_requested" ? "correcting" : state.status,
      native: { ...native, releaseState: wake.runId ? "released" : "claimed" },
      correction: { ...state.correction!, runId: state.correction?.runId ?? wake.runId, wakeState: wake.runId ? "requested" : "unknown" } } });
}

export async function reconcileNativeVerdict(ctx: PluginContext, mission: MissionRecord) {
  const { readNativeReviewIdentity, validateNativeReviewOutcome } = await import("./n2-native-report.js");
  const identity = await readNativeReviewIdentity(ctx, mission);
  if (!identity) return mission;
  const { record, card, run, binding } = identity;
  let state = storedN2(mission); const round = state.rounds.at(-1)!;
  await settle(ctx, mission, { runId: run.id, agentId: round.reviewerAgentId, reservationId: round.handoff.reservationId!, commandId: record.settlementCommandId });
  mission = await persistNativeReviewAccounting(ctx, await fresh(ctx, mission), identity);
  state = storedN2(mission);
  const observation = validateNativeReviewOutcome(mission, identity); const { report } = observation;
  const native = requireNative(mission); const n3 = n3Round(mission);
  if (!native.transmission.settledAt || state.correction?.runId && !state.correction.usageSettledAt
      || n3 && (!n3.transmission.settledAt || !n3.specialists.every(item => item.settledAt))) {
    throw new MissionError(409, "native_review_usage_pending", "Every admitted source, correction and specialist run must settle before Council validation");
  }
  mission = await persistNativeReviewObservation(ctx, mission, observation);
  const common = { companyId: mission.companyId, issueId: mission.rootIssueId, actorAgentId: run.agentId, runId: run.id,
    operationId: record.operationId, justification: report.rationale, resultReference: n2SubmissionResultReference(state.activeSubmissionId), nativeReview: binding };
  const decision: CouncilDecisionInput = report.verdict === "approved" ? { ...common, verdict: "approved", approvedCommit: record.packet.submission.candidateCommit }
    : { ...common, verdict: "changes_requested" };
  if (report.verdict === "changes_requested" && state.correctionsUsed >= state.correctionLimit) {
    return n2Cas(ctx, mission, { ...mission.aggregate, control: { status: "blocked", reason: "correction_limit_exceeded" },
      journal: [...mission.aggregate.journal, { action: "native_rejection_correction_limit_exceeded", runId: run.id, submissionId: state.activeSubmissionId }] });
  }
  mission = await prepareN2Decision(ctx, mission, decision, record.correctionReservationId);
  const receipt = await recordCouncilNativeReadback(ctx, decision, { packetHash: record.hash, reportHash: canonicalPayloadHash(report), card });
  return recordN2Decision(ctx, mission.missionId, decision, receipt);
}

async function releaseNativeCorrection(ctx: PluginContext, mission: MissionRecord, input: { actorUserId: string | null; body: Record<string, unknown> }) {
  const body = input.body; const commandId = runtimeUuid(body.commandId, "commandId");
  const prior = runtimeReceipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission, receipt: prior };
  const state = storedN2(mission); const native = requireNative(mission);
  if (native.reviewProtocol && state.correction?.runId && native.correctionOwnerAction) return { outcome: "observed", mission };
  assertCorrectionRelease(mission, body);
  const { assertNativeLeadWakePolicy } = await import("./n2-native-report.js");
  await assertNativeLeadWakePolicy(ctx, mission, false);
  const observed = await observeNativeCorrection(ctx, mission, input);
  if (observed) return observed;
  const claimed = await n2CommandCas(ctx, mission, body, "user", input.actorUserId!, { ...mission.aggregate,
    n2: { ...state, native: { ...native, correctionOwnerAction: "wake_claimed" }, correction: { ...state.correction!, wakeState: "unknown" } } });
  const wake = await ctx.issues.requestWakeup(mission.rootIssueId, mission.companyId, {
    idempotencyKey: `council:n2:correction:${state.correction!.reservationId}`, reason: "council_n2_settled_correction", actorUserId: input.actorUserId!,
  });
  return { ...claimed, outcome: wake.runId ? "requested" : "unknown", mission: await recordNativeCorrectionWake(ctx, mission, wake.runId) };
}

async function observeNativeCorrection(ctx: PluginContext, mission: MissionRecord, input: { actorUserId: string | null; body: Record<string, unknown> }) {
  const state = storedN2(mission); const native = requireNative(mission); const body = input.body;
  const summary = await ctx.issues.summaries.getOrchestration({ companyId: mission.companyId, issueId: mission.rootIssueId, includeSubtree: false });
  const active = summary.runs.filter(r => r.issueId === mission.rootIssueId && r.agentId === mission.aggregate.responsibilities.integrationLeadAgentId
    && ["queued", "running"].includes(r.status));
  if (active.length > 1) throw new MissionError(409, "native_correction_run_ambiguous", "Multiple lead runs cannot consume one correction reservation");
  if (active[0]) {
    const run = await readNativeRun(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId, agentId: active[0].agentId, runId: active[0].id });
    const observed = await n2CommandCas(ctx, mission, body, "user", input.actorUserId!, { ...mission.aggregate, phase: "correcting",
      n2: { ...state, status: "correcting", native: { ...native, releaseState: "released", correctionOwnerAction: "wake_claimed" },
        correction: { ...state.correction!, runId: run.id, wakeState: "requested" } } });
    return { ...observed, outcome: "observed" };
  }
  return null;
}

async function recordNativeCorrectionWake(ctx: PluginContext, mission: MissionRecord, runId: string | null) {
  const after = await fresh(ctx, mission); const current = storedN2(after);
  const started = Boolean(runId && current.status === "correction_requested");
  return n2Cas(ctx, after, { ...after.aggregate, phase: started ? "correcting" : after.aggregate.phase,
    n2: { ...current, status: started ? "correcting" : current.status,
      native: { ...current.native!, releaseState: runId ? "released" : "claimed" },
      correction: { ...current.correction!, runId: current.correction?.runId ?? runId, wakeState: runId ? "requested" : "unknown" } } });
}

async function persistNativeReviewObservation(ctx: PluginContext, mission: MissionRecord,
  observation: ReturnType<typeof import("./n2-native-report.js").validateNativeReviewOutcome>) {
  const { record, card, run, report, synthesis, binding } = observation;
  const state = storedN2(mission); const native = requireNative(mission); const n3 = n3Round(mission);
  // Confirm only the attribution already observed on the resolved native card/run.
  return n2Cas(ctx, mission, { ...mission.aggregate, phase: "reviewing", n2: { ...state, status: "reviewing",
    native: { ...native, reviewPackets: native.reviewPackets!.map(p => p.hash === record.hash ? { ...p,
      observation: { runId: run.id, interactionId: card.id, decisionId: binding.decisionId, report, observedAt: new Date().toISOString() } } : p) } },
    ...(synthesis && n3 ? { n3: { ...mission.aggregate.n3!, rounds: mission.aggregate.n3!.rounds.map(r => r === n3 ? { ...r, review: synthesis } : r) } } : {}) });
 }

function assertCorrectionRelease(mission: MissionRecord, body: Record<string, unknown>) {
  const state = storedN2(mission); const native = requireNative(mission);
  if (mission.version !== body.expectedVersion || state.status !== "correction_requested" || native.correctionOwnerAction !== "restore_wake_policy"
      || native.releaseState !== "claimed" || !state.correction?.reservationId) throw new MissionError(409, "native_correction_not_reserved", "Settled native verdict and the existing correction reservation must precede owner release");
}

async function persistNativeReviewAccounting(ctx: PluginContext, mission: MissionRecord, identity: import("./n2-native-report.js").NativeReviewIdentity) {
  const state = storedN2(mission); const round = state.rounds.at(-1)!; const native = requireNative(mission);
  if (round.handoff.usageSettledAt) return mission;
  const { record, run, binding } = identity;
  return n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...state,
    rounds: state.rounds.map(r => r.round === round.round ? { ...r, handoff: { ...r.handoff, state: "confirmed", reviewerRunId: run.id,
      observedAt: new Date().toISOString(), usageSettledAt: new Date().toISOString() } } : r),
    native: { ...native, reviewCards: native.reviewCards.some(c => c.round === round.round) ? native.reviewCards
      : [...native.reviewCards, { ...binding, round: round.round, settlementCommandId: record.settlementCommandId }] } } });
}
