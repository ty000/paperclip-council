import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcessGroup } from "./process-group.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
const expectedHost = process.env.COUNCIL_CONTRIBUTION_WAIT_HOST_COMMIT;
if (!host || !/^[a-f0-9]{40}$/.test(expectedHost ?? "") || git(host, ["rev-parse", "HEAD"]) !== expectedHost) {
  throw new Error("Explicit PAPERCLIP_TEST_HOST_ROOT and exact COUNCIL_CONTRIBUTION_WAIT_HOST_COMMIT required");
}
const hostFiles = ["server/src/services/issues.ts", "server/src/services/recovery/service.ts",
  "server/src/services/recovery/disposition-repair.ts", "server/src/services/issue-dependency-wakeups.ts",
  "packages/db/src/test-embedded-postgres.ts", "pnpm-lock.yaml"];
const hashes = () => Object.fromEntries(hostFiles.map(path => [path,
  createHash("sha256").update(readFileSync(resolve(host, path))).digest("hex")]));
const hostBefore = { commit: expectedHost, status: git(host, ["status", "--porcelain"]), sourceSha256: hashes() };
const candidateCommit = git(repository, ["rev-parse", "HEAD"]);
const candidateFiles = ["src/contribution-wait.ts", "src/native-wake-policy.ts", "src/contribution-proof.ts", "src/n1-missions.ts",
  "tests/functional/contribution-wait-native.test.ts", "scripts/qualification/contribution-wait-native.config.mjs",
  "scripts/qualification/run-contribution-wait-native.mjs"];
const candidateHashes = () => Object.fromEntries(candidateFiles.map(path => [path,
  createHash("sha256").update(readFileSync(resolve(repository, path))).digest("hex")]));
const candidateSourceSha256 = candidateHashes();
const runtime = mkdtempSync(resolve(tmpdir(), "council-contribution-wait-"));
const proofDirectory = resolve(repository, "artifacts");
mkdirSync(proofDirectory, { recursive: true });
const proofPath = resolve(proofDirectory, `contribution-wait-native-${candidateCommit}-${Date.now()}.json`);
const proof = { boundary: "Real Paperclip issue/dependency/recovery services and ephemeral PostgreSQL; enqueueWakeup intercepted before dispatch. No provider run or live service.",
  candidate: { commit: candidateCommit, dirty: Boolean(git(repository, ["status", "--porcelain"])), sourceSha256: candidateSourceSha256 },
  host: { path: resolve(host), ...hostBefore }, outcome: "pending" };
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
const env = { ...process.env, PAPERCLIP_TEST_HOST_ROOT: resolve(host),
  COUNCIL_CONTRIBUTION_WAIT_RUNTIME: runtime, COUNCIL_CONTRIBUTION_WAIT_EVIDENCE_PATH: proofPath,
  PAPERCLIP_HOME: runtime, PAPERCLIP_CONFIG: resolve(runtime, "config.json"), PAPERCLIP_INSTANCE_ID: "contribution-wait-fixture",
  PAPERCLIP_TELEMETRY_ENABLED: "false", OTEL_SDK_DISABLED: "true", NODE_ENV: "test", PAPERCLIP_LOG_LEVEL: "warn",
  PAPERCLIP_STORAGE_PROVIDER: "local_disk", PAPERCLIP_STORAGE_LOCAL_DIR: resolve(runtime, "storage"),
  PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD: "1", RUN_LOG_BASE_PATH: resolve(runtime, "run-logs") };
for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_CLOUD_TENANT_TOKEN",
  "PAPERCLIP_API_URL", "PAPERCLIP_PUBLIC_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RUN_LOG_S3_BUCKET"]) delete env[key];
try {
  await runProcessGroup(process.execPath, [resolve(repository, "node_modules/vitest/vitest.mjs"), "run", "--config",
    "scripts/qualification/contribution-wait-native.config.mjs"], { cwd: repository, env, timeoutMs: 180_000 });
} finally {
  rmSync(runtime, { recursive: true, force: true });
  const evidence = JSON.parse(readFileSync(proofPath, "utf8"));
  const hostAfter = { commit: git(host, ["rev-parse", "HEAD"]), status: git(host, ["status", "--porcelain"]), sourceSha256: hashes() };
  evidence.hostUnchanged = JSON.stringify(hostBefore) === JSON.stringify(hostAfter);
  evidence.candidateSourceUnchanged = JSON.stringify(candidateSourceSha256) === JSON.stringify(candidateHashes());
  evidence.runtimeRemoved = !existsSync(runtime);
  writeFileSync(proofPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Contribution wait native evidence: ${proofPath}`);
  if (!evidence.hostUnchanged || !evidence.candidateSourceUnchanged || !evidence.runtimeRemoved) {
    throw new Error("Observed source identity changed or owned runtime cleanup failed");
  }
}
if (JSON.parse(readFileSync(proofPath, "utf8")).outcome !== "provider-free native contribution wait validated") {
  throw new Error(`Incomplete native contribution wait evidence: ${proofPath}`);
}
