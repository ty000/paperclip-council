import { replaceMissingOpinion } from "./n2-ordinary-replacement.js";
import { ordinaryTaskInstructions } from "./n2-ordinary-instructions.js";
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AdmissionError } from "./admission.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { recordCouncilOrdinaryReadback } from "./decision-receipts.js";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, n2CommandCas, n2SubmissionResultReference, nativeN2Profile, prepareN2Decision,
  recordN2Decision, reserveN2Run, runtimeReceipt, runtimeUuid, startN2Review, startN2ResubmittedReview } from "./n2-missions.js";
import { freshN3Round } from "./n3-runtime.js";
import { n3Round, type N3NativeRound } from "./n3-state.js";
import type { N3OpinionSlot } from "./n3-opinions.js";
import { currentOrdinaryTask, freshOrdinary, ordinaryReceiptSubject, ordinaryTask, saveOrdinaryTask, validateOrdinaryReport,
  type OrdinaryTask } from "./n2-ordinary-state.js";
import { readOrdinaryRunSummary } from "./n2-ordinary-report.js";

function ordinaryRound(mission: MissionRecord, submission: Parameters<typeof freshN3Round>[1], slots: N3OpinionSlot[]): N3NativeRound {
  const { transmission: _unused, ...round } = freshN3Round(mission, submission, slots);
  return round;
}
function reviewTasks(mission: MissionRecord, round: N3NativeRound) {
  return [...round.review.slots.map(slot => ordinaryTask("specialist", round.review.subject.submissionId, slot.specialistAgentId, slot.slotId)),
    ordinaryTask("council", round.review.subject.submissionId, mission.aggregate.responsibilities.finalReviewerAgentId)];
}
async function requireCli(ctx: PluginContext, mission: MissionRecord, agentId: string) {
  const agent = await ctx.agents.get(agentId, mission.companyId);
  if (!agent || agent.adapterType !== "codex_local" || agent.adapterConfig?.engine !== "cli"
      || ["paused", "terminated", "pending_approval"].includes(agent.status)) {
    throw new MissionError(422, "ordinary_cli_required", "Ordinary Council actors must be available codex_local agents with explicit cli engine");
  }
}
async function assertRootIdle(ctx: PluginContext, mission: MissionRecord) {
  const root = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  const summary = await ctx.issues.summaries.getOrchestration({ companyId: mission.companyId, issueId: mission.rootIssueId, includeSubtree: false });
  if (!root || root.assigneeAgentId !== mission.aggregate.responsibilities.integrationLeadAgentId || root.status !== "in_progress"
      || root.executionPolicy || root.executionState || summary.runs.some(run => ["queued", "running"].includes(run.status))) {
    throw new MissionError(409, "ordinary_root_not_idle", "Root must remain under its lead, without native review policy/state or active run");
  }
}
export async function executeOrdinaryN2Board(ctx: PluginContext, mission: MissionRecord, input: { actorUserId: string | null; body: Record<string, unknown> }) {
  const body = input.body;
  if (body.command === "replace-missing-opinion") return replaceMissingOpinion(ctx, mission, input.actorUserId!, body);
  if (body.command === "reconcile-ordinary-n2") {
    await reconcileOrdinaryN2(ctx, mission);
    return { outcome: "reconciled", mission: await freshOrdinary(ctx, mission) };
  }
  if (body.command !== "start-review") throw new MissionError(400, "ordinary_command_unavailable", "Ordinary owner commands are start-review and reconcile-ordinary-n2");
  const prior = runtimeReceipt(mission, runtimeUuid(body.commandId, "commandId"), input.actorUserId!, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", mission, receipt: prior };
  if (mission.aggregate.n2 || mission.version !== body.expectedVersion) throw new MissionError(409, "ordinary_start_conflict", "Fresh ready-for-review mission version required");
  await assertRootIdle(ctx, mission);
  const { envelope } = await nativeN2Profile(ctx, mission);
  if (envelope.reservations.some(item => item.missionId === mission.missionId && item.status !== "settled")) {
    throw new MissionError(409, "ordinary_source_usage_pending", "Every prerequisite reservation must settle before ordinary review");
  }
  const state = startN2Review(mission, { baselineRunIds: [], baselineTokenTotal: 0, submissionId: runtimeUuid(body.submissionId, "submissionId") });
  const round = ordinaryRound(mission, state.submissions[0]!, body.n3Slots as N3OpinionSlot[]);
  for (const id of [...round.review.slots.map(slot => slot.specialistAgentId), mission.aggregate.responsibilities.finalReviewerAgentId,
    mission.aggregate.responsibilities.integrationLeadAgentId]) await requireCli(ctx, mission, id);
  const tasks = reviewTasks(mission, round);
  state.rounds[0]!.handoff.reservationId = tasks.at(-1)!.reservationId;
  state.ordinary = { protocol: "ordinary-cli-v1", tasks };
  const claimed = await n2CommandCas(ctx, mission, body, "user", input.actorUserId!, { ...mission.aggregate, phase: "review_handoff",
    control: { status: "active" }, n2: state, n3: { slots: round.review.slots, rounds: [round] } });
  await reconcileOrdinaryN2(ctx, claimed.mission);
  return { ...claimed, mission: await freshOrdinary(ctx, mission) };
}

async function dispatchTask(ctx: PluginContext, initial: MissionRecord, initialTask: OrdinaryTask) {
  let mission = initial; let task = initialTask;
  await requireCli(ctx, mission, task.agentId);
  if (!task.issueId) {
    if (task.creation !== "pending") throw new MissionError(409, "ordinary_effect_unknown", "Task creation was claimed; reconcile its existing effect, never create a replacement");
    mission = await saveOrdinaryTask(ctx, mission, { ...task, creation: "claimed" });
    const issue = await ctx.issues.create({ companyId: mission.companyId, projectId: mission.projectId,
      title: `Council ${task.kind} ${task.slotId ?? ""} ${task.submissionId}`, status: "backlog", assigneeAgentId: task.agentId,
      inheritExecutionWorkspaceFromIssueId: mission.rootIssueId,
      originKind: "plugin:private.paperclip-council:ordinary", originId: task.taskId,
      description: ordinaryTaskInstructions(mission, task) });
    task = { ...task, issueId: issue.id, creation: "confirmed" };
    mission = await saveOrdinaryTask(ctx, mission, task);
  }
  if (task.wake === "claimed") throw new MissionError(409, "ordinary_effect_unknown", "Wake already claimed; an unbound outcome cannot authorize another wake");
  await reserveN2Run(ctx, mission, { reservationId: task.reservationId, effectId: task.taskId, kind: task.replacementOf ? "resume" : task.kind === "correction" ? "correction" : "initial",
    ownerReplacementCommandId: task.replacementOf ? mission.aggregate.n2!.ordinary!.missingOpinionReplacement!.commandId : undefined });
  task = { ...task, wake: "claimed" };
  mission = await saveOrdinaryTask(ctx, mission, task);
  if (task.kind === "correction") {
    const root = await ctx.issues.get(task.issueId!, mission.companyId);
    await ctx.issues.update(task.issueId!, { status: "in_progress", description: `${root?.description ?? ""}\n\n${ordinaryTaskInstructions(mission, task)}` }, mission.companyId);
  } else await ctx.issues.update(task.issueId!, { status: "todo" }, mission.companyId);
  const wake = await ctx.issues.requestWakeup(task.issueId!, mission.companyId, { idempotencyKey: `council:ordinary:${task.taskId}`,
    reason: "council_ordinary_admitted", actorUserId: mission.ownerUserId });
  mission = await freshOrdinary(ctx, mission); task = currentOrdinaryTask(mission, task.taskId);
  if (!wake.runId || task.runId && task.runId !== wake.runId) throw new MissionError(409, "ordinary_effect_unknown", "Ordinary dispatch outcome requires exact run readback");
  return saveOrdinaryTask(ctx, mission, { ...task, runId: wake.runId });
}

async function settleTask(ctx: PluginContext, initial: MissionRecord, task: OrdinaryTask) {
  let mission = initial;
  const identity = { companyId: mission.companyId, issueId: task.issueId!, agentId: task.agentId, runId: task.runId! };
  const run = await readOrdinaryRun(ctx, identity);
  if (["queued", "running"].includes(run.status)) return null;
  const { profile, envelope } = await nativeN2Profile(ctx, mission);
  await settleOrdinaryRunUsage(ctx, { ...identity, commandId: task.settlementCommandId, reservationId: task.reservationId,
    periodKey: profile.periodKey, expectedVersion: envelope.version });
  if (run.status !== "succeeded") throw new MissionError(409, "ordinary_run_failed", "Terminal costs are recorded, but unsuccessful work cannot advance the mission");
  if (task.kind === "council") validateOrdinaryReport(mission, task, await readOrdinaryRunSummary(ctx, run));
  mission = await freshOrdinary(ctx, mission); task = currentOrdinaryTask(mission, task.taskId);
  const settledAt = new Date().toISOString();
  const state = mission.aggregate.n2!; const n3 = mission.aggregate.n3!;
  return n2Cas(ctx, mission, { ...mission.aggregate,
    n2: { ...state, ordinary: { ...state.ordinary!, tasks: state.ordinary!.tasks.map(item => item.taskId === task.taskId ? { ...task, settledAt } : item) }, ...(task.kind === "correction" ? { correction: { ...state.correction!, usageSettledAt: settledAt } } : {}),
      rounds: state.rounds.map(round => task.kind === "council" && round.submissionId === task.submissionId
        ? { ...round, handoff: { ...round.handoff, usageSettledAt: settledAt } } : round) },
    n3: { ...n3, rounds: n3.rounds.map(round => round.review.subject.submissionId === task.submissionId ? { ...round,
      specialists: round.specialists.map(item => item.slotId === task.slotId ? { ...item, issueId: task.issueId, runId: task.runId,
        reservationId: task.reservationId, settlementCommandId: task.settlementCommandId, wake: "claimed", creation: "claimed", settledAt } : item) } : round) } });
}

async function applyVerdict(ctx: PluginContext, mission: MissionRecord, task: OrdinaryTask) {
  const state = mission.aggregate.n2!; const submission = state.submissions.find(item => item.submissionId === task.submissionId)!;
  const report = task.report!;
  if (canonicalPayloadHash(n3Round(mission)!.review.synthesis) !== report.synthesisHash) throw new MissionError(409, "ordinary_synthesis_changed", "Council report must retain its exact N3 synthesis");
  const operationId = task.taskId;
  const correctionTask = ordinaryTask("correction", task.submissionId, mission.aggregate.responsibilities.integrationLeadAgentId);
  const existingIntent = mission.aggregate.effectIntents.find(item => item.kind === "n2_decision" && item.operationId === operationId);
  const correctionReservationId = typeof existingIntent?.reservationId === "string" ? existingIntent.reservationId : correctionTask.reservationId;
  const common = { companyId: mission.companyId, issueId: mission.rootIssueId, actorAgentId: task.agentId, runId: task.runId!,
    operationId, justification: report.rationale, resultReference: n2SubmissionResultReference(task.submissionId) };
  const decision = report.verdict === "approved" ? { ...common, verdict: "approved" as const, approvedCommit: submission.candidateCommit }
    : { ...common, verdict: "changes_requested" as const };
  if (!state.rounds.some(round => round.verdict?.operationId === operationId)) {
  mission = await prepareN2Decision(ctx, mission, decision, correctionReservationId);
  const receipt = await recordCouncilOrdinaryReadback(ctx, decision, { issueId: task.issueId!, report, requestBody: ordinaryReceiptSubject(submission, task) });
  mission = await recordN2Decision(ctx, mission.missionId, decision, receipt);
  }
  const latest = mission.aggregate.n2!;
  const tasks = latest.ordinary!.tasks.map(item => item.taskId === task.taskId ? { ...item, receiptRecordedAt: new Date().toISOString() } : item);
  if (report.verdict === "changes_requested" && !tasks.some(item => item.kind === "correction")) {
    tasks.push({ ...correctionTask, reservationId: latest.correction!.reservationId!, issueId: mission.rootIssueId, creation: "confirmed" });
  }
  return n2Cas(ctx, mission, { ...mission.aggregate, n2: { ...latest, ordinary: { ...latest.ordinary!, tasks } } });
}

/** One durable, sequential dispatcher; explicit owner reconciliation resumes events, never uncertain effects. */
export async function reconcileOrdinaryN2(ctx: PluginContext, initial: MissionRecord) {
  let mission = await freshOrdinary(ctx, initial);
  for (let step = 0; step < 12; step++) {
    const state = mission.aggregate.n2!;
    const task = state.ordinary!.tasks.find(item => !item.closedAt);
    if (!task) return mission;
    if (task.replacedBy) {
      await ctx.issues.update(task.issueId!, { status: "cancelled" }, mission.companyId);
      mission = await saveOrdinaryTask(ctx, mission, { ...task, closedAt: new Date().toISOString() });
      continue;
    }
    if (!task.runId) return dispatchTask(ctx, mission, task);
    if (!task.settledAt) {
      const settled = await settleTask(ctx, mission, task);
      if (!settled) return mission;
      mission = settled; continue;
    }
    if (task.kind === "specialist" && !n3Round(mission)!.review.opinions.some(opinion => opinion.slotId === task.slotId && opinion.specialistRunId === task.runId)) {
      throw new MissionError(409, "ordinary_opinion_missing", "Finished specialist task is not an opinion or implied agreement");
    }
    if (task.kind === "council" && !task.receiptRecordedAt) { mission = await applyVerdict(ctx, mission, task); continue; }
    if (task.kind === "correction") {
      if (state.status !== "resubmission_prepared") throw new MissionError(409, "ordinary_resubmission_missing", "Finished correction must supply a verified new candidate");
      const submission = state.correction!.preparedSubmission!;
      const round = ordinaryRound(mission, submission, mission.aggregate.n3!.slots);
      const tasks = reviewTasks(mission, round);
      const next = startN2ResubmittedReview(state, mission, { baselineRunIds: [task.runId], baselineTokenTotal: 0, reservationId: tasks.at(-1)!.reservationId });
      mission = await n2Cas(ctx, mission, { ...mission.aggregate, phase: "review_handoff", n2: { ...next,
        ordinary: { ...next.ordinary!, tasks: [...next.ordinary!.tasks.map(item => item.taskId === task.taskId ? { ...item, closedAt: new Date().toISOString() } : item), ...tasks] } },
        n3: { ...mission.aggregate.n3!, rounds: [...mission.aggregate.n3!.rounds, round] } });
      continue;
    }
    await ctx.issues.update(task.issueId!, { status: "done" }, mission.companyId);
    mission = await saveOrdinaryTask(ctx, mission, { ...task, closedAt: new Date().toISOString() });
    if (mission.aggregate.n2!.status === "accepted") {
      await ctx.issues.update(mission.rootIssueId, { status: "done" }, mission.companyId);
      return mission;
    }
  }
  throw new AdmissionError(409, "ordinary_reconcile_bound", "Ordinary reconciliation step bound reached");
}
