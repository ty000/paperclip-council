import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash as hash } from "../src/mission-primitives.js";
import { LINEAR_ORIGIN } from "../src/linear-intake-contract.js";
import type { ProjectMandate } from "../src/project-mandate-state.js";

type FixtureNode = { name: string; parent: string | null; status: "blocked" | "done" | "cancelled"; blockers: string[] };
export function linearFixture(definitions: FixtureNode[] = [
  { name: "root", parent: null, status: "blocked", blockers: [] },
  { name: "alpha", parent: "root", status: "blocked", blockers: ["history"] },
  { name: "beta", parent: "root", status: "blocked", blockers: ["alpha"] },
  { name: "history", parent: "root", status: "cancelled", blockers: [] },
  { name: "completed", parent: "root", status: "done", blockers: [] },
]) {
  const ids = Object.fromEntries(["company", "project", "organization", "team", "sourceProject", "todo", "lead", "a", "b", "owner", "policy", "activation", "catalog", "teamRoster", "councilRoster",
    ...definitions.map(node => node.name), ...definitions.map(node => `source-${node.name}`)].map(key => [key, randomUUID()]));
  const sourceSha256 = hash("source fixture"), fingerprint = hash("configuration fixture"), intakeId = `linear-intake-${hash("intake fixture")}`;
  const docKey = (id: string, key: string) => `${id}:${key}`;
  const documents = new Map<string, any>(), issues = new Map<string, any>();
  const keys = (sourceId: string) => ({ issue: `issue:${ids.organization}:${sourceId}`, document: `document:${ids.organization}:${sourceId}:linear-source-v1`, relations: `relations:${ids.organization}:${sourceId}` });
  function document(input: any) {
    const result = { ...input, id: randomUUID(), latestRevisionId: randomUUID(), latestRevisionNumber: 1 };
    documents.set(docKey(input.issueId, input.key), result); return result;
  }
  const planNodes = definitions.map(node => {
    const sourceId = ids[`source-${node.name}`]!;
    const state = { id: node.name === "root" ? ids.todo : randomUUID(), name: node.name === "root" ? "Todo" : node.status,
      type: node.status === "done" ? "completed" : node.status === "cancelled" ? "canceled" : "unstarted" };
    const source = { id: `L4-${node.name}`, uuid: sourceId, parentId: node.parent ? `L4-${node.parent}` : "Unselected-parent-context",
      teamId: ids.team, projectId: ids.sourceProject, title: node.name, description: node.name === "root" ? "Complete source ".repeat(2200) : `${node.name} full result`,
      updatedAt: "2026-10-07T12:00:00.000Z", createdAt: "2026-10-01T12:00:00.000Z", completedAt: node.status === "done" ? "2026-10-06T12:00:00.000Z" : null,
      canceledAt: node.status === "cancelled" ? "2026-10-06T12:00:00.000Z" : null, archivedAt: null,
      status: state.name, statusType: state.type, currentStateId: state.id,
      relations: { blockedBy: node.blockers.map(name => ({ id: `L4-${name}` })), blocks: [], relatedTo: [], duplicateOf: null },
      stateHistory: [{ state, startedAt: "2026-10-07T11:00:00.000Z", endedAt: null }] };
    const originId = `linear:${ids.organization}:${sourceId}`;
    const sourceDocumentBody = JSON.stringify({ schema: "linear-native-source.v1", organizationId: ids.organization, sourceSha256, source,
      provenance: { originKind: LINEAR_ORIGIN, intakeId, activationId: ids.activation, rootSourceId: ids["source-root"], catalogSha256: hash("catalog") } },
    (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item, 2);
    issues.set(ids[node.name]!, { id: ids[node.name], companyId: ids.company, projectId: ids.project, parentId: node.parent ? ids[node.parent] : null,
      originKind: LINEAR_ORIGIN, originId, title: source.title, description: source.description, status: node.status,
      // Native issues.get returns the issue row, without the optional per-user archivedAt enrichment.
      assigneeAgentId: null, assigneeUserId: null, checkoutRunId: null, executionRunId: null, executionLockedAt: null });
    document({ companyId: ids.company, issueId: ids[node.name], key: "linear-source-v1", title: "Linear source", format: "markdown", body: sourceDocumentBody });
    return { sourceId, originId, parentSourceId: node.parent ? ids[`source-${node.parent}`] : null, status: node.status, source,
      blockedBySourceIds: node.blockers.map(name => ids[`source-${name}`]!).sort(), sourceDocumentBody, keys: keys(sourceId) };
  });
  const readinessKey = `readiness:${intakeId}`;
  const plan = { schema: "linear-native-import-plan.v1", originKind: LINEAR_ORIGIN, companyId: ids.company, intakeId,
    activationId: ids.activation, fingerprint, requestVersion: 3, sourceSha256, targetProjectId: ids.project, rootSourceId: ids["source-root"],
    nodes: planNodes, externalBlockers: [], readinessKey, expectedEffectKeys: [...planNodes.flatMap(node => [node.keys.issue, node.keys.document, node.keys.relations]), readinessKey] };
  const effects: any[] = [];
  function effect(effectKey: string, intent: any, result: any) { effects.push({ effectKey, intentSha256: hash(intent), result, resultSha256: hash(result) }); }
  const blockers = new Map<string, string[]>();
  for (const [index, node] of definitions.entries()) {
    const issue = issues.get(ids[node.name]!)!, planNode = planNodes[index]!;
    const { id, assigneeAgentId: _agent, assigneeUserId: _user, checkoutRunId: _checkout, executionRunId: _run, executionLockedAt: _lock, archivedAt: _archive, ...intent } = issue;
    effect(planNode.keys.issue, intent, { nativeId: id, contentSha256: hash(intent) });
    const doc = documents.get(docKey(id, "linear-source-v1"));
    const { id: documentId, latestRevisionId, latestRevisionNumber, ...docIntent } = doc;
    effect(planNode.keys.document, docIntent, { nativeId: documentId, revisionId: latestRevisionId, revisionNumber: latestRevisionNumber, contentSha256: hash(docIntent) });
    const blockerIds = node.blockers.map(name => ids[name]!).sort(), relationIntent = { companyId: ids.company, issueId: id, blockerIds };
    blockers.set(id, blockerIds);
    effect(planNode.keys.relations, relationIntent, { nativeId: id, blockerIds, contentSha256: hash(relationIntent) });
  }
  const readiness = { schema: "linear-native-readiness.v1", companyId: ids.company, intakeId, activationId: ids.activation,
    configurationFingerprint: fingerprint, requestVersion: 3, planSha256: hash(plan), sourceSha256, targetProjectId: ids.project,
    originKind: LINEAR_ORIGIN, nativeRootId: ids.root, sourceRootId: ids["source-root"], correspondence: planNodes.map((node, index) => ({
      sourceId: node.sourceId, nativeId: ids[definitions[index]!.name], originId: node.originId, sourceRevision: node.source.updatedAt, status: node.status })),
    effects, externalBlockers: [] as any[], importStatus: "prepared", admissionAllowed: false, implementationStarted: false,
    receivingContract: "unqualified", requiresCurrentSourceAndMandateRevalidation: true };
  const readinessDocument = document({ companyId: ids.company, issueId: ids.root, key: "linear-intake-readiness-v1", title: "Linear intake readiness", format: "markdown", body: JSON.stringify(readiness) });
  const work = Object.fromEntries(definitions.filter(node => node.parent && node.status === "blocked").map((node, index) => [ids[`source-${node.name}`], {
    assigneeAgentId: ids[index % 2 ? "b" : "a"], ownedPaths: [`src/${node.name}`] }]));
  const policy = { companyId: ids.company, projectId: ids.project, revisionId: ids.policy, version: 1, authorizedBy: ids.owner,
    content: { enabled: true, ownerUserId: ids.owner, leadAgentId: ids.lead, teamRosterId: ids.teamRoster, councilRosterId: ids.councilRoster, teamRevision: "team-v1", councilRevision: "council-v1", allowedPaths: ["src"],
      baselineRootIds: [], criteriaSource: "project-defaults", operatingProfileHash: "profile", publication: null, n3Slots: [],
      template: { acceptanceCriteria: ["Explicit project result"], commitments: [], limits: { taskPolicy: "1000", periodPolicy: "20000", correctionLimit: 0, elapsedMinutes: 30 } },
      hierarchy: { protocol: "council-hierarchy-v1", execution: "sequential", maxContributions: 12, adoptExistingChildren: true },
      linearIntake: { protocol: "linear-intake-receiver-v1", originKind: LINEAR_ORIGIN, organizationId: ids.organization,
        teamId: ids.team, projectId: ids.sourceProject, todoStateId: ids.todo, work } } } as ProjectMandate;
  const get = vi.fn(async (id: string) => structuredClone(issues.get(id) ?? null));
  const list = vi.fn(async (input: any) => {
    // Host61b3fd57 plugin-host-services assertReadableOriginFilter: explicit
    // plugin origins must belong to the caller, even though company-scoped
    // originId reads and get() can read another plugin's native issues.
    const ownOrigin = "plugin:private.paperclip-council";
    if (typeof input.originKind === "string" && input.originKind.startsWith("plugin:")
        && input.originKind !== ownOrigin && !input.originKind.startsWith(`${ownOrigin}:`)) {
      throw new Error(`Plugin may only use originKind values under ${ownOrigin}`);
    }
    return [...issues.values()].filter(issue => !input.originId || issue.originId === input.originId)
      .map(issue => ({ ...issue, description: issue.description.slice(0, 1200) }));
  });
  const update = vi.fn(async (id: string, input: any) => { Object.assign(issues.get(id)!, input); return structuredClone(issues.get(id)!); });
  const upsert = vi.fn(async (input: any) => document(input));
  const ctx = { issues: { get, list, update, documents: { get: async (id: string, key: string) => structuredClone(documents.get(docKey(id, key)) ?? null), upsert },
    relations: { get: async (id: string) => ({ blockedBy: (blockers.get(id) ?? []).map(id => issues.get(id)), blocks: [] }) } } } as unknown as PluginContext;
  return { ids, ctx, policy, readiness, readinessDocument, issues, documents, blockers, get, list, update, upsert, plan, docKey,
    refreshReadiness: () => { readinessDocument.body = JSON.stringify(readiness); }, inventory: () => [...issues.values()] };
}
