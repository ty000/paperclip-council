import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error The ephemeral registry helper is intentionally plain ESM.
import { startPackageRegistry } from "../../scripts/qualification/npm-pair-registry.mjs";
import { startLinearHost, linearHostCommit, type LinearHost } from "./linear-intake-host.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
assert(process.env.COUNCIL_PACKAGE_TARBALL, "COUNCIL_PACKAGE_TARBALL must identify the built candidate");
assert(process.env.INTAKE_PACKAGE_TARBALL, "INTAKE_PACKAGE_TARBALL must identify the built candidate");
for (const flag of ["COUNCIL_N1_LIVE_AUTHORIZED", "COUNCIL_N2_LIVE_AUTHORIZED", "COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED"]) {
  assert.notEqual(process.env[flag], "1", "Package qualification excludes LIVE runs");
}

async function configureCouncil(host: LinearHost, companyId: string, pluginId: string) {
  const actor = await host.api("POST", `/api/companies/${companyId}/agents`, {
    name: "Package smoke identity", role: "engineer", adapterType: "process",
    adapterConfig: { command: "/usr/bin/false" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  });
  const key = await host.api("POST", `/api/agents/${actor.id}/keys`, { name: "isolated-package-smoke", scope: { kind: "standard" } });
  const secret = await host.api("POST", `/api/companies/${companyId}/secrets`, {
    name: "package-smoke", key: "PACKAGE_SMOKE", provider: "local_encrypted", value: key.token,
  });
  await host.api("POST", `/api/plugins/${pluginId}/config`, { companyId, configJson: {
    apiBaseUrl: host.base, councilAgentId: actor.id, councilApiKey: { type: "secret_ref", secretId: secret.id },
  } });
}

async function migrations(host: LinearHost, pluginId: string) {
  const rows = await host.db.$client.unsafe(
    "SELECT migration_key, checksum, status FROM plugin_migrations WHERE plugin_id = $1 ORDER BY migration_key", [pluginId]);
  assert(rows.length > 0);
  assert(rows.every((row: any) => row.status === "applied"));
  return Array.from(rows);
}

const registry: {
  origin: string; requests: Array<{ package: string; kind: string }>;
  packages: Array<{ file: string; name: string; version: string; sha256: string; integrity: string }>;
  close(): Promise<void>;
} = await startPackageRegistry(process.env.COUNCIL_PACKAGE_TARBALL, process.env.INTAKE_PACKAGE_TARBALL);
let host: LinearHost | undefined;
const proof: any = { schema: "council-intake-npm-package-install.v1", outcome: "RUNNING",
  hostCommit: linearHostCommit, councilSourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  councilSourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim() !== "",
  packages: registry.packages, checks: [],
  boundary: "Exact tarballs served from an ephemeral loopback npm registry; public npm runtime dependencies. Real host installation, SQL migrations, worker reload and same-version upgrade. No public npm publication, version-to-version migration, business enrollment or provider execution." };
try {
  host = await startLinearHost(repository);
  proof.runtime = host.runtime;
  const npmrc = resolve(host.runtime, "empty.npmrc");
  await writeFile(npmrc, "", { mode: 0o600 });
  Object.assign(process.env, { npm_config_registry: registry.origin, npm_config_userconfig: npmrc,
    npm_config_cache: resolve(host.runtime, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false" });
  const companyId = await host.bootstrapOwner();
  for (const candidate of registry.packages) {
    const installed = await host.api("POST", "/api/plugins/install", { packageName: candidate.name, version: candidate.version });
    assert.equal(installed.packageName, candidate.name);
    assert.equal(installed.packagePath, null, "Must exercise registry install, not local-path install");
    assert.equal(installed.version, candidate.version);
    assert.equal(installed.pluginKey, candidate.name.endsWith("/paperclip-council") ? "private.paperclip-council" : "ty000.linear-intake");
    const expectedHealth = installed.pluginKey === "private.paperclip-council" ? "ok" : "degraded";
    if (expectedHealth === "ok") await configureCouncil(host, companyId, installed.id);
    else await host.api("POST", `/api/plugins/${installed.id}/config`, { companyId, configJson: {} });
    const beforeMigrations = await migrations(host, installed.id);
    const beforeConfig = await host.api("GET", `/api/plugins/${installed.id}/config?companyId=${companyId}`);
    const restart = await host.restartWorker(installed.id);
    const upgraded = await host.api("POST", `/api/plugins/${installed.id}/upgrade`, { version: candidate.version });
    assert.equal(upgraded.id, installed.id);
    assert.equal(upgraded.version, candidate.version);
    const readback = await host.api("GET", `/api/plugins/${installed.id}`);
    assert.equal(readback.status, "ready");
    assert.equal(readback.packageName, candidate.name);
    assert.deepEqual(await migrations(host, installed.id), beforeMigrations);
    assert.deepEqual(await host.api("GET", `/api/plugins/${installed.id}/config?companyId=${companyId}`), beforeConfig);
    const health = await host.api("GET", `/api/plugins/${installed.id}/health`);
    assert.equal(health.status, "ready");
    assert.equal(health.healthy, true);
    const workerHealth: { status: string } = await host.workerManager.call(installed.id, "health", {});
    assert.equal(workerHealth.status, expectedHealth);
    const installedRoot = resolve(host.runtime, "plugins/node_modules", candidate.name);
    const packageJson = JSON.parse(await readFile(resolve(installedRoot, "package.json"), "utf8"));
    assert.equal(packageJson.name, candidate.name);
    proof.checks.push({ package: candidate.name, version: candidate.version, pluginId: installed.id,
      pluginKey: installed.pluginKey, registryInstall: true, migrationCount: beforeMigrations.length,
      restart, sameVersionUpgrade: true, configPreserved: true, health: expectedHealth });
  }
  const [counts] = await host.db.$client.unsafe(`SELECT
    (SELECT count(*)::int FROM issues) AS issues,
    (SELECT count(*)::int FROM heartbeat_runs) AS runs,
    (SELECT count(*)::int FROM agent_wakeup_requests) AS wakes`);
  assert.deepEqual(counts, { issues: 0, runs: 0, wakes: 0 });
  proof.absenceCounts = counts;
  assert.equal(new Set(registry.requests.filter(item => item.kind === "tarball").map(item => item.package)).size, 2);
  proof.outcome = "PASS";
} catch (error) {
  proof.outcome = "FAIL";
  proof.error = error instanceof Error ? error.message : "package qualification failed";
  process.exitCode = 1;
} finally {
  proof.registryRequests = registry.requests;
  try { if (host) proof.cleanup = await host.cleanup(); }
  catch (error) { proof.outcome = "FAIL"; proof.cleanupError = String(error); process.exitCode = 1; }
  await registry.close();
  if (host) {
    const path = resolve(host.runtime, "npm-package-proof.json");
    await writeFile(path, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ outcome: proof.outcome, proof: path, checks: proof.checks, error: proof.error }));
  } else console.error(JSON.stringify({ outcome: proof.outcome, error: proof.error }));
}
