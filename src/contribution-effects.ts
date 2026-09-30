import type { Issue } from "@paperclipai/shared";
import type { PluginContext, PluginIssueMutationActor } from "@paperclipai/plugin-sdk";

export const CONTRIBUTION_ISSUE_ORIGIN_KIND = "plugin:private.paperclip-council:contribution" as const;

export type ContributionIssueIntent = {
  /**
   * The caller sets this only after atomically persisting the one-shot effect
   * claim with the mission command. An unknown result must be persisted under
   * a different state and must never be passed back to this create helper.
   */
  state: "creation_claimed";
  intentId: string;
  companyId: string;
  projectId: string;
  rootIssueId: string;
  missionId: string;
  contributionId: string;
  assigneeAgentId: string;
  title: string;
  description?: string;
  blockedByIssueIds?: string[];
  actor?: PluginIssueMutationActor;
};

export type ContributionIssueCorrelation = {
  originKind: typeof CONTRIBUTION_ISSUE_ORIGIN_KIND;
  originId: string;
};

export type ContributionIssueConfirmation = {
  state: "confirmed";
  source: "create_response" | "correlation_readback";
  correlation: ContributionIssueCorrelation;
  issue: Issue;
};

export type ContributionIssueUnknownReason =
  | "correlation_read_failed"
  | "correlation_ambiguous"
  | "correlation_mismatch"
  | "create_failed_no_match"
  | "create_response_mismatch";

export type ContributionIssueUnknown = {
  state: "unknown";
  reason: ContributionIssueUnknownReason;
  retryAllowed: false;
  nextAction: "manual_reconciliation_required";
  correlation: ContributionIssueCorrelation;
};

export type ContributionIssueEffectResult =
  | ContributionIssueConfirmation
  | ContributionIssueUnknown;

type ReadbackResult =
  | { state: "confirmed"; issue: Issue }
  | { state: "absent" }
  | { state: "unknown"; reason: Exclude<ContributionIssueUnknownReason, "create_failed_no_match" | "create_response_mismatch"> };

export function buildContributionIssueOrigin(input: {
  missionId: string;
  contributionId: string;
}): ContributionIssueCorrelation {
  return {
    originKind: CONTRIBUTION_ISSUE_ORIGIN_KIND,
    originId: `mission:${input.missionId}:contribution:${input.contributionId}`,
  };
}

function matchesIntent(
  issue: Issue,
  intent: ContributionIssueIntent,
  correlation: ContributionIssueCorrelation,
): boolean {
  return issue.companyId === intent.companyId
    && issue.projectId === intent.projectId
    && issue.parentId === intent.rootIssueId
    && issue.assigneeAgentId === intent.assigneeAgentId
    && issue.originKind === correlation.originKind
    && issue.originId === correlation.originId;
}

function unknown(
  correlation: ContributionIssueCorrelation,
  reason: ContributionIssueUnknownReason,
): ContributionIssueUnknown {
  return {
    state: "unknown",
    reason,
    retryAllowed: false,
    nextAction: "manual_reconciliation_required",
    correlation,
  };
}

async function readCorrelation(
  ctx: PluginContext,
  intent: ContributionIssueIntent,
  correlation: ContributionIssueCorrelation,
): Promise<ReadbackResult> {
  let matches: Issue[];
  try {
    matches = await ctx.issues.list({
      companyId: intent.companyId,
      originKind: correlation.originKind,
      originId: correlation.originId,
      limit: 2,
    });
  } catch {
    return { state: "unknown", reason: "correlation_read_failed" };
  }

  if (matches.length === 0) return { state: "absent" };
  if (matches.length > 1) return { state: "unknown", reason: "correlation_ambiguous" };
  const issue = matches[0];
  if (!issue || !matchesIntent(issue, intent, correlation)) {
    return { state: "unknown", reason: "correlation_mismatch" };
  }
  return { state: "confirmed", issue };
}

/**
 * Reads native correlation without mutating Paperclip. An absent result never
 * authorizes another create after an uncertain request.
 */
export async function reconcileContributionIssueEffect(
  ctx: PluginContext,
  intent: ContributionIssueIntent,
): Promise<ContributionIssueConfirmation | ContributionIssueUnknown | { state: "absent"; correlation: ContributionIssueCorrelation }> {
  const correlation = buildContributionIssueOrigin(intent);
  const readback = await readCorrelation(ctx, intent, correlation);
  if (readback.state === "confirmed") {
    return { state: "confirmed", source: "correlation_readback", correlation, issue: readback.issue };
  }
  if (readback.state === "absent") return { state: "absent", correlation };
  return unknown(correlation, readback.reason);
}

/**
 * Performs at most one native create for a caller-persisted effect claim.
 * It never wakes the assignee and never retries an uncertain create.
 */
export async function createContributionIssueEffect(
  ctx: PluginContext,
  intent: ContributionIssueIntent,
): Promise<ContributionIssueEffectResult> {
  const correlation = buildContributionIssueOrigin(intent);
  const before = await readCorrelation(ctx, intent, correlation);
  if (before.state === "confirmed") {
    return { state: "confirmed", source: "correlation_readback", correlation, issue: before.issue };
  }
  if (before.state === "unknown") return unknown(correlation, before.reason);

  try {
    const issue = await ctx.issues.create({
      companyId: intent.companyId,
      projectId: intent.projectId,
      parentId: intent.rootIssueId,
      inheritExecutionWorkspaceFromIssueId: intent.rootIssueId,
      title: intent.title,
      description: intent.description,
      status: "backlog",
      assigneeAgentId: intent.assigneeAgentId,
      originKind: correlation.originKind,
      originId: correlation.originId,
      blockedByIssueIds: intent.blockedByIssueIds,
      actor: intent.actor,
    });
    if (!matchesIntent(issue, intent, correlation)) {
      return unknown(correlation, "create_response_mismatch");
    }
    return { state: "confirmed", source: "create_response", correlation, issue };
  } catch {
    const after = await readCorrelation(ctx, intent, correlation);
    if (after.state === "confirmed") {
      return { state: "confirmed", source: "correlation_readback", correlation, issue: after.issue };
    }
    if (after.state === "absent") return unknown(correlation, "create_failed_no_match");
    return unknown(correlation, after.reason);
  }
}
