import { completionPolicy } from "./completion-contract.js";
import type { PluginContext, PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { MissionError } from "./mission-primitives.js";
import type { MissionAggregate, MissionRecord } from "./missions.js";
import { ensureContributionWait } from "./contribution-wait.js";
import { physicalAgent } from "./model-state.js";
import { leadIssueId } from "./hierarchy-contract.js";
import { n1LeadExecution } from "./n1-integration-state.js";

export type NativeWakePolicy = { protocol: "council-native-wake-v1" }
  | { protocol: "council-native-wake-v2"; rootBaseline: Array<{ runId: string; agentId: string }>; runLimit?: number };

function mappedParent(m: MissionRecord, issueId: string) {
  const leaf = m.aggregate.hierarchy?.leaves?.find(item => item.issueId === issueId);
  return leaf ? leaf.parentId : m.rootIssueId;
}

function matchesIssue(issue: Awaited<ReturnType<PluginContext["issues"]["get"]>>, m: MissionRecord, issueId: string, agentId: string) {
  const bindings = { id: issueId, companyId: m.companyId, projectId: m.projectId, assigneeAgentId: agentId,
    parentId: issueId === leadIssueId(m) || issueId === n1LeadExecution(m).issueId ? null : mappedParent(m, issueId) };
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

async function finishContributionDisposition(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>,
  persist?: (m: MissionRecord, aggregate: MissionAggregate) => Promise<MissionRecord>) {
  const state = m.aggregate.n1 as import("./n1-missions.js").N1State;
  const slot = state.contributions.find(s => s.contributionId === body.contributionId);
  if (!slot?.commit || slot.commit !== body.commit || slot.authorRunId !== input.actor.runId || slot.childIssueId !== input.params.issueId) {
    throw new MissionError(409, "native_contribution_disposition", "Only the exact recorded contribution run may finish its child");
  }
  const agentId = physicalAgent(m, slot.assigneeAgentId, { issueId: slot.childIssueId, runId: slot.authorRunId });
  if (agentId !== input.actor.agentId) throw new MissionError(403, "native_disposition_actor", "Mapped contributor required");
  if (completionPolicy(m)) {
    if (!persist) throw new MissionError(409, "contribution_wait_persistence", "Persist the native wait before changing disposition");
    // Validate the mapped issue before creating any technical task.
    const issue = await ctx.issues.get(slot.childIssueId!, m.companyId);
    if (!matchesIssue(issue, m, slot.childIssueId!, agentId) || !["in_progress", "blocked", "done"].includes(issue!.status)) {
      throw new MissionError(409, "native_wait_identity", "Retain the exact mapped contribution issue");
    }
    if (issue!.status === "done") return m;
    m = await ensureContributionWait(ctx, m, slot.contributionId, persist);
  }
  await observeStatus(ctx, m, slot.childIssueId!, agentId, completionPolicy(m) ? "blocked" : "done");
  return m;
}

/** Native recovery must observe a dependency before a delivered child waits. */
export async function finishN1Disposition(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>,
  persist?: (m: MissionRecord, aggregate: MissionAggregate) => Promise<MissionRecord>) {
  if (!m.aggregate.nativeWakePolicy) return m;
  const state = m.aggregate.n1 as { rootDispatchRunId?: string; candidate?: unknown;
    contributions: Array<{ contributionId: string; childIssueId?: string; assigneeAgentId: string; commit?: string; authorRunId?: string }> };
  if (body.command === "record-contribution") return finishContributionDisposition(ctx, m, input, body, persist);
  if (body.command === "publish") {
    const execution = n1LeadExecution(m);
    const issueId = execution.issueId!;
    const agentId = physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId, runId: execution.runId });
    if (!state.candidate || execution.runId !== input.actor.runId || input.actor.agentId !== agentId || input.params.issueId !== issueId) {
      throw new MissionError(409, "native_candidate_disposition", "Only the recorded candidate's exact lead run may park the root");
    }
    await observeStatus(ctx, m, issueId, agentId, "blocked");
    if (issueId !== m.rootIssueId) await parkProductRoot(ctx, m);
  }
  return m;
}

async function parkProductRoot(ctx: PluginContext, m: MissionRecord) {
      const root = await ctx.issues.get(m.rootIssueId, m.companyId);
      const leaf = m.aggregate.projectMandate?.completion?.result === "integrated-verified" ? m.aggregate.hierarchy?.leaves?.find(l => l.issueId === m.rootIssueId) : undefined;
      const agentId = leaf ? physicalAgent(m, leaf.assigneeAgentId, { issueId: leaf.issueId }) : m.aggregate.responsibilities.integrationLeadAgentId;
      const expected = { companyId: m.companyId, projectId: m.projectId, parentId: leaf?.parentId ?? null, assigneeAgentId: agentId };
      if (!root || Object.entries(expected).some(([key, value]) => (root[key as keyof typeof root] ?? null) !== value)
          || !["backlog", "blocked"].includes(root.status) || [root.checkoutRunId, root.executionRunId].some(Boolean)) {
        throw new MissionError(409, "hierarchy_root_wait_unknown", "Original product root must remain waiting under its declared lead");
      }
      if (root.status !== "blocked") await ctx.issues.update(root.id, { status: "blocked" }, m.companyId);
      const after = await ctx.issues.get(root.id, m.companyId);
      if (after?.status !== "blocked") throw new MissionError(409, "hierarchy_root_wait_unknown", "Product root waiting state was not observed");
}
