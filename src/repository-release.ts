import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import type { AdmissionDocument } from "./admission.js";
import { nativeRunBindings } from "./native-run-bindings.js";
import { uncertainLinearEffects } from "./linear-continuity-control.js";
import { releaseReconciledRepository } from "./repository-occupation.js";

const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

async function campaignTerminal(ctx: PluginContext, m: MissionRecord) {
  if (m.aggregate.linearContinuity?.mode !== "milestone-fixed-v1") return true;
  const { campaignMembersSafe } = await import("./repository-campaign.js");
  return campaignMembersSafe(ctx, m, m.aggregate.completion?.state === "closed" ? "closed" : "cancelled");
}

function unresolvedCreation(m: MissionRecord) {
  const n1 = m.aggregate.n1 as N1State | undefined;
  const tasks = [...(m.aggregate.n2?.ordinary?.tasks ?? []), ...(m.aggregate.n6?.coordination?.tasks ?? []),
    ...(n1?.integration ? [n1.integration] : []), ...(m.aggregate.campaignClosure ? [m.aggregate.campaignClosure.task] : [])];
  return n1?.contributions.some(s => ["creation_claimed", "unknown"].includes(s.issueState) || s.nativeWait?.state === "claimed")
    || (n1?.coordination?.state === "claimed" && !n1.coordination.issueId)
    || m.aggregate.modelSelection?.tasks.some(task => task.launches.some(launch => !launch.runId && ["wake_claimed", "unknown"].includes(launch.state)))
    || tasks.some(t => t.creation === "claimed" && !t.issueId);
}

/** Read-only proof of stopped work. A terminal label or elapsed time alone never releases. */
export async function reconcileRepositoryRelease(ctx: PluginContext, m: MissionRecord): Promise<boolean> {
  if (m.aggregate.completion?.state !== "closed" && m.aggregate.linearContinuity?.control !== "cancelled") return false;
  if (uncertainLinearEffects(m) || unresolvedCreation(m)
      || m.aggregate.linearContinuity?.publications.some(p => !p.acknowledgement)) return false;
  if (!await campaignTerminal(ctx, m)) return false;
  const bindings = nativeRunBindings(m);
  if (bindings.some(b => b.pending)) return false;
  const documents = await ctx.db.query<{ document: AdmissionDocument }>(
    `SELECT document FROM ${ctx.db.namespace}.admission_envelopes WHERE company_id = $1`, [m.companyId]);
  const reservations = documents.flatMap(d => d.document.reservations.filter(r => r.missionId === m.missionId));
  if (documents.some(d => d.document.unadmittedRuns?.some(r => r.missionId === m.missionId))
      || reservations.some(r => r.status !== "settled" || r.usage?.status !== "known" || r.remainingExposure.status !== "known" || r.remainingExposure.units !== 0)
      || bindings.some(b => b.runId && !reservations.some(r => r.reservationId === b.reservationId))) return false;
  const issueIds = [...new Set([m.rootIssueId, ...(m.aggregate.hierarchy?.nodes ?? []).map(n => n.issueId), ...bindings.map(b => b.issueId)])];
  if (issueIds.length > 64) return false;
  for (const issueId of issueIds) {
    const issue = await ctx.issues.get(issueId, m.companyId);
    const inventory = await ctx.issues.summaries.getOrchestration({ companyId: m.companyId, issueId, includeSubtree: false });
    if (!issue || issue.companyId !== m.companyId || issue.projectId !== m.projectId || issue.checkoutRunId || issue.executionRunId
        || inventory.companyId !== m.companyId || inventory.issueId !== issueId || inventory.runs.length > 256
        || new Set(inventory.runs.map(run => run.id)).size !== inventory.runs.length
        || bindings.some(b => b.issueId === issueId && b.runId && !inventory.runs.some(run => run.id === b.runId && run.agentId === b.agentId))) return false;
    if (inventory.runs.some(run => !terminal.has(run.status) || run.issueId !== issueId
        || !(bindings.some(b => b.issueId === issueId && b.runId === run.id && b.agentId === run.agentId)
          || (issueId === m.rootIssueId && m.aggregate.nativeWakePolicy?.protocol === "council-native-wake-v2"
            && m.aggregate.nativeWakePolicy.rootBaseline.some(b => b.runId === run.id && b.agentId === run.agentId))))) return false;
  }
  await releaseReconciledRepository(ctx, m);
  return true;
}
