import { createHash, randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { canonicalSha256, L03Error } from "./l03.js";
import { L03GovernanceService, L03GovernanceStore } from "./l03-store.js";
import type { L03Actor, L03Command, L03CreateInput, L03Governance, CouncilOpinionAdmissionRequest, CouncilOpinionObservation } from "./l03-types.js";
import { ApprovalPreflightError } from "./delivery-manifest.js";
import { verifyL03Content, verifyL03Evidence } from "./l03-content.js";
import { getMission } from "./missions.js";
import { executeCouncilDecision, DecisionReceiptError, listDecisionReceipts, findDecisionReplay } from "./decision-receipts.js";
import { parseCouncilConfig } from "./decision-adapter.js";

const EXECUTIVE = "paperclip-executive.executive";
const INTERNAL = new Set(["grant-consultation-admission", "record-opinion", "record-consultation-observation", "claim-direction-effect", "record-direction-effect", "record-result-effect"]);

function actor(input: PluginApiRequestInput): L03Actor {
  if (input.actor.actorType !== "user" && input.actor.actorType !== "agent") throw new L03Error(403, "authenticated_actor_required", "A native user or agent identity is required");
  const id = input.actor.actorType === "agent" ? input.actor.agentId : input.actor.userId;
  if (!id) throw new L03Error(403, "authenticated_actor_required", "Native actor identity is missing");
  if (input.actor.actorType === "agent" && !input.actor.runId) throw new L03Error(403, "run_required", "An authenticated agent run is required");
  return { actorType: input.actor.actorType, actorId: id, userId: input.actor.userId, companyId: input.companyId };
}

function nextAction(g: L03Governance): string {
  const next: Record<L03Governance["phase"], string> = {
    awaiting_approach: "Executor submits a bounded approach against the preserved criteria.",
    collecting_approach_opinions: "Council reserves the required distinct opinions; missing or uncertain contributions keep execution blocked.",
    awaiting_approach_direction: "The final reviewer records a direction on the current approach.",
    approach_revision_required: "Executor addresses only the required gaps and submits a new approach identity.",
    awaiting_direction_effect: "Inspect the execution reservation. A missing or ambiguous wakeup response requires human investigation; do not resend.",
    executing: "Executor produces an immutable result and evidence within the assigned segment.",
    awaiting_result_review: "The final reviewer inspects the exact result and records its own decision.",
    result_correction_required: "Executor corrects the required gaps, preserves criteria and submits a new immutable result.",
    awaiting_result_effect: "Inspect the Council decision receipt; an uncertain native effect blocks dependent work.",
    accepted: "The identified result is accepted. Publication and deployment require separate authority.",
    refused: "The mission is refused; no dependent work is released.",
    escalated: "The configured owner must resolve the recorded escalation.",
    limit_exhausted: "The mission allowance is exhausted; no further admission is allowed.",
  };
  return next[g.phase];
}

function inspectL03(governance: L03Governance) {
  const decision = governance.resultDecisions.at(-1) ?? governance.approachDirections.at(-1);
  const observation = decision?.actualEffect;
  return { governance, nextAction: nextAction(governance), application: {
    status: observation ? "native observation confirmed" : decision ? "not confirmed" : "not attempted",
    observationRef: observation?.observationRef ?? null,
    note: observation ? "This observation belongs only to its recorded decision and subject." : "No native success is inferred from a stored decision, human acknowledgement or missing response.",
  } };
}

async function readApproach(ctx: PluginContext, g: L03Governance, contentRef: string, expectedHash: string) {
  // contentRef is a native issue document key, never a URL or local filesystem path.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(contentRef)) throw new L03Error(422, "invalid_approach_reference", "Approach reference must identify an issue document");
  const doc = await ctx.issues.documents.get(g.ticket.issueId, contentRef, g.companyId);
  if (!doc || createHash("sha256").update(doc.body).digest("hex") !== expectedHash) throw new L03Error(409, "approach_content_changed", "Current approach document does not match the submitted content hash");
  return doc;
}

export async function isL03GovernedIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  const rows = await ctx.db.query<{ mission_id: string }>(
    `SELECT mission_id FROM ${ctx.db.namespace}.mission_governance
      WHERE company_id = $1 AND (aggregate->'ticket'->>'issueId' = $2
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(aggregate->'results') AS result WHERE result->>'segmentIssueId' = $2)) LIMIT 1`,
    [companyId, issueId],
  );
  return rows.length > 0;
}

export function createL03Runtime(ctx: PluginContext) {
  const service = new L03GovernanceService(ctx);
  const store = new L03GovernanceStore(ctx);
  const read = async (companyId: string, missionId: string) => {
    const g = await service.get(companyId, missionId);
    if (!g) throw new L03Error(404, "governance_not_found", "L03 mission not found");
    return g;
  };
  async function list(companyId: string) {
    const receipts = await listDecisionReceipts(ctx, companyId);
    return { missions: (await store.list(companyId)).map(g => ({
      ...inspectL03(g),
      receipts: receipts.filter(r => g.receiptRefs.includes(r.operationId)),
    })) };
  }
  function positiveFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }
  function positiveInteger(value: unknown): boolean {
    return positiveFinite(value) && Number.isSafeInteger(value);
  }
  async function requireExecutorControls(g: L03Governance) {
    const agent = await ctx.agents.get(g.authority.executorAgentId, g.companyId);
    if (!agent || !["idle", "running", "active"].includes(agent.status)) {
      throw new L03Error(409, "execution_controls_missing", "Executor must be operational");
    }
    const config = agent.adapterConfig as Record<string, unknown>;
    const runtime = agent.runtimeConfig as { heartbeat?: Record<string, unknown> };
    const heartbeat = runtime?.heartbeat ?? {};
    const controls = [
      positiveFinite(config?.timeoutSec),
      heartbeat.wakeOnDemand === true,
      heartbeat.maxConcurrentRuns === 1,
      positiveInteger(heartbeat.maxDailyRuns),
      positiveInteger(heartbeat.maxDailyCostCents),
    ];
    if (!controls.every(Boolean)) {
      throw new L03Error(409, "execution_controls_missing", "Executor requires a positive timeout, explicit on-demand wake, concurrency one and finite daily run/cost thresholds");
    }
  }
  async function release(g: L03Governance, a: L03Actor, runId: string, decisionId: string) {
    const approach = g.approaches.find(p => p.approachId === g.activeApproachId);
    if (!approach) throw new L03Error(409, "approach_missing", "No current approach exists");
    await readApproach(ctx, g, approach.contentRef, approach.contentHash);
    const issue = await ctx.issues.get(g.ticket.issueId, g.companyId);
    if (!issue || issue.companyId !== g.companyId || issue.assigneeAgentId !== g.authority.executorAgentId) throw new L03Error(409, "segment_assignee_changed", "Bounded issue is no longer assigned to the pinned executor");
    await requireExecutorControls(g);
    const hold = (await listDecisionReceipts(ctx, g.companyId)).find(r => r.issueId === g.ticket.issueId && r.state === "indeterminate");
    if (hold) throw new L03Error(409, "issue_decision_indeterminate", "An uncertain retained Council receipt blocks execution for this issue");
    const attemptId = randomUUID();
    const claimed = await service.apply(g.companyId, g.missionId, a, { type: "claim-direction-effect", expectedVersion: g.version, decisionId, attemptId });
    await service.assertCurrent(g.companyId, g.missionId, a);
    // No catch/retry can release this reservation. A missing response remains blocked.
    const observation = await ctx.issues.requestWakeup(issue.id, g.companyId, {
      reason: `L03 approach ${approach.approachId}; decision ${decisionId}; attempt ${attemptId}`,
      idempotencyKey: attemptId, actorAgentId: a.actorId, actorRunId: runId,
    });
    if (!observation.queued || !observation.runId) return claimed;
    return service.apply(g.companyId, g.missionId, a, { type: "record-direction-effect", expectedVersion: claimed.version, decisionId }, {
      actualEffectObservation: { decisionId, status: "confirmed", receiptRef: attemptId,
        observationRef: `paperclip:run:${observation.runId}`, observedAt: new Date().toISOString() },
    });
  }
  async function applyResult(g: L03Governance, a: L03Actor, runId: string) {
    const decision = g.resultDecisions.at(-1);
    const result = g.results.at(-1);
    if (!decision || !result || !["accept", "revise"].includes(decision.verdict)) return g;
    await verifyL03Content(ctx, g.companyId, { ...result, issueId: result.segmentIssueId });
    if (decision.verdict === "revise") await requireExecutorControls(g);
    const config = parseCouncilConfig(await ctx.config.get(g.companyId));
    if (config.councilAgentId !== a.actorId) throw new L03Error(403, "reviewer_config_changed", "Configured native Council actor differs from the final reviewer");
    const current = await service.assertCurrent(g.companyId, g.missionId, a);
    if (current.version !== g.version) throw new L03Error(409, "governance_changed", "Governance changed before native application");
    const issue = await ctx.issues.get(result.segmentIssueId, g.companyId);
    if (!issue || issue.status !== "in_review" || issue.assigneeAgentId !== a.actorId) throw new L03Error(409, "review_target_changed", "Exact result issue is not pending this reviewer");
    const observed = await executeCouncilDecision(ctx, config, {
      companyId: g.companyId, issueId: result.segmentIssueId, operationId: decision.receiptRef,
      actorAgentId: a.actorId, runId, ...(decision.verdict === "accept" ? { verdict: "approved" as const, approvedCommit: result.candidateCommit } : { verdict: "changes_requested" as const }),
      justification: decision.rationale, resultReference: `l03:${g.missionId}:${result.resultId}:${result.candidateCommit}`,
    });
    if (observed.receipt.state !== "native_observed" || !observed.receipt.nativeObservation?.usable) return g;
    return service.apply(g.companyId, g.missionId, a, { type: "record-result-effect", expectedVersion: g.version, decisionId: decision.decisionId }, {
      actualEffectObservation: { decisionId: decision.decisionId, status: "confirmed", receiptRef: observed.receipt.operationId,
        observationRef: `council:receipt:${observed.receipt.operationId}`, observedAt: observed.receipt.nativeObservation.observedAt },
    });
  }
  async function command(input: PluginApiRequestInput) {
    const a = actor(input);
    const missionId = input.params.missionId;
    const body = input.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new L03Error(400, "invalid_command", "Command must be an object");
    if (input.routeKey === "l03-create") {
      if (body.councilAgentId !== body.finalReviewerAgentId || body.executivePluginActorId !== EXECUTIVE) throw new L03Error(422, "actor_binding_invalid", "L03 requires one configured final Council reviewer and the installed Executive plugin");
      const config = parseCouncilConfig(await ctx.config.get(input.companyId));
      if (config.councilAgentId !== body.finalReviewerAgentId) throw new L03Error(409, "reviewer_config_mismatch", "Native Council configuration must identify the final reviewer");
      const ticket = (body as unknown as L03CreateInput).ticket;
      const contentHash = createHash("sha256").update(ticket.suppliedContext.content).digest("hex");
      if (ticket.sourceHash !== contentHash || ticket.suppliedContext.sourceHash !== contentHash) throw new L03Error(422, "context_hash_mismatch", "Ticket hashes must bind the supplied context snapshot");
      const created = await service.create({ ...body, companyId: input.companyId } as L03CreateInput, a);
      return inspectL03(created);
    }
    if (!missionId) throw new L03Error(400, "mission_required", "Mission ID is required");
    const before = await read(input.companyId, missionId);
    if (body.type === "reconcile-result-observation") {
      await service.assertCurrent(input.companyId, missionId, a);
      if (a.actorType !== "agent" || a.actorId !== before.authority.councilAgentId) throw new L03Error(403, "council_required", "Configured Council actor required");
      const decision = before.resultDecisions.at(-1); const result = before.results.at(-1);
      if (!decision || !result) throw new L03Error(409, "result_decision_missing", "No stored result decision");
      if (!["accept", "revise"].includes(decision.verdict)) return inspectL03(before);
      const config = parseCouncilConfig(await ctx.config.get(input.companyId));
      if (config.councilAgentId !== a.actorId) throw new L03Error(403, "reviewer_config_changed", "Configured reviewer changed");
      const replay = await findDecisionReplay(ctx, config, {
        companyId: input.companyId, issueId: result.segmentIssueId, operationId: decision.receiptRef,
        actorAgentId: a.actorId, runId: input.actor.runId!,
        ...(decision.verdict === "accept" ? { verdict: "approved" as const, approvedCommit: result.candidateCommit } : { verdict: "changes_requested" as const }),
        justification: decision.rationale, resultReference: `l03:${before.missionId}:${result.resultId}:${result.candidateCommit}`,
      });
      const receipt = replay?.receipt;
      // Read only: absence or uncertainty never causes another native attempt.
      if (!receipt || receipt.state !== "native_observed" || !receipt.nativeObservation?.usable || decision.actualEffect) return inspectL03(before);
      return inspectL03(await service.apply(input.companyId, missionId, a, { type: "record-result-effect", expectedVersion: before.version, decisionId: decision.decisionId }, {
        actualEffectObservation: { decisionId: decision.decisionId, status: "confirmed", receiptRef: receipt.operationId, observationRef: `council:receipt:${receipt.operationId}`, observedAt: receipt.nativeObservation.observedAt },
      }));
    }
    if (body.type === "reemit-reservation") {
      await service.assertCurrent(input.companyId, missionId, a);
      const mission = await getMission(ctx, input.companyId, missionId);
      if (!mission || (a.actorId !== before.authority.councilAgentId && a.userId !== before.authority.ownerUserId)) throw new L03Error(403, "council_or_owner_required", "Council or owner required");
      if (mission.version !== before.missionVersion || Date.parse(before.authority.expiresAt) <= Date.now()) throw new L03Error(409, "mandate_changed", "Mandate is no longer current");
      const slot = before.consultationSlots.find(s => s.slot.reservationId === body.reservationId);
      if (!slot) throw new L03Error(404, "reservation_missing", "Reservation not found");
      await ctx.events.emit("opinion-slot-reserved.v1", input.companyId, slot.slot);
      return inspectL03(await read(input.companyId, missionId));
    }
    if (INTERNAL.has(String(body.type))) throw new L03Error(403, "internal_observation_only", "Native observations are never accepted from request JSON");
    const cmd = body as unknown as L03Command;
    if (cmd.type === "submit-approach") {
      await readApproach(ctx, before, cmd.approach.contentRef, cmd.approach.contentHash);
      await verifyL03Evidence(ctx, input.companyId, before.ticket.issueId, cmd.approach.evidenceRefs);
    }
    if (cmd.type === "reserve-consultation") {
      const approach = before.approaches.find(p => p.approachId === before.activeApproachId);
      if (!approach || cmd.reservation.context.sourceRef !== approach.contentRef || cmd.reservation.context.sourceHash !== approach.contentHash) throw new L03Error(422, "consultation_context_mismatch", "Consultation must reference the exact current approach");
      const doc = await readApproach(ctx, before, approach.contentRef, approach.contentHash);
      if (doc.body !== cmd.reservation.context.content || !cmd.reservation.evidenceRefs.every(ref => approach.evidenceRefs.includes(ref))) throw new L03Error(422, "consultation_evidence_mismatch", "Consultation context or evidence differs from the current approach");
      await verifyL03Evidence(ctx, input.companyId, before.ticket.issueId, cmd.reservation.evidenceRefs);
    }
    if (cmd.type === "submit-result") {
      // V1 releases the root issue as its bounded segment; arbitrary sibling issues are not authorized.
      if (cmd.result.segmentIssueId !== before.ticket.issueId) throw new L03Error(422, "segment_not_authorized", "Result must target the released issue");
      await verifyL03Content(ctx, input.companyId, { ...cmd.result, issueId: cmd.result.segmentIssueId });
    }
    if (cmd.type === "decide-result") {
      const result = before.results.find(r => r.resultId === cmd.resultId);
      if (result) await verifyL03Content(ctx, input.companyId, { ...result, issueId: result.segmentIssueId });
    }
    let updated = await service.apply(input.companyId, missionId, a, cmd);
    if (cmd.type === "reserve-consultation") await ctx.events.emit("opinion-slot-reserved.v1", input.companyId, cmd.reservation);
    if (cmd.type === "decide-approach" && cmd.verdict === "proceed") updated = await release(updated, a, input.actor.runId!, cmd.decisionId);
    if (cmd.type === "decide-result") updated = await applyResult(updated, a, input.actor.runId!);
    return inspectL03(updated);
  }
  async function api(input: PluginApiRequestInput) {
    try {
      if (input.params.companyId !== input.companyId) throw new L03Error(403, "company_scope_mismatch", "Path company differs from authenticated scope");
      if (input.routeKey === "l03-list") return { status: 200, body: await list(input.companyId) };
      return { status: 200, body: await command(input) };
    } catch (error) {
      if (error instanceof ApprovalPreflightError) return { status: error.status, body: { error: error.message, code: "content_preflight_failed" } };
      if (error instanceof TypeError) return { status: 422, body: { error: "Malformed L03 command", code: "invalid_command" } };
      if (error instanceof L03Error || error instanceof DecisionReceiptError) return { status: error.status, body: { error: error.message, code: error.code } };
      throw error;
    }
  }
  function pluginActor(event: PluginEvent): L03Actor {
    if (event.actorType !== "plugin" || event.actorId !== EXECUTIVE || !event.companyId) throw new L03Error(403, "executive_plugin_required", "Only the host-authenticated Executive plugin can import contributions");
    return { actorType: "plugin", actorId: EXECUTIVE, companyId: event.companyId };
  }
  async function eventMutation(companyId: string, missionId: string, a: L03Actor, command: (g: L03Governance) => L03Command) {
    // Host event notifications overlap and have no subscriber acknowledgement.
    // Retry only stale local persistence. Never retry a native send or change event identity.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await read(companyId, missionId);
      try { return await service.apply(companyId, missionId, a, command(before)); }
      catch (error) {
        if (!(error instanceof L03Error) || !["version_conflict", "version_or_mandate_conflict"].includes(error.code) || attempt === 7) throw error;
      }
    }
    throw new Error("Unreachable bounded event retry");
  }
  async function admission(event: PluginEvent) {
    const a = pluginActor(event); const request = event.payload as CouncilOpinionAdmissionRequest;
    const grantId = randomUUID();
    const g = await eventMutation(event.companyId, request.missionId, a, before => {
      const slot = before.consultationSlots.find(s => s.slot.reservationId === request.reservationId);
      if (!slot) throw new L03Error(404, "reservation_missing", "Reservation not found");
      return {
        type: "grant-consultation-admission", expectedVersion: before.version, request, grantId,
        grantExpiresAt: new Date(Math.min(Date.now() + 45_000, Date.parse(slot.slot.expiresAt))).toISOString(), slotHash: canonicalSha256(slot.slot),
      };
    });
    const grant = g.consultationSlots.find(s => s.slot.reservationId === request.reservationId)?.admissionGrant;
    if (grant) await ctx.events.emit("opinion-slot-admission-granted.v1", event.companyId, grant);
  }
  async function observed(event: PluginEvent) {
    const a = pluginActor(event); const observation = event.payload as CouncilOpinionObservation;
    await eventMutation(event.companyId, observation.missionId, a, before => ({
      type: "record-consultation-observation", expectedVersion: before.version, observation,
    }));
  }

  function register() {
    ctx.data.register("council-l03", async params => {
      if (typeof params.companyId !== "string") throw new L03Error(403, "company_required", "Host company scope required");
      return list(params.companyId);
    });
    ctx.events.on(`plugin.${EXECUTIVE}.opinion-slot-admission-requested.v1`, admission);
    ctx.events.on(`plugin.${EXECUTIVE}.opinion-observed.v1`, observed);
  }
  return { api, register, admission, observed, list };
}
