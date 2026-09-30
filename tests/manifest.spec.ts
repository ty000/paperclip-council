import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";

describe("paperclip council manifest", () => {
  it("preserves the decision route and declares the bounded L0 foundation bridge", () => {
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
    ]));
    expect(parsed.instanceConfigSchema).toMatchObject({
      required: ["apiBaseUrl", "councilAgentId", "councilApiKey"],
      properties: {
        councilApiKey: { format: "secret-ref" },
      },
    });
  });
});
