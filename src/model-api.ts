import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { MODEL_CATALOGUE, MODEL_PROFILES, ROLE_TEMPLATES, validateModelCatalogue, type ProfileId, type TaskFamily, type RoleKey } from "./model-catalogue.js";
import { setupVariant, inspectVariant, inspectPreparedVariants } from "./model-variants.js";
import { getMission, MissionError } from "./missions.js";
import { modelEstimates } from "./model-estimates.js";
import { ModelSelectionError, physicalAgent, modelMeasurements, type ModelLaunch } from "./model-state.js";
import { saveModelState, observeVariantRun } from "./model-runtime.js";

function text(value: unknown, field: string, limit = 200): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > limit) throw new ModelSelectionError("model_input_invalid", `${field} must be a bounded nonempty string`);
  return value;
}
async function owner(ctx: PluginContext, input: PluginApiRequestInput) {
  const company = await ctx.companies.get(input.companyId);
  if (input.actor.actorType !== "user" || !input.actor.userId || input.actor.userId !== company?.defaultResponsibleUserId) {
    throw new MissionError(403, "owner_required", "Only the configured company owner can configure model variants");
  }
}

async function companyEstimates(ctx: PluginContext, companyId: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin namespace");
  // Detailed archives can be large. Read only comparable launch metadata for the
  // same bounded company window, without transferring their history into the UI.
  const rows = await ctx.db.query<{ launch: ModelLaunch }>(`SELECT launches.value - 'historyArchive' AS launch
    FROM (SELECT aggregate->'modelSelection'->'tasks' AS tasks FROM ${ctx.db.namespace}.missions
      WHERE company_id = $1 ORDER BY updated_at DESC, mission_id LIMIT 50) recent
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(recent.tasks, '[]'::jsonb)) tasks(value)
    CROSS JOIN LATERAL jsonb_array_elements(tasks.value->'launches') launches(value)`, [companyId]);
  return modelEstimates(rows.map(row => row.launch));
}

/** Explicit owner setup; never run from plugin setup(), a timer, or a task launch. */
export async function handleModelProfiles(ctx: PluginContext, input: PluginApiRequestInput) {
  await owner(ctx, input);
  if (input.params.companyId !== input.companyId) throw new MissionError(403, "company_scope_mismatch", "Company route mismatch");
  const config = await ctx.config.get(input.companyId);
  const mapping = config.modelProfileMapping ?? MODEL_CATALOGUE;
  validateModelCatalogue(mapping);
  if (input.routeKey === "model-profiles-read") return { status: 200, body: {
    mapping, profiles: MODEL_PROFILES, roles: ROLE_TEMPLATES.map(r => ({ key: r.key, revision: r.revision, title: r.title, families: r.families, allowedProfiles: r.allowedProfiles })),
    enabledForNewMissions: config.modelVariantsEnabled === true && config.n2RuntimeProfile === "ordinary-cli-v1",
    availability: "not_validated_live", estimate: "comparable history, otherwise non calibré", estimates: await companyEstimates(ctx, input.companyId),
    variants: await inspectPreparedVariants(ctx, input.companyId) } };
  const body = input.body as Record<string, unknown>;
  if (body?.command !== "prepare-variant") throw new ModelSelectionError("model_command_invalid", "Setup prepares one declared role/profile revision at a time");
  const result = await setupVariant(ctx, input.companyId, text(body.roleKey, "roleKey") as RoleKey, text(body.profileId, "profileId") as ProfileId,
    body.revision === undefined ? "1" : text(body.revision, "revision"));
  return { status: 200, body: result };
}

/** Choosing a profile grants neither a new attempt nor a wake. Existing dispatch/admission decides those. */
export async function chooseModelProfile(ctx: PluginContext, input: PluginApiRequestInput) {
  const body = input.body as Record<string, unknown>;
  let m = await getMission(ctx, input.companyId, text(input.params.missionId ?? body.missionId, "missionId"));
  if (!m?.aggregate.modelSelection) throw new ModelSelectionError("model_mission_ineligible", "Only new opted-in standard missions support variants");
  let authority: "user" | "lead";
  let actorId: string;
  if (input.actor.actorType === "user") {
    await owner(ctx, input);
    if (input.actor.userId !== m.ownerUserId) throw new MissionError(403, "mission_owner_required", "Mission owner required");
    authority = "user"; actorId = input.actor.userId!;
  } else {
    const lead = physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: m.rootIssueId, runId: input.actor.runId });
    const runs = [m.aggregate.n1?.rootDispatchRunId, m.aggregate.n2?.correction?.runId];
    if (!input.actor.agentId || input.actor.agentId !== lead || !input.actor.runId || !runs.includes(input.actor.runId)
      || input.params.issueId !== m.rootIssueId) throw new MissionError(403, "integration_lead_required", "Only the admitted root lead may recommend another intervention's profile");
    await ctx.issues.assertCheckoutOwner({ companyId: m.companyId, issueId: m.rootIssueId, actorAgentId: lead, actorRunId: input.actor.runId });
    authority = "lead"; actorId = lead;
  }
  if (m.version !== body.expectedVersion) throw new ModelSelectionError("model_version_conflict", "Inspect the current mission version first");
  const taskKey = text(body.taskKey, "taskKey"); const interventionKey = text(body.interventionKey, "interventionKey");
  const family = text(body.family, "family") as TaskFamily; const profileId = text(body.profileId, "profileId") as ProfileId;
  const mapping = m.aggregate.modelSelection.tasks.find(t => t.taskKey === taskKey)?.mapping
    ?? (await ctx.config.get(m.companyId)).modelProfileMapping ?? MODEL_CATALOGUE;
  validateModelCatalogue(mapping);
  if (!(mapping as typeof MODEL_CATALOGUE).families.find(f => f.id === family)?.allowedProfiles.includes(profileId)) {
    throw new ModelSelectionError("model_profile_forbidden", "Explicit profile must be supported by the selected family's mapping");
  }
  const state = m.aggregate.modelSelection;
  const prior = state.choices.find(c => c.taskKey === taskKey && c.interventionKey === interventionKey);
  if (prior?.authority === "user" && authority !== "user") throw new ModelSelectionError("model_user_choice_pinned", "The explicit owner choice takes precedence over the lead");
  const choice = { taskKey, interventionKey, family, profileId, rationale: text(body.rationale, "rationale", 2000), authority, actorId, at: new Date().toISOString() };
  m = await saveModelState(ctx, m, { ...state, choices: [...state.choices.filter(c => c !== prior), choice] });
  return { status: 200, body: { mission: m, choice, effectPermission: "none" } };
}

export async function inspectModelSelections(ctx: PluginContext, input: PluginApiRequestInput) {
  await owner(ctx, input);
  let m = await getMission(ctx, input.companyId, text(input.params.missionId, "missionId"));
  if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
  const statuses = [];
  for (const launch of m.aggregate.modelSelection?.tasks.flatMap(t => t.launches) ?? []) {
    const variant = await inspectVariant(ctx, m.companyId, launch.logicalAgentId, launch.profileId, launch.variantRevision);
    statuses.push({ launchKey: launch.launchKey, ...variant });
    // A read route must not mutate state. Measurements are observed by explicit reconciliation.
  }
  const selected = m.aggregate.modelSelection;
  const state = selected ? { ...selected, tasks: selected.tasks.map(task => ({ ...task,
    launches: task.launches.map(({ historyArchive: _archive, ...launch }) => launch) })) } : null;
  return { status: 200, body: { state, statuses, measurements: modelMeasurements(m), estimates: await companyEstimates(ctx, m.companyId) } };
}

export async function reconcileModelMeasurements(ctx: PluginContext, input: PluginApiRequestInput) {
  await owner(ctx, input);
  let m = await getMission(ctx, input.companyId, text(input.params.missionId, "missionId"));
  if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
  for (const launch of m.aggregate.modelSelection?.tasks.flatMap(t => t.launches) ?? []) m = await observeVariantRun(ctx, m, launch.launchKey);
  return { status: 200, body: { mission: m, measurements: modelMeasurements(m) } };
}
