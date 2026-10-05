import { isDeepStrictEqual } from "node:util";
import type { PluginContext, PluginManagedAgentResolution } from "@paperclipai/plugin-sdk";
import { ModelSelectionError } from "./model-state.js";
import {
  COUNCIL_REVIEW_SKILL_KEY, ROLE_TEMPLATES, ROLE_TEMPLATE_REVISION,
  isProfileId, logicalAnchorKey, managedAgentDeclarations, roleTemplate, variantKey,
  type ProfileId, type RoleKey,
} from "./model-catalogue.js";

export interface VariantInspection {
  agentId: string | null;
  logicalAgentId: string | null;
  roleKey: RoleKey | null;
  profileId: ProfileId;
  revision: string;
  /** Configuration readback only; no provider/account or runtime execution qualification. */
  ready: boolean;
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  gaps: string[];
}
class VariantIdentityError extends ModelSelectionError {
  constructor(readonly code: "logical_identity_unknown" | "logical_identity_ambiguous" | "variant_outside_catalogue") {
    super(code, code);
  }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validateSelection(profileId: ProfileId, revision: string) {
  if (!isProfileId(profileId) || !ROLE_TEMPLATES.some(role => role.revision === revision)) throw new VariantIdentityError("variant_outside_catalogue");
}
async function readManaged(ctx: PluginContext, companyId: string, key: string) {
  try { return { value: await ctx.agents.managed.get(key, companyId), failed: false } as const; }
  catch { return { value: null, failed: true } as const; }
}
const derivedInstructionKeys = new Set(["instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath"]);
type VariantAvailability = "configured" | "missing" | "pending_approval" | "paused" | "blocked" | "unknown";
function availability(gaps: string[], status: string): VariantAvailability {
  if (!gaps.length) return "configured";
  if (gaps.some(gap => gap.includes("unavailable"))) return "unknown";
  const unavailable = new Set(["variant_missing", "agent_not_idle:pending_approval", "agent_not_idle:paused"]);
  if (gaps.every(gap => unavailable.has(gap))) {
    if (status === "missing" || status === "pending_approval" || status === "paused") return status;
  }
  return "blocked";
}

async function inspectRoleVariant(
  ctx: PluginContext, companyId: string, roleKey: RoleKey, profileId: ProfileId, revision: string,
  anchor: PluginManagedAgentResolution | null, inheritedGaps: string[] = [],
): Promise<VariantInspection> {
  const role = roleTemplate(roleKey, revision);
  if (!role.allowedProfiles.includes(profileId)) throw new VariantIdentityError("variant_outside_catalogue");
  const key = variantKey(roleKey, profileId, revision);
  const expectedDeclaration = managedAgentDeclarations().find(declaration => declaration.agentKey === key)!;
  const read = key === logicalAnchorKey(roleKey) && anchor
    ? { value: anchor, failed: false } : await readManaged(ctx, companyId, key);
  const resolution = read.value;
  const agent = resolution?.agent ?? null;
  const gaps = [...inheritedGaps];
  const logicalAgentId = anchor?.agent?.id ?? null;
  const expected: Record<string, unknown> = {
    agentKey: key, roleTemplateRevision: revision, instructionSha256: role.instructionSha256,
    adapterType: expectedDeclaration.adapterType, adapterConfig: expectedDeclaration.adapterConfig,
    heartbeat: object(expectedDeclaration.runtimeConfig).heartbeat, permissions: expectedDeclaration.permissions,
    desiredSkills: role.desiredSkills, accountAvailability: "not_validated_live",
  };
  if (!logicalAgentId) gaps.push("logical_anchor_missing");
  if (anchor && (anchor.companyId !== companyId || anchor.agent?.companyId !== companyId
    || anchor.agentId !== anchor.agent?.id || anchor.resourceKey !== logicalAnchorKey(roleKey))) gaps.push("logical_anchor_binding_mismatch");
  if (read.failed) gaps.push("variant_read_unavailable");
  if (resolution && (resolution.companyId !== companyId || resolution.resourceKey !== key)) gaps.push("variant_binding_mismatch");
  if (!agent && !read.failed) gaps.push(resolution?.status === "missing" && resolution.agentId === null ? "variant_missing" : "variant_readback_invalid");
  const observed: Record<string, unknown> = {
    agentKey: resolution?.resourceKey ?? null, status: read.failed ? "unknown" : agent?.status ?? "missing",
    instructionDrift: resolution?.defaultDrift ?? null,
    instructionReadbackAvailable: resolution?.defaultDrift !== undefined,
    accountAvailability: "not_validated_live", runtimeSkillMount: "not_validated_live",
  };
  if (agent) {
    if (agent.companyId !== companyId || resolution?.agentId !== agent.id) gaps.push("variant_binding_mismatch");
    if (agent.status !== "idle") gaps.push(`agent_not_idle:${agent.status}`);
    if (agent.adapterType !== expectedDeclaration.adapterType) gaps.push("adapter_type_drift");
    observed.adapterType = agent.adapterType;
    const actualConfig = object(agent.adapterConfig);
    const expectedConfig = expectedDeclaration.adapterConfig!;
    observed.adapterConfig = Object.fromEntries(Object.keys(expectedConfig).map(field => [field, actualConfig[field] ?? null]));
    for (const [field, value] of Object.entries(expectedConfig)) {
      if (!isDeepStrictEqual(actualConfig[field], value)) gaps.push(`adapter_config_drift:${field}`);
    }
    const unexpectedKeys = Object.keys(actualConfig).filter(field => !Object.hasOwn(expectedConfig, field) && !derivedInstructionKeys.has(field)).sort();
    observed.unexpectedAdapterKeys = unexpectedKeys;
    if (unexpectedKeys.length) gaps.push("unexpected_adapter_config");
    observed.heartbeat = object(agent.runtimeConfig).heartbeat ?? null;
    if (!isDeepStrictEqual(observed.heartbeat, expected.heartbeat)) gaps.push("heartbeat_policy_drift");
    observed.permissions = agent.permissions;
    if (!isDeepStrictEqual(agent.permissions, expected.permissions)) gaps.push("permissions_drift");
    if (resolution?.defaultDrift === undefined) gaps.push("instructions_readback_unavailable");
    else if (resolution.defaultDrift !== null) gaps.push("instructions_drift");
    observed.instructionBundleMode = actualConfig.instructionsBundleMode ?? null;
    if (actualConfig.instructionsBundleMode !== "managed") gaps.push("managed_instruction_bundle_required");
  }
  if (role.desiredSkills.includes(COUNCIL_REVIEW_SKILL_KEY)) {
    try {
      const skill = await ctx.skills.managed.get("council-review", companyId);
      observed.reviewSkill = { key: skill.skill?.key ?? null, versionId: skill.skill?.currentVersionId ?? null,
        drift: skill.defaultDrift ?? null, readbackAvailable: skill.defaultDrift !== undefined };
      if (!skill.skill || skill.companyId !== companyId || skill.skill.companyId !== companyId || skill.skill.key !== COUNCIL_REVIEW_SKILL_KEY) gaps.push("review_skill_missing_or_mismatched");
      if (skill.defaultDrift === undefined) gaps.push("review_skill_readback_unavailable");
      else if (skill.defaultDrift !== null) gaps.push("review_skill_drift");
    } catch { gaps.push("review_skill_read_unavailable"); }
  }
  observed.availability = availability(gaps, String(observed.status));
  return { agentId: agent?.id ?? null, logicalAgentId, roleKey, profileId, revision,
    ready: gaps.length === 0, expected, observed, gaps };
}

/** Read-only: resolve the stable native UUID, never infer identity from a display name. */
export async function inspectVariant(
  ctx: PluginContext, companyId: string, logicalId: string, profileId: ProfileId, revision = ROLE_TEMPLATE_REVISION,
): Promise<VariantInspection> {
  validateSelection(profileId, revision);
  // Later retained revisions of a role still share one v1 logical anchor.
  const roleKeys = [...new Set(ROLE_TEMPLATES.map(role => role.key))];
  const anchors = await Promise.all(roleKeys.map(async roleKey => ({ roleKey,
    ...await readManaged(ctx, companyId, logicalAnchorKey(roleKey)) })));
  const matches = anchors.filter(result => result.value?.agent?.id === logicalId);
  if (matches.length > 1) throw new VariantIdentityError("logical_identity_ambiguous");
  const unreadable = anchors.some(result => result.failed);
  if (!matches.length) {
    if (!unreadable) throw new VariantIdentityError("logical_identity_unknown");
    return { agentId: null, logicalAgentId: logicalId, roleKey: null, profileId, revision, ready: false,
      expected: { logicalAgentId: logicalId }, observed: { availability: "unknown", accountAvailability: "not_validated_live" }, gaps: ["logical_anchor_read_unavailable"] };
  }
  const match = matches[0]!;
  return inspectRoleVariant(ctx, companyId, match.roleKey, profileId, revision, match.value,
    unreadable ? ["logical_anchor_read_unavailable"] : []);
}

/** Read the declared inventory once per role; no reconcile, reset or wake. */
export async function inspectPreparedVariants(ctx: PluginContext, companyId: string): Promise<VariantInspection[]> {
  const roles = await Promise.all(ROLE_TEMPLATES.map(async role => {
    const anchor = await readManaged(ctx, companyId, logicalAnchorKey(role.key));
    return Promise.all(role.allowedProfiles.map(profile => inspectRoleVariant(ctx, companyId, role.key, profile, role.revision,
      anchor.value, anchor.failed ? ["logical_anchor_read_unavailable"] : [])));
  }));
  return roles.flat();
}

/** Setup only. A rejected reconcile may have applied: propagate without retry or reset. */
async function prepareAgent(ctx: PluginContext, companyId: string, key: string): Promise<void> {
  const before = await ctx.agents.managed.get(key, companyId);
  if (before.status === "missing" && before.agent === null && before.agentId === null) {
    await ctx.agents.managed.reconcile(key, companyId);
  }
}
export async function setupVariant(
  ctx: PluginContext, companyId: string, roleKey: RoleKey, profileId: ProfileId, revision = ROLE_TEMPLATE_REVISION,
): Promise<VariantInspection> {
  validateSelection(profileId, revision);
  const role = roleTemplate(roleKey, revision);
  if (!role.allowedProfiles.includes(profileId)) throw new VariantIdentityError("variant_outside_catalogue");
  if (role.desiredSkills.includes(COUNCIL_REVIEW_SKILL_KEY)) {
    const skill = await ctx.skills.managed.get("council-review", companyId);
    if (skill.status === "missing" && skill.skill === null && skill.skillId === null) {
      await ctx.skills.managed.reconcile("council-review", companyId);
    }
  }
  await prepareAgent(ctx, companyId, logicalAnchorKey(roleKey));
  const key = variantKey(roleKey, profileId, revision);
  if (key !== logicalAnchorKey(roleKey)) await prepareAgent(ctx, companyId, key);
  const anchor = await readManaged(ctx, companyId, logicalAnchorKey(roleKey));
  return inspectRoleVariant(ctx, companyId, roleKey, profileId, revision, anchor.value,
    anchor.failed ? ["logical_anchor_read_unavailable"] : []);
}
export async function setupVariants(ctx: PluginContext, companyId: string): Promise<VariantInspection[]> {
  const results: VariantInspection[] = [];
  // Sequential effects: a failure stops setup rather than creating more resources after an unknown outcome.
  for (const role of ROLE_TEMPLATES) {
    for (const profile of role.allowedProfiles) {
      results.push(await setupVariant(ctx, companyId, role.key, profile, role.revision));
    }
  }
  return results;
}
