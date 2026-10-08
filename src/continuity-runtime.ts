import { completionPolicy } from "./completion-contract.js";
import { reconcileCompletion } from "./completion-runtime.js";
import { reconcilePublicationFeedback } from "./pr-feedback-runtime.js";
import { leadIssueId } from "./hierarchy-contract.js";
import { publishContinuityObservation, type ContinuityObservation as Observation } from "./continuity-observation.js";
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { assertContinuityDeparture, type ContinuityCommand } from "./continuity-policy.js";
import { executeN1BoardCommand, type N1State } from "./n1-missions.js";
import { assertNativeRunInventory } from "./native-runs.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, nativeN2Profile } from "./n2-missions.js";
import { executeOrdinaryN2Board, reconcileOrdinaryN2 } from "./n2-ordinary-runtime.js";
import { reconcileN5 } from "./n5-runtime.js";
import { inspectN5 } from "./n5-state.js";
import { physicalAgent } from "./model-state.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "./g4-native.js";
import { reconcileProjectTasks } from "./project-task-intake.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { advanceHierarchyChildren } from "./hierarchy-continuity.js";

const CONTINUITY_JOB_KEY = "mission-continuity";
const waiting = (code: string, nextAction: string): Observation => ({ state: "waiting", code, nextAction });
const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;

async function prepareCommand(ctx: PluginContext, m: MissionRecord, command: ContinuityCommand, job: PluginJobContext) {
  const policy = m.aggregate.continuity!;
  let body = policy.commands[command];
  if (!body) {
    body = { companyId: m.companyId, command, commandId: randomUUID(), expectedVersion: m.version + 1,
      ...(command === "start-review" ? { submissionId: randomUUID(), n3Slots: policy.n3Slots } : {}) };
    m = await n2Cas(ctx, m, { ...m.aggregate, continuity: { ...policy, commands: { ...policy.commands, [command]: body } },
      journal: [...m.aggregate.journal, { action: "continuity_delegated_command", command, commandId: body.commandId,
        authorizedBy: policy.authorizedBy, jobRunId: job.runId, at: new Date().toISOString() }] });
  }
  return { mission: m, body };
}

async function delegatedCommand(ctx: PluginContext, initial: MissionRecord, command: ContinuityCommand, job: PluginJobContext) {
  if (command !== "reconcile-lead-usage") await assertProjectDeparture(ctx, initial);
  const { mission: m, body } = await prepareCommand(ctx, initial, command, job);
  const policy = m.aggregate.continuity!;
  // The owner delegation and original payload are persisted before execution.
  // A crash resumes this payload; no new effect or replacement command ID.
  if (command === "start-review") await executeOrdinaryN2Board(ctx, m, { actorUserId: policy.authorizedBy, body });
  else await executeN1BoardCommand(ctx, { companyId: m.companyId, missionId: m.missionId, actorUserId: policy.authorizedBy, body });
  return { state: "progressed", code: command, nextAction: "Council poursuit les étapes déjà autorisées du mandat." } satisfies Observation;
}

async function settleNonAdvancingLead(ctx: PluginContext, initial: MissionRecord, state: N1State, job: PluginJobContext) {
  const { mission: m, body } = await prepareCommand(ctx, initial, "reconcile-lead-usage", job);
  const { envelope } = await nativeN2Profile(ctx, m);
  await settleOrdinaryRunUsage(ctx, { companyId: m.companyId, issueId: leadIssueId(m), runId: state.rootDispatchRunId!,
    agentId: physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: leadIssueId(m), runId: state.rootDispatchRunId }),
    commandId: String(body.commandId), reservationId: state.activationReservationId, periodKey: state.periodKey,
    expectedVersion: envelope.version });
}

function delegatedHierarchy(m: MissionRecord, state: N1State) {
  return m.aggregate.hierarchy?.leaves && completionPolicy(m) && (!state.candidate || state.integration);
}

async function advanceN1(ctx: PluginContext, m: MissionRecord, state: N1State, job: PluginJobContext): Promise<Observation> {
  if (!state.rootDispatchState) {
    assertContinuityDeparture(m);
    return delegatedCommand(ctx, m, "start-lead", job);
  }
  if (state.rootDispatchState !== "requested" || !state.rootDispatchRunId) {
    throw new MissionError(409, "continuity_lead_effect_unknown", "Inspect the original lead wake; no repeated departure is authorized");
  }
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: leadIssueId(m), runId: state.rootDispatchRunId,
    agentId: physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: leadIssueId(m), runId: state.rootDispatchRunId }) });
  if (["queued", "running", "scheduled_retry"].includes(run.status)) return waiting("native_lead_running", "Council attend la fin du run admis du lead.");
  if (run.status === "succeeded" && delegatedHierarchy(m, state)) {
    await settleNonAdvancingLead(ctx, m, state, job);
    const code = await advanceHierarchyChildren(ctx, await fresh(ctx, m));
    return { state: code.endsWith("running") ? "waiting" : "progressed", code,
      nextAction: "Council règle et clôt chaque enfant prouvé, puis admet le suivant et le run d’intégration finale." };
  }
  if (run.status !== "succeeded" || !state.candidate) {
    await settleNonAdvancingLead(ctx, m, state, job);
    throw new MissionError(409, run.status === "succeeded" ? "continuity_candidate_missing" : "continuity_lead_failed",
      "Terminal costs are retained; a missing verified candidate or unsuccessful lead requires an explicit decision");
  }
  return delegatedCommand(ctx, m, "reconcile-lead-usage", job);
}

async function advanceReview(ctx: PluginContext, m: MissionRecord, job: PluginJobContext): Promise<Observation> {
  if (!m.aggregate.n2) {
    assertContinuityDeparture(m);
    return delegatedCommand(ctx, m, "start-review", job);
  }
  if (!m.aggregate.n2.ordinary) throw new MissionError(409, "continuity_runtime_mismatch", "Historical experimental review contracts are not delegated to this driver");
  m = await reconcileOrdinaryN2(ctx, m);
  m = await fresh(ctx, m);
  if (m.aggregate.n2!.status !== "accepted") return waiting("native_review_pending", "Les avis indépendants, la revue et les coûts doivent être concluants avant la suite.");
  if (!m.aggregate.n5 && completionPolicy(m)) return finishAuthorizedResult(ctx, m);
  if (!m.aggregate.n5) return { state: "complete", code: "accepted_without_publication", nextAction: "Le candidat est accepté. Aucune publication n'a été autorisée." };
  m = await reconcileN5(ctx, m);
  m = await reconcilePublicationFeedback(ctx, m);
  if (completionPolicy(m)) {
    if (!inspectN5(m)?.publicationReady) return waiting("native_delivery_pending", "Le résultat autorisé attend sa preuve de publication exacte et ses coûts terminaux.");
    return finishAuthorizedResult(ctx, m);
  }
  return inspectN5(m)?.ready
    ? { state: "complete", code: "authorized_pr_observed", nextAction: "La PR autorisée est observée sur le candidat accepté. La fusion reste distincte." }
    : waiting("native_delivery_pending", "Council attend la publication autorisée et ses preuves natives, sans répéter un effet incertain.");
}

async function finishAuthorizedResult(ctx: PluginContext, m: MissionRecord): Promise<Observation> {
  m = await reconcileCompletion(ctx, m);
  return m.aggregate.completion?.state === "closed"
    ? { state: "complete", code: "proof_result_closed", nextAction: "Enfants et parent clos avec preuve consolidée du résultat autorisé et notification native confirmée." }
    : waiting("completion_proof_pending", "Council conserve la clôture revendiquée et attend sa lecture native.");
}

export async function advanceContinuity(ctx: PluginContext, initial: MissionRecord, job: PluginJobContext): Promise<Observation> {
  const m = await fresh(ctx, initial);
  const policy = m.aggregate.continuity;
  if (!policy?.enabled) return waiting("continuity_disabled", "La progression déléguée est désactivée.");
  const company = await ctx.companies.get(m.companyId);
  if (policy.authorizedBy !== m.ownerUserId || company?.defaultResponsibleUserId !== policy.authorizedBy
      || policy.mandateHash !== canonicalPayloadHash(m.aggregate.mandate)) {
    throw new MissionError(409, "continuity_authority_drift", "The persisted owner or mandate changed; no automatic transition is authorized");
  }
  if (m.aggregate.completion?.state === "closed") return { state: "complete", code: "proof_result_closed", nextAction: "Le résultat autorisé conserve sa preuve de clôture et sa notification historique ; aucune nouvelle publication n’est déléguée." };
  await assertNativeRunInventory(ctx, m);
  if (m.aggregate.control.status === "blocked") throw new MissionError(409, "continuity_mission_blocked", m.aggregate.control.reason);
  if (m.aggregate.phase === "draft") return waiting("activation_required", "Le propriétaire doit activer le mandat avant tout travail.");
  if (!m.aggregate.n2 && m.aggregate.phase !== "ready_for_review") {
    const n1 = m.aggregate.n1 as N1State | undefined;
    if (!n1) throw new MissionError(409, "continuity_prerequisite_missing", "Activated N1 prerequisites required");
    return advanceN1(ctx, m, n1, job);
  }
  return advanceReview(ctx, m, job);
}

export function registerContinuityJob(ctx: PluginContext, list: () => Promise<MissionRecord[]>) {
  ctx.jobs.register(CONTINUITY_JOB_KEY, async job => {
    let intakeFailure: string | null = null;
    try { await reconcileProjectTasks(ctx); }
    catch (error) { intakeFailure = error instanceof MissionError ? error.code : "project_intake_scan_unavailable"; }
    const unavailable: Array<{ missionId: string; code: string }> = [];
    for (const m of await list()) {
      let observation: Observation;
      try { observation = await advanceContinuity(ctx, m, job); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "continuity_observation_failed";
        observation = ["g4_usage_unavailable", "g4_run_not_terminal", "ordinary_run_not_terminal"].includes(code)
          ? waiting(code, "Council conserve la réservation et attend une lecture native concluante du coût terminal.")
          : { state: "blocked", code, nextAction: "Une décision du propriétaire est requise sur l'état conservé. Council n'autorise aucune répétition incertaine." };
      }
      try { await publishContinuityObservation(ctx, m, observation); }
      catch (error) { unavailable.push({ missionId: m.missionId, code: error instanceof MissionError ? error.code : "native_status_transport_unavailable" }); }
    }
    if (unavailable.length) throw new MissionError(409, "continuity_status_unavailable", `Native status readback failed (${unavailable.map(item => item.code).join(", ")}); inspect the retained job`, { failures: unavailable });
    if (intakeFailure) throw new MissionError(409, "project_intake_scan_failed", "Project intake failed; existing delegated missions were still observed", { code: intakeFailure });
  });
}
