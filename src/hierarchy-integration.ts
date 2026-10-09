import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readAdmission, reserveAdmission } from "./admission.js";
import { assertNativeLaunchAllowed, readNativeG4Profile, readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { getMission, MissionError, type MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import type { N1Integration } from "./n1-integration-state.js";
import { n2Cas } from "./n2-missions.js";
import { assertContinuityDeparture, assertN1DepartureWindow } from "./continuity-policy.js";
import { bindVariantIssue, claimVariantWake, observeVariantRun, prepareVariantLaunch, recordVariantWake } from "./model-runtime.js";
import { physicalAgent } from "./model-state.js";
import { assertHierarchySources } from "./hierarchy-runtime.js";

const state = (m: MissionRecord) => m.aggregate.n1 as N1State;
const taskAt = (m: MissionRecord) => state(m).integration!;
const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;
const save = (ctx: PluginContext, m: MissionRecord, task: N1Integration) =>
  n2Cas(ctx, m, { ...m.aggregate, n1: { ...state(m), integration: task } });

function instructions(m: MissionRecord) {
  return `Integrate the already verified sequential contributions for Council mission ${m.missionId}. This is the final integration stage, not another planning attempt. Do not redispatch or rewrite the children's commit history. Read the original root issue ${m.rootIssueId} and its native plan document before editing: implement the shared interfaces, wiring, and composed tests assigned to the lead in that plan, within projectMandate.allowedPaths. This stage grants only the planned integration work, no unrelated refactor or child reimplementation.
POST /api/plugins/private.paperclip-council/api/issues/$PAPERCLIP_TASK_ID/council/commands with Authorization: Bearer $PAPERCLIP_API_KEY and x-paperclip-run-id: $PAPERCLIP_RUN_ID. Normalize trailing /api in PAPERCLIP_API_URL. Never print credentials.
Begin with exactly {"command":"inspect","missionId":"${m.missionId}"}. Require every participant to have a commit and ${m.aggregate.projectMandate?.completion?.result === "integrated-verified" ? "proof.readyAt (product delivery is still pending)" : "proof.closedAt"}; require n1.integration.runId to equal your run ID. Use n1.sourceBaseCommit as the immutable base; verify the working tree is clean and HEAD equals the final child's commit. If this fails, stop and report the exact mismatch without another wake.
Complete the planned integration and run the repository's relevant composed validation. Preserve all child commits as ancestors. Create exactly one final integration commit containing the planned shared changes; use git commit --allow-empty only when no shared edit is necessary. Derive integrationAdjustedPaths from the exact changed files of that one commit (git diff --name-only HEAD^ HEAD), not from a handwritten approximation. Create refs/heads/base at sourceBaseCommit and refs/heads/candidate at the new full SHA; git bundle create <file> refs/heads/base refs/heads/candidate and git bundle verify <file>. Compute SHA-256 and upload multipart field file to /api/companies/${m.companyId}/issues/${m.rootIssueId}/attachments with the same authenticated headers. The attachment belongs to the original product root, while Council commands address this integration task.
Inspect for the current version, then POST {command:"publish",missionId:"${m.missionId}",commandId:<node crypto.randomUUID()>,expectedVersion:<observed>,attachmentId:<upload response>,baseCommit:<full pinned SHA>,candidateCommit:<full new SHA>,expectedSha256:<computed digest>,integrationAdjustedPaths:<exact files from final commit>}. Omit integrationAdjustedPaths when the final commit is empty. Require HTTP 200. Retain sanitized non-2xx response and stop on failure. Finish your run; Council settles it then starts the admitted review. Do not PATCH native status, comment, or wake another run.
Plugins/skills à utiliser : Paperclip and Git tools already installed, followed by Council inspect/publish. No new plugin installation.
Modèle et effort recommandés : lead d'intégration, Sol/medium under the pinned orchestration mapping (model-effort-mapping.md, 2026-09-05). The admitted physical profile remains authoritative; availability is not inferred from these instructions.`;
}

async function prepareIssue(ctx: PluginContext, initial: MissionRecord) {
  let m = initial, task = taskAt(m);
  const prepared = await prepareVariantLaunch(ctx, m, { taskKey: m.rootIssueId, interventionKey: "integration",
    launchKey: task.reservationId, logicalAgentId: m.aggregate.responsibilities.integrationLeadAgentId,
    family: "orchestration", expectedRoles: ["lead"], ...(task.issueId ? { issueId: task.issueId } : {}) });
  m = prepared.mission;
  if (task.issueId) return m;
  const agentId = prepared.binding?.agentId ?? m.aggregate.responsibilities.integrationLeadAgentId;
  const originKind = "plugin:private.paperclip-council:n1-integration";
  if (task.creation === "pending") {
    task = { ...task, creation: "claimed" }; m = await save(ctx, m, task);
    try { await ctx.issues.create({ companyId: m.companyId, projectId: m.projectId, status: "backlog", assigneeAgentId: agentId,
      title: `Council integration ${m.missionId}`, description: instructions(m), inheritExecutionWorkspaceFromIssueId: m.rootIssueId,
      originKind, originId: task.taskId }); } catch { /* Only correlate the original create. */ }
  }
  const matches = await ctx.issues.list({ companyId: m.companyId, projectId: m.projectId, originKind, originId: task.taskId,
    includePluginOperations: true, limit: 2 });
  const issue = matches.length === 1 ? await ctx.issues.get(matches[0]!.id, m.companyId) : null;
  const expected = { companyId: m.companyId, projectId: m.projectId, assigneeAgentId: agentId,
    status: "backlog", originKind, originId: task.taskId, description: instructions(m) };
  if (!issue || issue.parentId || Object.entries(expected).some(([key, value]) => issue[key as keyof typeof issue] !== value)) {
    throw new MissionError(409, "hierarchy_integration_creation_unknown", "Correlate the original integration task; never create a replacement");
  }
  return save(ctx, m, { ...task, issueId: issue.id, creation: "confirmed" });
}

async function launch(ctx: PluginContext, initial: MissionRecord) {
  let m = initial;
  assertContinuityDeparture(m); assertN1DepartureWindow(m);
  await assertHierarchySources(ctx, m);
  m = await prepareIssue(ctx, m); let task = taskAt(m);
  if (task.wake === "claimed") throw new MissionError(409, "hierarchy_integration_wake_unknown", "Retain the exact claimed wake; no automatic retry");
  const profile = await readNativeG4Profile(ctx, m.companyId);
  const envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey: state(m).periodKey });
  if (!profile || !envelope) throw new MissionError(409, "hierarchy_integration_budget", "Retain the original native token profile and envelope");
  const usageBaselineUnits = await assertNativeLaunchAllowed(ctx, { companyId: m.companyId, issueId: task.issueId! });
  await reserveAdmission(ctx, { companyId: m.companyId, periodKey: state(m).periodKey, reservationId: task.reservationId,
    missionId: m.missionId, effectId: task.taskId, requestedUnits: profile.runReservationUnits,
    attempt: { kind: "initial", ordinal: 0 }, expectedVersion: envelope.version });
  m = await bindVariantIssue(ctx, m, task.reservationId, task.issueId!);
  m = await claimVariantWake(ctx, m, task.reservationId, (before, aggregate) => save(ctx, { ...before, aggregate },
    { ...task, wake: "claimed", usageBaselineUnits }));
  let wake: { runId: string | null } | null = null;
  try {
    await ctx.issues.update(task.issueId!, { status: "todo" }, m.companyId);
    wake = await ctx.issues.requestWakeup(task.issueId!, m.companyId, { idempotencyKey: `council:n1:integration:${task.taskId}`,
      reason: "council_hierarchy_integration", actorUserId: m.aggregate.continuity!.authorizedBy });
  } catch { /* Claimed effect remains retained even when transport is unknown. */ }
  m = await fresh(ctx, m);
  m = await recordVariantWake(ctx, m, task.reservationId, wake?.runId ?? null, (before, aggregate, runId) =>
    save(ctx, { ...before, aggregate }, { ...taskAt(before), runId }));
  if (!taskAt(m).runId) throw new MissionError(409, "hierarchy_integration_wake_unknown", "Exact native integration run remains unobserved");
  return m;
}

export async function advanceHierarchyIntegration(ctx: PluginContext, initial: MissionRecord) {
  let m = initial;
  if (!state(m).integration) {
    assertContinuityDeparture(m); assertN1DepartureWindow(m);
    m = await save(ctx, m, { taskId: randomUUID(), reservationId: randomUUID(), settlementCommandId: randomUUID(),
      issueId: null, creation: "pending", wake: "pending", runId: null });
  }
  let task = taskAt(m);
  if (!task.runId) { await launch(ctx, m); return "hierarchy_integration_started"; }
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: task.issueId!, runId: task.runId,
    agentId: physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: task.issueId!, runId: task.runId }) });
  if (["queued", "running", "scheduled_retry"].includes(run.status)) return "hierarchy_integration_running";
  if (!task.settledAt) {
    const envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey: state(m).periodKey });
    if (!envelope) throw new MissionError(409, "hierarchy_integration_budget", "Original envelope is required");
    await settleOrdinaryRunUsage(ctx, { companyId: m.companyId, issueId: task.issueId!, runId: task.runId,
      agentId: run.agentId, commandId: task.settlementCommandId, periodKey: state(m).periodKey,
      reservationId: task.reservationId, expectedVersion: envelope.version });
    m = await observeVariantRun(ctx, await fresh(ctx, m), task.reservationId);
    task = { ...taskAt(m), settledAt: new Date().toISOString() }; m = await save(ctx, m, task);
  }
  if (run.status !== "succeeded" || !state(m).candidate) throw new MissionError(409, "hierarchy_integration_incomplete", "Terminal cost is settled; the integration stage did not publish a verified candidate");
  await n2Cas(ctx, m, { ...m.aggregate, phase: "ready_for_review", control: { status: "inactive", reason: "candidate_ready_for_review" },
    journal: [...m.aggregate.journal, { action: "hierarchy_integration_settled", runId: task.runId, candidate: state(m).candidate!.candidate, at: task.settledAt }] });
  return "hierarchy_ready_for_review";
}
