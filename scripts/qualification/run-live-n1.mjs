import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHostRoot, inspectHost, repositoryRoot } from "./paperclip-host.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { withOwnedQualificationRuntime } from "./run-bounded.mjs";
import { assertQualificationEvidence, claimLiveEvidencePaths } from "./evidence-contract.mjs";

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// fallow-ignore-next-line complexity
function authorizedProfile() {
  if (required("COUNCIL_N1_LIVE_AUTHORIZED") !== "1") {
    throw new Error("COUNCIL_N1_LIVE_AUTHORIZED=1 is the explicit provider-run authorization gate");
  }
  if (required("COUNCIL_N1_LIVE_MODEL") !== "gpt-5.6-sol" || required("COUNCIL_N1_LIVE_EFFORT") !== "high") {
    throw new Error("The authorized N1 live profile is gpt-5.6-sol/high; no silent substitution is allowed");
  }
  const runUnits = Number(required("COUNCIL_N1_LIVE_RUN_UNITS"));
  const periodUnits = Number(required("COUNCIL_N1_LIVE_PERIOD_UNITS"));
  if (!Number.isSafeInteger(runUnits) || runUnits < 1 || !Number.isSafeInteger(periodUnits) || periodUnits < runUnits * 3) {
    throw new Error("The explicit period token allowance must cover exactly three positive per-run reservations");
  }
}

function assertCodexAuthentication() {
  const authPath = resolve(process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex"), "auth.json");
  if (!existsSync(authPath)) throw new Error(`Codex authentication is unavailable at ${authPath}`);
}

function committedCandidate() {
  const candidateCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("Native N1 qualification requires a clean committed candidate");
  }
  return candidateCommit;
}

function preparedHost() {
  const host = inspectHost(defaultHostRoot);
  if (!host.prepared || !host.runtimeReady) {
    throw new Error("Run pnpm qualification:host:prepare before the provider-authorized N1 qualification");
  }
  return host;
}

async function installChromium(host, playwrightBrowsersPath) {
  mkdirSync(playwrightBrowsersPath, { recursive: true });
  await runProcessGroup("corepack", ["pnpm", "exec", "playwright", "install", "chromium"], {
    cwd: host.target,
    timeoutMs: 5 * 60_000,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath },
  });
}

// fallow-ignore-next-line complexity
function assertPassingEvidence(evidencePath, candidateCommit, notBefore) {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assertQualificationEvidence(evidence, { mode: "live", candidateCommit, notBefore });
}

async function runNativeQualification(runtime, options) {
  const notBefore = Date.now();
  await runProcessGroup("corepack", ["pnpm", "test:functional"], {
    cwd: repositoryRoot,
    timeoutMs: 45 * 60_000,
    env: {
      ...process.env,
      COUNCIL_PACKAGE_EXPECTED_COMMIT: options.candidateCommit,
      PAPERCLIP_TEST_HOST_ROOT: options.host.target,
      PAPERCLIP_QUALIFICATION_RUNTIME: runtime,
      PAPERCLIP_PLAYWRIGHT_BROWSERS_PATH: options.playwrightBrowsersPath,
      PLAYWRIGHT_BROWSERS_PATH: options.playwrightBrowsersPath,
      COUNCIL_PACKAGE_EVIDENCE_PATH: options.evidencePath,
      COUNCIL_N1_LIVE_SCREENSHOT_PATH: options.screenshotPath,
    },
  });
  assertPassingEvidence(options.evidencePath, options.candidateCommit, notBefore);
}

async function main() {
  authorizedProfile();
  assertCodexAuthentication();
  const candidateCommit = committedCandidate();
  const { evidencePath, screenshotPath } = claimLiveEvidencePaths(
    repositoryRoot,
    candidateCommit,
    process.env.COUNCIL_PACKAGE_EVIDENCE_PATH,
  );
  const host = preparedHost();
  const playwrightBrowsersPath = resolve(repositoryRoot, ".paperclip/qualification/playwright");
  await installChromium(host, playwrightBrowsersPath);
  await withOwnedQualificationRuntime((runtime) => runNativeQualification(runtime, {
    candidateCommit, host, playwrightBrowsersPath, evidencePath, screenshotPath,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
