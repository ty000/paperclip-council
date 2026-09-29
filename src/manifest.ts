import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "private.paperclip-council";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Paperclip Council",
  description: "Private local integration that emits explicit council decisions through Paperclip's public issue API.",
  author: "Local Paperclip integration",
  categories: ["automation"],
  capabilities: ["api.routes.register", "issues.read", "secrets.read-ref"],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    required: ["apiBaseUrl", "councilAgentId", "councilApiKey"],
    properties: {
      apiBaseUrl: {
        type: "string",
        format: "uri",
        title: "Paperclip API base URL",
        description: "Loopback origin of the Paperclip instance, without credentials, path, query, fragment, or an /api suffix.",
      },
      councilAgentId: {
        type: "string",
        format: "uuid",
        title: "Council agent ID",
        description: "Paperclip agent whose dedicated standard API key is stored below.",
      },
      councilApiKey: {
        format: "secret-ref",
        title: "Council agent API key",
        description: "Reference to the Paperclip company secret containing the dedicated council agent token.",
      },
    },
  },
  apiRoutes: [
    {
      routeKey: "decision",
      method: "POST",
      path: "/issues/:issueId/decision",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "required-for-agent-in-progress",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],
};

export default manifest;
