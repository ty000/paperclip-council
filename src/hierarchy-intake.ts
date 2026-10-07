import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { HierarchyLeaf, HierarchyState } from "./hierarchy-contract.js";
import type { ProjectMandate } from "./project-mandate-state.js";
import { projectIssues } from "./project-mandate-state.js";
import { validateRosterPair } from "./rosters.js";
import { ownershipsOverlap } from "./integration.js";
import type { LinearReadinessSnapshot } from "./linear-intake-contract.js";

function paths(value: unknown, policy: ProjectMandate) {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new MissionError(422, "hierarchy_work_paths", "Each leaf needs explicit ownedPaths in its council-work JSON document");
  return value.map(path => {
    if (typeof path !== "string" || path.length > 512 || path.startsWith("/") || path.includes("\\")) throw new MissionError(422, "hierarchy_work_paths", "Safe bounded repository-relative leaf ownership required");
    const normalized = path.replace(/\/$/, "");
    if (normalized.split("/").some(segment => ["", ".", "..", ".git"].includes(segment))
        || !policy.content.allowedPaths.some(allowed => allowed === "." || normalized === allowed || normalized.startsWith(`${allowed}/`))) {
      throw new MissionError(422, "hierarchy_write_scope", "Leaf ownership exceeds the pinned project paths");
    }
    return path;
  });
}

async function leaf(ctx: PluginContext, policy: ProjectMandate, issue: Awaited<ReturnType<typeof projectIssues>>[number], allowed: Set<string>): Promise<HierarchyLeaf> {
  if (!issue.assigneeAgentId || !allowed.has(issue.assigneeAgentId) || !["backlog", "blocked"].includes(issue.status) || !issue.description?.trim()) {
    throw new MissionError(422, "hierarchy_leaf_eligibility", "Existing leaves must have an explicit result, a declared contributor and waiting status; completed or running tasks are preserved for an evidence decision");
  }
  const doc = await ctx.issues.documents.get(issue.id, "council-work", policy.companyId);
  let work: any;
  try { work = doc && JSON.parse(doc.body); } catch { /* no inferred ownership */ }
  if (!work || !doc?.latestRevisionId || Array.isArray(work) || Object.keys(work).some(key => key !== "ownedPaths")) {
    throw new MissionError(422, "hierarchy_work_document", "Add council-work JSON with ownedPaths only to each existing leaf; dependencies remain native relations");
  }
  const relations = await ctx.issues.relations.get(issue.id, policy.companyId);
  return { contributionId: randomUUID(), issueId: issue.id, parentId: issue.parentId!, assigneeAgentId: issue.assigneeAgentId,
    title: issue.title, descriptionHash: canonicalPayloadHash(issue.description), documentRevisionId: doc.latestRevisionId,
    ownedPaths: paths(work.ownedPaths, policy), blockedByIssueIds: relations.blockedBy.map(blocker => blocker.id).sort(),
    pendingBlockerIds: relations.blockedBy.filter(blocker => !["done", "cancelled"].includes(blocker.status)).map(blocker => blocker.id) };
}

function descendants(rootId: string, issues: Awaited<ReturnType<typeof projectIssues>>) {
  const selected: typeof issues = []; let frontier = [rootId]; const visited = new Set(frontier);
  for (let depth = 0; frontier.length; depth++) {
    if (depth >= 8) throw new MissionError(409, "hierarchy_depth_bound", "An explicit plan is needed beyond eight levels");
    const children = issues.filter(issue => frontier.includes(issue.parentId ?? ""));
    if (children.some(issue => visited.has(issue.id)) || selected.length + children.length > 32) throw new MissionError(409, "hierarchy_tree_bound", "Retain the existing tree; its cycle or size exceeds the complete 32-node scope");
    children.forEach(issue => visited.add(issue.id)); selected.push(...children); frontier = children.map(issue => issue.id);
  }
  return selected;
}

function order(leaves: HierarchyLeaf[]) {
  const pending = [...leaves], sorted: HierarchyLeaf[] = [], ids = new Set(leaves.map(item => item.issueId));
  if (leaves.some(item => item.pendingBlockerIds.some(id => !ids.has(id)))) {
    throw new MissionError(409, "hierarchy_external_dependency", "A pending dependency outside the executable leaves needs resolution; no product arbitration or blocker removal");
  }
  while (pending.length) {
    const index = pending.findIndex(item => item.pendingBlockerIds.every(id => sorted.some(previous => previous.issueId === id)));
    if (index < 0) throw new MissionError(409, "hierarchy_dependency_cycle", "Leaf dependencies contain a cycle; retain the original tasks and relations");
    sorted.push(pending.splice(index, 1)[0]!);
  }
  return sorted;
}

function historicalStatus(issueId: string, imported?: LinearReadinessSnapshot) {
  const node = imported?.nodes.find(item => item.nativeId === issueId);
  return node?.role === "historical" ? node.status as "done" | "cancelled" : undefined;
}
function requireWaiting(sources: Awaited<ReturnType<typeof projectIssues>>, imported?: LinearReadinessSnapshot) {
  for (const issue of sources) {
    const historical = historicalStatus(issue.id, imported);
    const expected = historical ? issue.status === historical : ["backlog", "blocked"].includes(issue.status);
    if (!expected || issue.checkoutRunId || issue.executionRunId) throw new MissionError(409, "hierarchy_existing_execution", "Adoption requires waiting work without active locks; imported terminal history must retain its pinned status");
  }
}
export async function prepareHierarchy(ctx: PluginContext, policy: ProjectMandate, rootId: string, issues: Awaited<ReturnType<typeof projectIssues>>, imported?: LinearReadinessSnapshot): Promise<HierarchyState | undefined> {
  const contract = policy.content.hierarchy;
  const previews = descendants(rootId, issues);
  if (!previews.length) return contract;
  if (!contract?.adoptExistingChildren) throw new MissionError(409, "project_hierarchy_pending", "Existing children are retained; their adoption requires explicit hierarchy authority in the project mandate");
  const sources = await Promise.all([issues.find(item => item.id === rootId)!, ...previews].map(async preview => {
    const issue = await ctx.issues.get(preview.id, policy.companyId);
    if (!issue || issue.id !== preview.id || issue.companyId !== policy.companyId || issue.projectId !== policy.projectId || issue.parentId !== preview.parentId) {
      throw new MissionError(409, "hierarchy_source_changed", "Exact full native hierarchy readback required; list descriptions are previews");
    }
    return issue;
  }));
  const [root, ...tree] = sources;
  requireWaiting(sources, imported);
  const leafIssues = imported ? tree.filter(issue => imported.nodes.some(node => node.nativeId === issue.id && node.role === "contribution"))
    : tree.filter(issue => !tree.some(child => child.parentId === issue.id));
  if (leafIssues.length > contract.maxContributions) throw new MissionError(422, "hierarchy_contribution_bound", "The existing leaf count exceeds the declared contribution bound");
  const pair = await validateRosterPair(ctx, policy.companyId, policy.content.teamRosterId, policy.content.councilRosterId);
  if (!pair.eligible || pair.team.head.publishedRevision !== policy.content.teamRevision) throw new MissionError(409, "hierarchy_roster_drift", "Retain the pinned contributor roster before adoption");
  const allowed = new Set(pair.team.revision.content.members.map(member => member.agentId).filter(id => id !== policy.content.leadAgentId));
  const leaves: HierarchyLeaf[] = [];
  for (const issue of leafIssues) leaves.push(await leaf(ctx, policy, issue, allowed));
  for (const [index, left] of leaves.entries()) for (const right of leaves.slice(index + 1)) {
    if (left.ownedPaths.some(a => right.ownedPaths.some(b => ownershipsOverlap(a, b)))) throw new MissionError(422, "hierarchy_ownership_overlap", "Existing leaf write ownership overlaps; the owner must resolve the scope");
  }
  const nodes = [];
  for (const issue of [root!, ...tree]) {
    const relations = await ctx.issues.relations.get(issue.id, policy.companyId);
    const importedNode = imported?.nodes.find(node => node.nativeId === issue.id);
    nodes.push({ issueId: issue.id, parentId: issue.parentId, title: issue.title, descriptionHash: canonicalPayloadHash(issue.description),
      assigneeAgentId: issue.assigneeAgentId, blockedByIssueIds: relations.blockedBy.map(blocker => blocker.id).sort(),
      ...(importedNode ? { linearSource: { originId: importedNode.originId, documentRevisionId: importedNode.sourceRevisionId, bodySha256: importedNode.sourceBodySha256 } } : {}),
      ...(historicalStatus(issue.id, imported) ? { historicalStatus: historicalStatus(issue.id, imported) } : {}) });
  }
  return { ...contract, leaves: order(leaves), nodes, ancestorIds: tree.filter(issue => !leafIssues.includes(issue) && !historicalStatus(issue.id, imported)).map(issue => issue.id) };
}
