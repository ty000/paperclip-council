import type { PluginContext } from "@paperclipai/plugin-sdk";
import { FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";
import { getMission, MissionError, type MissionRecord } from "./missions.js";
import { nativeRunBindings } from "./native-run-bindings.js";
import type { AdmissionDocument } from "./admission.js";
import { uncertainLinearEffects } from "./linear-continuity-control.js";
import type { N1State } from "./n1-missions.js";

export type RepositoryCampaignMembership = { campaignRootMissionId: string };
type CampaignPlanLeaf = { sourceId: string; nativeId: string };

export function fixedCampaignPlanLeaves(root: MissionRecord): CampaignPlanLeaf[] | null {
  const plans = root.aggregate.linearContinuity?.publications.filter(publication => {
    const plan = publication.payload.campaignPlan as { schema?: string } | undefined;
    return plan?.schema === "council-linear-delivery-plan-v1";
  }) ?? [];
  if (plans.length !== 1) return null;
  const plan = plans[0]!.payload.campaignPlan as { campaignRootMissionId?: unknown; leaves?: unknown };
  if (plan.campaignRootMissionId !== root.missionId || !Array.isArray(plan.leaves)
      || !plan.leaves.length || plan.leaves.length > 33) return null;
  const leaves: CampaignPlanLeaf[] = [];
  for (const value of plan.leaves) {
    if (!value || typeof value !== "object") return null;
    const leaf = value as Record<string, unknown>;
    if (typeof leaf.sourceId !== "string" || !leaf.sourceId || typeof leaf.nativeId !== "string" || !leaf.nativeId) return null;
    leaves.push({ sourceId: leaf.sourceId, nativeId: leaf.nativeId });
  }
  if (new Set(leaves.map(leaf => leaf.sourceId)).size !== leaves.length
      || new Set(leaves.map(leaf => leaf.nativeId)).size !== leaves.length) return null;
  return leaves;
}

export function campaignPlanCoversMembers(root: MissionRecord, members: MissionRecord[]) {
  const leaves = fixedCampaignPlanLeaves(root);
  return Boolean(leaves && leaves.length === members.length && campaignPlanContainsMembers(root, members));
}

export function campaignPlanContainsMembers(root: MissionRecord, members: MissionRecord[]) {
  const leaves = fixedCampaignPlanLeaves(root);
  return Boolean(leaves && new Set(members.map(member => member.rootIssueId)).size === members.length
    && new Set(members.map(member => member.missionId)).size === members.length
    && members.every(member => member.companyId === root.companyId && member.projectId === root.projectId
      && member.aggregate.repositoryCampaign?.campaignRootMissionId === root.missionId
      && leaves.some(leaf => leaf.nativeId === member.rootIssueId)));
}

export async function campaignRoot(ctx: PluginContext, m: MissionRecord | Pick<MissionRecord, "companyId" | "missionId" | "projectId" | "aggregate"> & { ownerUserId?: string }) {
  const id = m.aggregate.repositoryCampaign?.campaignRootMissionId;
  if (!id) return m as MissionRecord;
  const root = await getMission(ctx, m.companyId, id);
  if (!root || root.missionId === m.missionId || root.projectId !== m.projectId || m.ownerUserId !== undefined && root.ownerUserId !== m.ownerUserId
      || root.aggregate.linearContinuity?.mode !== FIXED_CAMPAIGN_MODE
      || root.aggregate.linearContinuity.binding.campaignId !== root.missionId) {
    throw new MissionError(409, "repository_campaign_binding", "The trusted leaf must retain its original fixed campaign root and authority");
  }
  return root;
}

const terminalRuns = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
function unresolvedMemberCreation(m: MissionRecord) {
  const n1 = m.aggregate.n1 as N1State | undefined;
  const tasks = [...(m.aggregate.n2?.ordinary?.tasks ?? []), ...(m.aggregate.n6?.coordination?.tasks ?? []),
    ...(n1?.integration ? [n1.integration] : [])];
  return n1?.contributions.some(slot => ["creation_claimed", "unknown"].includes(slot.issueState) || slot.nativeWait?.state === "claimed")
    || n1?.coordination?.state === "claimed" && !n1.coordination.issueId
    || m.aggregate.modelSelection?.tasks.some(task => task.launches.some(launch => !launch.runId && ["wake_claimed", "unknown"].includes(launch.state)))
    || tasks.some(task => task.creation === "claimed" && !task.issueId);
}
export async function campaignMembersSafe(ctx: PluginContext, root: MissionRecord, terminal: false | "closed" | "cancelled" = false) {
  const members = await listCampaignMembers(ctx, root);
  const documents = await ctx.db.query<{ document: AdmissionDocument }>(
    `SELECT document FROM ${ctx.db.namespace}.admission_envelopes WHERE company_id = $1`, [root.companyId]);
  for (const member of members) if (!await memberSafe(ctx, member, documents, terminal)) return false;
  return true;
}

async function memberSafe(ctx: PluginContext, member: MissionRecord, documents: Array<{ document: AdmissionDocument }>, terminal: false | "closed" | "cancelled") {
  if (terminal === "closed" && member.aggregate.completion?.state !== "closed") return false;
  if (uncertainLinearEffects(member) || unresolvedMemberCreation(member)) return false;
  const bindings = nativeRunBindings(member), reservations = documents.flatMap(document => document.document.reservations.filter(r => r.missionId === member.missionId));
  if (bindings.some(binding => binding.pending)
      || documents.some(document => document.document.unadmittedRuns?.some(run => run.missionId === member.missionId))
      || reservations.some(r => r.status !== "settled" || r.usage?.status !== "known" || r.remainingExposure.status !== "known" || r.remainingExposure.units !== 0)
      || bindings.some(binding => binding.runId && !reservations.some(r => r.reservationId === binding.reservationId))) return false;
  return memberInventorySafe(ctx, member, bindings, terminal);
}

async function memberInventorySafe(ctx: PluginContext, member: MissionRecord, bindings: ReturnType<typeof nativeRunBindings>, terminal: false | "closed" | "cancelled") {
  const issueIds = [...new Set([member.rootIssueId, ...(member.aggregate.hierarchy?.nodes ?? []).map(node => node.issueId), ...bindings.map(binding => binding.issueId)])];
  if (issueIds.length > 64) return false;
  let cancelled = true;
  for (const issueId of issueIds) {
    const observed = await safeIssueInventory(ctx, member, issueId, bindings);
    if (!observed.safe) return false;
    cancelled &&= observed.cancelled;
  }
  return terminal !== "cancelled" || member.aggregate.completion?.state === "closed" || cancelled;
}

async function safeIssueInventory(ctx: PluginContext, member: MissionRecord, issueId: string, bindings: ReturnType<typeof nativeRunBindings>) {
  const issue = await ctx.issues.get(issueId, member.companyId);
  const inventory = await ctx.issues.summaries.getOrchestration({ companyId: member.companyId, issueId, includeSubtree: false });
  if (!issue || issue.companyId !== member.companyId || issue.projectId !== member.projectId || issue.checkoutRunId || issue.executionRunId
      || inventory.companyId !== member.companyId || inventory.issueId !== issueId || inventory.runs.length > 256) return { safe: false, cancelled: false };
  const baseline = member.aggregate.nativeWakePolicy?.protocol === "council-native-wake-v2" ? member.aggregate.nativeWakePolicy.rootBaseline : [];
  const safe = inventory.runs.every(run => terminalRuns.has(run.status) && run.issueId === issueId
    && (bindings.some(binding => binding.issueId === issueId && binding.runId === run.id && binding.agentId === run.agentId)
      || issueId === member.rootIssueId && baseline.some(item => item.runId === run.id && item.agentId === run.agentId)));
  return { safe, cancelled: issue.status === "cancelled" };
}

export async function listCampaignMembers(ctx: PluginContext, root: MissionRecord) {
  const rows = await ctx.db.query<any>(`SELECT * FROM ${ctx.db.namespace}.missions
    WHERE company_id = $1 AND aggregate->'repositoryCampaign'->>'campaignRootMissionId' = $2
    ORDER BY mission_id LIMIT 34`, [root.companyId, root.missionId]);
  if (rows.length > 33) throw new MissionError(409, "repository_campaign_bound", "Campaign membership exceeds the fixed source bound");
  return Promise.all(rows.map(row => getMission(ctx, row.company_id, row.mission_id))).then(items => items.filter(Boolean) as MissionRecord[]);
}

/** Existing continuity job hook for later global review; it grants no launch. */
export async function campaignProgress(ctx: PluginContext, root: MissionRecord) {
  const members = await listCampaignMembers(ctx, root);
  const closed = members.filter(member => member.aggregate.completion?.state === "closed");
  return { memberMissionIds: members.map(member => member.missionId), closedMissionIds: closed.map(member => member.missionId),
    allMembersClosed: campaignPlanCoversMembers(root, members) && closed.length === members.length };
}
