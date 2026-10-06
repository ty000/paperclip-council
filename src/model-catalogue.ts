import { createHash } from "node:crypto";
import type { PluginManagedAgentDeclaration, PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { MODEL_CHARTER_SOURCES } from "./model-charters.js";
import { ModelSelectionError } from "./model-state.js";

export const MODEL_PROFILES = {
  "terra-low": { id: "terra-low", model: "gpt-5.6-terra", effort: "low" },
  "sol-medium": { id: "sol-medium", model: "gpt-5.6-sol", effort: "medium" },
  "sol-high": { id: "sol-high", model: "gpt-5.6-sol", effort: "high" },
  "astra-high": { id: "astra-high", model: "gpt-6-astra", effort: "high" },
} as const;
export type ProfileId = keyof typeof MODEL_PROFILES;
export type TaskFamily = "synthesis" | "implementation" | "diagnosis" | "review" | "validation" | "design" | "orchestration";
export interface ModelFamily {
  id: TaskFamily;
  defaultProfile: ProfileId;
  allowedProfiles: ProfileId[];
}
export interface ModelCatalogue {
  schemaVersion: 1;
  revision: string;
  variantRevision?: string;
  families: ModelFamily[];
  unavailabilityAlternatives?: Partial<Record<ProfileId, ProfileId>>;
}
export const MODEL_CATALOGUE: ModelCatalogue = {
  schemaVersion: 1, revision: "1", variantRevision: "1",
  families: [
    { id: "synthesis", defaultProfile: "terra-low", allowedProfiles: ["terra-low", "sol-medium"] },
    { id: "implementation", defaultProfile: "sol-medium", allowedProfiles: ["sol-medium", "sol-high"] },
    { id: "diagnosis", defaultProfile: "sol-medium", allowedProfiles: ["sol-medium", "sol-high", "astra-high"] },
    { id: "review", defaultProfile: "sol-medium", allowedProfiles: ["sol-medium", "sol-high", "astra-high"] },
    { id: "validation", defaultProfile: "sol-medium", allowedProfiles: ["sol-medium", "sol-high"] },
    { id: "design", defaultProfile: "sol-medium", allowedProfiles: ["sol-medium", "sol-high", "astra-high"] },
    { id: "orchestration", defaultProfile: "sol-medium", allowedProfiles: ["sol-medium", "sol-high", "astra-high"] },
  ],
};

function orderedProfileSubsets(profiles: readonly ProfileId[]): ProfileId[][] {
  return Array.from({ length: 2 ** profiles.length - 1 }, (_, index) =>
    profiles.filter((_profile, position) => ((index + 1) & (1 << position)) !== 0));
}

function familyConfigSchema(family: ModelFamily) {
  return {
    oneOf: orderedProfileSubsets(family.allowedProfiles).flatMap(allowedProfiles =>
      allowedProfiles.map(defaultProfile => ({
        type: "object",
        additionalProperties: false,
        required: ["id", "defaultProfile", "allowedProfiles"],
        properties: {
          id: { const: family.id },
          defaultProfile: { const: defaultProfile },
          allowedProfiles: { const: allowedProfiles },
        },
      }))),
  };
}

/** Draft-07 configuration boundary; runtime validation remains authoritative after config read. */
export const MODEL_PROFILE_MAPPING_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "revision", "families"],
  properties: {
    schemaVersion: { const: 1 },
    revision: { type: "string", pattern: "^[1-9][0-9]*$" },
    variantRevision: { type: "string", pattern: "^[1-9][0-9]*$" },
    families: {
      type: "array",
      minItems: MODEL_CATALOGUE.families.length,
      maxItems: MODEL_CATALOGUE.families.length,
      allOf: MODEL_CATALOGUE.families.map(family => ({ contains: familyConfigSchema(family) })),
    },
    unavailabilityAlternatives: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(Object.keys(MODEL_PROFILES).map(profile => [profile, {
        type: "string",
        enum: Object.keys(MODEL_PROFILES).filter(alternative => alternative !== profile),
      }])),
    },
  },
};

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === "string" && Object.hasOwn(MODEL_PROFILES, value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateCatalogue(value: unknown): ModelCatalogue {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.revision !== "string"
    || !/^[1-9][0-9]*$/.test(value.revision) || !Array.isArray(value.families)) throw new Error("Invalid model catalogue version or families");
  if (Object.keys(value).some(key => !["schemaVersion", "revision", "variantRevision", "families", "unavailabilityAlternatives"].includes(key))) throw new Error("Unknown model catalogue field");
  if (value.variantRevision !== undefined && (typeof value.variantRevision !== "string" || !/^[1-9][0-9]*$/.test(value.variantRevision))) throw new Error("Invalid variant revision");
  const seen = new Set<string>();
  const known = new Set(MODEL_CATALOGUE.families.map(family => family.id));
  for (const family of value.families) {
    if (!record(family) || typeof family.id !== "string" || !known.has(family.id as TaskFamily)
      || seen.has(family.id) || !isProfileId(family.defaultProfile) || !Array.isArray(family.allowedProfiles)
      || !family.allowedProfiles.length || family.allowedProfiles.some(profile => !isProfileId(profile))
      || new Set(family.allowedProfiles).size !== family.allowedProfiles.length
      || !family.allowedProfiles.includes(family.defaultProfile)
      || Object.keys(family).some(key => !["id", "defaultProfile", "allowedProfiles"].includes(key))) throw new Error("Invalid model family");
    const approved = MODEL_CATALOGUE.families.find(row => row.id === family.id)!;
    const ranks = family.allowedProfiles.map(profile => approved.allowedProfiles.indexOf(profile));
    if (ranks.some((rank, index) => rank < 0 || index > 0 && rank <= ranks[index - 1]!)) throw new Error("Family profiles must be an ordered subset of the approved matrix");
    seen.add(family.id);
  }
  if (seen.size !== known.size) throw new Error("Exactly seven model families are required");
  if (value.unavailabilityAlternatives !== undefined) {
    if (!record(value.unavailabilityAlternatives)) throw new Error("Invalid unavailability alternatives");
    for (const [profile, alternative] of Object.entries(value.unavailabilityAlternatives)) {
      if (!isProfileId(profile) || !isProfileId(alternative) || profile === alternative) throw new Error("Invalid unavailability alternative");
    }
  }
  return structuredClone(value) as unknown as ModelCatalogue;
}

export function validateModelCatalogue(value: unknown): ModelCatalogue {
  try { return validateCatalogue(value); }
  catch (error) { throw new ModelSelectionError("model_catalogue_invalid", error instanceof Error ? error.message : "Invalid catalogue"); }
}

export const ROLE_TEMPLATE_REVISION = "1";
export const COUNCIL_REVIEW_RESOURCE_KEY = "council-variant-review-v1";
export const COUNCIL_REVIEW_SKILL_KEY = `plugin/private-paperclip-council/${COUNCIL_REVIEW_RESOURCE_KEY}`;
const sources = MODEL_CHARTER_SOURCES;
const roles = [
  ["executor", "engineer", "Software Executor", "executor", ""],
  ["lead", "engineer", "Integration Lead", "executor", "Own integration of the named contributions. You do not own the final verdict."],
  ["contributor-1", "engineer", "Contributor 1", "executor", "First independent contributor identity. Keep the assigned contribution and write ownership separate."],
  ["contributor-2", "engineer", "Contributor 2", "executor", "Second independent contributor identity. Keep the assigned contribution and write ownership separate."],
  ["generalist-reviewer", "general", "Generalist Reviewer", "generalist-reviewer", ""],
  ["product-reviewer", "general", "Product Reviewer", "product-reviewer", ""],
  ["development-reviewer", "engineer", "Development Reviewer", "development-reviewer", ""],
  ["architecture-reviewer", "engineer", "Architecture Reviewer", "architecture-reviewer", ""],
  ["ux-accessibility-reviewer", "designer", "UX & Accessibility Reviewer", "ux-accessibility-reviewer", ""],
  ["quality-reviewer", "qa", "Quality Reviewer", "quality-reviewer", ""],
  ["security-reviewer", "security", "Security Reviewer", "security-reviewer", ""],
  ["operations-reviewer", "devops", "Operations Reviewer", "operations-reviewer", ""],
  ["test", "qa", "Test Executor", "executor", "Execute only the assigned validation and preserve its complete evidence. Test execution is not final acceptance."],
  ["design", "designer", "Design Contributor", "executor", "Produce bounded design options and criterion-linked rationale within the mandate. Owner-reserved arbitration remains with the owner."],
  ["coordinator", "pm", "Dependency Coordinator", "executor", "Coordinate only the named dependency and its authorized work. Preserve source/result provenance; never invent authorization or accepted results."],
  ["facilitator", "general", "Council Facilitator", "executor", "Organize the assigned exchange and preserve attributed dissent. Facilitation grants no verdict, approval or extra participant."],
  ["publisher", "engineer", "Delivery Publisher", "executor", "Apply only the exact authorized delivery to its named destination. Unknown delivery effects block retry; never turn review approval into publication authority."],
] as const;
export type RoleKey = (typeof roles)[number][0];
export interface RoleTemplate {
  key: RoleKey;
  revision: string;
  role: string;
  title: string;
  instructions: Record<string, string>;
  instructionSha256: string;
  desiredSkills: string[];
  permissions: Record<string, unknown>;
  families: TaskFamily[];
  allowedProfiles: ProfileId[];
}
function roleFamilies(key: RoleKey): TaskFamily[] {
  if (key.endsWith("reviewer")) return ["review"];
  if (key === "contributor-1" || key === "contributor-2") return ["implementation", "validation"];
  if (key === "test") return ["validation"];
  if (key === "design") return ["design"];
  if (key === "lead") return ["orchestration", "diagnosis", "implementation"];
  if (key === "coordinator" || key === "publisher") return ["orchestration"];
  if (key === "facilitator") return ["synthesis", "orchestration"];
  return ["synthesis", "implementation", "diagnosis"];
}
export const ROLE_TEMPLATES: readonly RoleTemplate[] = roles.map(([key, role, title, source, specialization]) => {
  const sourceContent = sources[`agents/${source}/AGENTS.md`].content;
  const content = (key.endsWith("reviewer") ? sourceContent.replaceAll("council-review", COUNCIL_REVIEW_RESOURCE_KEY) : sourceContent) + (specialization ? `\n## Profile specialization\n\n${specialization}\n` : "")
    + "\n## Physical variants\n\nThis agent is one physical variant of a stable Council identity. A different model/profile does not create independence, a new budget or a new authorization. Use the durable task binding and available public history; do not assume a prior variant's private session was transferred.\n";
  const families = roleFamilies(key);
  const allowedProfiles = [...new Set(MODEL_CATALOGUE.families.filter(family => families.includes(family.id)).flatMap(family => family.allowedProfiles))];
  return { key, revision: ROLE_TEMPLATE_REVISION, role, title, families, allowedProfiles, instructions: { "AGENTS.md": content },
    instructionSha256: createHash("sha256").update(content).digest("hex"),
    desiredSkills: key.endsWith("reviewer") ? [COUNCIL_REVIEW_SKILL_KEY] : [],
    permissions: { canCreateAgents: false, canCreateSkills: false } };
});
export function roleTemplate(roleKey: string, revision = ROLE_TEMPLATE_REVISION): RoleTemplate {
  const role = ROLE_TEMPLATES.find(template => template.key === roleKey && template.revision === revision);
  if (!role) throw new Error("Role or revision is outside the Council catalogue");
  return role;
}
export function variantKey(roleKey: RoleKey, profile: ProfileId, revision = ROLE_TEMPLATE_REVISION): string {
  const role = roleTemplate(roleKey, revision);
  if (!isProfileId(profile) || !role.allowedProfiles.includes(profile)) throw new Error("Profile is outside this role's Council catalogue");
  return `council-${roleKey}-${profile}-v${revision}`;
}
/** This v1 key remains the logical identity anchor when later templates are added. */
export function logicalAnchorKey(roleKey: RoleKey): string {
  return `council-${roleKey}-sol-medium-v1`;
}
export function managedAgentDeclarations(): PluginManagedAgentDeclaration[] {
  return ROLE_TEMPLATES.flatMap(role => role.allowedProfiles.map(id => MODEL_PROFILES[id]).map(profile => ({
    agentKey: variantKey(role.key, profile.id, role.revision), displayName: `Council ${role.title} · ${profile.id} · v${role.revision}`,
    role: role.role, title: role.title, adapterType: "codex_local", status: "idle" as const,
    adapterConfig: { engine: "cli", model: profile.model, modelReasoningEffort: profile.effort,
      dangerouslyBypassApprovalsAndSandbox: false, search: false, fastMode: false, extraArgs: [],
      paperclipSkillSync: { desiredSkills: [...role.desiredSkills] } },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    permissions: { ...role.permissions }, budgetMonthlyCents: 0,
    instructions: { entryFile: "AGENTS.md", files: { ...role.instructions } },
  })));
}
export function managedSkillDeclarations(): PluginManagedSkillDeclaration[] {
  return [{ skillKey: COUNCIL_REVIEW_RESOURCE_KEY, displayName: "Council Variant Review", slug: COUNCIL_REVIEW_RESOURCE_KEY,
    // Host imports derive the slug from Markdown, not declaration.slug alone.
    markdown: sources["skills/council-review/SKILL.md"].content.replaceAll("council-review", COUNCIL_REVIEW_RESOURCE_KEY) }];
}
