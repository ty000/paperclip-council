import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash } from "./mission-primitives.js";
import type { ProjectMandate } from "./project-mandate-state.js";
import { ownershipsOverlap } from "./integration.js";
import { LINEAR_ORIGIN, LINEAR_READINESS_KEY, LINEAR_SOURCE_KEY, parseLinearReadiness, parseLinearSource, requireLinear,
  type LinearNode, type LinearReadiness, type LinearReadinessSnapshot, type LinearPreparation, type LinearSourceDocument } from "./linear-intake-contract.js";

type IssueDocument = NonNullable<Awaited<ReturnType<PluginContext["issues"]["documents"]["get"]>>>;
type Source = { native: Issue; document: IssueDocument; parsed: LinearSourceDocument };
function same(actual: unknown, expected: unknown, code = "linear_readback_mismatch") {
  requireLinear(canonicalPayloadHash(actual) === canonicalPayloadHash(expected), code);
}
function linearDocumentIntent(doc: IssueDocument) {
  return { companyId: doc.companyId, issueId: doc.issueId, key: doc.key, title: doc.title, format: doc.format, body: doc.body };
}
function documentResult(doc: IssueDocument) {
  requireLinear(doc.latestRevisionId && doc.latestRevisionNumber > 0, "linear_document_revision");
  return { nativeId: doc.id, revisionId: doc.latestRevisionId, revisionNumber: doc.latestRevisionNumber, contentSha256: canonicalPayloadHash(linearDocumentIntent(doc)) };
}
function effect(readiness: LinearReadiness, key: string, intent: unknown, observed: unknown) {
  const matches = readiness.effects.filter(item => item.effectKey === key);
  requireLinear(matches.length === 1, "linear_effect_missing");
  const receipt = matches[0]!;
  same(receipt.intentSha256, canonicalPayloadHash(intent));
  same(receipt.resultSha256, canonicalPayloadHash(receipt.result));
  same(receipt.result, observed);
}
function keys(org: string, sourceId: string) {
  return { issue: `issue:${org}:${sourceId}`, document: `document:${org}:${sourceId}:linear-source-v1`, relations: `relations:${org}:${sourceId}` };
}
function bindReadiness(policy: ProjectMandate, rootId: string, doc: IssueDocument, body: LinearReadiness) {
  same([doc.companyId, doc.issueId, doc.key, doc.title, doc.format], [policy.companyId, rootId, LINEAR_READINESS_KEY, "Linear intake readiness", "markdown"]);
  same([body.companyId, body.targetProjectId, body.nativeRootId], [policy.companyId, policy.projectId, rootId]);
  requireLinear(body.externalBlockers.length === 0, "linear_external_blocker", "Unresolved external source blockers grant no extra read or import authority");
  requireLinear(new Set(body.correspondence.map(node => node.nativeId)).size === body.correspondence.length, "linear_duplicate_identity");
  requireLinear(new Set(body.correspondence.map(node => node.sourceId)).size === body.correspondence.length, "linear_duplicate_identity");
  requireLinear(body.effects.length === body.correspondence.length * 3, "linear_effect_inventory");
  requireLinear(new Set(body.effects.map(item => item.effectKey)).size === body.effects.length, "linear_effect_inventory");
}
function bindSource(policy: ProjectMandate, body: LinearReadiness, entry: LinearReadiness["correspondence"][number], parsed: LinearSourceDocument) {
  const scope = policy.content.linearIntake!, source = parsed.source;
  same([parsed.organizationId, source.teamId, source.projectId], [scope.organizationId, scope.teamId, scope.projectId]);
  same([parsed.sourceSha256, source.uuid, source.updatedAt], [body.sourceSha256, entry.sourceId, entry.sourceRevision]);
  same(parsed.provenance, { originKind: LINEAR_ORIGIN, intakeId: body.intakeId, activationId: body.activationId,
    rootSourceId: body.sourceRootId, catalogSha256: parsed.provenance.catalogSha256 });
  same(entry.originId, `linear:${scope.organizationId}:${entry.sourceId}`);
  same(entry.status, source.statusType === "completed" ? "done" : source.statusType === "canceled" ? "cancelled" : "blocked");
  const open = source.stateHistory.filter(interval => interval.endedAt === null);
  requireLinear(open.length === 1, "linear_state_history");
  same([open[0]!.state.id, open[0]!.state.name, open[0]!.state.type], [source.currentStateId, source.status, source.statusType]);
  if (entry.sourceId === body.sourceRootId) same([source.currentStateId, source.archivedAt, entry.status], [scope.todoStateId, null, "blocked"]);
}
async function readSource(ctx: PluginContext, policy: ProjectMandate, body: LinearReadiness, entry: LinearReadiness["correspondence"][number]): Promise<Source> {
  const native = await ctx.issues.get(entry.nativeId, policy.companyId);
  requireLinear(native, "linear_native_missing");
  same([native.id, native.companyId, native.projectId, native.originKind, native.originId], [entry.nativeId, policy.companyId, policy.projectId, LINEAR_ORIGIN, entry.originId]);
  const origins = await ctx.issues.list({ companyId: policy.companyId, originKind: LINEAR_ORIGIN, originId: entry.originId, includePluginOperations: true, limit: 2 });
  same(origins.map(item => item.id), [entry.nativeId], "linear_origin_ambiguous");
  const document = await ctx.issues.documents.get(native.id, LINEAR_SOURCE_KEY, policy.companyId);
  requireLinear(document, "linear_source_document_missing");
  same([document.companyId, document.issueId, document.key, document.title, document.format], [policy.companyId, native.id, LINEAR_SOURCE_KEY, "Linear source", "markdown"]);
  const parsed = parseLinearSource(document.body);
  bindSource(policy, body, entry, parsed);
  return { native, document, parsed };
}
function sourceReferences(sources: Source[]) {
  const refs = new Map<string, Source>();
  for (const item of sources) for (const key of [item.parsed.source.id, item.parsed.source.uuid]) {
    requireLinear(!refs.has(key) || refs.get(key) === item, "linear_source_alias"); refs.set(key, item);
  }
  return refs;
}
function parentFor(item: Source, body: LinearReadiness, refs: Map<string, Source>) {
  if (item.parsed.source.uuid === body.sourceRootId) return null;
  const parent = refs.get(item.parsed.source.parentId ?? "");
  requireLinear(parent, "linear_parent_missing");
  return parent.native.id;
}
function blockersFor(item: Source, refs: Map<string, Source>) {
  return [...new Set(item.parsed.source.relations.blockedBy.map(ref => {
    const blocker = refs.get(ref.id); requireLinear(blocker, "linear_external_blocker"); return blocker.native.id;
  }))].sort();
}
function requireIdle(issue: Issue) {
  same([issue.assigneeUserId, issue.checkoutRunId, issue.executionRunId, issue.executionLockedAt, issue.archivedAt], [null, null, null, null, null]);
}
function nativeWaiting(item: Source, node: LinearNode, preparation?: LinearPreparation) {
  requireIdle(item.native);
  const claim = preparation?.effects[`assignment:${node.nativeId}`];
  if (claim) {
    const initial = item.native.status === node.status && item.native.assigneeAgentId === null;
    const prepared = item.native.status === "backlog" && item.native.assigneeAgentId === node.assigneeAgentId;
    requireLinear(prepared || initial && claim.state === "claimed", "linear_preparation_changed");
  } else same([item.native.status, item.native.assigneeAgentId], [node.status, null]);
}
async function nodeFor(ctx: PluginContext, policy: ProjectMandate, body: LinearReadiness, item: Source, refs: Map<string, Source>) {
  const entry = body.correspondence.find(node => node.nativeId === item.native.id)!;
  const parentId = parentFor(item, body, refs), blockerIds = blockersFor(item, refs), source = item.parsed.source;
  const intent = { companyId: policy.companyId, projectId: policy.projectId, parentId, title: source.title,
    description: source.description ?? "", status: entry.status, originKind: LINEAR_ORIGIN, originId: entry.originId };
  same([item.native.parentId, item.native.title, item.native.description], [parentId, intent.title, intent.description]);
  const identity = keys(policy.content.linearIntake!.organizationId, entry.sourceId);
  effect(body, identity.issue, intent, { nativeId: item.native.id, contentSha256: canonicalPayloadHash(intent) });
  effect(body, identity.document, linearDocumentIntent(item.document), documentResult(item.document));
  const relationIntent = { companyId: policy.companyId, issueId: item.native.id, blockerIds };
  const relations = await ctx.issues.relations.get(item.native.id, policy.companyId);
  same(relations.blockedBy.map(blocker => blocker.id).sort(), blockerIds);
  effect(body, identity.relations, relationIntent, { nativeId: item.native.id, blockerIds, contentSha256: canonicalPayloadHash(relationIntent) });
  return { nativeId: item.native.id, sourceId: source.uuid, parentId, originId: entry.originId, title: source.title,
    description: intent.description, status: entry.status, blockerIds, sourceDocumentId: item.document.id,
    sourceRevisionId: item.document.latestRevisionId!, sourceBodySha256: canonicalPayloadHash(item.document.body),
    role: "historical" as LinearNode["role"], assigneeAgentId: null as string | null, ownedPaths: [] as string[] };
}
function requireTree(nodes: LinearNode[], rootId: string) {
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string, depth: number) {
    requireLinear(depth <= 8 && !visiting.has(id), "linear_hierarchy_cycle_bound");
    visiting.add(id); visited.add(id);
    for (const child of nodes.filter(node => node.parentId === id)) visit(child.nativeId, depth + 1);
    visiting.delete(id);
  }
  requireLinear(nodes.filter(node => node.parentId === null).length === 1, "linear_parent_inventory");
  visit(rootId, 0); requireLinear(visited.size === nodes.length, "linear_parent_inventory");
}
function assignRoles(nodes: LinearNode[], policy: ProjectMandate) {
  const work = policy.content.linearIntake!.work;
  for (const node of nodes) {
    const activeChildren = nodes.filter(child => child.parentId === node.nativeId && child.status === "blocked");
    if (node.status !== "blocked") { requireLinear(activeChildren.length === 0, "linear_terminal_parent_active_child"); continue; }
    node.assigneeAgentId = policy.content.leadAgentId;
    node.role = node.parentId ? "aggregate" : "root";
    if (!node.parentId || activeChildren.length) continue;
    const assignment = work[node.sourceId]; requireLinear(assignment, "linear_work_missing", "Every executable source leaf requires an explicit project assignment and ownedPaths");
    node.role = "contribution"; node.assigneeAgentId = assignment.assigneeAgentId; node.ownedPaths = assignment.ownedPaths;
  }
  const leaves = nodes.filter(node => node.role === "contribution");
  requireLinear(leaves.length > 0, "linear_no_executable_descendant");
  requireLinear(leaves.length <= policy.content.hierarchy!.maxContributions, "linear_contribution_bound");
  for (const [i, a] of leaves.entries()) for (const b of leaves.slice(i + 1)) {
    requireLinear(!a.ownedPaths.some(path => b.ownedPaths.some(other => ownershipsOverlap(path, other))), "linear_ownership_overlap");
  }
}
function requireDependencies(nodes: LinearNode[]) {
  const done = new Set(nodes.filter(node => node.status !== "blocked").map(node => node.nativeId));
  const pending = nodes.filter(node => node.role === "contribution");
  while (pending.length) {
    const index = pending.findIndex(node => node.blockerIds.every(id => done.has(id)));
    requireLinear(index >= 0, "linear_dependency_pending", "Only acyclic dependencies between executable leaves or resolved source history are supported");
    done.add(pending.splice(index, 1)[0]!.nativeId);
  }
}
function requireInventory(nodes: LinearNode[], issues: Issue[]) {
  const ids = new Set(nodes.map(node => node.nativeId));
  requireLinear(nodes.every(node => issues.some(issue => issue.id === node.nativeId)), "linear_inventory_missing");
  requireLinear(!issues.some(issue => issue.parentId && ids.has(issue.parentId) && !ids.has(issue.id)), "linear_inventory_extra");
}
function requirePlan(body: LinearReadiness, sources: Source[], nodes: LinearNode[], org: string) {
  const byId = new Map(nodes.map(node => [node.nativeId, node]));
  const planNodes = sources.map((item, index) => {
    const node = nodes[index]!, identity = keys(org, node.sourceId);
    return { sourceId: node.sourceId, originId: node.originId, parentSourceId: node.parentId ? byId.get(node.parentId)!.sourceId : null,
      status: node.status, source: item.parsed.source, blockedBySourceIds: node.blockerIds.map(id => byId.get(id)!.sourceId).sort(),
      sourceDocumentBody: item.document.body, keys: identity };
  });
  const readinessKey = `readiness:${body.intakeId}`;
  same(canonicalPayloadHash({ schema: "linear-native-import-plan.v1", originKind: LINEAR_ORIGIN, companyId: body.companyId,
    intakeId: body.intakeId, activationId: body.activationId, fingerprint: body.configurationFingerprint, requestVersion: body.requestVersion,
    sourceSha256: body.sourceSha256, targetProjectId: body.targetProjectId, rootSourceId: body.sourceRootId, nodes: planNodes,
    externalBlockers: body.externalBlockers, readinessKey,
    expectedEffectKeys: [...planNodes.flatMap(node => [node.keys.issue, node.keys.document, node.keys.relations]), readinessKey] }), body.planSha256, "linear_plan_digest");
}

/** Full source/native readback; list responses are used only for complete identity inventory. */
export async function readLinearIntake(ctx: PluginContext, policy: ProjectMandate, rootId: string, issues: Issue[], preparation?: LinearPreparation): Promise<LinearReadinessSnapshot> {
  requireLinear(policy.content.linearIntake && policy.content.hierarchy?.adoptExistingChildren, "linear_policy_required");
  const doc = await ctx.issues.documents.get(rootId, LINEAR_READINESS_KEY, policy.companyId);
  requireLinear(doc, "linear_readiness_missing");
  const body = parseLinearReadiness(doc.body); bindReadiness(policy, rootId, doc, body);
  const sources: Source[] = [];
  for (const entry of body.correspondence) sources.push(await readSource(ctx, policy, body, entry));
  const refs = sourceReferences(sources), nodes: LinearNode[] = [];
  for (const item of sources) nodes.push(await nodeFor(ctx, policy, body, item, refs));
  requireTree(nodes, rootId); requireInventory(nodes, issues); assignRoles(nodes, policy); requireDependencies(nodes);
  sources.forEach((item, index) => nativeWaiting(item, nodes[index]!, preparation));
  requirePlan(body, sources, nodes, policy.content.linearIntake!.organizationId);
  const receipt = { ...documentResult(doc), nativeRootId: body.nativeRootId, planSha256: body.planSha256, sourceSha256: body.sourceSha256 };
  const subject = { companyId: body.companyId, intakeId: body.intakeId, activationId: body.activationId,
    configurationFingerprint: body.configurationFingerprint, requestVersion: body.requestVersion, nativeRootId: body.nativeRootId,
    targetProjectId: body.targetProjectId, sourceSha256: body.sourceSha256, planSha256: body.planSha256,
    readinessDocumentId: doc.id, readinessRevisionId: doc.latestRevisionId!, readinessSha256: canonicalPayloadHash(receipt) };
  const result = { body, subject, bodySha256: canonicalPayloadHash(body), nodes };
  if (preparation) same(result, preparation.snapshot, "linear_pinned_readiness_changed");
  return result;
}
