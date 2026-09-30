import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "private.paperclip-council";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.2",
  displayName: "Paperclip Council",
  description: "Private local integration that emits explicit council decisions through Paperclip's public issue API.",
  author: "Local Paperclip integration",
  categories: ["automation"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "issues.wakeup",
    "issue.documents.read",
    "issue.attachments.read",
    "issue.interactions.create",
    "issue.interactions.read",
    "issue.interactions.respond",
    "secrets.read-ref",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: {
    namespaceSlug: "private_paperclip_council",
    migrationsDir: "migrations",
    coreReadTables: ["companies", "issues"],
  },
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
    {
      routeKey: "foundation-probe",
      method: "POST",
      path: "/issues/:issueId/foundation-probe",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],
};

export default manifest;
