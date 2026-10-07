import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash } from "./mission-primitives.js";
import { LINEAR_ORIGIN, requireLinear, type LinearNode, type LinearPreparation } from "./linear-intake-contract.js";

type Persist = (state: LinearPreparation) => Promise<void>;
type Operation = { key: string; intent: Record<string, unknown>; read: () => Promise<{ revisionId?: string } | null>; dispatch: () => Promise<unknown> };
type Session = { state: LinearPreparation; persist: Persist; guard: () => Promise<void> };
async function save(session: Session, key: string, effect: LinearPreparation["effects"][string]) {
  const next = { ...session.state, effects: { ...session.state.effects, [key]: effect } };
  await session.persist(next); session.state = next;
}
async function perform(session: Session, operation: Operation) {
  const intentSha256 = canonicalPayloadHash(operation.intent), saved = session.state.effects[operation.key];
  if (saved) requireLinear(saved.intentSha256 === intentSha256, "linear_preparation_intent_changed");
  let observed = await operation.read();
  if (!observed) {
    requireLinear(!saved, "linear_preparation_unknown", "A claimed preparation is unresolved; reconcile its original native identity without redispatch");
    await session.guard();
    await save(session, operation.key, { state: "claimed", intentSha256 });
    await session.guard();
    await operation.dispatch();
    observed = await operation.read();
    requireLinear(observed, "linear_preparation_unknown");
  }
  if (saved?.state === "confirmed") {
    requireLinear(saved.revisionId === observed.revisionId, "linear_preparation_changed"); return;
  }
  await save(session, operation.key, { state: "confirmed", intentSha256, ...observed });
}
function idle(issue: Issue) {
  requireLinear([issue.assigneeUserId, issue.checkoutRunId, issue.executionRunId, issue.executionLockedAt, issue.archivedAt].every(value => value === null), "linear_preparation_execution");
}
function identity(issue: Issue | null, companyId: string, projectId: string, node: LinearNode): asserts issue is Issue {
  requireLinear(issue, "linear_native_missing");
  const actual = [issue.id, issue.companyId, issue.projectId, issue.parentId, issue.originKind, issue.originId, issue.title, issue.description];
  const expected = [node.nativeId, companyId, projectId, node.parentId, LINEAR_ORIGIN, node.originId, node.title, node.description];
  requireLinear(canonicalPayloadHash(actual) === canonicalPayloadHash(expected), "linear_preparation_changed"); idle(issue);
}
function assignment(ctx: PluginContext, session: Session, node: LinearNode): Operation {
  const { companyId, targetProjectId } = session.state.snapshot.subject;
  const key = `assignment:${node.nativeId}`, body = { status: "backlog" as const, assigneeAgentId: node.assigneeAgentId };
  return { key, intent: { companyId, issueId: node.nativeId, ...body }, async read() {
    const issue = await ctx.issues.get(node.nativeId, companyId); identity(issue, companyId, targetProjectId, node);
    if (issue.status === "backlog" && issue.assigneeAgentId === node.assigneeAgentId) {
      requireLinear(session.state.effects[key], "linear_preparation_unattributed"); return {};
    }
    requireLinear(issue.status === node.status && issue.assigneeAgentId === null, "linear_preparation_changed"); return null;
  }, dispatch: () => ctx.issues.update(node.nativeId, body, companyId) };
}
function workDocument(ctx: PluginContext, session: Session, node: LinearNode): Operation {
  const { companyId } = session.state.snapshot.subject;
  const input = { companyId, issueId: node.nativeId, key: "council-work", title: "Council authorized work", format: "markdown" as const,
    body: JSON.stringify({ ownedPaths: node.ownedPaths }) };
  return { key: `work:${node.nativeId}`, intent: input, async read() {
    const doc = await ctx.issues.documents.get(node.nativeId, input.key, companyId);
    if (!doc) return null;
    const fields = { companyId: doc.companyId, issueId: doc.issueId, key: doc.key, title: doc.title, format: doc.format, body: doc.body };
    requireLinear(canonicalPayloadHash(fields) === canonicalPayloadHash(input), "linear_work_document_conflict");
    requireLinear(doc.latestRevisionId, "linear_work_document_revision"); return { revisionId: doc.latestRevisionId };
  }, dispatch: () => ctx.issues.documents.upsert(input) };
}

/** A persisted CAS claim permits one native write. Absence after a claim never permits another write. */
export async function prepareLinearTasks(ctx: PluginContext, state: LinearPreparation, persist: Persist, guard: () => Promise<void>): Promise<LinearPreparation> {
  const session = { state, persist, guard };
  for (const node of state.snapshot.nodes) {
    if (node.role === "historical") continue;
    await perform(session, assignment(ctx, session, node));
    if (node.role === "contribution") await perform(session, workDocument(ctx, session, node));
  }
  return session.state;
}

/** Bounded mission objective, never a truncation of the full native source description. */
export function linearMissionObjective(state: LinearPreparation): string {
  const snapshot = state.snapshot, root = snapshot.nodes.find(node => node.nativeId === snapshot.subject.nativeRootId)!;
  const objective = `${root.title}\n\n${root.description}`;
  if (objective.length <= 4000) return objective;
  return ["Implement the selected Linear source family under the explicit project acceptance criteria and commitments.",
    `Native root: ${root.nativeId}. Complete title and description remain on that issue.`,
    `Full immutable source: ${root.sourceDocumentId} revision ${root.sourceRevisionId}.`,
    `Source document body digest: ${root.sourceBodySha256}.`,
    `Family source digest: ${snapshot.subject.sourceSha256}.`,
    `Readiness: ${snapshot.subject.readinessDocumentId} revision ${snapshot.subject.readinessRevisionId}.`,
    `Readiness receipt digest: ${snapshot.subject.readinessSha256}.`,
    "Historical descendants are preserved evidence, not executable contributions or newly completed work."].join("\n");
}
