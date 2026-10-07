import { assertContinuityDeparture } from "./continuity-policy.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionAggregate, MissionRecord } from "./missions.js";
import { MODEL_CATALOGUE, roleTemplate, validateModelCatalogue, type TaskFamily, type ProfileId, type RoleKey } from "./model-catalogue.js";
import { inspectVariant } from "./model-variants.js";
import { ModelSelectionError, modelLaunch, type ModelLaunch, type ModelSelectionState, type ModelMeasurement } from "./model-state.js";
import { readOrdinaryRun, suppressedBeforeProvider } from "./g4-native.js";
import { collectInterventionHistory, publishInterventionHistory } from "./model-history.js";
import { assertWorkspacePreflight } from "./workspace-preflight.js";
import { assertNativeRunInventory } from "./native-runs.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";

type LaunchInput = { taskKey: string; interventionKey: string; launchKey: string; logicalAgentId: string; family: TaskFamily; issueId?: string | null; expectedRoles: readonly RoleKey[] };
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/** Namespace-local CAS; never changes another mission or resets its admission/attempt state. */
export async function saveModelState(ctx: PluginContext, m: MissionRecord, state: ModelSelectionState): Promise<MissionRecord> {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin namespace");
  const aggregate = { ...m.aggregate, modelSelection: state };
  const result = await ctx.db.execute(`UPDATE ${ctx.db.namespace}.missions SET aggregate = $1::jsonb, version = version + 1, updated_at = now()
    WHERE company_id = $2 AND mission_id = $3 AND version = $4`, [JSON.stringify(aggregate), m.companyId, m.missionId, m.version]);
  if (result.rowCount !== 1) throw new ModelSelectionError("model_version_conflict", "Mission changed; inspect the existing selection before continuing");
  return { ...m, version: m.version + 1, aggregate };
}
async function changeLaunch(ctx: PluginContext, m: MissionRecord, launch: ModelLaunch) {
  const state = m.aggregate.modelSelection!;
  return saveModelState(ctx, m, { ...state, tasks: state.tasks.map(t => ({ ...t,
    launches: t.launches.map(l => l.launchKey === launch.launchKey ? launch : l) })) });
}

function measurement(run: Awaited<ReturnType<typeof readOrdinaryRun>>): ModelMeasurement {
  const tokens = (key: string) => run.usageJson?.usageSource === "per_run" && Number.isSafeInteger(run.usageJson[key])
    && Number(run.usageJson[key]) >= 0 ? Number(run.usageJson[key]) : null;
  const elapsed = run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : NaN;
  return { runId: run.id, status: run.status, inputTokens: tokens("inputTokens"), outputTokens: tokens("outputTokens"),
    durationMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null, observedAt: new Date().toISOString() };
}
export async function observeVariantRun(ctx: PluginContext, m: MissionRecord, launchKey: string): Promise<MissionRecord> {
  const launch = modelLaunch(m, launchKey);
  if (!launch?.runId || !launch.issueId || launch.measurement) return m;
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: launch.issueId, agentId: launch.agentId, runId: launch.runId });
  return terminal.has(run.status) && run.finishedAt ? changeLaunch(ctx, m, { ...launch, measurement: measurement(run) }) : m;
}

function authorizedPreExecutionReplacement(m: MissionRecord, prior: ModelLaunch,
  nextLaunchKey: string, run: Awaited<ReturnType<typeof readOrdinaryRun>>) {
  const recovery = m.aggregate.n2?.ordinary?.preExecutionRecovery;
  return Boolean(recovery && recovery.reservationId === nextLaunchKey && recovery.priorRunId === run.id
    && recovery.priorReservationId === prior.launchKey && suppressedBeforeProvider(run));
}

async function previousAttempt(ctx: PluginContext, m: MissionRecord, prior: ModelLaunch | undefined, nextLaunchKey: string) {
  if (!prior) return undefined;
  if (!prior.runId || !prior.issueId || prior.state !== "bound") throw new ModelSelectionError("model_previous_unknown", "Previous launch outcome is unknown; retain its identity");
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: prior.issueId, agentId: prior.agentId, runId: prior.runId });
  if (authorizedPreExecutionReplacement(m, prior, nextLaunchKey, run)) {
    return { ...measurement(run), inputTokens: 0, outputTokens: 0 };
  }
  if (run.status !== "succeeded" || !run.finishedAt || run.usageJson?.usageSource !== "per_run") {
    throw new ModelSelectionError("model_previous_unsettled", "A technical failure, active run or unknown accounting cannot authorize a profile change");
  }
  return measurement(run);
}

async function selectedVariant(ctx: PluginContext, m: MissionRecord, logicalId: string, profile: ProfileId, revision: string) {
  const inspection = await inspectVariant(ctx, m.companyId, logicalId, profile, revision);
  if (!inspection.ready || !inspection.agentId || !inspection.roleKey) throw new ModelSelectionError("model_variant_unavailable", "Variant is not ready; inspect expected/observed configuration", inspection);
  return inspection;
}

/** N1 accepts execution, test and design charters with distinct default families. */
export async function contributionModelFamily(ctx: PluginContext, m: MissionRecord, logicalId: string): Promise<TaskFamily> {
  if (!m.aggregate.modelSelection) return "implementation";
  const anchor = await inspectVariant(ctx, m.companyId, logicalId, "sol-medium", "1");
  if (anchor.roleKey === "test") return "validation";
  return anchor.roleKey === "design" ? "design" : "implementation";
}

function assertRoleFamily(roleKey: string, revision: string, family: TaskFamily) {
  if (!roleTemplate(roleKey, revision).families.includes(family)) {
    throw new ModelSelectionError("model_role_family_mismatch", "Selected family is outside this Council role's charter");
  }
}

/** Called only by existing authorized dispatchers. This function never grants another attempt or wakes an agent. */
export async function prepareVariantLaunch(ctx: PluginContext, initial: MissionRecord, input: LaunchInput) {
  assertContinuityDeparture(initial);
  await assertProjectDeparture(ctx, initial);
  await assertNativeRunInventory(ctx, initial, true);
  let m = initial; const state = m.aggregate.modelSelection;
  if (!state) return { mission: m, binding: null };
  await assertWorkspacePreflight(ctx, m);
  const replay = modelLaunch(m, input.launchKey);
  if (replay) {
    if (replay.logicalAgentId !== input.logicalAgentId || replay.taskKey !== input.taskKey || replay.interventionKey !== input.interventionKey) {
      throw new ModelSelectionError("model_launch_conflict", "Launch identity is already pinned to another intervention");
    }
    if (["unknown", "wake_claimed"].includes(replay.state)) throw new ModelSelectionError("model_effect_unknown", "Retain the existing uncertain launch; no replacement key");
    const variant = await selectedVariant(ctx, m, replay.logicalAgentId, replay.profileId, replay.variantRevision);
    if (!variant.roleKey || !input.expectedRoles.includes(variant.roleKey)) throw new ModelSelectionError("model_role_mismatch", "Variant charter does not match the required workflow role");
    assertRoleFamily(variant.roleKey, replay.variantRevision, replay.family);
    return { mission: m, binding: replay };
  }
  const existingTask = state.tasks.find(t => t.taskKey === input.taskKey);
  const config = existingTask ? null : await ctx.config.get(m.companyId);
  const mapping = structuredClone(existingTask?.mapping ?? (config?.modelProfileMapping as typeof MODEL_CATALOGUE | undefined) ?? MODEL_CATALOGUE);
  validateModelCatalogue(mapping);
  const task = existingTask ?? { taskKey: input.taskKey, mapping, variantRevision: mapping.variantRevision ?? "1", launches: [] };
  const previous = task.launches.filter(l => l.interventionKey === input.interventionKey).at(-1);
  if (previous && previous.logicalAgentId !== input.logicalAgentId) throw new ModelSelectionError("model_intervention_conflict", "An intervention cannot change its logical identity");
  const choice = state.choices.find(c => c.taskKey === input.taskKey && c.interventionKey === input.interventionKey);
  const family = choice?.family ?? input.family;
  const rule = mapping.families.find(f => f.id === family);
  if (!rule) throw new ModelSelectionError("model_family_invalid", "Unknown task family");
  const freshChoice = choice && (!previous || choice.at !== previous.choiceAt);
  const requestedProfileId = freshChoice ? choice.profileId : previous?.profileId ?? rule.defaultProfile;
  const profileId = requestedProfileId;
  if (!rule.allowedProfiles.includes(profileId)) throw new ModelSelectionError("model_profile_forbidden", "Profile is outside this pinned family mapping");
  const ascent = Boolean(previous && previous.profileId !== profileId);
  if (ascent && (task.ascentLaunchKey || ["terra-low", "sol-medium", "sol-high", "astra-high"].indexOf(profileId) <= ["terra-low", "sol-medium", "sol-high", "astra-high"].indexOf(previous!.profileId))) {
    throw new ModelSelectionError("model_ascent_limit", "Only one upward profile change is permitted for this whole task");
  }
  const priorMeasurement = await previousAttempt(ctx, m, previous, input.launchKey);
  const variant = await inspectVariant(ctx, m.companyId, input.logicalAgentId, profileId, task.variantRevision);
  if (!variant.ready) {
    // The current public host contract exposes configuration/readiness, not a
    // confirmed pre-execution provider availability signal. A missing or paused
    // agent is not permission to substitute a model. Retain declared alternatives
    // in the versioned format, but fail closed until such evidence is available.
    throw new ModelSelectionError("model_variant_unavailable", "Variant is not ready. Configuration state cannot prove model unavailability or authorize fallback", variant);
  }
  if (!variant.agentId || !variant.roleKey) throw new ModelSelectionError("model_variant_unavailable", "Variant identity is not proven", variant);
  if (!input.expectedRoles.includes(variant.roleKey)) throw new ModelSelectionError("model_role_mismatch", "Variant charter does not match the required workflow role");
  assertRoleFamily(variant.roleKey, task.variantRevision, family);
  const binding: ModelLaunch = { ...input, issueId: input.issueId ?? null, agentId: variant.agentId!, roleKey: variant.roleKey!,
    profileId, requestedProfileId, family, rationale: choice?.rationale ?? (previous ? "Conserve le profil de l'intervention autorisée" : "Profil par défaut de la famille"),
    authority: choice?.authority ?? "default", ...(choice ? { choiceAt: choice.at } : {}), mappingRevision: mapping.revision, variantRevision: task.variantRevision,
    selectedAt: new Date().toISOString(), state: "selected", runId: null, ascent, ...(previous ? { previousLaunchKey: previous.launchKey } : {}) };
  const launches = task.launches.map(l => l.launchKey === previous?.launchKey && priorMeasurement ? { ...l, measurement: priorMeasurement } : l);
  const nextTask = { ...task, launches: [...launches, binding], ...(ascent ? { ascentLaunchKey: input.launchKey } : {}) };
  m = await saveModelState(ctx, m, { ...state, tasks: existingTask ? state.tasks.map(t => t === existingTask ? nextTask : t) : [...state.tasks, nextTask] });
  return { mission: m, binding };
}

async function idleIssue(ctx: PluginContext, m: MissionRecord, issueId: string) {
  const issue = await ctx.issues.get(issueId, m.companyId);
  const summary = await ctx.issues.summaries.getOrchestration({ companyId: m.companyId, issueId, includeSubtree: false });
  if (!issue || issue.companyId !== m.companyId || issue.executionRunId || issue.checkoutRunId
    || summary.runs.some(r => ["queued", "running"].includes(r.status))) throw new ModelSelectionError("model_issue_active", "Physical assignment requires a known idle issue without active locks");
  if (issue.assigneeAdapterOverrides && Object.keys(issue.assigneeAdapterOverrides).length) {
    throw new ModelSelectionError("model_override_conflict", "Issue overrides may replace the fixed variant configuration; explicit repair required");
  }
  return issue;
}

async function attachHistory(ctx: PluginContext, m: MissionRecord, launch: ModelLaunch, issueId: string) {
  if (!launch.ascent || launch.history) return m;
  const attempts = m.aggregate.modelSelection!.tasks.find(t => t.taskKey === launch.taskKey)!.launches
    .filter(l => l.interventionKey === launch.interventionKey && l.launchKey !== launch.launchKey);
  const runs = attempts.filter(l => l.runId && l.issueId).map(l => ({ runId: l.runId!, issueId: l.issueId!, agentId: l.agentId }));
  const archive = launch.historyArchive ?? await collectInterventionHistory(ctx, { companyId: m.companyId, missionId: m.missionId,
    interventionKey: launch.interventionKey, issues: [...new Set(runs.map(r => r.issueId))], runs,
    journal: m.aggregate.journal.filter(j => j.runId && runs.some(r => r.runId === j.runId) || j.contributionId === launch.interventionKey) });
  if (!launch.historyArchive) {
    launch = { ...launch, historyArchive: archive };
    m = await changeLaunch(ctx, m, launch);
  }
  const published = await publishInterventionHistory(ctx, m.companyId, issueId, launch.launchKey, archive);
  const { historyArchive: _publishedArchive, ...retained } = launch;
  return changeLaunch(ctx, m, { ...retained, history: { indexKey: published.indexKey, indexSha256: published.indexSha256,
    gapCount: archive.gaps.length, cutoff: archive.cutoff } });
}

export async function bindVariantIssue(ctx: PluginContext, initial: MissionRecord, launchKey: string, issueId: string): Promise<MissionRecord> {
  let m = initial; let launch = modelLaunch(m, launchKey);
  if (!launch) return m;
  if (launch.issueId && launch.issueId !== issueId) throw new ModelSelectionError("model_issue_conflict", "Launch already belongs to a different native issue");
  if (["unknown", "wake_claimed", "bound"].includes(launch.state)) throw new ModelSelectionError("model_effect_unknown", "A claimed launch cannot be reassigned or woken again");
  await selectedVariant(ctx, m, launch.logicalAgentId, launch.profileId, launch.variantRevision);
  const issue = await idleIssue(ctx, m, issueId);
  if (issue.assigneeAgentId !== launch.agentId) {
    if (launch.state === "assignment_claimed") throw new ModelSelectionError("model_assignment_unknown", "Prior assignment was claimed; resolve its native effect before continuing");
    launch = { ...launch, issueId, state: "assignment_claimed" };
    m = await changeLaunch(ctx, m, launch);
    try { await ctx.issues.update(issueId, { assigneeAgentId: launch.agentId }, m.companyId); }
    catch { /* Readback is authoritative; never issue a second mutation on a lost response. */ }
    const observed = await idleIssue(ctx, m, issueId);
    if (observed.assigneeAgentId !== launch.agentId) throw new ModelSelectionError("model_assignment_unknown", "Assigned variant was not observed; retain the existing claim");
  }
  m = await attachHistory(ctx, m, launch, issueId); launch = modelLaunch(m, launchKey)!;
  const marker = `Council profile launch ${launch.launchKey}`;
  const current = await ctx.issues.get(issueId, m.companyId);
  const guidance = `${marker}: logical=${launch.logicalAgentId}; physical=${launch.agentId}; profile=${launch.profileId}; mapping=${launch.mappingRevision}. Reason: ${launch.rationale}.`
      + (launch.history ? `\nRead the public detailed history index at GET /api/issues/${issueId}/documents/${launch.history.indexKey} and every indexed part progressively. Gaps: ${launch.history.gapCount}; cutoff: ${launch.history.cutoff}. Preserved history is not evidence that you have read it.` : "")
      + (launch.interventionKey === "lead" ? `\nBefore launching another intervention, select its lightest sufficient profile through Council command select-model-profile with missionId, expectedVersion, taskKey, interventionKey, family, profileId, rationale. Owner choices take precedence. This selects a profile only; it grants no retry or wake. Contributions use their contributionId as taskKey/interventionKey; review uses root issue ${m.rootIssueId} and reviewer or specialist:<slotId>.` : "");
  if (!current?.description?.includes(guidance)) {
    if (current?.description?.includes(marker)) throw new ModelSelectionError("model_context_drift", "Recorded profile guidance differs from the pinned launch");
    await ctx.issues.update(issueId, { description: `${current?.description ?? ""}\n\n${guidance}` }, m.companyId);
    const readback = await ctx.issues.get(issueId, m.companyId);
    if (!readback?.description?.includes(guidance)) throw new ModelSelectionError("model_context_unknown", "Launch context was not observed; retain the existing launch");
  }
  return changeLaunch(ctx, m, { ...launch, issueId, state: "ready" });
}

export function claimVariantWake(ctx: PluginContext, m: MissionRecord, launchKey: string): Promise<MissionRecord>;
export function claimVariantWake<T>(ctx: PluginContext, m: MissionRecord, launchKey: string,
  persist: (mission: MissionRecord, aggregate: MissionAggregate) => Promise<T>): Promise<T>;
export async function claimVariantWake<T>(ctx: PluginContext, m: MissionRecord, launchKey: string,
  persist?: (mission: MissionRecord, aggregate: MissionAggregate) => Promise<T>): Promise<MissionRecord | T> {
  assertContinuityDeparture(m);
  await assertProjectDeparture(ctx, m);
  await assertNativeRunInventory(ctx, m, true);
  const launch = modelLaunch(m, launchKey);
  if (!launch) return persist ? persist(m, m.aggregate) : m;
  if (launch.state !== "ready" || !launch.issueId) throw new ModelSelectionError("model_launch_not_ready", "Persisted assignment and history must be ready before wake");
  await selectedVariant(ctx, m, launch.logicalAgentId, launch.profileId, launch.variantRevision);
  await assertWorkspacePreflight(ctx, m);
  const issue = await idleIssue(ctx, m, launch.issueId);
  if (issue.assigneeAgentId !== launch.agentId) throw new ModelSelectionError("model_assignment_drift", "Issue assignment changed before wake");
  const state = m.aggregate.modelSelection!;
  const aggregate: MissionAggregate = { ...m.aggregate, modelSelection: { ...state, tasks: state.tasks.map(task => ({ ...task,
    launches: task.launches.map(item => item.launchKey === launchKey ? { ...item, state: "wake_claimed" } : item) })) } };
  return persist ? persist(m, aggregate) : saveModelState(ctx, m, aggregate.modelSelection!);
}

export function recordVariantWake(ctx: PluginContext, m: MissionRecord, launchKey: string, runId: string | null): Promise<MissionRecord>;
export function recordVariantWake<T>(ctx: PluginContext, m: MissionRecord, launchKey: string, runId: string | null,
  persist: (mission: MissionRecord, aggregate: MissionAggregate, effectiveRunId: string | null) => Promise<T>): Promise<T>;
export async function recordVariantWake<T>(ctx: PluginContext, m: MissionRecord, launchKey: string, runId: string | null,
  persist?: (mission: MissionRecord, aggregate: MissionAggregate, effectiveRunId: string | null) => Promise<T>): Promise<MissionRecord | T> {
  const launch = modelLaunch(m, launchKey);
  if (!launch) return persist ? persist(m, m.aggregate, runId) : m;
  if (launch.state === "bound" && (launch.runId === runId || runId === null)) {
    return persist ? persist(m, m.aggregate, launch.runId) : m;
  }
  if (launch.runId && launch.runId !== runId) throw new ModelSelectionError("model_run_conflict", "A launch cannot bind a replacement native run");
  if (!["wake_claimed", "unknown", "bound"].includes(launch.state)) throw new ModelSelectionError("model_launch_not_ready", "Run must belong to a durably claimed launch");
  const aggregate: MissionAggregate = { ...m.aggregate, modelSelection: { ...m.aggregate.modelSelection!,
    tasks: m.aggregate.modelSelection!.tasks.map(task => ({ ...task, launches: task.launches.map(item =>
      item.launchKey === launchKey ? { ...item, state: runId ? "bound" : "unknown", runId } : item) })) } };
  return persist ? persist(m, aggregate, runId) : saveModelState(ctx, m, aggregate.modelSelection!);
}
