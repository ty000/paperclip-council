import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { MODEL_CATALOGUE, MODEL_PROFILE_MAPPING_SCHEMA, validateModelCatalogue } from "../src/model-catalogue.js";

describe("paperclip council manifest", () => {
  it("preserves earlier routes and declares the mission persistence API", () => {
    const parsed = pluginManifestV1Schema.parse(manifest);
    expect(parsed.apiRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routeKey: "decision",
        auth: "agent",
        path: "/issues/:issueId/decision",
      }),
      expect.objectContaining({
        routeKey: "foundation-probe",
        auth: "board-or-agent",
        path: "/issues/:issueId/foundation-probe",
      }),
      expect.objectContaining({
        routeKey: "rosters-list",
        auth: "board",
        path: "/companies/:companyId/rosters",
      }),
      expect.objectContaining({
        routeKey: "roster-command",
        auth: "board",
        path: "/companies/:companyId/rosters/:rosterId/commands",
      }),
      expect.objectContaining({
        routeKey: "missions-command",
        auth: "board",
        path: "/companies/:companyId/missions",
      }),
      expect.objectContaining({
        routeKey: "mission-read",
        auth: "board",
        path: "/companies/:companyId/missions/:missionId",
      }),
    ]));
    expect(parsed.tools).toEqual([expect.objectContaining({ name: "mission-command" })]);
    expect(parsed.capabilities).toContain("agent.tools.register");
    expect(parsed.database).toEqual(expect.objectContaining({
      namespaceSlug: "private_paperclip_council",
      migrationsDir: "migrations",
    }));
    expect(parsed.capabilities).toEqual(expect.arrayContaining([
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "issue.attachments.read",
      "issue.interactions.read",
      "companies.read",
      "projects.read",
      "agents.read",
      "ui.page.register",
    ]));
    expect(parsed.instanceConfigSchema).toMatchObject({
      required: ["apiBaseUrl", "councilAgentId", "councilApiKey"],
      properties: {
        councilApiKey: { format: "secret-ref" },
      },
    });
    expect(((parsed.instanceConfigSchema!.properties as Record<string, unknown>).modelProfileMapping as Record<string, unknown>))
      .toMatchObject(MODEL_PROFILE_MAPPING_SCHEMA);
    expect(parsed.version).toBe("0.7.10");
    expect((parsed.instanceConfigSchema!.properties as Record<string, unknown>).workspacePreflight)
      .toMatchObject({ type: "object", additionalProperties: false, required: ["codexHome"] });
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version).toBe(parsed.version);
    expect(parsed.entrypoints.ui).toBe("./dist/ui");
    expect(parsed.ui?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "page",
        id: "council-rosters",
        routePath: "council-rosters",
        exportName: "CouncilRostersPage",
      }),
    ]));
  });

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_HOST_ROOT))("matches runtime validation under the host Ajv config boundary", () => {
    const hostRoot = process.env.PAPERCLIP_TEST_HOST_ROOT!;
    const hostRequire = createRequire(resolve(hostRoot, "server/package.json"));
    const AjvModule = hostRequire("ajv") as { default?: new (options: Record<string, unknown>) => { compile(schema: unknown): (value: unknown) => boolean } };
    const Ajv = AjvModule.default ?? AjvModule as unknown as new (options: Record<string, unknown>) => { compile(schema: unknown): (value: unknown) => boolean };
    const schemaValid = new Ajv({ allErrors: true }).compile(MODEL_PROFILE_MAPPING_SCHEMA);
    const cases: Array<[string, unknown, boolean]> = [
      ["canonical", structuredClone(MODEL_CATALOGUE), true],
      ["compatible alternative", { ...structuredClone(MODEL_CATALOGUE), unavailabilityAlternatives: { "terra-low": "sol-medium" } }, true],
      ["unknown root field", { ...structuredClone(MODEL_CATALOGUE), foo: "bar" }, false],
      ["missing family", (() => { const value = structuredClone(MODEL_CATALOGUE); value.families.pop(); return value; })(), false],
      ["duplicate family", (() => { const value = structuredClone(MODEL_CATALOGUE); value.families[6] = structuredClone(value.families[0]!); return value; })(), false],
      ["default outside subset", (() => { const value = structuredClone(MODEL_CATALOGUE); value.families[0]!.defaultProfile = "sol-high"; return value; })(), false],
      ["invalid profile", (() => { const value: any = structuredClone(MODEL_CATALOGUE); value.families[0].allowedProfiles.push("unknown"); return value; })(), false],
      ["unordered subset", (() => { const value = structuredClone(MODEL_CATALOGUE); value.families[1]!.allowedProfiles.reverse(); return value; })(), false],
      ["nonpositive revision", { ...structuredClone(MODEL_CATALOGUE), revision: "0" }, false],
      ["multiple alternatives for one profile", { ...structuredClone(MODEL_CATALOGUE), unavailabilityAlternatives: { "terra-low": ["sol-medium", "sol-high"] } }, false],
    ];
    for (const [name, value, expected] of cases) {
      expect(schemaValid(value), `${name}: host schema`).toBe(expected);
      let runtimeValid = true;
      try { validateModelCatalogue(value); } catch { runtimeValid = false; }
      expect(runtimeValid, `${name}: runtime validator`).toBe(expected);
    }
  });
});
