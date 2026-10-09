import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { projectRoleContext } from "./project-workflow.js";

/** Keep the native plan as the source; the existing creation intent stores this snapshot. */
export async function readContributionContext(ctx: PluginContext, mission: MissionRecord): Promise<string> {
  const plan = await ctx.issues.documents.get(mission.rootIssueId, "plan", mission.companyId);
  const mandate = mission.aggregate.mandate;
  const targeted = projectRoleContext(mission, "contributor");
  return [
    ...(targeted ? [targeted, "", "## Native parent plan", `Parent issue: ${mission.rootIssueId}; GET /api/issues/${mission.rootIssueId}`] : [
      "## Mission and parent plan",
      `Parent issue: ${mission.rootIssueId}; GET /api/issues/${mission.rootIssueId}`,
      `Mission objective: ${mandate.objective}`,
      "Acceptance criteria:",
      ...mandate.acceptanceCriteria.map(criterion => `- ${criterion}`),
    ]),
    "Commitments and exclusions:",
    ...mandate.commitments.map(commitment => `- ${commitment}`),
    `Operating limits: ${JSON.stringify(mandate.limits)}`,
    "",
    `Native plan: GET /api/issues/${mission.rootIssueId}/documents/plan`,
    ...(plan ? [
      `Plan document: ${plan.id}; revision: ${plan.latestRevisionId}`,
      "Plan snapshot at child creation:",
      plan.body,
    ] : ["No native plan document exists. Read the parent issue for the contribution brief; do not invent missing requirements."]),
    "",
    "## Before implementation",
    "Read the parent issue, current native plan when present, repository AGENTS.md and the sources referenced by your work slot.",
    "Identify your contribution by its ID, assignee and owned paths. Confirm its expected result, interfaces, dependencies, acceptance checks and exclusions before coding.",
    "The plan describes the whole mission; implement only this child's owned scope. Report a missing or conflicting requirement to the lead; do not silently broaden scope or invent a product decision.",
    "If the plan revision has changed, reconcile the instructions with the lead before applying the changed scope. This snapshot grants no additional permission or dispatch authority.",
    "Return the commit, behavior delivered, relevant test results and any unmet criterion. Run the existing contribution-reporting command below.",
  ].join("\n");
}
