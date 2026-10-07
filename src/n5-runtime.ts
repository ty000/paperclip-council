import { n5PublisherInstructions } from "./n5-instructions.js";
import { requestN5Correction, rebindN5Plan } from "./n5-continuation.js";
import { acceptedN5Submission } from "./n5-preflight.js";
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { AdmissionError } from "./admission.js";
import { createContributionIssueEffect, reconcileContributionIssueEffect } from "./contribution-effects.js";
import { readNativeRun, readOrdinaryRun, settleNativeExactRunUsage, settleOrdinaryRunUsage } from "./g4-native.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, n2CommandCas, nativeN2Profile, reserveN2Run, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { assertCurrentN5Plan, observeN5Native, readN5Plan } from "./n5-native.js";
import { inspectN5, type N5State } from "./n5-state.js";
import { bindVariantIssue, claimVariantWake, observeVariantRun, prepareVariantLaunch, recordVariantWake } from "./model-runtime.js";
import { modelLaunch, physicalAgent } from "./model-state.js";
import { validatePublisherPreflight } from "./n5-publisher-preflight.js";
import { assertNativeRunInventory } from "./native-runs.js";

const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;
const save = (ctx: PluginContext, m: MissionRecord, n5: N5State) => n2Cas(ctx, m, { ...m.aggregate, n5 });
function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200) throw new MissionError(422, "n5_invalid_input", `${label} must be a bounded string`);
  return value;
}
async function authorize(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  if (m.aggregate.n5?.publication) throw new MissionError(409, "n5_authority_frozen", "An admitted publication cannot be replaced or reset");
  const publisherAgentId = runtimeUuid(body.publisherAgentId, "publisherAgentId");
  const agent = await ctx.agents.get(publisherAgentId, m.companyId);
  if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw new MissionError(422, "n5_publisher_unavailable", "Available publisher required");
  if (m.aggregate.n2?.ordinary && (agent.adapterType !== "codex_local" || agent.adapterConfig?.engine !== "cli")) throw new MissionError(422, "ordinary_cli_required", "Ordinary delivery requires an explicit CLI publisher");
  const repository = text(body.repository, "repository");
  const baseRef = text(body.baseRef, "baseRef"); const headRef = text(body.headRef, "headRef");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || baseRef === headRef
      || [baseRef, headRef].some(ref => !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref) || ref.includes(".."))) throw new MissionError(422, "n5_repository_binding", "Explicit repository and distinct safe base/head refs required");
  const plan = await readN5Plan(ctx, m, runtimeUuid(body.planRevisionId, "planRevisionId"));
  const config = await ctx.config.get(m.companyId);
  const publisherPreflight = (m.aggregate.n2?.ordinary || config.n2RuntimeProfile === "ordinary-cli-v1")
    && config.n5PublisherPreflightEnabled !== false ? "publisher-run-report-v1" as const : undefined;
  return n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n5: { plan,
    authority: { publisherAgentId, repository, baseRef, headRef, authorizedBy: actorId, authorizedAt: new Date().toISOString(),
      ...(publisherPreflight ? { publisherPreflight } : {}) } } });
}

/** Persisted authority may admit exactly one publisher after acceptance; no per-delivery human gate. */
export async function startN5Publication(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; const n5 = m.aggregate.n5;
  if (!n5) return m;
  const continuation = n5.continuation;
  const updating = Boolean(continuation && !continuation.updateAdmitted && n5.publication?.settledAt
    && m.aggregate.n2?.status === "accepted" && m.aggregate.n2.activeSubmissionId !== continuation.previousPublication.submission.submissionId);
  if (n5.publication && !updating) return n5.publication.creation === "confirmed" ? resumeN5PreWake(ctx, m) : resumeN5Creation(ctx, m);
  if (m.aggregate.n2?.ordinary) {
    const publisher = await ctx.agents.get(n5.authority.publisherAgentId, m.companyId);
    if (!publisher || publisher.adapterType !== "codex_local" || publisher.adapterConfig?.engine !== "cli"
        || ["paused", "terminated", "pending_approval"].includes(publisher.status)) {
      throw new MissionError(422, "ordinary_cli_required", "Ordinary delivery requires an available explicit CLI publisher before admission");
    }
  }
  const submission = acceptedN5Submission(m);
  await assertCurrentN5Plan(ctx, m);
  if (m.aggregate.n2?.native?.reviewProtocol && n5.authority.publisherAgentId === m.aggregate.responsibilities.integrationLeadAgentId) {
    const { assertNativeLeadWakePolicy } = await import("./n2-native-report.js");
    await assertNativeLeadWakePolicy(ctx, m, false);
  }
  const intentId = randomUUID(); const reservationId = randomUUID();
  // Persist the publication identity before variant selection so every recovery
  // reuses the same launch key instead of creating an orphan selected launch.
  m = await save(ctx, m, { ...n5, ...(updating ? { continuation: { ...continuation!, updateAdmitted: true } } : {}),
    publication: { operation: updating ? "update" : "create", targetUrl: updating ? continuation!.previousPublication.observation!.url : undefined, intentId, submission, issueId: null, runId: null, reservationId,
    settlementCommandId: randomUUID(), createdAt: new Date().toISOString(), creation: "preparing", wake: "pending", state: "pending" } });
  return resumeN5Creation(ctx, m);
}

async function resumeN5Creation(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; let p = m.aggregate.n5?.publication;
  if (!p || p.creation === "confirmed" || p.issueId) return m;
  let publisherAgentId = modelLaunch(m, p.reservationId)?.agentId ?? m.aggregate.n5!.authority.publisherAgentId;
  if (p.creation === "preparing") {
    const prepared = await prepareVariantLaunch(ctx, m, { taskKey: "delivery", interventionKey: "publisher", launchKey: p.reservationId,
      logicalAgentId: m.aggregate.n5!.authority.publisherAgentId, family: "orchestration", expectedRoles: ["publisher"] });
    m = prepared.mission; p = m.aggregate.n5!.publication!;
    publisherAgentId = prepared.binding?.agentId ?? m.aggregate.n5!.authority.publisherAgentId;
  }
  const intent = { state: "creation_claimed" as const, intentId: p.intentId, companyId: m.companyId,
    projectId: m.projectId, rootIssueId: m.rootIssueId, missionId: m.missionId, contributionId: p.intentId,
    assigneeAgentId: publisherAgentId, title: `Council delivery ${p.submission.submissionId}`,
    description: JSON.stringify({ missionId: m.missionId, intentId: p.intentId, operation: p.operation, targetUrl: p.targetUrl,
      plan: m.aggregate.n5!.plan, authority: m.aggregate.n5!.authority, submission: p.submission, instructions: n5PublisherInstructions(m) }) };
  if (p.creation === "claimed") {
    const recovered = await reconcileContributionIssueEffect(ctx, intent);
    if (recovered.state !== "confirmed") return m;
    m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...p, issueId: recovered.issue.id, creation: "confirmed" } });
    return resumeN5PreWake(ctx, m, true);
  }
  // Crossing this CAS means child creation may be attempted. Recovery after
  // this point is correlation readback only and can never issue another create.
  m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...p, creation: "claimed" } });
  p = m.aggregate.n5!.publication!;
  const created = await createContributionIssueEffect(ctx, intent);
  if (created.state !== "confirmed") return m;
  m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...p, issueId: created.issue.id, creation: "confirmed" } });
  return resumeN5PreWake(ctx, m, true);
}

async function resumeN5PreWake(ctx: PluginContext, initial: MissionRecord, newlyCreated = false) {
  let m = initial; let p = m.aggregate.n5?.publication;
  if (!p || p.creation !== "confirmed" || !p.issueId || p.runId || !m.aggregate.modelSelection && !newlyCreated) return m;
  const prior = m.aggregate.modelSelection ? modelLaunch(m, p.reservationId) : undefined;
  if (prior && !["selected", "assignment_claimed", "ready"].includes(prior.state)) return m;
  const issueId = p.issueId;
  await reserveN2Run(ctx, m, { reservationId: p.reservationId, effectId: p.intentId,
    kind: p.operation === "update" ? "correction" : "initial" });
  const prepared = prior || !m.aggregate.modelSelection ? { mission: m, binding: prior ?? null } : await prepareVariantLaunch(ctx, m, { taskKey: "delivery", interventionKey: "publisher", launchKey: p.reservationId,
    logicalAgentId: m.aggregate.n5!.authority.publisherAgentId, family: "orchestration", issueId, expectedRoles: ["publisher"] });
  m = await bindVariantIssue(ctx, prepared.mission, p.reservationId, issueId);
  p = m.aggregate.n5!.publication!;
  if (p.wake !== "claimed") {
    m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...p, wake: "claimed" } });
  }
  m = await claimVariantWake(ctx, m, p.reservationId);
  let wake: { runId: string | null };
  try {
    await ctx.issues.update(issueId, { status: "todo" }, m.companyId);
    wake = await ctx.issues.requestWakeup(issueId, m.companyId, { idempotencyKey: `council:n5:${p.intentId}`, reason: "council_n5_authorized_delivery", actorUserId: m.ownerUserId });
  } catch (error) {
    await recordVariantWake(ctx, await fresh(ctx, m), p.reservationId, null);
    throw error;
  }
  m = await fresh(ctx, m);
  return recordVariantWake(ctx, m, p.reservationId, wake.runId, (before, aggregate, effectiveRunId) => {
    const publication = aggregate.n5!.publication!;
    if (publication.runId && effectiveRunId && publication.runId !== effectiveRunId) {
      throw new MissionError(409, "n5_publisher_binding", "Publisher wake conflicts with its exact admitted run");
    }
    return save(ctx, { ...before, aggregate }, { ...aggregate.n5!, publication: {
      ...publication, runId: publication.runId ?? effectiveRunId,
    } });
  });
}

export async function reconcileN5(ctx: PluginContext, initial: MissionRecord) {
  await assertNativeRunInventory(ctx, initial);
  let m = initial;
  if (!m.aggregate.n5) return m;
  if (!m.aggregate.n5.publication || m.aggregate.n5.continuation && !m.aggregate.n5.continuation.updateAdmitted
      && m.aggregate.n2?.status === "accepted" && m.aggregate.n2.activeSubmissionId !== m.aggregate.n5.publication.submission.submissionId) return startN5Publication(ctx, m);
  let p = m.aggregate.n5.publication;
  if (!p.runId || !p.issueId) return p.creation === "confirmed" ? resumeN5PreWake(ctx, m) : resumeN5Creation(ctx, m);
  if (!p.settledAt) {
    const { profile, envelope } = await nativeN2Profile(ctx, m);
    if (!envelope.reservations.find(r => r.reservationId === p.reservationId)?.settlementReceipts.some(r => r.commandId === p.settlementCommandId)) {
      await (m.aggregate.n2?.ordinary ? settleOrdinaryRunUsage : settleNativeExactRunUsage)(ctx, { companyId: m.companyId, issueId: p.issueId,
        agentId: physicalAgent(m, m.aggregate.n5.authority.publisherAgentId, { launchKey: p.reservationId, issueId: p.issueId, runId: p.runId }),
        runId: p.runId, reservationId: p.reservationId, commandId: p.settlementCommandId, periodKey: profile.periodKey, expectedVersion: envelope.version });
    }
    m = await fresh(ctx, m); p = m.aggregate.n5!.publication!;
    m = await observeVariantRun(ctx, m, p.reservationId);
    m = await save(ctx, m, { ...m.aggregate.n5!, publication: { ...p, settledAt: new Date().toISOString() } });
  }
  if (m.aggregate.n2?.ordinary) await ctx.issues.update(p.issueId!, { status: "done" }, m.companyId);
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
  if (input.body.command === "request-delivery-correction") return requestN5Correction(ctx, m, input.body, input.actorUserId);
  const prior = runtimeReceipt(m, runtimeUuid(input.body.commandId, "commandId"), input.actorUserId, canonicalPayloadHash(input.body));
  if (prior) return { outcome: "replayed", effectPermission: "none", mission: m, receipt: prior };
  return authorize(ctx, m, input.body, input.actorUserId);
}

async function bindPublisher(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput) {
  const n5 = m.aggregate.n5; const p = n5?.publication;
  const launch = p ? modelLaunch(m, p.reservationId) : undefined;
  if (!n5 || !p || !p.issueId || input.params.issueId !== p.issueId || input.actor.actorType !== "agent"
      || input.actor.agentId !== physicalAgent(m, n5.authority.publisherAgentId, { launchKey: p.reservationId, issueId: p.issueId })
      || !input.actor.runId || p.wake !== "claimed"
      || m.aggregate.modelSelection && (!launch || !["wake_claimed", "unknown", "bound"].includes(launch.state))
      || p.runId && p.runId !== input.actor.runId) throw new MissionError(403, "n5_publisher_binding", "Exact authorized publisher child and reserved run required");
  const run = await (m.aggregate.n2?.ordinary ? readOrdinaryRun : readNativeRun)(ctx, { companyId: m.companyId, issueId: p.issueId, runId: input.actor.runId, agentId: input.actor.agentId });
  if (run.status !== "running" || !run.startedAt || run.finishedAt) throw new MissionError(409, "n5_publisher_not_running", "Publisher run must be active");
  if (p.runId) return recordVariantWake(ctx, m, p.reservationId, input.actor.runId);
  return recordVariantWake(ctx, m, p.reservationId, input.actor.runId, (before, aggregate, effectiveRunId) => save(ctx,
    { ...before, aggregate }, { ...aggregate.n5!, publication: { ...aggregate.n5!.publication!, runId: p.runId ?? effectiveRunId } }));
}
function attributedObservation(value: unknown, states: string[], actor: PluginApiRequestInput["actor"], headSha: string) {
  const v = value as Record<string, unknown>;
  if (!v || !states.includes(String(v.state)) || v.headSha !== headSha || !Array.isArray(v.evidenceRefs)
      || !v.evidenceRefs.length || v.evidenceRefs.some(r => typeof r !== "string" || !r || r.length > 1000)) throw new MissionError(422, "n5_checks_binding", "Checks/reviews need explicit state, exact head and evidence references");
  return { headSha, state: v.state, evidenceRefs: v.evidenceRefs, observedAt: new Date().toISOString(), agentId: actor.agentId ?? null, userId: actor.userId ?? null, runId: actor.runId ?? null };
}
async function holdOrdinaryPublisher(ctx: PluginContext, m: MissionRecord) {
  if (m.aggregate.n2?.ordinary) await ctx.issues.update(m.aggregate.n5!.publication!.issueId!, { status: "blocked" }, m.companyId);
}
export async function handleN5Agent(ctx: PluginContext, input: PluginApiRequestInput) {
  try {
    const body = input.body as Record<string, unknown>;
    let m = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
    if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
    if (body.command === "n5-rebind-plan") {
      const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), input.actor.agentId!, canonicalPayloadHash(body));
      if (prior) return { status: 200, body: { outcome: "replayed", effectPermission: "none", mission: m, receipt: prior } };
      return { status: 200, body: await rebindN5Plan(ctx, m, input, body) };
    }
    m = await bindPublisher(ctx, m, input);
    if (body.command === "n5-inspect") return { status: 200, body: { version: m.version, delivery: inspectN5(m) } };
    const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), input.actor.agentId!, canonicalPayloadHash(body));
    if (prior) {
      await holdOrdinaryPublisher(ctx, m);
      return { status: 200, body: { outcome: "replayed", effectPermission: "none", mission: m, receipt: prior } };
    }
    const n5 = m.aggregate.n5!; let p = n5.publication!;
    if (body.command === "n5-claim-publication") {
      if (p.claimedAt) throw new MissionError(409, "n5_effect_already_claimed", "One publication intent is already consumed; correlate readback without another effect");
      await assertNativeRunInventory(ctx, m);
      const candidate = acceptedN5Submission(m); await assertCurrentN5Plan(ctx, m);
      if (canonicalPayloadHash(candidate) !== canonicalPayloadHash(p.submission)) throw new MissionError(409, "n5_candidate_changed", "Accepted candidate changed");
      if (n5.authority.publisherPreflight) {
        const bindings = validatePublisherPreflight(m, body.preflight, input.actor.runId!);
        p = { ...p, preflight: { protocol: "publisher-run-report-v1", provenance: "publisher_run_report",
          runId: input.actor.runId!, agentId: input.actor.agentId!, recordedAt: new Date().toISOString(),
          reportSha256: canonicalPayloadHash(body.preflight), ...bindings } };
      }
      p = { ...p, state: "unknown", claimedAt: new Date().toISOString(), claimCommandId: String(body.commandId) };
    } else if (body.command === "n5-observe-delivery") {
      if (!p.claimedAt) throw new MissionError(409, "n5_intent_required", "Persist the one-shot publication intent before any effect");
      await assertCurrentN5Plan(ctx, m);
      const observation = await observeN5Native(ctx, m);
      p = { ...p, state: "opened", readbackUnavailable: undefined, observation,
        checks: body.checks ? attributedObservation(body.checks, ["unknown", "pending", "passed", "failed"], input.actor, observation.headSha) as NonNullable<typeof p.checks> : undefined,
        reviews: body.reviews ? attributedObservation(body.reviews, ["unknown", "pending", "approved", "changes_requested"], input.actor, observation.headSha) as NonNullable<typeof p.reviews> : undefined };
    } else throw new MissionError(400, "n5_unknown_command", "Unknown delivery command");
    const result = await n2CommandCas(ctx, m, body, "agent", input.actor.agentId!, { ...m.aggregate, n5: { ...n5, publication: p } });
    await holdOrdinaryPublisher(ctx, m);
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
