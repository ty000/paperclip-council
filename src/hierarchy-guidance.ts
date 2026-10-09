import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { MissionError } from "./mission-primitives.js";
import { projectRoleContext } from "./project-workflow.js";

/** Short assignment context; the existing document retains the full reporting command. */
export function hierarchyLaunchGuidance(m: MissionRecord, issueId: string): string | null {
  const leaf = m.aggregate.hierarchy?.leaves?.find(leaf => leaf.issueId === issueId);
  if (!leaf) return null;
  const key = `council-execution-${m.missionId}`;
  const predecessor = leaf.blockedByIssueIds.length ? `native issues ${leaf.blockedByIssueIds.join(", ")}` : "none declared";
  const context = projectRoleContext(m, "contributor", { paths: leaf.ownedPaths, predecessor });
  const guidance = `Council execution ${m.missionId}: before implementation, read the body of GET /api/issues/${issueId}/documents/${key} using your authenticated Paperclip access. This document defines your owned paths and mandatory contribution reporting command. After committing, execute that command to register the exact commit and Git proof with Council. A Paperclip work product or comment alone is not the handoff. Do not mark this issue done yourself: Council closes it after your run finishes and its usage settles. Read only the relevant source and contract sections; exclude compiled bundles and unrelated documentation from searches.`;
  return context ? `${context}\n\n${guidance}` : guidance;
}

/** Expose the document in the description actually delivered by the native wake. */
export async function ensureHierarchyLaunchGuidance(ctx: PluginContext, m: MissionRecord, issueId: string) {
  const guidance = hierarchyLaunchGuidance(m, issueId);
  if (!guidance) return;
  const document = await ctx.issues.documents.get(issueId, `council-execution-${m.missionId}`, m.companyId);
  if (!document?.latestRevisionId || !document.body) {
    throw new MissionError(409, "hierarchy_guidance_missing", "Read the existing Council execution document before admitting the child; no wake was requested");
  }
  const issue = await ctx.issues.get(issueId, m.companyId);
  if (!issue || issue.companyId !== m.companyId || issue.projectId !== m.projectId) {
    throw new MissionError(409, "hierarchy_guidance_identity", "The original child must remain in the mission project");
  }
  const suffix = `\n\n${guidance}`;
  if ((issue.description ?? "").includes(suffix)) return;
  const description = (issue.description ?? "") + suffix;
  await ctx.issues.update(issueId, { description }, m.companyId);
  if ((await ctx.issues.get(issueId, m.companyId))?.description !== description) {
    throw new MissionError(409, "hierarchy_guidance_unknown", "Observe the exact assignment guidance before another departure");
  }
}
