import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { integratedResult } from "./integration-contract.js";
import { campaignPlanContainsMembers, fixedCampaignPlanLeaves, listCampaignMembers } from "./repository-campaign.js";
import { uncertainLinearEffects } from "./linear-continuity-control.js";
import { readTaskIntake } from "./project-intake-rebind.js";

type MemberRef = { missionId: string; nativeIssueId: string; sourceId: string };
type RetainedDelivery = MemberRef & { url: string; integratedCommit: string; verified: boolean };

function retainedDelivery(member: MissionRecord, ref: MemberRef): RetainedDelivery | null {
  const integration = member.aggregate.n5?.integration, report = integration?.report;
  if (!report || report.state !== "merged" || !report.integratedCommit) return null;
  if (integration.reportHash !== canonicalPayloadHash(report) || report.companyId !== member.companyId || report.missionId !== member.missionId) {
    throw new MissionError(409, "linear_cancel_result_unknown", "Retain original member integration evidence before publishing its cancellation result");
  }
  try {
    const result = integratedResult(member);
    return { ...ref, url: result.url, integratedCommit: result.integratedCommit, verified: true };
  } catch (error) {
    if (!(error instanceof MissionError) || error.code !== "integrated_result_pending") throw error;
    // A verified merge observation survives cancellation even if its checks failed.
    return { ...ref, url: report.url, integratedCommit: report.integratedCommit, verified: false };
  }
}

function openPullRequest(member: MissionRecord) {
  const n5 = member.aggregate.n5, publication = n5?.publication;
  if (n5?.integration?.report?.state === "merged") return null;
  const observed = publication?.observation ?? n5?.integration?.previousPublication?.observation;
  return observed?.state === "open" && observed.matchesCandidate ? observed.url : null;
}

async function cancellationLeaves(ctx: PluginContext, root: MissionRecord) {
  const plan = fixedCampaignPlanLeaves(root);
  if (plan) return plan;
  const leafIds = root.aggregate.hierarchy?.leaves?.map(leaf => leaf.issueId) ?? [];
  if (!leafIds.length) return [];
  // Cancellation is also permitted before the plan has been published. Keep
  // those unstarted leaves visible using the original prepared source mapping.
  const intake = await readTaskIntake(ctx, root.companyId, root.projectId, root.rootIssueId);
  const snapshot = intake?.state.linearIntake?.snapshot;
  if (intake?.mission_id !== root.missionId || !snapshot
      || canonicalPayloadHash(snapshot.subject) !== canonicalPayloadHash(root.aggregate.projectMandate?.linearIntake?.subject)) {
    throw new MissionError(409, "linear_cancel_plan_unknown", "Original prepared intake is required before publishing unstarted cancellation work");
  }
  return leafIds.map(nativeId => {
    const node = snapshot.nodes.find((item: { nativeId: string; role: string }) => item.nativeId === nativeId && item.role === "contribution");
    if (!node || typeof node.sourceId !== "string" || !node.sourceId) throw new MissionError(409, "linear_cancel_plan_unknown", "Every unstarted leaf must retain its source mapping");
    return { nativeId, sourceId: node.sourceId as string };
  });
}

/** The control root has no delivery PR. Read its exact planned members and retain
 * observed integrations, unfinished leaves and open PRs without any cleanup. */
export async function campaignCancellationSummary(ctx: PluginContext, root: MissionRecord) {
  const members = await listCampaignMembers(ctx, root), leaves = await cancellationLeaves(ctx, root);
  if (members.length && !campaignPlanContainsMembers(root, members)) {
    throw new MissionError(409, "linear_cancel_members_unknown", "The original delivery plan must account for every campaign member");
  }
  const retainedDeliveries: RetainedDelivery[] = [], openPullRequests: Array<MemberRef & { url: string }> = [];
  const remainingWork: Array<Omit<MemberRef, "missionId"> & { missionId: string | null }> = [];
  for (const leaf of leaves) {
    const member = members.find(item => item.rootIssueId === leaf.nativeId);
    if (!member) { remainingWork.push({ sourceId: leaf.sourceId, nativeIssueId: leaf.nativeId, missionId: null }); continue; }
    if (uncertainLinearEffects(member)) throw new MissionError(409, "linear_cancel_effect_unknown", "Reconcile the original member effects before cancellation");
    const ref = { missionId: member.missionId, nativeIssueId: member.rootIssueId, sourceId: leaf.sourceId };
    const delivery = retainedDelivery(member, ref), url = openPullRequest(member);
    if (delivery) retainedDeliveries.push(delivery);
    if (!delivery?.verified) remainingWork.push(ref);
    if (url) openPullRequests.push({ ...ref, url });
  }
  return { schema: "council-linear-cancellation-summary-v1", retainedDeliveries, remainingWork, openPullRequests };
}
