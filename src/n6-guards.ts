import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertN6SourceAccounting } from "./n6-accounting.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { acceptedN5Submission } from "./n5-preflight.js";
import type { N6Dependency } from "./n6-state.js";

export const N6_GUARD_ORIGIN = "plugin:private.paperclip-council:result-gate" as const;
export const guardOriginId = (m: MissionRecord) => `mission:${m.missionId}:dependency:${m.aggregate.n6!.intentId}`;

export async function assertN6Owner(ctx: PluginContext, m: MissionRecord, actorId: string | null) {
  const company = await ctx.companies.get(m.companyId);
  if (!actorId || actorId !== m.ownerUserId || company?.defaultResponsibleUserId !== actorId) {
    throw new MissionError(403, "n6_owner_required", "Current mission/company owner must authorize the dependency");
  }
}

export async function readN6Source(ctx: PluginContext, m: MissionRecord, dependency: Pick<N6Dependency, "sourceMissionId" | "sourceRootIssueId">) {
  const source = await getMission(ctx, m.companyId, dependency.sourceMissionId);
  if (!source || source.companyId !== m.companyId || source.projectId !== m.projectId
      || source.rootIssueId !== dependency.sourceRootIssueId || source.missionId === m.missionId) {
    throw new MissionError(409, "n6_source_scope", "One different source in the same company/project is required");
  }
  return source;
}

export async function assertN6Acyclic(ctx: PluginContext, target: MissionRecord, source: MissionRecord) {
  const visited = new Set([target.missionId]);
  let cursor: MissionRecord | null = source;
  while (cursor) {
    if (visited.has(cursor.missionId)) throw new MissionError(409, "n6_cycle", "Result dependency would create a cycle");
    visited.add(cursor.missionId);
    cursor = cursor.aggregate.n6 ? await readN6Source(ctx, cursor, cursor.aggregate.n6) : null;
  }
}

/** Accepted result is separate from PR publication; every admitted source run must be settled. */
export async function assertN6AcceptedSource(ctx: PluginContext, m: MissionRecord) {
  const dep = m.aggregate.n6!;
  await assertN6Owner(ctx, m, dep.authorizedBy);
  const source = await readN6Source(ctx, m, dep);
  const submission = acceptedN5Submission(source);
  const actual = { submissionId: submission.submissionId, candidateCommit: submission.candidateCommit,
    bundleSha256: submission.sha256, evidenceRevision: submission.evidenceRevision, mandateHash: submission.mandateHash };
  if (canonicalPayloadHash(actual) !== canonicalPayloadHash(dep.expectedResult)) {
    throw new MissionError(409, "n6_result_mismatch", "Accepted predecessor differs from the authorized exact result");
  }
  await assertN6SourceAccounting(ctx, source);
  return source;
}

export async function readN6Guard(ctx: PluginContext, m: MissionRecord) {
  const dep = m.aggregate.n6!;
  const guard = dep.guardIssueId ? await ctx.issues.get(dep.guardIssueId, m.companyId) : null;
  if (!guard || guard.companyId !== m.companyId || guard.projectId !== m.projectId || guard.parentId
      || guard.assigneeAgentId || guard.assigneeUserId || guard.originKind !== N6_GUARD_ORIGIN || guard.originId !== guardOriginId(m)) {
    throw new MissionError(409, "n6_guard_unconfirmed", "Exact unassigned native dependency gate must be confirmed");
  }
  return guard;
}

export async function assertN6LaunchReady(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>) {
  if (!m.aggregate.n6) return;
  const dep = m.aggregate.n6;
  const authorized = body.command === "activate" ? dep.activationBody : dep.startBody;
  if (!authorized || canonicalPayloadHash(body) !== canonicalPayloadHash(authorized)) {
    throw new MissionError(409, "n6_launch_authority", "N6 activation and dispatch must use the exact persisted owner-authorized commands");
  }
  if (dep.coordination && (dep.coordination.state !== "released" || dep.coordination.tasks.some(t => !t.closedAt || !t.settledAt))) {
    throw new MissionError(409, "n6_coordination_pending", "Delegated coordination must release B after all work settles");
  }
  await assertN6AcceptedSource(ctx, m);
  const guard = await readN6Guard(ctx, m);
  const relations = await ctx.issues.relations.get(m.rootIssueId, m.companyId);
  if (!m.aggregate.n6.verifiedAt || guard.status !== "done"
      || !relations.blockedBy.some(issue => issue.id === guard.id)
      || relations.blockedBy.some(issue => issue.status !== "done")) {
    throw new MissionError(409, "n6_gate_pending", "Exact verified native gate and all blockers must be done before admission/dispatch");
  }
}

/** Exact accepted attachment is accessible to the authenticated downstream lead; no floating Git ref. */
export async function readN6Handoff(ctx: PluginContext, m: MissionRecord) {
  const source = await assertN6AcceptedSource(ctx, m);
  const accepted = acceptedN5Submission(source);
  const attachment = (await ctx.issues.listAttachments(source.rootIssueId, source.companyId)).find(a => a.id === accepted.attachmentId);
  if (!attachment || attachment.companyId !== source.companyId || attachment.issueId !== source.rootIssueId
      || attachment.sha256 !== accepted.sha256 || attachment.byteSize !== accepted.byteSize) {
    throw new MissionError(409, "n6_attachment_mismatch", "Exact accepted source attachment must remain available and unchanged");
  }
  return { sourceMissionId: source.missionId, sourceRootIssueId: source.rootIssueId, expectedResult: m.aggregate.n6!.expectedResult,
    attachmentId: accepted.attachmentId, downloadPath: `/api/attachments/${accepted.attachmentId}/content`,
    sha256: accepted.sha256, byteSize: accepted.byteSize, baseCommit: accepted.baseCommit, candidateCommit: accepted.candidateCommit,
    instruction: "Download with injected Bearer auth; verify SHA256, Git bundle and exact candidate before consuming. Never substitute main or a branch." };
}
