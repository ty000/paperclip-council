import { createHash, randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { AdmissionError } from "./admission.js";
import { createContributionIssueEffect } from "./contribution-effects.js";
import { readNativeRun, settleNativeExactRunUsage } from "./g4-native.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { inspectN2State, n2Cas, n2CommandCas, nativeN2Profile, reserveN2Run, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { assertCurrentN5Plan, observeN5Native, readN5Plan } from "./n5-native.js";
import { inspectN5, type N5State } from "./n5-state.js";

const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;
const save = (ctx: PluginContext, m: MissionRecord, n5: N5State) => n2Cas(ctx, m, { ...m.aggregate, n5 });
function accepted(m: MissionRecord) {
  const n2 = inspectN2State(m);
  if (n2?.status !== "accepted" || n2.application.state !== "observed" || !n2.usage.complete
      || !n2.submission || n2.application.submissionId !== n2.submission.submissionId) throw new MissionError(409, "n5_accepted_candidate_required", "Native acceptance and exact terminal accounting must precede publication");
  if (n2.submission.mandateHash !== createHash("sha256").update(JSON.stringify(m.aggregate.mandate)).digest("hex")) throw new MissionError(409, "n5_mandate_changed", "Accepted submission belongs to a different mandate");
  const native = m.aggregate.n2?.native;
  if (native && !native.transmission.settledAt) throw new MissionError(409, "n5_source_usage_pending", "Native transmission accounting is required before publication");
  if (m.aggregate.n3?.rounds.some(round => !round.transmission.settledAt || round.specialists.some(item => !item.settledAt))) {
    throw new MissionError(409, "n5_source_usage_pending", "Every N3 specialist and transmission must be settled before publication");
  }
  return n2.submission;
}
function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200) throw new MissionError(422, "n5_invalid_input", `${label} must be a bounded string`);
  return value;
}
async function authorize(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  if (m.aggregate.n5?.publication) throw new MissionError(409, "n5_authority_frozen", "An admitted publication cannot be replaced or reset");
  const publisherAgentId = runtimeUuid(body.publisherAgentId, "publisherAgentId");
  const agent = await ctx.agents.get(publisherAgentId, m.companyId);
  if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw new MissionError(422, "n5_publisher_unavailable", "Available publisher required");
  const repository = text(body.repository, "repository");
  const baseRef = text(body.baseRef, "baseRef"); const headRef = text(body.headRef, "headRef");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || baseRef === headRef
      || [baseRef, headRef].some(ref => !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref) || ref.includes(".."))) throw new MissionError(422, "n5_repository_binding", "Explicit repository and distinct safe base/head refs required");
  const plan = await readN5Plan(ctx, m, runtimeUuid(body.planRevisionId, "planRevisionId"));
  return n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n5: { plan,
    authority: { publisherAgentId, repository, baseRef, headRef, authorizedBy: actorId, authorizedAt: new Date().toISOString() } } });
}

/** Persisted authority may admit exactly one publisher after acceptance; no per-delivery human gate. */
export async function startN5Publication(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; const n5 = m.aggregate.n5;
  if (!n5 || n5.publication) return m;
  const submission = accepted(m);
  await assertCurrentN5Plan(ctx, m);
  const intentId = randomUUID(); const reservationId = randomUUID();
  // This CAS is the unique creation claim; any uncertain child creation stays retained.
  m = await save(ctx, m, { ...n5, publication: { intentId, submission, issueId: null, runId: null, reservationId,
    settlementCommandId: randomUUID(), createdAt: new Date().toISOString(), creation: "claimed", wake: "pending", state: "pending" } });
  const created = await createContributionIssueEffect(ctx, { state: "creation_claimed", intentId, companyId: m.companyId,
    projectId: m.projectId, rootIssueId: m.rootIssueId, missionId: m.missionId, contributionId: intentId,
    assigneeAgentId: n5.authority.publisherAgentId, title: `Council delivery ${submission.submissionId}`,
    description: JSON.stringify({ missionId: m.missionId, intentId, plan: n5.plan, authority: n5.authority, submission,
      instructions: "Use n5-inspect then n5-claim-publication before git/gh. Only effectPermission=execute allows one create. Verify local and remote candidate/ref before gh. Write native delivery JSON {intentId,url,link} with link as Markdown autolink <URL> and pull_request work product, refresh the external object, then n5-observe-delivery. Ambiguous effect: never create again. Finish with attributed checks/review limits." }) });
  if (created.state !== "confirmed") return m;
  m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...m.aggregate.n5!.publication!, issueId: created.issue.id, creation: "confirmed" } });
  await reserveN2Run(ctx, m, { reservationId, effectId: intentId, kind: "initial" });
  m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...m.aggregate.n5!.publication!, wake: "claimed" } });
  await ctx.issues.update(created.issue.id, { status: "todo" }, m.companyId);
  const wake = await ctx.issues.requestWakeup(created.issue.id, m.companyId, { idempotencyKey: `council:n5:${intentId}`, reason: "council_n5_authorized_delivery" });
  m = await fresh(ctx, m);
  if (!m.aggregate.n5!.publication!.runId && wake.runId) m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...m.aggregate.n5!.publication!, runId: wake.runId } });
  return m;
}

export async function reconcileN5(ctx: PluginContext, initial: MissionRecord) {
  let m = initial;
  if (!m.aggregate.n5) return m;
  if (!m.aggregate.n5.publication) return startN5Publication(ctx, m);
  let p = m.aggregate.n5.publication;
  if (!p.runId || !p.issueId) return m;
  if (!p.settledAt) {
    const { profile, envelope } = await nativeN2Profile(ctx, m);
    if (!envelope.reservations.find(r => r.reservationId === p.reservationId)?.settlementReceipts.some(r => r.commandId === p.settlementCommandId)) {
      await settleNativeExactRunUsage(ctx, { companyId: m.companyId, issueId: p.issueId, agentId: m.aggregate.n5.authority.publisherAgentId,
        runId: p.runId, reservationId: p.reservationId, commandId: p.settlementCommandId, periodKey: profile.periodKey, expectedVersion: envelope.version });
    }
    m = await fresh(ctx, m); p = m.aggregate.n5!.publication!;
    m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...p, settledAt: new Date().toISOString() } });
  }
  return m.aggregate.n5!.publication!.claimedAt ? refreshN5Observation(ctx, m) : m;
}

async function executeN5Board(ctx: PluginContext, input: { companyId: string; missionId: string; actorUserId: string | null; body: Record<string, unknown> }) {
  const m = await getMission(ctx, input.companyId, input.missionId);
  if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
  const company = await ctx.companies.get(m.companyId);
  if (!input.actorUserId || input.actorUserId !== m.ownerUserId || input.actorUserId !== company?.defaultResponsibleUserId) throw new MissionError(403, "mission_owner_required", "Mission owner required");
  if (input.body.command === "reconcile-delivery") {
    const reconciled = await reconcileN5(ctx, m);
    const updated = input.body.checks || input.body.reviews ? await refreshN5Observation(ctx, reconciled,
      { actorType: "user", actorId: input.actorUserId, userId: input.actorUserId }, input.body) : reconciled;
    return { outcome: "reconciled", mission: updated };
  }
  const prior = runtimeReceipt(m, runtimeUuid(input.body.commandId, "commandId"), input.actorUserId, canonicalPayloadHash(input.body));
  if (prior) return { outcome: "replayed", mission: m, receipt: prior };
  return authorize(ctx, m, input.body, input.actorUserId);
}

async function bindPublisher(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput) {
  const n5 = m.aggregate.n5; const p = n5?.publication;
  if (!n5 || !p || !p.issueId || input.params.issueId !== p.issueId || input.actor.actorType !== "agent"
      || input.actor.agentId !== n5.authority.publisherAgentId || !input.actor.runId || p.wake !== "claimed"
      || p.runId && p.runId !== input.actor.runId) throw new MissionError(403, "n5_publisher_binding", "Exact authorized publisher child and reserved run required");
  const run = await readNativeRun(ctx, { companyId: m.companyId, issueId: p.issueId, runId: input.actor.runId, agentId: input.actor.agentId });
  if (run.status !== "running" || !run.startedAt || run.finishedAt) throw new MissionError(409, "n5_publisher_not_running", "Publisher run must be active");
  return p.runId ? m : save(ctx, m, { ...n5, publication: { ...p, runId: input.actor.runId } });
}
function attributedObservation(value: unknown, states: string[], actor: PluginApiRequestInput["actor"], headSha: string) {
  const v = value as Record<string, unknown>;
  if (!v || !states.includes(String(v.state)) || v.headSha !== headSha || !Array.isArray(v.evidenceRefs)
      || !v.evidenceRefs.length || v.evidenceRefs.some(r => typeof r !== "string" || !r || r.length > 1000)) throw new MissionError(422, "n5_checks_binding", "Checks/reviews need explicit state, exact head and evidence references");
  return { headSha, state: v.state, evidenceRefs: v.evidenceRefs, observedAt: new Date().toISOString(), agentId: actor.agentId ?? null, userId: actor.userId ?? null, runId: actor.runId ?? null };
}
export async function handleN5Agent(ctx: PluginContext, input: PluginApiRequestInput) {
  try {
    const body = input.body as Record<string, unknown>;
    let m = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
    if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
    m = await bindPublisher(ctx, m, input);
    if (body.command === "n5-inspect") return { status: 200, body: { version: m.version, delivery: inspectN5(m) } };
    const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), input.actor.agentId!, canonicalPayloadHash(body));
    if (prior) return { status: 200, body: { outcome: "replayed", effectPermission: "none", mission: m, receipt: prior } };
    const n5 = m.aggregate.n5!; let p = n5.publication!;
    if (body.command === "n5-claim-publication") {
      if (p.claimedAt) throw new MissionError(409, "n5_effect_already_claimed", "One publication intent is already consumed; correlate readback without another effect");
      const candidate = accepted(m); await assertCurrentN5Plan(ctx, m);
      if (canonicalPayloadHash(candidate) !== canonicalPayloadHash(p.submission)) throw new MissionError(409, "n5_candidate_changed", "Accepted candidate changed");
      p = { ...p, state: "unknown", claimedAt: new Date().toISOString(), claimCommandId: String(body.commandId) };
    } else if (body.command === "n5-observe-delivery") {
      if (!p.claimedAt) throw new MissionError(409, "n5_intent_required", "Persist the one-shot publication intent before any effect");
      const observation = await observeN5Native(ctx, m);
      p = { ...p, state: "opened", readbackUnavailable: undefined, observation,
        checks: body.checks ? attributedObservation(body.checks, ["unknown", "pending", "passed", "failed"], input.actor, observation.headSha) as NonNullable<typeof p.checks> : undefined,
        reviews: body.reviews ? attributedObservation(body.reviews, ["unknown", "pending", "approved", "changes_requested"], input.actor, observation.headSha) as NonNullable<typeof p.reviews> : undefined };
    } else throw new MissionError(400, "n5_unknown_command", "Unknown delivery command");
    const result = await n2CommandCas(ctx, m, body, "agent", input.actor.agentId!, { ...m.aggregate, n5: { ...n5, publication: p } });
    return { status: 200, body: { ...result, effectPermission: body.command === "n5-claim-publication" && result.outcome === "applied" ? "execute" : "none" } };
  } catch (error) {
    if (error instanceof MissionError || error instanceof AdmissionError) return { status: error.status, body: { code: error.code, error: error.message } };
    throw error;
  }
}

export async function handleN5Board(ctx: PluginContext, input: PluginApiRequestInput) {
  try {
    if (input.params.companyId !== input.companyId) throw new MissionError(403, "company_scope_mismatch", "Company route does not match host scope");
    const result = await executeN5Board(ctx, { companyId: input.companyId, missionId: runtimeUuid(input.params.missionId, "missionId"),
      actorUserId: input.actor.actorType === "user" ? input.actor.userId ?? null : null, body: input.body as Record<string, unknown> });
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof MissionError || error instanceof AdmissionError) return { status: error.status, body: { code: error.code, error: error.message } };
    throw error;
  }
}

async function refreshN5Observation(ctx: PluginContext, m: MissionRecord, actor?: PluginApiRequestInput["actor"], body: Record<string, unknown> = {}) {
  const n5 = m.aggregate.n5!; const p = n5.publication!;
  let observation;
  try { await assertCurrentN5Plan(ctx, m); observation = await observeN5Native(ctx, m); }
  catch (error) {
    if (!(error instanceof MissionError)) throw error;
    return save(ctx, m, { ...n5, publication: { ...p, readbackUnavailable: error.code } });
  }
  const sameHead = observation.headSha === p.observation?.headSha;
  const checks = actor && body.checks ? attributedObservation(body.checks, ["unknown", "pending", "passed", "failed"], actor, observation.headSha) as NonNullable<typeof p.checks> : sameHead ? p.checks : undefined;
  const reviews = actor && body.reviews ? attributedObservation(body.reviews, ["unknown", "pending", "approved", "changes_requested"], actor, observation.headSha) as NonNullable<typeof p.reviews> : sameHead ? p.reviews : undefined;
  return save(ctx, m, { ...n5, publication: { ...p, state: "opened", observation, readbackUnavailable: undefined, checks, reviews } });
}
