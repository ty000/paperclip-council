import type { PluginContext, PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { MissionError, type MissionRecord } from "./missions.js";
import { physicalAgent } from "./model-state.js";

export type NativeWakePolicy = { protocol: "council-native-wake-v1" };

function matchesIssue(issue: Awaited<ReturnType<PluginContext["issues"]["get"]>>, m: MissionRecord, issueId: string, agentId: string) {
  const bindings = { id: issueId, companyId: m.companyId, projectId: m.projectId, assigneeAgentId: agentId,
    parentId: issueId === m.rootIssueId ? null : m.rootIssueId };
  return Boolean(issue && Object.entries(bindings).every(([key, expected]) => (issue[key as keyof typeof issue] ?? null) === expected));
}

async function observeStatus(ctx: PluginContext, m: MissionRecord, issueId: string, agentId: string, status: "done" | "blocked") {
  const issue = await ctx.issues.get(issueId, m.companyId);
  if (!matchesIssue(issue, m, issueId, agentId) || !["in_progress", status].includes(issue!.status)) {
    throw new MissionError(409, "native_wait_identity", "Council disposition requires its exact mapped issue and assignee");
  }
  if (issue!.status !== status) await ctx.issues.update(issueId, { status }, m.companyId);
  const after = await ctx.issues.get(issueId, m.companyId);
  if (!matchesIssue(after, m, issueId, agentId) || after!.status !== status) {
    throw new MissionError(409, "native_wait_unobserved", "Council disposition was not observed; retain its committed report and replay identity");
  }
}

/** SDK status mutation has no implicit assignment/parent wake on the qualified host. */
export async function finishN1Disposition(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  if (!m.aggregate.nativeWakePolicy) return;
  const state = m.aggregate.n1 as { rootDispatchRunId?: string; candidate?: unknown;
    contributions: Array<{ contributionId: string; childIssueId?: string; assigneeAgentId: string; commit?: string; authorRunId?: string }> };
  if (body.command === "record-contribution") {
    const slot = state.contributions.find(s => s.contributionId === body.contributionId);
    if (!slot?.commit || slot.commit !== body.commit || slot.authorRunId !== input.actor.runId || slot.childIssueId !== input.params.issueId) {
      throw new MissionError(409, "native_contribution_disposition", "Only the exact recorded contribution run may finish its child");
    }
    const agentId = physicalAgent(m, slot.assigneeAgentId, { issueId: slot.childIssueId, runId: slot.authorRunId });
    if (agentId !== input.actor.agentId) throw new MissionError(403, "native_disposition_actor", "Mapped contributor required");
    await observeStatus(ctx, m, slot.childIssueId!, agentId, "done");
  }
  if (body.command === "publish") {
    const agentId = physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: m.rootIssueId, runId: state.rootDispatchRunId });
    if (!state.candidate || state.rootDispatchRunId !== input.actor.runId || input.actor.agentId !== agentId || input.params.issueId !== m.rootIssueId) {
      throw new MissionError(409, "native_candidate_disposition", "Only the recorded candidate's exact lead run may park the root");
    }
    await observeStatus(ctx, m, m.rootIssueId, agentId, "blocked");
  }
}
