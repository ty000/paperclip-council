import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { readOrdinaryRun } from "./g4-native.js";
import { getMission, MissionError } from "./missions.js";
import { runtimeUuid } from "./n2-missions.js";
import { campaignReviewInstructions } from "./campaign-closure-runtime.js";
import { modelLaunch, physicalAgent } from "./model-state.js";
import { recordVariantWake } from "./model-runtime.js";
import { n2Cas } from "./n2-missions.js";

export async function handleCampaignReviewAgent(ctx: PluginContext, input: PluginApiRequestInput) {
  const body = input.body as Record<string, unknown>;
  const initial = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
  const state = initial?.aggregate.campaignClosure, task = state?.task;
  if (!initial || !state || !task || task.issueId !== input.params.issueId || state.phase !== "reviewing") {
    throw new MissionError(404, "campaign_review_missing", "Active global campaign review task not found");
  }
  const launch = modelLaunch(initial, task.reservationId);
  const expectedAgentId = physicalAgent(initial, task.agentId, { launchKey: task.reservationId, issueId: task.issueId });
  if (input.actor.actorType !== "agent" || input.actor.agentId !== expectedAgentId || !input.actor.runId
      || task.wake !== "claimed" || task.runId && task.runId !== input.actor.runId
      || initial.aggregate.modelSelection && (!launch || !["wake_claimed", "unknown", "bound"].includes(launch.state))) {
    throw new MissionError(403, "campaign_review_binding", "Exact admitted reviewer, task and native run are required");
  }
  const run = await readOrdinaryRun(ctx, { companyId: initial.companyId, issueId: task.issueId,
    runId: input.actor.runId, agentId: input.actor.agentId });
  if (run.status !== "running" || run.finishedAt) throw new MissionError(409, "campaign_review_inactive", "The exact active admitted reviewer run is required");
  let mission = initial;
  if (!task.runId) mission = await recordVariantWake(ctx, initial, task.reservationId, input.actor.runId,
    (before, aggregate, runId) => n2Cas(ctx, before, { ...aggregate, campaignClosure: { ...state, task: { ...task, runId } } }));
  if (body.command !== "campaign-review-inspect" || Object.keys(body).some(key => !["command", "missionId"].includes(key))) {
    throw new MissionError(403, "campaign_review_read_only", "The reviewer may inspect the pinned subject only; no body-declared verdict is accepted");
  }
  const closure = mission.aggregate.campaignClosure!;
  return { status: 200, body: { inspection: { missionId: mission.missionId, rootIssueId: mission.rootIssueId,
    campaignClosure: { task: closure.task, subject: closure.subject, instructions: campaignReviewInstructions(mission, closure),
      terminalReportSchema: "council-linear-campaign-review-report-v1" } } } };
}
