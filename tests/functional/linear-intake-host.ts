import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const linearHostCommit = "61b3fd57a695614dc4a37e2303f426a34a9795cf";

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function runtimeDirectory(repository: string) {
  const parent = resolve(repository, ".runtime/lot4");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(resolve(parent, "native-"));
}

function isolateEnvironment(runtime: string) {
  Object.assign(process.env, {
    PAPERCLIP_HOME: runtime, PAPERCLIP_INSTANCE_ID: "linear-intake-isolated",
    PAPERCLIP_CONFIG: resolve(runtime, "config.json"),
    PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_SECRETS_MASTER_KEY_FILE: resolve(runtime, "master.key"),
    PAPERCLIP_TELEMETRY_ENABLED: "false", PAPERCLIP_LOG_LEVEL: "warn",
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false", PAPERCLIP_STORAGE_PROVIDER: "local_disk",
    PAPERCLIP_STORAGE_LOCAL_DIR: resolve(runtime, "storage"), OTEL_SDK_DISABLED: "true", NODE_ENV: "test",
    PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD: "1", PAPERCLIP_IN_WORKTREE: "false", RUN_LOG_BASE_PATH: resolve(runtime, "run-logs"),
  });
  for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_MANAGED_CONFIG",
    "PAPERCLIP_CLOUD_TENANT_TOKEN", "PAPERCLIP_TRUSTED_USER_ID", "PAPERCLIP_PUBLIC_URL",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RUN_LOG_S3_BUCKET"]) delete process.env[key];
}

/** Real isolated host and installed workers; no replacement scheduler or plugin DB shim. */
export async function startLinearHost(repository: string) {
  const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
  assert(host, "An explicit prepared, read-only Paperclip host is required");
  assert.equal(git(host, ["rev-parse", "HEAD"]), linearHostCommit);
  assert.equal(git(host, ["status", "--porcelain", "--untracked-files=no"]), "");
  const runtime = await runtimeDirectory(repository);
  isolateEnvironment(runtime);
  const hostImport = (path: string) => import(pathToFileURL(resolve(host, path)).href);
  const tables = await hostImport("packages/db/src/index.ts");
  const { createApp } = await hostImport("server/src/app.ts");
  const { createPluginWorkerManager } = await hostImport("server/src/services/plugin-worker-manager.ts");
  const { resolveHeartbeatSchedulingSuppression } = await hostImport("server/src/services/heartbeat.ts");
  assert.deepEqual(resolveHeartbeatSchedulingSuppression(), { suppressed: false, reason: null },
    "The private fixture host must permit native dispatch to its explicit deterministic CLI transport");
  const { createStorageService } = await hostImport("server/src/storage/service.ts");
  const { createLocalDiskStorageProvider } = await hostImport("server/src/storage/local-disk-provider.ts");
  const database = await tables.startEmbeddedPostgresTestDatabase("council-linear-intake-");
  const db = tables.createDb(database.connectionString);
  const server = createServer();
  let app: any;
  const workerManager = createPluginWorkerManager();
  try {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  process.env.PAPERCLIP_API_URL = base;
  app = await createApp(db, {
    uiMode: "none", serverPort: address.port,
    storageService: createStorageService(createLocalDiskStorageProvider(resolve(runtime, "storage"))),
    deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"],
    bindHost: "127.0.0.1", companyDeletionEnabled: false, announcements: { enabled: false, feedUrl: "" },
    instanceId: "linear-intake-isolated", hostVersion: "0.3.1", localPluginDir: resolve(runtime, "plugins"),
    pluginWorkerManager: workerManager,
  });
  server.on("request", app);
  await app.locals.bundledPluginsStartup;

  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }

  return {
    runtime, base, api, hostImport, workerManager, db, tables,
    async bootstrapOwner() {
      const company = await api("POST", "/api/companies", { name: "Isolated Linear Council receiver", requireBoardApprovalForNewAgents: false });
      // Explicit identity-only test fixture. Runtime owns no authority without the native company owner and mandate.
      await db.insert(tables.authUsers).values({ id: "local-board", name: "Isolated test owner", email: "linear-owner@example.test",
        createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(tables.companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "local-board",
        membershipRole: "owner", status: "active" }).onConflictDoNothing();
      await db.insert(tables.instanceUserRoles).values({ userId: "local-board", role: "instance_admin" }).onConflictDoNothing();
      await api("PATCH", `/api/companies/${company.id}`, { defaultResponsibleUserId: "local-board" });
      return company.id as string;
    },
    async restartWorker(pluginId: string) {
      const before = await api("GET", `/api/plugins/${pluginId}/dashboard`);
      await api("POST", `/api/plugins/${pluginId}/disable`, {});
      await api("POST", `/api/plugins/${pluginId}/enable`, {});
      const after = await api("GET", `/api/plugins/${pluginId}/dashboard`);
      assert.notEqual(before.worker.pid, after.worker.pid);
      return { beforePid: before.worker.pid, afterPid: after.worker.pid };
    },
    async cleanup() {
      await workerManager.stopAll();
      await app.locals.paperclipShutdown();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await db.$client.end();
      await database.cleanup();
      assert.equal(git(host, ["status", "--porcelain", "--untracked-files=no"]), "");
      return { serverStopped: true, databaseStopped: true, hostTrackedUnchanged: true, runtimeRetained: true };
    },
  };
  } catch (error) {
    await workerManager.stopAll();
    await app?.locals.paperclipShutdown();
    await new Promise<void>(done => server.close(() => done()));
    await db.$client.end();
    await database.cleanup();
    throw error;
  }
}

export type LinearHost = Awaited<ReturnType<typeof startLinearHost>>;

export async function waitForLinear<T>(label: string, read: () => Promise<T>, complete: (value: T) => boolean, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (complete(value)) return value;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`Bounded observation timed out: ${label}`);
}
