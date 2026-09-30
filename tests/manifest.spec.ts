import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";

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
});
