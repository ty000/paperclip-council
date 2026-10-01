import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Test-only host imports are read-only. Binaries and driver are already installed;
// no host setup helper is used, since it may repair files in its dependency tree.
export async function isolatedPostgres() {
  const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
  assert(host, "PAPERCLIP_TEST_HOST_ROOT must identify an existing host checkout (read-only)");
  const requireDb = createRequire(resolve(host, "packages/db/package.json"));
  const postgres = requireDb("postgres");
  const native = resolve(dirname(requireDb.resolve("embedded-postgres")), "../../@embedded-postgres/linux-x64/native");
  const directory = await mkdtemp(resolve(tmpdir(), "council-receipts-pg-"));
  const environment = { ...process.env, LD_LIBRARY_PATH: resolve(native, "lib") };
  const bin = (name: string, args: string[]) => execFileSync(resolve(native, "bin", name), args, { env: environment, stdio: "pipe" });
  // A probe-and-release TCP port has a TOCTOU window before pg_ctl binds it.
  // The owned temporary directory gives every run an exclusive Unix socket.
  const port = 5432;
  let started = false;
  let sql: any;
  try {
    bin("initdb", ["-D", resolve(directory, "data"), "-U", "postgres", "-A", "trust", "--no-locale"]);
    bin("pg_ctl", ["-D", resolve(directory, "data"), "-l", resolve(directory, "postgres.log"), "-o", `-h '' -p ${port} -k ${directory}`, "-w", "start"]);
    started = true;
    sql = postgres({ host: directory, port, database: "postgres", username: "postgres", max: 12, onnotice: () => {} });
    // Match the host drizzle/postgres-js parameter serializers.
    requireDb("drizzle-orm/postgres-js").drizzle(sql);
    const guards = await import(pathToFileURL(resolve(host, "server/src/services/plugin-database.ts")).href);
    const namespace = "plugin_private_paperclip_council_270061461e";
    const db = {
      namespace,
      async query(statement: string, params: unknown[] = []) {
        guards.validatePluginRuntimeQuery(statement, namespace, []);
        return Array.from(await sql.unsafe(statement, params));
      },
      async execute(statement: string, params: unknown[] = []) {
        guards.validatePluginRuntimeExecute(statement, namespace);
        const result = await sql.unsafe(statement, params);
        return { rowCount: result.count };
      },
    };
    return {
      sql, db, directory, connection: { host: directory, port, database: "postgres", username: "postgres" },
      async migration(file: string) {
        const source = await readFile(file, "utf8");
        for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) {
          guards.validatePluginMigrationStatement(statement, namespace, ["companies", "issues", "projects"]);
        }
        await sql.begin((transaction: any) => transaction.unsafe(source));
      },
      async cleanup() {
        await sql.end({ timeout: 2 });
        bin("pg_ctl", ["-D", resolve(directory, "data"), "-m", "fast", "-w", "stop"]);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await sql?.end({ timeout: 2 });
    if (started) bin("pg_ctl", ["-D", resolve(directory, "data"), "-m", "fast", "-w", "stop"]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
