// A real disposable worker process killed by run.ts after the synthetic host
// has accepted its request. It has no access to a live instance or credentials.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { executeCouncilDecision } from "../../src/decision-receipts.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
const fixture = JSON.parse(process.env.COUNCIL_CRASH_FIXTURE!);
const requireDb = createRequire(resolve(process.env.PAPERCLIP_TEST_HOST_ROOT!, "packages/db/package.json"));
const sql = requireDb("postgres")(fixture.connection);
requireDb("drizzle-orm/postgres-js").drizzle(sql);
const ctx = {
  db: {
    namespace: "plugin_private_paperclip_council_270061461e",
    query: (statement: string, params: unknown[]) => sql.unsafe(statement, params),
    execute: async (statement: string, params: unknown[]) => ({ rowCount: (await sql.unsafe(statement, params)).count }),
  }, secrets: { resolve: async () => "synthetic-only" },
} as unknown as PluginContext;
try { await executeCouncilDecision(ctx, fixture.config, fixture.input); }
finally { await sql.end(); }
