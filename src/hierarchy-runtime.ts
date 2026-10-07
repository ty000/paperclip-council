import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { projectIssues } from "./project-mandate-state.js";
import { physicalAgent, modelLaunchGuidance } from "./model-state.js";

/** Only exact suffixes attributable to this issue's persisted launches are Council context. */
function descriptionMatchesSource(m: MissionRecord, issueId: string, description: string | null, expectedHash: string) {
  if (canonicalPayloadHash(description) === expectedHash) return true;
  if (description === null) return false;
  const suffixes = (m.aggregate.modelSelection?.tasks ?? []).flatMap(task => task.launches)
    .filter(launch => launch.issueId === issueId).map(launch => `\n\n${modelLaunchGuidance(m, launch, issueId)}`);
  let source = description;
  while (suffixes.length) {
    const index = suffixes.findIndex(suffix => source.endsWith(suffix));
    if (index < 0) return false;
    source = source.slice(0, -suffixes.splice(index, 1)[0]!.length);
    if (canonicalPayloadHash(source) === expectedHash || source === "" && canonicalPayloadHash(null) === expectedHash) return true;
  }
  return false;
}

/** All sources remain native. Changes require a new owner decision, never inferred adoption. */
export async function assertHierarchySources(ctx: PluginContext, m: MissionRecord) {
  const hierarchy = m.aggregate.hierarchy;
  if (!hierarchy?.nodes) return;
  const issues = await projectIssues(ctx, m.companyId, m.projectId);
  const expected = new Set(hierarchy.nodes.map(node => node.issueId));
  const operational = new Set([m.aggregate.n5?.publication?.issueId, m.aggregate.n5?.continuation?.previousPublication.issueId].filter(Boolean));
  if (issues.some(issue => issue.parentId && expected.has(issue.parentId) && !expected.has(issue.id) && !operational.has(issue.id))) {
    throw new MissionError(409, "hierarchy_source_changed", "A new descendant is outside the pinned hierarchy; retain all tasks without another departure");
  }
  for (const node of hierarchy.nodes) {
    const issue = await ctx.issues.get(node.issueId, m.companyId);
    const leaf = hierarchy.leaves?.find(item => item.issueId === node.issueId);
    const agentId = node.assigneeAgentId && leaf ? physicalAgent(m, node.assigneeAgentId, { issueId: node.issueId }) : node.assigneeAgentId;
    const relations = await ctx.issues.relations.get(node.issueId, m.companyId);
    if (!issue || issue.id !== node.issueId || issue.companyId !== m.companyId || issue.projectId !== m.projectId
        || !issues.some(item => item.id === issue.id) || issue.parentId !== node.parentId || issue.title !== node.title
        || !descriptionMatchesSource(m, issue.id, issue.description, node.descriptionHash)
        || issue.assigneeAgentId !== agentId || canonicalPayloadHash(relations.blockedBy.map(item => item.id).sort()) !== canonicalPayloadHash(node.blockedByIssueIds)) {
      throw new MissionError(409, "hierarchy_source_changed", "Pinned task identity, result, assignment or native dependencies changed; no replacement or blocker removal");
    }
    if (leaf && (await ctx.issues.documents.get(leaf.issueId, "council-work", m.companyId))?.latestRevisionId !== leaf.documentRevisionId) {
      throw new MissionError(409, "hierarchy_source_changed", "Leaf ownership document changed after admission");
    }
  }
}

export async function assertHierarchyDependencies(ctx: PluginContext, m: MissionRecord, issueId: string) {
  if (!m.aggregate.hierarchy?.leaves) return;
  const relations = await ctx.issues.relations.get(issueId, m.companyId);
  if (relations.blockedBy.some(item => !["done", "cancelled"].includes(item.status))) {
    throw new MissionError(409, "hierarchy_dependency_pending", "Native predecessors must finish before this leaf can be admitted");
  }
}

/** Supply execution guidance as an immutable Council document, preserving the product description. */
export async function materializeHierarchyGuidance(ctx: PluginContext, m: MissionRecord, issueId: string, body: string) {
  const key = `council-execution-${m.missionId}`;
  let doc = await ctx.issues.documents.get(issueId, key, m.companyId);
  if (!doc) {
    await ctx.issues.documents.upsert({ issueId, key, title: "Council admitted contribution", format: "markdown", body, companyId: m.companyId });
    doc = await ctx.issues.documents.get(issueId, key, m.companyId);
  }
  if (!doc?.latestRevisionId || doc.body !== body) throw new MissionError(409, "hierarchy_guidance_unknown", "Original execution guidance is not observed; do not overwrite or create a replacement key");
}
