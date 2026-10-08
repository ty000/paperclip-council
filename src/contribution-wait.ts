import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError, type MissionAggregate, type MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";

const originKind = "plugin:private.paperclip-council:operation:contribution-settlement";
type Persist = (m: MissionRecord, aggregate: MissionAggregate) => Promise<MissionRecord>;
const slotAt = (m: MissionRecord, id: string) => (m.aggregate.n1 as N1State).contributions.find(s => s.contributionId === id)!;
const originId = (m: MissionRecord, id: string) => `${m.missionId}:${id}`;

async function readWait(ctx: PluginContext, m: MissionRecord, id: string) {
  const matches = await ctx.issues.list({ companyId: m.companyId, projectId: m.projectId,
    originKind, originId: originId(m, id), includePluginOperations: true, limit: 2 });
  const issue = matches.length === 1 ? await ctx.issues.get(matches[0]!.id, m.companyId) : null;
  const expected = { companyId: m.companyId, projectId: m.projectId, originKind, originId: originId(m, id) };
  if (!issue || issue.parentId || issue.assigneeAgentId || issue.assigneeUserId
      || Object.entries(expected).some(([key, value]) => issue[key as keyof typeof issue] !== value)
      || !["backlog", "done"].includes(issue.status)
      || slotAt(m, id).nativeWait?.issueId && slotAt(m, id).nativeWait!.issueId !== issue.id) {
    throw new MissionError(409, "contribution_wait_unknown", "Read back the original Council settlement task; do not create a replacement or launch an agent");
  }
  return issue;
}

/** A real native dependency holds the child while its admitted run finishes. */
export async function ensureContributionWait(ctx: PluginContext, initial: MissionRecord, id: string, persist: Persist) {
  let m = initial;
  const slot = slotAt(m, id);
  if (!slot.commit || !slot.proof || !slot.childIssueId || slot.authorRunId !== slot.dispatchRunId) {
    throw new MissionError(409, "contribution_wait_binding", "Only the recorded, verified contribution may wait for settlement");
  }
  if (!slot.nativeWait) {
    const n1 = m.aggregate.n1 as N1State;
    m = await persist(m, { ...m.aggregate, n1: { ...n1, contributions: n1.contributions.map(s => s.contributionId === id
      ? { ...s, nativeWait: { state: "claimed" as const } } : s) } });
    try {
      await ctx.issues.create({ companyId: m.companyId, projectId: m.projectId, status: "backlog", originKind,
        originId: originId(m, id), title: `Council — règlement de contribution ${id}`,
        description: `Attente technique gérée par Council pour ${slot.childIssueId}. Aucun agent à lancer ni décision humaine attendue. Council termine cette tâche après règlement du run ${slot.dispatchRunId} et clôture vérifiée de la contribution.` });
    } catch { /* A claimed create is reconciled by its original correlation only. */ }
  }
  const wait = await readWait(ctx, m, id);
  const child = await ctx.issues.get(slot.childIssueId, m.companyId);
  if (wait.status !== "backlog" && child?.status !== "done") {
    throw new MissionError(409, "contribution_wait_released", "The settlement dependency cannot finish before its contribution");
  }
  const relations = await ctx.issues.relations.get(slot.childIssueId, m.companyId);
  if (!relations.blockedBy.some(b => b.id === wait.id)) {
    await ctx.issues.relations.addBlockers(slot.childIssueId, [wait.id], m.companyId);
  }
  if (!(await ctx.issues.relations.get(slot.childIssueId, m.companyId)).blockedBy.some(b => b.id === wait.id)) {
    throw new MissionError(409, "contribution_wait_unobserved", "Observe the native dependency before parking the contribution");
  }
  if (!slotAt(m, id).nativeWait?.issueId) {
    const n1 = m.aggregate.n1 as N1State;
    m = await persist(m, { ...m.aggregate, n1: { ...n1, contributions: n1.contributions.map(s => s.contributionId === id
      ? { ...s, nativeWait: { state: "confirmed" as const, issueId: wait.id } } : s) } });
  }
  return m;
}

/** Close the dependency only after native child closure: no newly runnable child. */
export async function finishContributionWait(ctx: PluginContext, m: MissionRecord, id: string) {
  const slot = slotAt(m, id);
  if (!slot.nativeWait) return; // Previously delivered missions retain their original proof.
  const wait = await readWait(ctx, m, id);
  const child = await ctx.issues.get(slot.childIssueId!, m.companyId);
  if (child?.status !== "done") throw new MissionError(409, "contribution_wait_child_pending", "Close the verified contribution before its settlement dependency");
  if ((await ctx.issues.relations.get(child.id, m.companyId)).blockedBy.some(b => b.id === wait.id)) {
    await ctx.issues.relations.removeBlockers(child.id, [wait.id], m.companyId);
  }
  if ((await ctx.issues.relations.get(child.id, m.companyId)).blockedBy.some(b => b.id === wait.id)) {
    throw new MissionError(409, "contribution_wait_release_unknown", "Observe removal of only the Council settlement dependency after child closure");
  }
  if (wait.status !== "done") await ctx.issues.update(wait.id, { status: "done" }, m.companyId);
  if ((await readWait(ctx, m, id)).status !== "done") throw new MissionError(409, "contribution_wait_close_unknown", "Read back the original settlement task closure");
}
