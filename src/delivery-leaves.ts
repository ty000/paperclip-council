import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getMission, canonicalPayloadHash, getMissionByRootIssue, MissionError, type MissionRecord } from "./missions.js";
import { integratedResult } from "./integration-contract.js";
import { assertIntegrationRecoveryStable } from "./integration-recovery.js";
import type { ProjectMandate } from "./project-mandate-state.js";
import { projectIssues, projectTable } from "./project-mandate-state.js";
import { campaignRoot, listCampaignMembers } from "./repository-campaign.js";
import { assertLinearContinuityDeparture } from "./linear-continuity-control.js";
import { queueLinearPublication } from "./linear-continuity-transport.js";

type Issues = Awaited<ReturnType<typeof projectIssues>>;
export function deliveryCampaignRoot(id: string, issues: Issues) {
  const seen = new Set<string>();
  let issue = issues.find(i => i.id === id);
  while (issue?.parentId) {
    if (seen.has(issue.id) || seen.size >= 32) throw new MissionError(409, "delivery_tree_bound", "Native delivery ancestry must be complete and acyclic");
    seen.add(issue.id);
    const parent = issues.find(i => i.id === issue!.parentId);
    if (!parent) throw new MissionError(409, "delivery_parent_missing", "Original native campaign ancestry must remain readable");
    issue = parent;
  }
  return issue?.id;
}
export function isIntegratedLeaf(issue: Issues[number], policy: ProjectMandate, issues: Issues) {
  const supported = issue.originKind === "manual" || issue.originKind === "plugin:ty000.linear-intake" && policy.content.linearContinuity?.mode === "milestone-fixed-v1";
  return Boolean(policy.content.publication?.contract?.integration && supported
    && !issues.some(child => child.parentId === issue.id && (child.originKind === "manual" || child.originKind === "plugin:ty000.linear-intake")) && ["backlog", "blocked"].includes(issue.status)
    && issue.assigneeAgentId && issue.assigneeAgentId !== policy.content.leadAgentId
    && !policy.content.baselineRootIds.includes(deliveryCampaignRoot(issue.id, issues) ?? ""));
}

/** Reuse the project intake job and the native tree; no campaign scheduler or invented subtickets. */
export async function assertPreviousDelivery(ctx: PluginContext, m: MissionRecord, policy: ProjectMandate, issues: Issues) {
  if (!policy.content.publication?.contract?.integration) return;
  const campaign = deliveryCampaignRoot(m.rootIssueId, issues);
  const leaves = issues.filter(issue => deliveryCampaignRoot(issue.id, issues) === campaign && !issues.some(child => child.parentId === issue.id && (child.originKind === "manual" || child.originKind === "plugin:ty000.linear-intake"))
    && (issue.originKind === "manual" || issue.originKind === "plugin:ty000.linear-intake" && policy.content.linearContinuity?.mode === "milestone-fixed-v1"))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
  // Native blockers determine a complete topological order; creation order breaks ties only.
  const internalIds = new Set(leaves.map(leaf => leaf.id));
  const pending = [...leaves], ordered: Issues = [];
  while (pending.length) {
    let selected = -1;
    for (const [index, leaf] of pending.entries()) {
      const relations = await ctx.issues.relations.get(leaf.id, m.companyId);
      if (relations.blockedBy.every(b => internalIds.has(b.id)
        ? ordered.some(i => i.id === b.id) : ["done", "cancelled"].includes(b.status))) { selected = index; break; }
    }
    if (selected < 0) throw new MissionError(409, "delivery_dependency_pending", "Retain unresolved external blockers or cycles; no removal or inferred ordering");
    ordered.push(pending.splice(selected, 1)[0]!);
  }
  const index = ordered.findIndex(i => i.id === m.rootIssueId);
  if (index < 0) throw new MissionError(409, "delivery_leaf_identity", "Original code delivery leaf must remain in its native campaign");
  const control = m.aggregate.repositoryCampaign ? await campaignRoot(ctx, m) : null;
  let predecessor: MissionRecord["aggregate"]["deliveryPredecessor"];
  for (const leaf of ordered.slice(0, index)) {
    if (["done", "cancelled"].includes(leaf.status)) {
      // Historical terminal work keeps its meaning, but a managed delivery needs its integrated proof.
      const prior = await getMissionByRootIssue(ctx, m.companyId, leaf.id);
      if (!prior) {
        if (control?.aggregate.hierarchy?.leaves?.some(planned => planned.issueId === leaf.id)) {
          throw new MissionError(409, "previous_delivery_pending", "A planned campaign contribution cannot be skipped by a manual terminal status");
        }
        continue;
      }
      const result = integratedResult(prior);
      await assertIntegrationRecoveryStable(ctx, prior);
      if (prior.aggregate.completion?.state === "closed") {
        if (m.aggregate.repositoryCampaign) {
          const published = await publishCampaignDelivery(ctx, control!, prior, result);
          await assertLinearContinuityDeparture(ctx, published);
        }
        predecessor = { sourceMissionId: prior.missionId, result }; continue;
      }
    }
    throw new MissionError(409, "previous_delivery_pending", "The previous managed code leaf must be merged, verified and proof-closed before this admission");
  }
  return predecessor;
}

async function publishCampaignDelivery(ctx: PluginContext, control: MissionRecord, prior: MissionRecord,
  result: ReturnType<typeof integratedResult>) {
  const rows = await ctx.db.query<{ state: { repositoryCampaign?: { campaignRootMissionId: string; sourceId: string } } }>(
    `SELECT state FROM ${projectTable(ctx, "project_task_intakes")} WHERE company_id = $1 AND root_issue_id = $2`, [prior.companyId, prior.rootIssueId]);
  const membership = rows[0]?.state.repositoryCampaign;
  if (!membership || membership.campaignRootMissionId !== control.missionId) throw new MissionError(409, "linear_campaign_member", "Delivery publication requires the original private source membership");
  return queueLinearPublication(ctx, control, "progress", { campaignDelivery: { schema: "council-linear-delivery-result-v1",
    campaignRootMissionId: control.missionId, sourceMissionId: prior.missionId, sourceIssueId: prior.rootIssueId,
    proofId: prior.aggregate.completion!.proofId, result }, statusUpdates: [{ sourceId: membership.sourceId, state: "completed" }] });
}

/** Existing root job publishes every closed member, including the final leaf. */
export async function reconcileCampaignDeliveries(ctx: PluginContext, initial: MissionRecord) {
  let control = initial;
  for (const member of await listCampaignMembers(ctx, initial)) {
    if (member.aggregate.completion?.state !== "closed") continue;
    const result = integratedResult(member);
    await assertIntegrationRecoveryStable(ctx, member);
    control = await publishCampaignDelivery(ctx, control, member, result);
  }
  return control;
}

export async function assertDeliveryPredecessor(ctx: PluginContext, m: MissionRecord) {
  const prior = m.aggregate.deliveryPredecessor;
  if (!prior) return;
  const source = await getMission(ctx, m.companyId, prior.sourceMissionId);
  if (!source || source.projectId !== m.projectId || source.aggregate.completion?.state !== "closed" || canonicalPayloadHash(integratedResult(source)) !== canonicalPayloadHash(prior.result)) throw new MissionError(409, "delivery_predecessor_changed", "Retain the exact proof-closed integrated predecessor before another departure");
  await assertIntegrationRecoveryStable(ctx, source);
}
