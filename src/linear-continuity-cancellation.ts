import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, n2CommandCas, nativeN2Profile, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { bindPublisher, resumeN5Creation } from "./n5-runtime.js";
import { settleOrdinaryRunUsage } from "./g4-native.js";
import { physicalAgent } from "./model-state.js";
import { linearPublicationState, saveLinearContinuity } from "./linear-continuity-transport.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { z } from "@paperclipai/plugin-sdk";
import { FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";
import { uncertainLinearEffects } from "./linear-continuity-control.js";
import { campaignCancellationSummary } from "./linear-cancellation-summary.js";

const reportSchema = z.object({ protocol: z.literal("publisher-cancellation-report-v1"), companyId: z.string().uuid(), missionId: z.string().uuid(),
  intentId: z.string().uuid(), issueId: z.string().uuid(), runId: z.string().uuid(), repository: z.string(), url: z.string().url(),
  candidateCommit: z.string().regex(/^[a-f0-9]{40}$/), state: z.enum(["open", "closed", "merged"]), observedAt: z.string().datetime({ offset: true }) }).strict();

async function readCancellationNode(ctx: PluginContext, m: MissionRecord, node: import("./hierarchy-contract.js").HierarchyNode) {
  const issue = await ctx.issues.get(node.issueId, m.companyId);
  const expected = { companyId: m.companyId, projectId: m.projectId, parentId: node.parentId, assigneeAgentId: node.assigneeAgentId };
  if (!issue || Object.entries(expected).some(([k,v]) => (issue[k as keyof typeof issue] ?? null) !== v)
      || issue.checkoutRunId || issue.executionRunId) throw new MissionError(409, "linear_cancel_node_identity", "Only original idle product nodes may be cancelled at the safe point");
  return issue;
}
async function closeRemainingProductNodes(ctx: PluginContext, m: MissionRecord) {
  const nodes = m.aggregate.hierarchy?.nodes ?? [];
  if (!nodes.length) throw new MissionError(409, "linear_cancel_tree_missing", "Original native product nodes must be known before cancellation");
  for (const node of [...nodes].reverse()) {
    const issue = await readCancellationNode(ctx, m, node);
    if (["done", "cancelled"].includes(issue.status)) continue;
    const state = m.aggregate.linearContinuity!, effects = state.cancelledNodes ?? [];
    if (effects.some(item => item.issueId === issue.id && item.state === "claimed")) throw new MissionError(409, "linear_cancel_node_unknown", "Original cancellation was claimed; readback only, never repeat an uncertain update");
    m = await saveLinearContinuity(ctx, m, { ...state, cancelledNodes: [...effects, { issueId: issue.id, state: "claimed" }] });
    await ctx.issues.update(issue.id, { status: "cancelled" }, m.companyId);
    if ((await ctx.issues.get(issue.id, m.companyId))?.status !== "cancelled") throw new MissionError(409, "linear_cancel_node_unknown", "Native cancellation is not observed; retain original effect");
  }
  const state = m.aggregate.linearContinuity!;
  return saveLinearContinuity(ctx, m, { ...state, cancelledNodes: (state.cancelledNodes ?? []).map(item => ({ ...item, state: "confirmed" })) });
}
async function admitCancellationPublisher(ctx: PluginContext, m: MissionRecord) {
  const state = m.aggregate.linearContinuity!, n5 = m.aggregate.n5!, previous = n5.publication!;
  if (!previous.settledAt || !previous.observation?.matchesCandidate) throw new MissionError(409, "linear_cancel_pr_pending", "Original admitted publication and its exact PR must be reconciled first");
  if (previous.observation.state !== "open") throw new MissionError(409, "linear_cancel_pr_state", "Unexpected external PR state requires readback; no integration success is inferred");
  const publication = { operation: "cancel-pr" as const, targetUrl: previous.observation.url, intentId: randomUUID(), submission: previous.submission,
    issueId: null, runId: null, reservationId: randomUUID(), settlementCommandId: randomUUID(),
    createdAt: new Date().toISOString(), creation: "preparing" as const, wake: "pending" as const, state: "pending" as const };
  m = await n2Cas(ctx, m, { ...m.aggregate, linearContinuity: { ...state, cancellation: { previousPublication: previous, state: "pending" } }, n5: { ...n5, publication } });
  return resumeN5Creation(ctx, m);
}
export async function reconcileLinearCancellation(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; const state = m.aggregate.linearContinuity!;
  if (state.control !== "cancel_requested") return m;
  const n5 = m.aggregate.n5, p = n5?.publication;
  const manualCleanup = state.mode === FIXED_CAMPAIGN_MODE;
  if (manualCleanup && uncertainLinearEffects(m)) throw new MissionError(409, "linear_cancel_effect_unknown", "Reconcile original effects before cancellation; open PR cleanup remains manual");
  if (!manualCleanup && n5?.integration?.state !== "verified" && p?.claimedAt) {
    if (!state.cancellation) return admitCancellationPublisher(ctx, m);
    m = await reconcileCancellationPublisher(ctx, m);
    if (m.aggregate.linearContinuity!.cancellation?.state !== "closed" || !m.aggregate.n5?.publication?.settledAt) return m;
  }
  if (n5?.integration?.mergeClaimedAt && !n5.integration.report) throw new MissionError(409, "linear_cancel_merge_unknown", "Read the original merge outcome; cancellation never assumes it did not happen");
  const cancellationSummary = manualCleanup ? await campaignCancellationSummary(ctx, m) : undefined;
  m = await closeRemainingProductNodes(ctx, m);
  const subject = { ...m, aggregate: { ...m.aggregate, linearContinuity: { ...m.aggregate.linearContinuity!, control: "cancelled" as const } } };
  return saveLinearContinuity(ctx, m, linearPublicationState(subject, "cancellation", { workResultAcquired: false, campaignSuccess: false,
    integratedCommitRetained: m.aggregate.n5?.integration?.report?.integratedCommit ?? null, cancelledNodes: m.aggregate.linearContinuity!.cancelledNodes,
    ...(manualCleanup ? { pullRequestCleanup: "manual", openPullRequest: p?.observation?.state === "open" ? p.observation.url : null, cancellationSummary } : {}) }));
}
export async function reconcileCancellationPublisher(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; const p = m.aggregate.n5!.publication!;
  if (!p.issueId || !p.runId) return resumeN5Creation(ctx, m);
  if (!p.settledAt) {
    const { profile, envelope } = await nativeN2Profile(ctx, m);
    await settleOrdinaryRunUsage(ctx, { companyId: m.companyId, issueId: p.issueId, runId: p.runId,
      agentId: physicalAgent(m, m.aggregate.n5!.authority.publisherAgentId, { launchKey: p.reservationId, runId: p.runId }),
      commandId: p.settlementCommandId, reservationId: p.reservationId, periodKey: profile.periodKey, expectedVersion: envelope.version });
    m = (await getMission(ctx, m.companyId, m.missionId))!;
    m = await n2Cas(ctx, m, { ...m.aggregate, n5: { ...m.aggregate.n5!, publication: { ...m.aggregate.n5!.publication!, settledAt: new Date().toISOString() } } });
  }
  if (m.aggregate.linearContinuity!.cancellation?.state === "closed") await ctx.issues.update(p.issueId, { status: "done" }, m.companyId);
  return m;
}
export async function handleCancellationRequest(ctx: PluginContext, input: PluginApiRequestInput) {
  const body = input.body as Record<string, unknown>, initial = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
  if (!initial) throw new MissionError(404, "mission_not_found", "Mission not found");
  const m = await bindPublisher(ctx, initial, input), p = m.aggregate.n5!.publication!, state = m.aggregate.linearContinuity!;
  if (p.operation !== "cancel-pr" || state?.control !== "cancel_requested" || !state.cancellation) throw new MissionError(403, "linear_cancel_actor", "Exact separately admitted cancellation publisher required");
  const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), input.actor.agentId!, canonicalPayloadHash(body));
  if (prior) return { status: 200, body: { outcome: "replayed", effectPermission: "none", mission: m, receipt: prior } };
  const report = reportSchema.parse(body.report), expected = { companyId: m.companyId, missionId: m.missionId, intentId: p.intentId,
    issueId: p.issueId, runId: p.runId, repository: m.aggregate.n5!.authority.repository, url: p.targetUrl, candidateCommit: p.submission.candidateCommit };
  if (Object.entries(expected).some(([k,v]) => report[k as keyof typeof report] !== v) || Date.parse(report.observedAt) < Date.parse(p.createdAt)
      || Date.now() - Date.parse(report.observedAt) > 300_000 || Date.parse(report.observedAt) > Date.now() + 5000) throw new MissionError(409, "linear_cancel_report", "Fresh exact PR/head and admitted actor readback required");
  if (body.command === "n5-claim-cancellation") {
    await assertProjectDeparture(ctx, m, p.reservationId);
    if (state.cancellation.claimedAt || report.state !== "open") throw new MissionError(409, "linear_cancel_effect_claimed", "Only one close of the exact still-open PR is allowed");
    const result = await n2CommandCas(ctx, m, body, "agent", input.actor.agentId!, { ...m.aggregate, linearContinuity: { ...state,
      cancellation: { ...state.cancellation, claimedAt: new Date().toISOString(), claimCommandId: String(body.commandId), state: "unknown" } } });
    return { status: 200, body: { ...result, effectPermission: result.outcome === "applied" ? "execute" : "none" } };
  }
  if (!state.cancellation.claimedAt || report.state === "merged" || Date.parse(report.observedAt) < Date.parse(state.cancellation.claimedAt)) throw new MissionError(409, "linear_cancel_readback", "Read the original close outcome; an unexpected merge remains distinct");
  const result = await n2CommandCas(ctx, m, body, "agent", input.actor.agentId!, { ...m.aggregate, linearContinuity: { ...state,
    cancellation: { ...state.cancellation, report, state: report.state === "closed" ? "closed" : "unknown" } } });
  await ctx.issues.update(p.issueId!, { status: "blocked" }, m.companyId);
  return { status: 200, body: { ...result, effectPermission: "none" } };
}
