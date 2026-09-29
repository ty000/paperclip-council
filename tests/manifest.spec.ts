import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";

describe("paperclip council manifest", () => {
  it("declares one agent-authenticated decision route and secret-ref configuration", () => {
    const parsed = pluginManifestV1Schema.parse(manifest);
    expect(parsed.apiRoutes).toEqual([
      expect.objectContaining({
        routeKey: "decision",
        auth: "agent",
        path: "/issues/:issueId/decision",
      }),
    ]);
    expect(parsed.instanceConfigSchema).toMatchObject({
      required: ["apiBaseUrl", "councilAgentId", "councilApiKey"],
      properties: {
        councilApiKey: { format: "secret-ref" },
      },
    });
  });
});
