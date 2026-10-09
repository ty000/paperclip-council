import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import { n2Cas, nativeN2Profile } from "./n2-missions.js";
import { completionEvidence } from "./completion-evidence.js";
import { integratedResult } from "./integration-contract.js";
import { completionPolicy, type CompletionState } from "./completion-contract.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { physicalAgent } from "./model-state.js";
import { leadIssueId } from "./hierarchy-contract.js";
import { reconcileRepositoryRelease } from "./repository-release.js";

function deliveredResultDescription(evidence: ReturnType<typeof completionEvidence>) {
  if (evidence.integrated) return `${evidence.integrated.url}\nCommit intégré : ${evidence.integrated.integratedCommit}.`;
  return evidence.publication?.observation?.url ?? "Candidat accepté sans publication autorisée";
}

async function assertClosureAccounting(ctx: PluginContext, m: MissionRecord) {
  const { envelope } = await nativeN2Profile(ctx, m);
  const reservations = envelope.reservations.filter(r => r.missionId === m.missionId);
  if (!reservations.length || reservations.some(r => r.status !== "settled" || r.usage?.status !== "known" || r.remainingExposure.status !== "known" || r.remainingExposure.units !== 0)) {
    throw new MissionError(409, "completion_usage_pending", "Every mission run must retain exact known terminal costs without open exposure before parent closure");
  }
}
async function finishProofDocument(ctx: PluginContext, m: MissionRecord, c: CompletionState) {
  let doc = await ctx.issues.documents.get(m.rootIssueId, c.documentKey, m.companyId);
  if (!doc) {
    if (c.documentRevisionId) throw new MissionError(409, "completion_document_missing", "Retain the previously confirmed proof document identity");
    await ctx.issues.documents.upsert({ issueId: m.rootIssueId, companyId: m.companyId, key: c.documentKey, title: "Council — preuve du résultat autorisé", format: "markdown", body: c.body });
    doc = await ctx.issues.documents.get(m.rootIssueId, c.documentKey, m.companyId);
  }
  if (!doc?.latestRevisionId || doc.body !== c.body) throw new MissionError(409, "completion_document_unknown", "Original consolidated proof was not observed; no overwrite or replacement key");
  if (!c.documentRevisionId) m = await n2Cas(ctx, m, { ...m.aggregate, completion: { ...c, documentRevisionId: doc.latestRevisionId } });
  return m;
}
function nativeNodeMatches(issue: Awaited<ReturnType<PluginContext["issues"]["get"]>>, m: MissionRecord, node: import("./hierarchy-contract.js").HierarchyNode) {
  const expected = { id: node.issueId, companyId: m.companyId, projectId: m.projectId, parentId: node.parentId, assigneeAgentId: node.assigneeAgentId };
  return issue && Object.entries(expected).every(([key, value]) => (issue[key as keyof typeof issue] ?? null) === value);
}
async function closeProductParent(ctx: PluginContext, m: MissionRecord, node: import("./hierarchy-contract.js").HierarchyNode) {
  for (const child of m.aggregate.hierarchy!.nodes!.filter(child => child.parentId === node.issueId)) {
    const expectedStatus = child.historicalStatus ?? "done";
    if ((await ctx.issues.get(child.issueId, m.companyId))?.status !== expectedStatus) throw new MissionError(409, "completion_child_pending", "Necessary children must be done; imported history must retain its original terminal state");
  }
  const relations = await ctx.issues.relations.get(node.issueId, m.companyId);
  if (relations.blockedBy.some(b => !["done", "cancelled"].includes(b.status))) throw new MissionError(409, "completion_dependency_pending", "Native blockers are preserved and must resolve before closing each parent");
  const issue = await ctx.issues.get(node.issueId, m.companyId);
  if (!nativeNodeMatches(issue, m, node) || issue!.checkoutRunId || issue!.executionRunId || !["backlog", "blocked", "done"].includes(issue!.status)) throw new MissionError(409, "completion_parent_identity", "Original idle native parents are required; no task takeover");
  if (issue!.status !== "done") await ctx.issues.update(node.issueId, { status: "done" }, m.companyId);
  const after = await ctx.issues.get(node.issueId, m.companyId);
  if (!nativeNodeMatches(after, m, node) || after!.status !== "done") throw new MissionError(409, "completion_parent_unknown", "Retain the original claimed closure and inspect native status");
  const c = m.aggregate.completion!;
  if (!c.closedNodeIds.includes(node.issueId)) m = await n2Cas(ctx, m, { ...m.aggregate, completion: { ...c, closedNodeIds: [...c.closedNodeIds, node.issueId] } });
  return m;
}
async function closeCoordinator(ctx: PluginContext, m: MissionRecord) {
  const coordinator = leadIssueId(m);
  if (coordinator === m.rootIssueId) return;
  const integration = (m.aggregate.n1 as N1State).integration;
  for (const issueId of [coordinator, ...(integration?.issueId ? [integration.issueId] : [])]) {
    const issue = await ctx.issues.get(issueId, m.companyId);
    const agentId = physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId });
    const statuses = integration?.settledAt ? ["in_progress", "in_review", "blocked", "done"] : ["blocked", "done"];
    if (!issue || issue.companyId !== m.companyId || issue.projectId !== m.projectId || issue.parentId || issue.assigneeAgentId !== agentId
        || issue.checkoutRunId || issue.executionRunId || !statuses.includes(issue.status)) throw new MissionError(409, "completion_coordinator_identity", "Retain the original settled operational task identities");
    if (issue.status !== "done") await ctx.issues.update(issueId, { status: "done" }, m.companyId);
    if ((await ctx.issues.get(issueId, m.companyId))?.status !== "done") throw new MissionError(409, "completion_coordinator_unknown", "The settled operational tasks must also finish");
  }
}
async function closeProductNodes(ctx: PluginContext, m: MissionRecord) {
  const leaves = new Set((m.aggregate.n1 as N1State).contributions.map(s => s.childIssueId));
  const pending = m.aggregate.hierarchy!.nodes!.filter(n => !leaves.has(n.issueId) && !n.historicalStatus);
  for (let step = 0; pending.length && step < 32; step++) {
    const index = pending.findIndex(n => !pending.some(child => child.parentId === n.issueId));
    if (index < 0) throw new MissionError(409, "completion_parent_cycle", "No parent can close before its necessary children");
    m = await closeProductParent(ctx, m, pending.splice(index, 1)[0]!);
  }
  if (pending.length) throw new MissionError(409, "completion_parent_bound", "Parent closure exhausted the pinned hierarchy bound");
  await closeCoordinator(ctx, m);
  return m;
}
async function finishNotification(ctx: PluginContext, m: MissionRecord) {
  let c = m.aggregate.completion!, n = c.notification;
  if (n.state === "confirmed") return m;
  const matches = (await ctx.issues.listComments(m.rootIssueId, m.companyId)).filter(comment => comment.body === n.body && comment.authorAgentId === n.authorAgentId);
  if (matches.length > 1) throw new MissionError(409, "completion_notification_ambiguous", "Multiple matching notifications require inspection, never another comment");
  if (!matches.length) {
    if (n.state === "claimed") throw new MissionError(409, "completion_notification_unknown", "Notification was claimed; native readback only, no repeated send");
    m = await n2Cas(ctx, m, { ...m.aggregate, completion: { ...c, notification: { ...n, state: "claimed" } } });
    await ctx.issues.createComment(m.rootIssueId, n.body, m.companyId, { authorAgentId: n.authorAgentId });
    c = m.aggregate.completion!; n = c.notification;
  }
  const observed = (await ctx.issues.listComments(m.rootIssueId, m.companyId)).filter(comment => comment.body === n.body && comment.authorAgentId === n.authorAgentId);
  if (observed.length !== 1) throw new MissionError(409, "completion_notification_unknown", "The original final notification must be observed without another effect");
  return n2Cas(ctx, m, { ...m.aggregate, completion: { ...c, state: "closed", completedAt: new Date().toISOString(), notification: { ...n, state: "confirmed", commentId: observed[0]!.id } } });
}

/** Consolidates existing proof; no extra provider run, new budget or GitHub write. */
export async function reconcileCompletion(ctx: PluginContext, m: MissionRecord) {
  if (!m.aggregate.linearContinuity && m.aggregate.completion?.state === "closed") await reconcileRepositoryRelease(ctx, m);
  if (!completionPolicy(m) || m.aggregate.completion?.state === "closed") return m;
  await assertProjectDeparture(ctx, m); await assertClosureAccounting(ctx, m);
  if (completionPolicy(m)?.result === "integrated-verified") {
    integratedResult(m);
    if (m.aggregate.n5?.integration?.recovery) await (await import("./integration-recovery.js")).assertIntegrationRecoveryStable(ctx, m);
    const obligations = m.aggregate.n5!.integration!.obligations;
    if (m.aggregate.n5!.authority.contract!.integration!.parentObligations.length) {
      const doc = await ctx.issues.documents.get(m.rootIssueId, `council-parent-obligations-${m.missionId}`, m.companyId);
      if (!obligations || doc?.id !== obligations.documentId || doc.latestRevisionId !== obligations.revisionId || canonicalPayloadHash(doc.body) !== obligations.bodyHash) throw new MissionError(409, "completion_parent_obligations", "Exact own parent evidence must remain current before closure");
    }
    const { closeQualifiedContribution } = await import("./contribution-proof.js");
    for (const slot of (m.aggregate.n1 as N1State).contributions) m = await closeQualifiedContribution(ctx, m, slot.contributionId, (before, aggregate) => n2Cas(ctx, before, aggregate));
  }
  if (!m.aggregate.completion) {
    const evidence = completionEvidence(m), proofId = canonicalPayloadHash(evidence), documentKey = `council-completion-${m.missionId}`;
    const runId = m.aggregate.n2!.rounds.at(-1)!.handoff.reviewerRunId;
    const authorAgentId = physicalAgent(m, m.aggregate.responsibilities.finalReviewerAgentId, { runId });
    m = await n2Cas(ctx, m, { ...m.aggregate, completion: { state: "closing", proofId, documentKey, body: JSON.stringify({ ...evidence, proofId }), qualifiedAt: new Date().toISOString(), closedNodeIds: [],
      notification: { state: "pending", authorAgentId, body: `Council : résultat autorisé terminé (${evidence.result}).\nCandidat : ${evidence.submission.candidateCommit}.\n${deliveredResultDescription(evidence)}\nPreuve native : ${documentKey}.\nProof ID : ${proofId}` } } });
  }
  if (canonicalPayloadHash(completionEvidence(m)) !== m.aggregate.completion!.proofId) throw new MissionError(409, "completion_subject_changed", "Retain the original proof; a changed candidate or evidence cannot consume its closure");
  m = await finishProofDocument(ctx, m, m.aggregate.completion!);
  m = await closeProductNodes(ctx, m);
  await assertProjectDeparture(ctx, m);
  if (canonicalPayloadHash(completionEvidence(m)) !== m.aggregate.completion!.proofId) throw new MissionError(409, "completion_subject_changed", "Evidence changed before final notification");
  m = await finishNotification(ctx, m);
  if (!m.aggregate.linearContinuity) await reconcileRepositoryRelease(ctx, m);
  return m;
}
