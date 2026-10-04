import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { repositoryRoot } from "./paperclip-host.mjs";
import { withOwnedQualificationRuntime } from "./run-bounded.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { ordinaryCampaignProfile, assertOrdinaryCampaignResult } from "./ordinary-campaign-contract.mjs";
const [mode, configPath] = process.argv.slice(2);
if (!configPath) throw new Error("Usage: run-ordinary-campaign.mjs prepare|session <profile.json> OR stop <session-evidence.json>");
if (mode === "stop") {
  const session = JSON.parse(readFileSync(resolve(configPath), "utf8")).ordinaryCampaign?.session;
  if (!session || dirname(session.runtime) !== tmpdir() || !basename(session.runtime).startsWith("paperclip-council-package-")
      || session.stopFile !== resolve(session.runtime, "ordinary-campaign.stop")) throw new Error("Owned ordinary session evidence required");
  writeFileSync(session.stopFile, session.id, { mode: 0o600, flag: "wx" });
  console.log("Stop requested; wait for launcher exit and cleanup evidence.");
} else {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const candidate = git(repositoryRoot, "rev-parse", "HEAD");
  if (git(repositoryRoot, "status", "--porcelain")) throw new Error("Clean committed source required");
  const profile = ordinaryCampaignProfile(JSON.parse(readFileSync(resolve(configPath), "utf8")), mode, candidate);
  const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
  if (!host || git(host, "rev-parse", "HEAD") !== profile.hostSha || git(host, "status", "--porcelain", "--untracked-files=no")) throw new Error("Clean pinned host required");
  for (const [key, value] of Object.entries(process.env)) if (/^COUNCIL_.*(?:LIVE_AUTHORIZED|NATIVE_LIFECYCLE|PREREQUISITE)$/.test(key) && value === "1") throw new Error("Ordinary preparation excludes execution modes");
  const evidencePath = resolve(repositoryRoot, `artifacts/ordinary-campaign-${mode}-${candidate}.json`);
  mkdirSync(dirname(evidencePath), { recursive: true }); writeFileSync(evidencePath, "{}\n", { flag: "wx" });
  let runtimePath; let exitCode = 1;
  try {
    await withOwnedQualificationRuntime(async runtime => {
      runtimePath = runtime;
      await runProcessGroup("corepack", ["pnpm", "exec", "tsx", "tests/functional/run.ts"], { cwd: repositoryRoot,
        timeoutMs: mode === "session" ? 180 * 60_000 : 15 * 60_000,
        env: { ...process.env, COUNCIL_ORDINARY_CAMPAIGN_PROFILE: JSON.stringify(profile), COUNCIL_PACKAGE_EXPECTED_COMMIT: candidate,
          PAPERCLIP_TEST_HOST_ROOT: host, PAPERCLIP_QUALIFICATION_RUNTIME: runtime, COUNCIL_PACKAGE_EVIDENCE_PATH: evidencePath } });
      exitCode = 0;
    });
  } finally {
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")); evidence.launcherExitCode = exitCode;
    evidence.launcherCleanup = { runtimePath, ownedRuntimeRemoved: Boolean(runtimePath && !existsSync(runtimePath)) };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  }
  assertOrdinaryCampaignResult(exitCode, JSON.parse(readFileSync(evidencePath, "utf8")), profile);
  console.log(`Ordinary ${mode} completed: ${evidencePath}`);
}
