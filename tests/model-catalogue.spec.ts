import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOGUE, MODEL_PROFILE_MAPPING_SCHEMA, MODEL_PROFILES, ROLE_TEMPLATES, logicalAnchorKey,
  managedAgentDeclarations, managedSkillDeclarations, validateModelCatalogue, variantKey,
} from "../src/model-catalogue.js";
import { MODEL_CHARTER_SOURCES } from "../src/model-charters.js";

describe("versioned model catalogue", () => {
  it("keeps all seven approved families, concrete profiles and no invented fallback", () => {
    expect(validateModelCatalogue(MODEL_CATALOGUE)).toEqual(MODEL_CATALOGUE);
    expect(MODEL_CATALOGUE.families).toHaveLength(7);
    expect(MODEL_CATALOGUE.families.map(f => [f.id, f.defaultProfile])).toEqual([
      ["synthesis", "terra-low"], ["implementation", "sol-medium"], ["diagnosis", "sol-medium"],
      ["review", "sol-medium"], ["validation", "sol-medium"], ["design", "sol-medium"], ["orchestration", "sol-medium"],
    ]);
    expect(MODEL_CATALOGUE.unavailabilityAlternatives).toBeUndefined();
    expect(MODEL_CATALOGUE.variantRevision).toBe("1");
    expect(MODEL_PROFILES["astra-high"]).toEqual({ id: "astra-high", model: "gpt-6-astra", effort: "high" });
  });
  it.each([
    (v: any) => { v.families.pop(); },
    (v: any) => { v.families[1].id = "synthesis"; },
    (v: any) => { v.families[0].defaultProfile = "sol-high"; },
    (v: any) => { v.families[0].allowedProfiles.push("gpt-5.6"); },
    (v: any) => { v.families[0].allowedProfiles.push("astra-high"); },
    (v: any) => { v.families[1].allowedProfiles.reverse(); },
    (v: any) => { v.unavailabilityAlternatives = { "terra-low": ["sol-medium", "sol-high"] }; },
    (v: any) => { v.unavailabilityAlternatives = { "terra-low": "terra-low" }; },
    (v: any) => { v.unavailabilityAlternatives = { "terra-low": "unknown" }; },
    (v: any) => { v.variantRevision = 2; },
    (v: any) => { v.extraPolicy = true; },
  ])("rejects a malformed catalogue", mutate => {
    const value = structuredClone(MODEL_CATALOGUE); mutate(value);
    expect(() => validateModelCatalogue(value)).toThrow();
  });
  it("accepts an explicit single compatible alternative", () => {
    const value = { ...structuredClone(MODEL_CATALOGUE), unavailabilityAlternatives: { "terra-low": "sol-medium" } };
    expect(validateModelCatalogue(value).unavailabilityAlternatives).toEqual({ "terra-low": "sol-medium" });
  });
  it("exports the same seven-family and profile boundary enforced at runtime", () => {
    expect(MODEL_PROFILE_MAPPING_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "revision", "families"],
      properties: {
        schemaVersion: { const: 1 },
        revision: { type: "string", pattern: "^[1-9][0-9]*$" },
        variantRevision: { type: "string", pattern: "^[1-9][0-9]*$" },
        families: { type: "array", minItems: 7, maxItems: 7 },
        unavailabilityAlternatives: { type: "object", additionalProperties: false },
      },
    });
    const familyBoundary = (MODEL_PROFILE_MAPPING_SCHEMA.properties as any).families.allOf;
    expect(familyBoundary).toHaveLength(7);
    expect(familyBoundary.map((rule: any) => rule.contains.oneOf[0].properties.id.const)).toEqual(MODEL_CATALOGUE.families.map(family => family.id));
    const alternatives = (MODEL_PROFILE_MAPPING_SCHEMA.properties as any).unavailabilityAlternatives.properties;
    expect(Object.keys(alternatives)).toEqual(Object.keys(MODEL_PROFILES));
    for (const [profile, rule] of Object.entries(alternatives) as Array<[string, any]>) {
      expect(rule.enum).not.toContain(profile);
      expect(rule.enum).toHaveLength(Object.keys(MODEL_PROFILES).length - 1);
    }
  });
  it("leaves contextual fallback permission to the pinned family and permits a future revision reference", () => {
    const value = { ...structuredClone(MODEL_CATALOGUE), variantRevision: "2", unavailabilityAlternatives: { "sol-medium": "sol-high" } };
    expect(validateModelCatalogue(value).unavailabilityAlternatives).toEqual({ "sol-medium": "sol-high" });
    expect(() => variantKey("lead", "sol-high", "2")).toThrow("outside");
  });
  it("embeds the actual source charters and shared procedure, with no installed-path dependency", () => {
    for (const [source, embedded] of Object.entries(MODEL_CHARTER_SOURCES)) {
      const body = readFileSync(new URL(`../${source}`, import.meta.url), "utf8");
      expect(embedded.content).toBe(body);
      expect(embedded.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    }
    expect(managedSkillDeclarations()[0]!.markdown).toBe(MODEL_CHARTER_SOURCES["skills/council-review/SKILL.md"].content);
  });
  it("prepares real native variants with identical role rules and no periodic work", () => {
    const declarations = managedAgentDeclarations();
    expect(declarations.length).toBeLessThan(ROLE_TEMPLATES.length * 4);
    expect(declarations.some(v => v.agentKey === "council-contributor-1-astra-high-v1")).toBe(false);
    expect(declarations.some(v => v.agentKey === "council-generalist-reviewer-terra-low-v1")).toBe(false);
    expect(declarations.some(v => v.agentKey === "council-executor-terra-low-v1")).toBe(true);
    expect(ROLE_TEMPLATES.find(role => role.key === "publisher")?.families).toEqual(["orchestration"]);
    expect(new Set(declarations.map(v => v.agentKey)).size).toBe(declarations.length);
    expect(logicalAnchorKey("contributor-1")).not.toBe(logicalAnchorKey("contributor-2"));
    for (const role of ROLE_TEMPLATES) {
      const variants = declarations.filter(v => v.agentKey.startsWith(`council-${role.key}-`));
      for (const variant of variants) {
        expect(variant.instructions?.files).toEqual(role.instructions);
        expect(variant.permissions).toEqual(role.permissions);
        expect(variant.adapterConfig?.paperclipSkillSync).toEqual({ desiredSkills: role.desiredSkills });
        expect(variant.runtimeConfig?.heartbeat).toEqual({ enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 });
        expect(variant.adapterType).toBe("codex_local"); expect(variant.adapterConfig?.engine).toBe("cli");
      }
    }
    expect(variantKey("lead", "sol-medium", "1")).toBe(logicalAnchorKey("lead"));
  });
});
