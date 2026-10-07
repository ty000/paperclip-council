import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { projectIssues } from "./project-mandate-state.js";
import { physicalAgent, modelLaunchGuidance } from "./model-state.js";
import { LINEAR_ORIGIN, LINEAR_READINESS_KEY, LINEAR_SOURCE_KEY, requireLinear } from "./linear-intake-contract.js";
import type { HierarchyNode } from "./hierarchy-contract.js";

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

async function assertLinearReadiness(ctx: PluginContext, m: MissionRecord) {
  const snapshot = m.aggregate.projectMandate?.linearIntake;
  if (!snapshot) return;
  const doc = await ctx.issues.documents.get(m.rootIssueId, LINEAR_READINESS_KEY, m.companyId);
  requireLinear(doc?.latestRevisionId === snapshot.subject.readinessRevisionId && doc.id === snapshot.subject.readinessDocumentId, "linear_readiness_changed");
  let body: unknown;
  try { body = JSON.parse(doc.body); } catch { requireLinear(false, "linear_readiness_changed"); }
  requireLinear(canonicalPayloadHash(body) === snapshot.bodySha256, "linear_readiness_changed");
}
async function assertLinearNode(ctx: PluginContext, m: MissionRecord, node: HierarchyNode, issue: Awaited<ReturnType<PluginContext["issues"]["get"]>>) {
  if (!node.linearSource) return;
  requireLinear(issue?.originKind === LINEAR_ORIGIN && issue.originId === node.linearSource.originId, "linear_source_identity_changed");
  const doc = await ctx.issues.documents.get(node.issueId, LINEAR_SOURCE_KEY, m.companyId);
  requireLinear(doc?.latestRevisionId === node.linearSource.documentRevisionId && canonicalPayloadHash(doc.body) === node.linearSource.bodySha256, "linear_source_document_changed");

}

/** All sources remain native. Changes require a new owner decision, never inferred adoption. */
export async function assertHierarchySources(ctx: PluginContext, m: MissionRecord) {
  const hierarchy = m.aggregate.hierarchy;
  if (!hierarchy?.nodes) return;
  await assertLinearReadiness(ctx, m);
  const issues = await projectIssues(ctx, m.companyId, m.projectId);
  const expected = new Set(hierarchy.nodes.map(node => node.issueId));
  const operational = new Set([m.aggregate.n5?.publication?.issueId, m.aggregate.n5?.continuation?.previousPublication.issueId].filter(Boolean));
  if (issues.some(issue => issue.parentId && expected.has(issue.parentId) && !expected.has(issue.id) && !operational.has(issue.id))) {
    throw new MissionError(409, "hierarchy_source_changed", "A new descendant is outside the pinned hierarchy; retain all tasks without another departure");
  }
  for (const node of hierarchy.nodes) {
    const issue = await ctx.issues.get(node.issueId, m.companyId);
    await assertLinearNode(ctx, m, node, issue);
    const leaf = hierarchy.leaves?.find(item => item.issueId === node.issueId);
    const agentId = node.assigneeAgentId && leaf ? physicalAgent(m, node.assigneeAgentId, { issueId: node.issueId }) : node.assigneeAgentId;
    const relations = await ctx.issues.relations.get(node.issueId, m.companyId);
    if (node.historicalStatus && issue?.status !== node.historicalStatus) throw new MissionError(409, "hierarchy_history_changed", "Imported terminal history cannot be reopened or counted as new execution");
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
