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

const CONTINUITY_JOB_KEY = "mission-continuity";
type Observation = { state: "waiting" | "progressed" | "blocked" | "complete"; code: string; nextAction: string };
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
  await settleOrdinaryRunUsage(ctx, { companyId: m.companyId, issueId: m.rootIssueId, runId: state.rootDispatchRunId!,
    agentId: physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: m.rootIssueId, runId: state.rootDispatchRunId }),
    commandId: String(body.commandId), reservationId: state.activationReservationId, periodKey: state.periodKey,
    expectedVersion: envelope.version });
}

async function advanceN1(ctx: PluginContext, m: MissionRecord, state: N1State, job: PluginJobContext): Promise<Observation> {
  if (!state.rootDispatchState) {
    assertContinuityDeparture(m);
    return delegatedCommand(ctx, m, "start-lead", job);
  }
  if (state.rootDispatchState !== "requested" || !state.rootDispatchRunId) {
    throw new MissionError(409, "continuity_lead_effect_unknown", "Inspect the original lead wake; no repeated departure is authorized");
  }
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: m.rootIssueId, runId: state.rootDispatchRunId,
    agentId: physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: m.rootIssueId, runId: state.rootDispatchRunId }) });
  if (["queued", "running", "scheduled_retry"].includes(run.status)) return waiting("native_lead_running", "Council attend la fin du run admis du lead.");
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
  if (!m.aggregate.n5) return { state: "complete", code: "accepted_without_publication", nextAction: "Le candidat est accepté. Aucune publication n'a été autorisée." };
  m = await reconcileN5(ctx, m);
  return inspectN5(m)?.ready
    ? { state: "complete", code: "authorized_pr_observed", nextAction: "La PR autorisée est observée sur le candidat accepté. La fusion reste distincte." }
    : waiting("native_delivery_pending", "Council attend la publication autorisée et ses preuves natives, sans répéter un effet incertain.");
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

async function publishObservation(ctx: PluginContext, m: MissionRecord, observation: Observation) {
  const labels = { waiting: "En attente", progressed: "En cours", blocked: "Décision requise", complete: "Parcours autorisé terminé" };
  const body = `# Progression Council\n\n**État :** ${labels[observation.state]}\n\n${observation.nextAction}\n\nRéférence de diagnostic : \`${observation.code}\`\n`;
  const key = "council-continuity";
  const existing = await ctx.issues.documents.get(m.rootIssueId, key, m.companyId);
  if (existing?.body === body) return;
  await ctx.issues.documents.upsert({ companyId: m.companyId, issueId: m.rootIssueId, key, body,
    title: "Progression Council", format: "markdown", changeSummary: observation.nextAction });
}

export function registerContinuityJob(ctx: PluginContext, list: () => Promise<MissionRecord[]>) {
  ctx.jobs.register(CONTINUITY_JOB_KEY, async job => {
    const unavailable: string[] = [];
    for (const m of await list()) {
      let observation: Observation;
      try { observation = await advanceContinuity(ctx, m, job); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "continuity_observation_failed";
        observation = ["g4_usage_unavailable", "g4_run_not_terminal", "ordinary_run_not_terminal"].includes(code)
          ? waiting(code, "Council conserve la réservation et attend une lecture native concluante du coût terminal.")
          : { state: "blocked", code, nextAction: "Une décision du propriétaire est requise sur l'état conservé. Council n'autorise aucune répétition incertaine." };
      }
      try { await publishObservation(ctx, m, observation); }
      catch { unavailable.push(m.missionId); }
    }
    if (unavailable.length) throw new MissionError(409, "continuity_status_unavailable", "Native status documents could not be read back; inspect the failed job", { missionIds: unavailable });
  });
}
