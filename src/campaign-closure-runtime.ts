import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { readOrdinaryRunSummary } from "./n2-ordinary-report.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, nativeN2Profile, reserveN2Run } from "./n2-missions.js";
import { bindVariantIssue, claimVariantWake, observeVariantRun, prepareVariantLaunch, recordVariantWake } from "./model-runtime.js";
import { physicalAgent } from "./model-state.js";
import { linearPublicationState } from "./linear-continuity-transport.js";
import { readLinearProof } from "./linear-continuity-documents.js";
import { assertLinearContinuityDeparture } from "./linear-continuity-control.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { campaignMembersSafe, listCampaignMembers } from "./repository-campaign.js";
import { assertCampaignClosureReadback, campaignClosureFingerprint, validateCampaignReviewReport,
  type CampaignClosureState, type CampaignReviewTask } from "./campaign-closure-contract.js";
import { assertIndependentCampaignReviewer, campaignTerminalStatusUpdates, currentCampaignClosureSubject } from "./campaign-closure-subject.js";

const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;

export function campaignReviewInstructions(m: MissionRecord, state: CampaignClosureState) {
  return `Begin with exactly {"command":"campaign-review-inspect","missionId":"${m.missionId}"}. Read every source document selector and current delivery proof in inspection.campaignClosure.subject. Reuse the attributed leaf reviews; do not rerun every PR review or form a committee. Finish the exact admitted run with one JSON object only: {"schema":"council-linear-campaign-review-report-v1","campaignRootMissionId":"${m.missionId}","taskId":"${state.task.taskId}","sourceSha256":"${state.subject.sourceSha256}","mandateSha256":"${state.subject.mandateSha256}","coverageSha256":"${state.subject.coverageSha256}","resultsSha256":"${state.subject.resultsSha256}","verdict":"approved|blocked","rows":[{"criterionId":"<every criterionId exactly once>","sourceSha256":"<its exact sourceSha256>","deliveryOrObligationIds":["delivery:<missionId> or transverse:campaign"],"verification":{"environment":"<where checked>","method":"<what was checked>"},"result":"satisfied|unsatisfied|unknown","proofIds":["<only allowedProofIds>"],"remainder":null|"<explicit gap>"}]}. Approval requires every row satisfied with current proof and null remainder. Do not submit a verdict command; the terminal run readback is the only verdict.`;
}

function saveClosure(ctx: PluginContext, m: MissionRecord, closure: CampaignClosureState) {
  return n2Cas(ctx, m, { ...m.aggregate, campaignClosure: closure });
}

function replaceTask(state: CampaignClosureState, task: CampaignReviewTask): CampaignClosureState {
  return { ...state, task };
}

function closureOrder(root: MissionRecord, memberIssueIds: Set<string>) {
  const pending = (root.aggregate.hierarchy?.nodes ?? []).filter(node => !node.historicalStatus && !memberIssueIds.has(node.issueId));
  const ordered: typeof pending = [];
  while (pending.length) {
    const index = pending.findIndex(node => !pending.some(child => child.parentId === node.issueId));
    if (index < 0) throw new MissionError(409, "campaign_close_cycle", "Native campaign parents must remain acyclic before terminal closure");
    ordered.push(pending.splice(index, 1)[0]!);
  }
  if (!ordered.length || ordered.at(-1)!.issueId !== root.rootIssueId) {
    throw new MissionError(409, "campaign_close_root", "The campaign root must be the final native node closed");
  }
  return ordered.map(node => ({ issueId: node.issueId, state: "pending" as const }));
}

async function beginReview(ctx: PluginContext, initial: MissionRecord) {
  let m = initial;
  if (m.aggregate.linearContinuity!.publications.some(item => !item.acknowledgement)) return m;
  await assertLinearContinuityDeparture(ctx, m);
  if (!await campaignMembersSafe(ctx, m, "closed")) throw new MissionError(409, "campaign_review_members", "Every delivery must be safely proof-closed before the global review");
  const members = await listCampaignMembers(ctx, m);
  const subject = await currentCampaignClosureSubject(ctx, m);
  const task: CampaignReviewTask = { taskId: randomUUID(), agentId: m.aggregate.responsibilities.finalReviewerAgentId,
    issueId: null, creation: "pending", reservationId: randomUUID(), settlementCommandId: randomUUID(), runId: null, wake: "pending" };
  const closure: CampaignClosureState = { protocol: "council-linear-campaign-closure-v1", phase: "reviewing", subject, task,
    proofDocument: { key: `council-campaign-closure-${m.missionId}`, body: "" },
    nativeClosures: closureOrder(m, new Set(members.map(member => member.rootIssueId))) };
  return saveClosure(ctx, m, closure);
}

async function dispatchReview(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; let state = m.aggregate.campaignClosure!; let task = state.task;
  if (task.wake === "claimed" || !task.issueId && task.creation !== "pending") {
    throw new MissionError(409, "campaign_review_effect_unknown", "Retain the original claimed review task or wake; no replacement is allowed");
  }
  const prepared = await prepareVariantLaunch(ctx, m, { taskKey: "campaign-global-review", interventionKey: "reviewer",
    launchKey: task.reservationId, logicalAgentId: task.agentId, family: "review", expectedRoles: ["generalist-reviewer"],
    ...(task.issueId ? { issueId: task.issueId } : {}) });
  m = prepared.mission; state = m.aggregate.campaignClosure!; task = state.task;
  const reviewerAgentId = prepared.binding?.agentId ?? task.agentId;
  assertIndependentCampaignReviewer(m, await listCampaignMembers(ctx, m), reviewerAgentId);
  if (!task.issueId) {
    task = { ...task, creation: "claimed" }; m = await saveClosure(ctx, m, replaceTask(state, task));
    const issue = await ctx.issues.create({ companyId: m.companyId, projectId: m.projectId, status: "backlog",
      assigneeAgentId: reviewerAgentId, title: `Council global campaign review: ${m.missionId}`,
      description: campaignReviewInstructions(m, m.aggregate.campaignClosure!), inheritExecutionWorkspaceFromIssueId: m.rootIssueId,
      originKind: "plugin:private.paperclip-council:campaign-review", originId: task.taskId });
    task = { ...task, issueId: issue.id, creation: "confirmed" };
    m = await saveClosure(ctx, m, replaceTask(m.aggregate.campaignClosure!, task));
  }
  await reserveN2Run(ctx, m, { reservationId: task.reservationId, effectId: task.taskId, kind: "initial" });
  m = await bindVariantIssue(ctx, m, task.reservationId, task.issueId!);
  state = m.aggregate.campaignClosure!; task = state.task;
  m = await claimVariantWake(ctx, m, task.reservationId, (before, aggregate) => n2Cas(ctx, before, {
    ...aggregate, campaignClosure: replaceTask(state, { ...task, wake: "claimed" }) }));
  task = m.aggregate.campaignClosure!.task;
  let wake: { runId: string | null };
  try {
    await ctx.issues.update(task.issueId!, { status: "todo" }, m.companyId);
    wake = await ctx.issues.requestWakeup(task.issueId!, m.companyId, { idempotencyKey: `council:campaign-review:${task.taskId}`,
      reason: "council_campaign_global_review_admitted", actorUserId: m.ownerUserId });
  } catch (error) {
    await recordVariantWake(ctx, await fresh(ctx, m), task.reservationId, null);
    throw error;
  }
  m = await fresh(ctx, m); state = m.aggregate.campaignClosure!; task = state.task;
  m = await recordVariantWake(ctx, m, task.reservationId, wake.runId, (before, aggregate, runId) => n2Cas(ctx, before, {
    ...aggregate, campaignClosure: replaceTask(state, { ...task, runId }) }));
  if (!m.aggregate.campaignClosure!.task.runId) throw new MissionError(409, "campaign_review_effect_unknown", "The exact admitted reviewer run must be observed");
  return m;
}

function parsedSummary(value: unknown) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value)); }
  catch { throw new MissionError(409, "campaign_review_report", "The exact terminal campaign review JSON report is required"); }
}

async function blockedReview(ctx: PluginContext, m: MissionRecord, reason: string, report?: CampaignClosureState["report"]) {
  const state = m.aggregate.campaignClosure!, task = { ...state.task, settledAt: new Date().toISOString() };
  const next: CampaignClosureState = { ...state, phase: "blocked", task, blockedReason: reason,
    ...(report ? { report, reportSha256: canonicalPayloadHash(report) } : {}) };
  const content = { campaignReview: { schema: "council-linear-campaign-review-blocker-v1",
    campaignRootMissionId: m.missionId, reason,
    coverage: state.subject.coverage.map(item => ({ criterionId: item.criterionId, kind: item.kind,
      label: item.label, sourceSha256: item.sourceSha256 })),
    results: state.subject.results.map(item => ({ resultId: item.resultId, sourceId: item.sourceId,
      missionId: item.missionId, proofId: item.proofId, integratedResult: item.integratedResult })),
    ...(report ? { report, reportSha256: canonicalPayloadHash(report) } : {}) } };
  const linearContinuity = linearPublicationState(m, "blocker", content);
  m = await n2Cas(ctx, m, { ...m.aggregate, linearContinuity, campaignClosure: next });
  await ctx.issues.update(task.issueId!, { status: "blocked" }, m.companyId);
  return m;
}

async function settleReview(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; let state = m.aggregate.campaignClosure!; const task = state.task;
  const reviewerAgentId = physicalAgent(m, task.agentId, { launchKey: task.reservationId, issueId: task.issueId!, runId: task.runId! });
  const identity = { companyId: m.companyId, issueId: task.issueId!, runId: task.runId!, agentId: reviewerAgentId };
  const run = await readOrdinaryRun(ctx, identity);
  if (!terminal.has(run.status)) return m;
  const { profile, envelope } = await nativeN2Profile(ctx, m);
  await settleOrdinaryRunUsage(ctx, { ...identity, periodKey: profile.periodKey, reservationId: task.reservationId,
    commandId: task.settlementCommandId, expectedVersion: envelope.version });
  m = await fresh(ctx, m); state = m.aggregate.campaignClosure!;
  m = await observeVariantRun(ctx, m, task.reservationId);
  if (run.status !== "succeeded") return blockedReview(ctx, m, `review_run_${run.status}`);
  let report;
  try {
    const current = await currentCampaignClosureSubject(ctx, m);
    if (campaignClosureFingerprint(current) !== campaignClosureFingerprint(state.subject)) {
      return blockedReview(ctx, m, "review_subject_stale");
    }
    report = validateCampaignReviewReport(state.subject, task.taskId, parsedSummary(await readOrdinaryRunSummary(ctx, run)));
  } catch (error) {
    return blockedReview(ctx, m, error instanceof MissionError ? error.code : "campaign_review_report");
  }
  if (report.verdict !== "approved") return blockedReview(ctx, m, "global_coverage_incomplete", report);
  const proofBody = JSON.stringify({ schema: "council-linear-campaign-closure-proof-v1",
    subjectFingerprint: campaignClosureFingerprint(state.subject), subject: state.subject, report,
    reportSha256: canonicalPayloadHash(report) }, null, 2);
  const next: CampaignClosureState = { ...m.aggregate.campaignClosure!, phase: "reviewed",
    task: { ...m.aggregate.campaignClosure!.task, settledAt: new Date().toISOString() }, report,
    reportSha256: canonicalPayloadHash(report), proofDocument: { ...state.proofDocument, body: proofBody } };
  m = await saveClosure(ctx, m, next);
  await ctx.issues.update(task.issueId!, { status: "blocked" }, m.companyId);
  return m;
}

async function ensureProofDocument(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; const state = m.aggregate.campaignClosure!, proof = state.proofDocument;
  let document = await ctx.issues.documents.get(m.rootIssueId, proof.key, m.companyId);
  if (!document) {
    if (proof.revisionId) throw new MissionError(409, "campaign_close_proof_missing", "Retain the confirmed global proof document identity");
    await ctx.issues.documents.upsert({ issueId: m.rootIssueId, companyId: m.companyId, key: proof.key,
      title: "Council — bilan global de campagne", format: "markdown", body: proof.body });
    document = await ctx.issues.documents.get(m.rootIssueId, proof.key, m.companyId);
  }
  if (!document?.latestRevisionId || document.body !== proof.body) throw new MissionError(409, "campaign_close_proof_unknown", "The exact global proof document must be observed without replacement");
  if (!proof.revisionId) m = await saveClosure(ctx, m, { ...state, proofDocument: { ...proof, revisionId: document.latestRevisionId } });
  return m;
}

async function queueClosurePublication(ctx: PluginContext, initial: MissionRecord) {
  await assertProjectDeparture(ctx, initial);
  let m = await ensureProofDocument(ctx, initial); let state = m.aggregate.campaignClosure!;
  await assertProjectDeparture(ctx, m);
  const current = await currentCampaignClosureSubject(ctx, m);
  if (campaignClosureFingerprint(current) !== campaignClosureFingerprint(state.subject)) {
    return blockedReview(ctx, m, "review_subject_stale", state.report);
  }
  const statusUpdates = await campaignTerminalStatusUpdates(ctx, m);
  const report = state.report!;
  const content = { campaignClosure: { schema: "council-linear-campaign-closure-result-v1",
    campaignRootMissionId: m.missionId,
    summary: { verdict: report.verdict, total: report.rows.length,
      satisfied: report.rows.filter(row => row.result === "satisfied").length,
      remaining: report.rows.filter(row => row.result !== "satisfied").length },
    coverage: state.subject.coverage.map(item => ({ criterionId: item.criterionId, kind: item.kind,
      label: item.label, sourceSha256: item.sourceSha256 })),
    results: state.subject.results.map(item => ({ resultId: item.resultId, sourceId: item.sourceId,
      missionId: item.missionId, proofId: item.proofId, integratedResult: item.integratedResult })),
    report, reportSha256: state.reportSha256,
    proof: { key: state.proofDocument.key, revisionId: state.proofDocument.revisionId,
      bodySha256: canonicalPayloadHash(state.proofDocument.body) } }, statusUpdates };
  const linearContinuity = linearPublicationState(m, "closure", content);
  const payloadSha256 = canonicalPayloadHash({ protocol: linearContinuity.protocol, mode: linearContinuity.mode,
    binding: linearContinuity.binding, sourceSha256: linearContinuity.sourceSha256, kind: "closure", ...content });
  const publication = linearContinuity.publications.find(item => item.payloadSha256 === payloadSha256);
  if (!publication) throw new MissionError(409, "campaign_close_publication", "The retained closure publication identity is missing");
  state = { ...state, phase: "publishing", publicationIntentId: publication.intentId, publicationPayloadSha256: publication.payloadSha256 };
  return n2Cas(ctx, m, { ...m.aggregate, linearContinuity, campaignClosure: state });
}

async function observeClosurePublication(ctx: PluginContext, initial: MissionRecord) {
  const state = initial.aggregate.campaignClosure!;
  const publication = initial.aggregate.linearContinuity!.publications.find(item => item.intentId === state.publicationIntentId
    && item.payloadSha256 === state.publicationPayloadSha256);
  if (!publication?.acknowledgement) return initial;
  const document = await readLinearProof(ctx, initial, publication.acknowledgement.reference);
  let receipt: any;
  try { receipt = JSON.parse(document.body); } catch { throw new MissionError(409, "campaign_close_ack", "The global publication acknowledgement must be valid JSON"); }
  const statusUpdates = (publication.payload.statusUpdates ?? []) as Array<{ sourceId: string; state: string }>;
  assertCampaignClosureReadback(initial.aggregate.linearContinuity!.binding.sourceRootId, statusUpdates, receipt.effects);
  await assertLinearContinuityDeparture(ctx, initial);
  return saveClosure(ctx, initial, { ...state, phase: "closing", publicationAcknowledgedAt: publication.acknowledgement.confirmedAt });
}

async function nativeNodeReadyToClose(ctx: PluginContext, m: MissionRecord, issueId: string) {
  const node = m.aggregate.hierarchy!.nodes!.find(item => item.issueId === issueId)!;
  const issue = await ctx.issues.get(issueId, m.companyId);
  const expected = { companyId: m.companyId, projectId: m.projectId, parentId: node.parentId, assigneeAgentId: node.assigneeAgentId };
  if (!issue || Object.entries(expected).some(([key, value]) => (issue[key as keyof typeof issue] ?? null) !== value)
      || issue.checkoutRunId || issue.executionRunId) throw new MissionError(409, "campaign_close_native_identity", "Only the original idle campaign parent may close");
  const children = m.aggregate.hierarchy!.nodes!.filter(child => child.parentId === node.issueId);
  for (const child of children) if (!["done", "cancelled"].includes((await ctx.issues.get(child.issueId, m.companyId))?.status ?? "")) {
    throw new MissionError(409, "campaign_close_child", "Every native child must be terminal before its parent closes");
  }
  const relations = await ctx.issues.relations.get(node.issueId, m.companyId);
  if (relations.blockedBy.some(blocker => !["done", "cancelled"].includes(blocker.status))) {
    throw new MissionError(409, "campaign_close_dependency", "Native blockers must be terminal before campaign closure");
  }
  return issue;
}

async function closeOneNativeNode(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; let state = m.aggregate.campaignClosure!;
  const entry = state.nativeClosures.find(item => item.state !== "confirmed");
  if (!entry || m.aggregate.linearContinuity!.control !== "running") return m;
  const issue = await nativeNodeReadyToClose(ctx, m, entry.issueId);
  if (entry.state === "pending") {
    await assertLinearContinuityDeparture(ctx, m);
    if (!["backlog", "blocked"].includes(issue.status)) throw new MissionError(409, "campaign_review_manual_done", "A manual terminal status cannot replace the claimed Council closure");
    state = { ...state, nativeClosures: state.nativeClosures.map(item => item === entry ? { ...item, state: "claimed" } : item) };
    m = await saveClosure(ctx, m, state);
    await ctx.issues.update(entry.issueId, { status: "done" }, m.companyId);
  }
  if ((await ctx.issues.get(entry.issueId, m.companyId))?.status !== "done") {
    throw new MissionError(409, "campaign_close_native_unknown", "The claimed native closure must be observed; it is never repeated");
  }
  return saveClosure(ctx, m, { ...m.aggregate.campaignClosure!, nativeClosures: m.aggregate.campaignClosure!.nativeClosures.map(item =>
    item.issueId === entry.issueId ? { ...item, state: "confirmed" } : item) });
}

async function finishClosure(ctx: PluginContext, initial: MissionRecord) {
  let m = initial;
  for (let step = 0; step < 33 && m.aggregate.campaignClosure!.nativeClosures.some(item => item.state !== "confirmed"); step++) {
    m = await closeOneNativeNode(ctx, await fresh(ctx, m));
    if (m.aggregate.linearContinuity!.control !== "running") return m;
  }
  const state = m.aggregate.campaignClosure!;
  if (state.nativeClosures.some(item => item.state !== "confirmed")) throw new MissionError(409, "campaign_close_bound", "Native campaign closure exceeded the fixed 33-node bound");
  m = await fresh(ctx, m);
  if (m.aggregate.linearContinuity!.control !== "running" || m.aggregate.campaignClosure!.phase !== "closing") return m;
  await assertLinearContinuityDeparture(ctx, m);
  const reviewerAgentId = physicalAgent(m, state.task.agentId, { launchKey: state.task.reservationId,
    issueId: state.task.issueId!, runId: state.task.runId! });
  const completedAt = new Date().toISOString();
  const completion = { state: "closed" as const, proofId: state.reportSha256!, documentKey: state.proofDocument.key,
    body: state.proofDocument.body, documentRevisionId: state.proofDocument.revisionId, closedNodeIds: state.nativeClosures.map(item => item.issueId),
    qualifiedAt: state.task.settledAt!, completedAt, notification: { body: "Published by the confirmed Linear campaign closure intent",
      authorAgentId: reviewerAgentId, state: "confirmed" as const, commentId: state.publicationIntentId } };
  m = await n2Cas(ctx, m, { ...m.aggregate, completion,
    campaignClosure: { ...state, phase: "closed", completedAt } });
  await ctx.issues.update(state.task.issueId!, { status: "done" }, m.companyId);
  return m;
}

/** Existing continuity job hook. It creates one review task and never schedules replacement work. */
export async function reconcileCampaignClosure(ctx: PluginContext, initial: MissionRecord) {
  let m = await fresh(ctx, initial);
  if (m.aggregate.linearContinuity?.mode !== "milestone-fixed-v1" || m.aggregate.repositoryCampaign) return m;
  if (m.aggregate.linearContinuity.control === "cancelled") {
    if (m.aggregate.campaignClosure && !["closed", "cancelled"].includes(m.aggregate.campaignClosure.phase)) {
      m = await saveClosure(ctx, m, { ...m.aggregate.campaignClosure, phase: "cancelled", blockedReason: "campaign_cancelled" });
    }
    return m;
  }
  if (m.aggregate.linearContinuity.control !== "running" || m.aggregate.linearContinuity.controlReason) return m;
  if (!m.aggregate.campaignClosure) m = await beginReview(ctx, m);
  let state = m.aggregate.campaignClosure;
  if (!state || ["blocked", "closed", "cancelled"].includes(state.phase)) return m;
  if (state.phase === "reviewing" && !state.task.runId) return dispatchReview(ctx, m);
  if (state.phase === "reviewing" && !state.task.settledAt) m = await settleReview(ctx, m);
  state = m.aggregate.campaignClosure!;
  if (state.phase === "reviewed") m = await queueClosurePublication(ctx, m);
  if (m.aggregate.campaignClosure!.phase === "publishing") m = await observeClosurePublication(ctx, m);
  if (m.aggregate.campaignClosure!.phase === "closing") m = await finishClosure(ctx, m);
  return m;
}
