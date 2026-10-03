import { inspectN3, n3Round, type N3Execution as Execution, type N3NativeRound, type N3State } from "./n3-state.js";
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { createContributionIssueEffect } from "./contribution-effects.js";
import { readNativeRun, settleNativeExactRunUsage } from "./g4-native.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, n2CommandCas, nativeN2Profile, reserveN2Run, runtimeReceipt, runtimeUuid, storedN2, type N2DecisionContext, type N2Submission } from "./n2-missions.js";
import { recordN3Opinion, startN3ReviewRound, synthesizeN3Review, type N3CandidateSubject, type N3OpinionSlot } from "./n3-opinions.js";

const execution = (): Execution => ({ reservationId: randomUUID(), settlementCommandId: randomUUID(), runId: null, wake: "pending" });
export const n3Subject = (submission: N2Submission): N3CandidateSubject => ({ submissionId: submission.submissionId, candidateCommit: submission.candidateCommit, bundleSha256: submission.sha256, evidenceRevision: submission.evidenceRevision, mandateHash: submission.mandateHash });

export function freshN3Round(mission: MissionRecord, submission: N2Submission, slots: N3OpinionSlot[]): N3NativeRound {
  const contributors = (mission.aggregate.n1 as { contributions?: Array<{ assigneeAgentId: string }> })?.contributions ?? [];
  const authors = [...new Set([mission.aggregate.responsibilities.integrationLeadAgentId, ...contributors.map(entry => entry.assigneeAgentId)])];
  return { review: startN3ReviewRound({ subject: n3Subject(submission), slots, authorAgentIds: authors, finalReviewerAgentId: mission.aggregate.responsibilities.finalReviewerAgentId }),
    specialists: slots.map(slot => ({ ...execution(), slotId: slot.slotId, issueId: null, creation: "pending" })), transmission: execution() };
}
export async function selectN3(ctx: PluginContext, mission: MissionRecord, submission: N2Submission, slots: N3OpinionSlot[]): Promise<N3State> {
  const round = freshN3Round(mission, submission, slots);
  for (const slot of round.review.slots) {
    const agent = await ctx.agents.get(slot.specialistAgentId, mission.companyId);
    if (!agent || agent.adapterType !== "paperclip_runner" || ["paused", "terminated", "pending_approval"].includes(agent.status)) {
      throw new MissionError(422, "n3_specialist_unavailable", "Each selected specialist must be available in this company on the explicit native profile");
    }
  }
  return { slots: round.review.slots, rounds: [round] };
}
async function fresh(ctx: PluginContext, mission: MissionRecord) {
  return (await getMission(ctx, mission.companyId, mission.missionId))!;
}
async function saveRound(ctx: PluginContext, mission: MissionRecord, round: N3NativeRound) {
  const n3 = mission.aggregate.n3!;
  return n2Cas(ctx, mission, { ...mission.aggregate, n3: { ...n3, rounds: n3.rounds.map(entry => entry.review.subject.submissionId === round.review.subject.submissionId ? round : entry) } });
}
function requireRound(mission: MissionRecord) {
  const round = n3Round(mission);
  if (!round) throw new MissionError(409, "n3_round_missing", "An active N3 round is required");
  const submission = storedN2(mission).submissions.find(entry => entry.submissionId === storedN2(mission).activeSubmissionId)!;
  if (canonicalPayloadHash(round.review.subject) !== canonicalPayloadHash(n3Subject(submission))) throw new MissionError(409, "stale_n3_subject", "N3 round differs from the immutable N2 submission");
  return round;
}
/** Called in the verified source run; finish must report the actual dependency block. */
export async function prepareN3Collection(ctx: PluginContext, initial: MissionRecord) {
  let mission = initial; let round = requireRound(mission);
  if (!round.blockerIssueId) {
    if (round.blockerClaimed) throw new MissionError(409, "n3_effect_unknown", "N3 blocker creation needs owner reconciliation; no replacement creation");
    mission = await saveRound(ctx, mission, { ...round, blockerClaimed: true });
    const blocker = await ctx.issues.create({ companyId: mission.companyId, parentId: mission.rootIssueId, title: `Council N3 opinions and usage ${round.review.subject.submissionId}`, status: "todo" });
    mission = await saveRound(ctx, mission, { ...requireRound(mission), blockerIssueId: blocker.id });
  }
  round = requireRound(mission);
  await ctx.issues.relations.addBlockers(mission.rootIssueId, [round.blockerIssueId!], mission.companyId);
  return mission;
}
async function settleExecution(ctx: PluginContext, mission: MissionRecord, item: Execution, issueId: string, agentId: string) {
  if (item.settledAt || !item.runId) return item;
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  if (!envelope.reservations.find(entry => entry.reservationId === item.reservationId)?.settlementReceipts.some(receipt => receipt.commandId === item.settlementCommandId)) {
    await settleNativeExactRunUsage(ctx, { companyId: mission.companyId, issueId, agentId, runId: item.runId,
      reservationId: item.reservationId, commandId: item.settlementCommandId, periodKey: profile.periodKey, expectedVersion: envelope.version });
  }
  return { ...item, settledAt: new Date().toISOString() };
}
async function startSpecialist(ctx: PluginContext, initial: MissionRecord, index: number) {
  let mission = initial; let round = requireRound(mission); let item = round.specialists[index]!;
  const slot = round.review.slots[index]!;
  if (!item.issueId) {
    if (item.creation === "claimed") return mission;
    item = { ...item, creation: "claimed" };
    mission = await saveRound(ctx, mission, { ...round, specialists: round.specialists.map((entry, i) => i === index ? item : entry) });
    const created = await createContributionIssueEffect(ctx, { state: "creation_claimed", intentId: item.reservationId, missionId: mission.missionId,
      companyId: mission.companyId, rootIssueId: mission.rootIssueId, projectId: mission.projectId, contributionId: item.reservationId,
      assigneeAgentId: slot.specialistAgentId, title: `Council N3 ${slot.perspective}: ${round.review.subject.submissionId}`,
      description: JSON.stringify({ missionId: mission.missionId, rootIssueId: mission.rootIssueId, slot, subject: round.review.subject,
        command: "n3-opinion", instruction: "Inspect using n3-inspect on this child issue; submit an attributed opinion before native finish. Do not decide the root." }) });
    if (created.state !== "confirmed") return mission;
    item = { ...item, issueId: created.issue.id };
    round = requireRound(mission);
    mission = await saveRound(ctx, mission, { ...round, specialists: round.specialists.map((entry, i) => i === index ? item : entry) });
  }
  if (item.wake === "claimed") return mission;
  await reserveN2Run(ctx, mission, { reservationId: item.reservationId, effectId: item.reservationId, kind: "initial" });
  item = { ...item, wake: "claimed" }; round = requireRound(mission);
  mission = await saveRound(ctx, mission, { ...round, specialists: round.specialists.map((entry, i) => i === index ? item : entry) });
  await ctx.issues.update(item.issueId!, { status: "todo" }, mission.companyId);
  const wake = await ctx.issues.requestWakeup(item.issueId!, mission.companyId, { idempotencyKey: `council:n3:${item.reservationId}`, reason: "council_n3_specialist" });
  mission = await fresh(ctx, mission); round = requireRound(mission);
  return saveRound(ctx, mission, { ...round, specialists: round.specialists.map((entry, i) => i === index ? { ...entry, runId: entry.runId ?? wake.runId } : entry) });
}
async function releaseTransmission(ctx: PluginContext, mission: MissionRecord) {
  let round = requireRound(mission);
  if (round.transmission.wake === "claimed") return mission;
  await reserveN2Run(ctx, mission, { reservationId: round.transmission.reservationId, effectId: round.transmission.reservationId, kind: "initial" });
  const review = storedN2(mission).rounds.at(-1)!;
  await reserveN2Run(ctx, mission, { reservationId: review.handoff.reservationId!, effectId: review.submissionId, kind: "initial" });
  mission = await saveRound(ctx, mission, { ...round, transmission: { ...round.transmission, wake: "claimed" } });
  await ctx.issues.relations.removeBlockers(mission.rootIssueId, [round.blockerIssueId!], mission.companyId);
  await ctx.issues.update(round.blockerIssueId!, { status: "done" }, mission.companyId);
  await ctx.issues.update(mission.rootIssueId, { status: "todo" }, mission.companyId);
  const wake = await ctx.issues.requestWakeup(mission.rootIssueId, mission.companyId, { idempotencyKey: `council:n3:transmission:${round.transmission.reservationId}`, reason: "council_n3_ready_for_synthesis" });
  mission = await fresh(ctx, mission); round = requireRound(mission);
  return saveRound(ctx, mission, { ...round, released: true, transmission: { ...round.transmission, runId: round.transmission.runId ?? wake.runId } });
}
/** Invoked after source accounting or an authenticated native child terminal event. */
export async function reconcileN3(ctx: PluginContext, initial: MissionRecord) {
  let mission = initial; let round = requireRound(mission);
  const state = storedN2(mission);
  const sourceSettled = state.rounds.at(-1)!.round === 1 ? state.native!.transmission.settledAt : state.correction?.usageSettledAt;
  if (!sourceSettled || !round.blockerIssueId) return;
  for (let i = 0; i < round.specialists.length; i++) {
    const item = round.specialists[i]!; const slot = round.review.slots[i]!;
    if (!item.runId) { await startSpecialist(ctx, mission, i); return; }
    if (!item.settledAt) {
      const settled = await settleExecution(ctx, mission, item, item.issueId!, slot.specialistAgentId);
      mission = await fresh(ctx, mission); round = requireRound(mission);
      mission = await saveRound(ctx, mission, { ...round, specialists: round.specialists.map((entry, index) => index === i ? { ...entry, ...settled } : entry) });
      round = requireRound(mission);
    }
    if (!round.review.opinions.some(opinion => opinion.slotId === slot.slotId)) return;
  }
  if (!round.released) { await releaseTransmission(ctx, mission); return; }
  if (round.transmission.runId && !round.transmission.settledAt) {
    const transmission = await settleExecution(ctx, mission, round.transmission, mission.rootIssueId, mission.aggregate.responsibilities.integrationLeadAgentId);
    mission = await fresh(ctx, mission);
    await saveRound(ctx, mission, { ...requireRound(mission), transmission });
  }
}

export async function bindN3Transmission(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput): Promise<MissionRecord | null> {
  const round = n3Round(mission);
  if (!round || round.transmission.wake !== "claimed" || round.attestedAt) return null;
  const lead = mission.aggregate.responsibilities.integrationLeadAgentId;
  if (input.actor.actorType !== "agent" || input.actor.agentId !== lead || !input.actor.runId) return null;
  const run = await readNativeRun(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId, agentId: lead, runId: input.actor.runId });
  if (run.status !== "running" || run.finishedAt || round.transmission.runId && round.transmission.runId !== input.actor.runId) throw new MissionError(409, "n3_transmission_mismatch", "Admitted N3 transmission run required");
  return round.transmission.runId ? mission : saveRound(ctx, mission, { ...round, transmission: { ...round.transmission, runId: input.actor.runId } });
}
export async function attestN3Transmission(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  const round = requireRound(mission);
  if (input.actor.actorType !== "agent" || input.actor.agentId !== mission.aggregate.responsibilities.integrationLeadAgentId || !input.actor.runId
      || input.actor.runId !== round.transmission.runId || !round.specialists.every(item => item.settledAt) || round.review.status !== "ready_for_synthesis") throw new MissionError(409, "n3_opinions_pending", "Opinions and exact terminal usage must precede native handoff");
  return commandRound(ctx, mission, input, body, { ...round, attestedAt: new Date().toISOString() });
}
async function commandRound(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>, round: N3NativeRound) {
  return n2CommandCas(ctx, mission, body, "agent", input.actor.agentId!, { ...mission.aggregate, n3: { ...mission.aggregate.n3!, rounds: mission.aggregate.n3!.rounds.map(entry => entry.review.subject.submissionId === round.review.subject.submissionId ? round : entry) } });
}
export async function handleN3Specialist(ctx: PluginContext, input: PluginApiRequestInput) {
  const body = input.body as Record<string, unknown>;
  let mission = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
  if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
  let round = requireRound(mission);
  const index = round.specialists.findIndex(item => item.issueId === input.params.issueId);
  const item = round.specialists[index]; const slot = round.review.slots[index];
  if (!item || !slot || input.actor.actorType !== "agent" || input.actor.agentId !== slot.specialistAgentId || !input.actor.runId || item.wake !== "claimed") throw new MissionError(403, "n3_specialist_binding", "Selected specialist and native child issue/run required");
  const run = await readNativeRun(ctx, { companyId: mission.companyId, issueId: item.issueId!, agentId: slot.specialistAgentId, runId: input.actor.runId });
  if (run.status !== "running" || run.finishedAt || item.runId && item.runId !== input.actor.runId) throw new MissionError(409, "n3_specialist_run", "Active reserved specialist run required");
  if (!item.runId) {
    mission = await saveRound(ctx, mission, { ...round, specialists: round.specialists.map((entry, i) => i === index ? { ...entry, runId: input.actor.runId! } : entry) });
    round = requireRound(mission);
  }
  if (body.command === "n3-inspect") return { version: mission.version, n3: inspectN3(mission), slot };
  const prior = runtimeReceipt(mission, runtimeUuid(body.commandId, "commandId"), input.actor.agentId, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission, receipt: prior };
  const opinion = body.opinion as Parameters<typeof recordN3Opinion>[1];
  const review = recordN3Opinion(round.review, { ...opinion, authenticatedAgentId: input.actor.agentId, authenticatedRunId: input.actor.runId });
  return commandRound(ctx, mission, input, body, { ...round, review });
}
export async function synthesizeN3(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  const round = requireRound(mission);
  if (!round.specialists.every(item => item.settledAt)) throw new MissionError(409, "n3_usage_pending", "Exact specialist terminal usage must be settled before synthesis");
  const synthesis = body.synthesis as Parameters<typeof synthesizeN3Review>[1];
  const review = synthesizeN3Review(round.review, { ...synthesis, authenticatedAgentId: input.actor.agentId!, authenticatedRunId: input.actor.runId! });
  const nextActor = review.synthesis!.verdict === "waiting" ? String(body.nextActor ?? "").trim() : undefined;
  if (nextActor === "") throw new MissionError(422, "n3_next_actor_required", "An escalated waiting synthesis requires an explicit next actor");
  return commandRound(ctx, mission, input, body, { ...round, review, nextActor });
}
export function assertN3Decision(mission: MissionRecord, decision: N2DecisionContext) {
  if (!mission.aggregate.n3) return;
  const round = requireRound(mission); const synthesis = round.review.synthesis;
  if (!synthesis || synthesis.verdict !== decision.verdict || synthesis.finalReviewerRunId !== decision.runId || synthesis.finalReviewerAgentId !== decision.actorAgentId
      || !round.specialists.every(item => item.settledAt)) throw new MissionError(409, "n3_synthesis_required", "Matching final-reviewer synthesis and settled opinions required before any native decision effect");
}
