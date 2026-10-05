import { modelLaunch, physicalAgent } from "./model-state.js";
import { recordVariantWake } from "./model-runtime.js";
import { ordinaryTaskInstructions } from "./n2-ordinary-instructions.js";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { readOrdinaryRun } from "./g4-native.js";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { inspectN2State, n2Cas, n2CommandCas, prepareResubmissionCommand, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { n3Round, inspectN3 } from "./n3-state.js";
import { recordN3Opinion, synthesizeN3Review } from "./n3-opinions.js";
import { currentOrdinaryTask, saveOrdinaryTask, type OrdinaryReport, type OrdinaryTask } from "./n2-ordinary-state.js";

function assertOwnerResume(mission: MissionRecord, task: OrdinaryTask, run: Awaited<ReturnType<typeof readOrdinaryRun>>) {
  const continuation = mission.aggregate.n5?.continuation;
  if (!task.runId && task.kind === "correction" && continuation
      && (run.contextSnapshot.resumeIntent !== true || Date.parse(run.startedAt!) < Date.parse(continuation.requestedAt))) {
    throw new MissionError(409, "ordinary_owner_resume_required", "The reserved post-publication correction must bind the owner's explicit root resume run");
  }
}

async function bindActor(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput) {
  const task = mission.aggregate.n2!.ordinary!.tasks.find(item => item.issueId === input.params.issueId
    && item.submissionId === mission.aggregate.n2!.activeSubmissionId && !item.settledAt);
  const launch = task ? modelLaunch(mission, task.reservationId) : undefined;
  if (!task || input.actor.actorType !== "agent" || physicalAgent(mission, task.agentId, { issueId: task.issueId, launchKey: task.reservationId }) !== input.actor.agentId || !input.actor.runId || task.wake !== "claimed"
      || mission.aggregate.modelSelection && (!launch || !["wake_claimed", "unknown", "bound"].includes(launch.state))
      || task.runId && task.runId !== input.actor.runId) throw new MissionError(403, "ordinary_actor_binding", "Exact admitted task, actor and run required");
  const run = await readOrdinaryRun(ctx, { companyId: mission.companyId, issueId: task.issueId!, agentId: input.actor.agentId, runId: input.actor.runId });
  if (run.status !== "running" || !run.startedAt || run.finishedAt) throw new MissionError(409, "ordinary_run_inactive", "Command requires its active CLI run");
  assertOwnerResume(mission, task, run);
  mission = await recordVariantWake(ctx, mission, task.reservationId, run.id);
  if (!task.runId) mission = await saveOrdinaryTask(ctx, mission, { ...task, runId: run.id });
  const state = mission.aggregate.n2!;
  if (task.kind === "council" && state.status === "review_handoff") {
    mission = await n2Cas(ctx, mission, { ...mission.aggregate, phase: "reviewing", n2: { ...state, status: "reviewing",
      rounds: state.rounds.map(round => round.submissionId === task.submissionId ? { ...round,
        handoff: { ...round.handoff, state: "confirmed", reviewerRunId: run.id, observedAt: new Date().toISOString() } } : round) } });
  }
  if (task.kind === "correction" && state.status === "correction_requested") {
    mission = await n2Cas(ctx, mission, { ...mission.aggregate, phase: "correcting", n2: { ...state, status: "correcting",
      correction: { ...state.correction!, runId: run.id, wakeState: "requested" } } });
  }
  return { mission, task: currentOrdinaryTask(mission, task.taskId) };
}
function reportFor(mission: MissionRecord, task: OrdinaryTask, synthesis: NonNullable<ReturnType<typeof n3Round>>["review"]["synthesis"]): OrdinaryReport {
  if (!synthesis || synthesis.verdict === "waiting") throw new MissionError(409, "ordinary_synthesis_waiting", "Unresolved synthesis cannot authorize acceptance or correction");
  return { schema: "council-ordinary-result-v1", missionId: mission.missionId, taskId: task.taskId,
    subject: synthesis.subject, verdict: synthesis.verdict, rationale: synthesis.rationale, synthesisHash: canonicalPayloadHash(synthesis) };
}
export async function executeOrdinaryN2Agent(ctx: PluginContext, initial: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  const binding = await bindActor(ctx, initial, input);
  const mission = binding.mission; const task = binding.task; const round = n3Round(mission)!;
  if (["inspect", "ordinary-inspect", "n3-inspect"].includes(String(body.command))) {
    return { missionId: mission.missionId, version: mission.version, phase: mission.aggregate.phase,
      task, instructions: ordinaryTaskInstructions(mission, task), n2: inspectN2State(mission), n3: inspectN3(mission), rootIssueId: mission.rootIssueId };
  }
  const prior = runtimeReceipt(mission, runtimeUuid(body.commandId, "commandId"), task.agentId, canonicalPayloadHash(body));
  if (prior) {
    await ctx.issues.update(task.issueId!, { status: "blocked" }, mission.companyId);
    return { outcome: "replayed", mission, receipt: prior, finishReport: task.report };
  }
  if (body.command === "prepare-resubmission" && task.kind === "correction") {
    const result = await prepareResubmissionCommand(ctx, mission, input, body);
    await ctx.issues.update(task.issueId!, { status: "blocked" }, mission.companyId);
    return result;
  }
  const n3 = mission.aggregate.n3!;
  if (body.command === "n3-opinion" && task.kind === "specialist") {
    const opinion = body.opinion as Parameters<typeof recordN3Opinion>[1];
    if (opinion?.slotId !== task.slotId) throw new MissionError(403, "ordinary_slot_mismatch", "Opinion must target this admitted specialist slot");
    const review = recordN3Opinion(round.review, { ...opinion, authenticatedAgentId: task.agentId, authenticatedRunId: task.runId! });
    const result = await n2CommandCas(ctx, mission, body, "agent", task.agentId, { ...mission.aggregate,
      n3: { ...n3, rounds: n3.rounds.map(entry => entry === round ? { ...round, review } : entry) } });
    await ctx.issues.update(task.issueId!, { status: "blocked" }, mission.companyId);
    return result;
  }
  if (body.command === "ordinary-verdict" && task.kind === "council") {
    if (!round.specialists.every(item => item.settledAt)) throw new MissionError(409, "n3_usage_pending", "Specialist terminal usage must settle before Council judgment");
    if (task.report) throw new MissionError(409, "ordinary_verdict_frozen", "This Council task already prepared its immutable verdict");
    const review = synthesizeN3Review(round.review, { ...(body.synthesis as Parameters<typeof synthesizeN3Review>[1]),
      authenticatedAgentId: task.agentId, authenticatedRunId: task.runId! });
    const report = reportFor(mission, task, review.synthesis);
    const result = await n2CommandCas(ctx, mission, body, "agent", task.agentId, { ...mission.aggregate,
      n3: { ...n3, rounds: n3.rounds.map(entry => entry === round ? { ...round, review } : entry) },
      n2: { ...mission.aggregate.n2!, ordinary: { ...mission.aggregate.n2!.ordinary!,
        tasks: mission.aggregate.n2!.ordinary!.tasks.map(item => item.taskId === task.taskId ? { ...task, report } : item) } } });
    await ctx.issues.update(task.issueId!, { status: "blocked" }, mission.companyId);
    return { ...result, finishReport: report };
  }
  throw new MissionError(400, "ordinary_command_unavailable", "Command is not available to this ordinary task role");
}
