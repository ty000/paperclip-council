import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "./paperclip-host.mjs";
import { withOwnedQualificationRuntime } from "./run-bounded.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { N45_HOST_SHA, n45Profile, assertN45Result } from "./n45-contract.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const [mode, configPath] = process.argv.slice(2);
if (!configPath) throw new Error("Usage: node scripts/qualification/run-n45-campaign.mjs prepare|launch <profile.json>");
const candidate = git(repositoryRoot, ["rev-parse", "HEAD"]);
if (git(repositoryRoot, ["status", "--porcelain"])) throw new Error("Clean committed Council candidate required");
const profile = n45Profile(JSON.parse(readFileSync(resolve(configPath), "utf8")), mode, candidate);
if (mode === "launch") throw new Error("Launch is operator-assisted: follow docs/n5/N45-CAMPAIGN.md on a fresh authorized instance; this prepare command never enables or wakes agents");
const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
if (!host || git(host, ["rev-parse", "HEAD"]) !== N45_HOST_SHA || git(host, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("Clean pinned host required");
for (const [key, value] of Object.entries(process.env)) if (/^COUNCIL_.*(?:LIVE_AUTHORIZED|NATIVE_LIFECYCLE|PREREQUISITE)$/.test(key) && value === "1") throw new Error("N45 excludes other qualification modes");
const evidencePath = resolve(repositoryRoot, `artifacts/n45-${mode}-${candidate}.json`);
mkdirSync(resolve(repositoryRoot, "artifacts"), { recursive: true });
writeFileSync(evidencePath, "{}\n", { flag: "wx" });
let runtimePath; let exitCode = 1;
try {
  await withOwnedQualificationRuntime(async runtime => {
    runtimePath = runtime;
    await runProcessGroup("corepack", ["pnpm", "exec", "tsx", "tests/functional/run.ts"], {
      cwd: repositoryRoot, timeoutMs: mode === "prepare" ? 10 * 60_000 : 150 * 60_000,
      env: { ...process.env, COUNCIL_N45_PROFILE: JSON.stringify(profile), COUNCIL_PACKAGE_EXPECTED_COMMIT: candidate,
        PAPERCLIP_TEST_HOST_ROOT: host, PAPERCLIP_QUALIFICATION_RUNTIME: runtime, COUNCIL_PACKAGE_EVIDENCE_PATH: evidencePath },
    });
    exitCode = 0;
  });
} finally {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  evidence.launcherExitCode = exitCode;
  evidence.launcherCleanup = { runtimePath, ownedRuntimeRemoved: Boolean(runtimePath && !existsSync(runtimePath)) };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
}
assertN45Result(exitCode, JSON.parse(readFileSync(evidencePath, "utf8")), mode, candidate);
console.log(`N45 ${mode} completed: ${evidencePath}`);
