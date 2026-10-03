import assert from "node:assert/strict";
import { prepareN45 } from "./n45-prepare.js";
import { n45ProjectedPreflight } from "./n45-preflight.js";
import { n45ToolBoundary } from "./n45-tool-boundary.js";
export async function runN45Preparation(input: any, profile: any) {
  assert.equal(profile.mode, "prepare", "This launcher prepares only; follow the explicit operator recipe for a future authorized campaign");
  const campaign = await prepareN45(input, profile);
  input.evidence.n45 = { mode: "prepare", profile, companyId: campaign.companyId, projectId: campaign.projectId, rootIssueId: campaign.rootIssueId,
    missionId: campaign.missionId, agentIds: Object.fromEntries(Object.entries(campaign.agents).map(([role, agent]: [string, any]) => [role, agent.id])),
    toolProfile: campaign.toolProfile, planRevisionId: campaign.planRevisionId, operatingProfile: campaign.operatingProfile, work: campaign.work, n3Slots: campaign.n3Slots };
  await input.save();
  input.evidence.n45.projectedPreflight = await n45ProjectedPreflight(input, campaign, profile);
  await input.save();
  const { createGitHubExternalObjectProvider } = await input.hostImport("server/src/services/github-external-object-provider.ts");
  const resolver = createGitHubExternalObjectProvider(input.db).resolvers.find((r: any) => r.objectType === "pull_request");
  input.evidence.n45.externalResolver = { source: "native default company credential resolver; fresh company has no GitHub secret, public anonymous fallback",
    url: "https://github.com/ty000/paperclip-council/pull/23",
    result: await resolver.resolve({ companyId: campaign.companyId, object: { externalId: "ty000/paperclip-council#pull/23", sanitizedCanonicalUrl: "https://github.com/ty000/paperclip-council/pull/23" } }) };
  await input.save();
  input.evidence.n45.toolBoundary = await n45ToolBoundary(input, campaign);
  const runs = await campaign.api("GET", `/api/companies/${campaign.companyId}/heartbeat-runs?limit=1000`);
  const rows = Array.isArray(runs) ? runs : runs.runs;
  assert.equal(rows.length, 1, "only the explicitly labelled gateway fixture may exist");
  assert.equal(rows[0].id, input.evidence.n45.toolBoundary.binding.runId);
  assert.equal(rows[0].status, "cancelled");
  input.evidence.n45.runReadbacks = rows;
  input.evidence.n45.providerInvocationCount = 0;
  input.evidence.n45.nativeCampaignRunCount = 0;
  const wakes = await input.db.select({ id: input.tables.agentWakeupRequests.id }).from(input.tables.agentWakeupRequests).where(input.eq(input.tables.agentWakeupRequests.companyId, campaign.companyId));
  assert.equal(wakes.length, 0, "no campaign agent may be woken during preparation");
  input.evidence.n45.wakeupCount = wakes.length;
  input.evidence.n45.launchReady = false;
  input.evidence.outcome = "N45 PREPARATION OBSERVED";
}
