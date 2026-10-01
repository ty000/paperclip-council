import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHostRoot, inspectHost, repositoryRoot } from "./paperclip-host.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { withOwnedQualificationRuntime } from "./run-bounded.mjs";

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
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
  const authPath = resolve(process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex"), "auth.json");
  if (!existsSync(authPath)) throw new Error(`Codex authentication is unavailable at ${authPath}`);

  const candidateCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("Native N1 qualification requires a clean committed candidate");
  }
  const host = inspectHost(defaultHostRoot);
  if (!host.prepared || !host.runtimeReady) {
    throw new Error("Run pnpm qualification:host:prepare before the provider-authorized N1 qualification");
  }

  const playwrightBrowsersPath = resolve(repositoryRoot, ".paperclip/qualification/playwright");
  mkdirSync(playwrightBrowsersPath, { recursive: true });
  await runProcessGroup("corepack", ["pnpm", "exec", "playwright", "install", "chromium"], {
    cwd: host.target,
    timeoutMs: 5 * 60_000,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath },
  });

  const evidencePath = process.env.COUNCIL_PACKAGE_EVIDENCE_PATH
    ?? resolve(repositoryRoot, "artifacts", "n1-live.json");
  await withOwnedQualificationRuntime(async (runtime) => {
    await runProcessGroup("corepack", ["pnpm", "test:functional"], {
      cwd: repositoryRoot,
      timeoutMs: 45 * 60_000,
      env: {
        ...process.env,
        COUNCIL_PACKAGE_EXPECTED_COMMIT: candidateCommit,
        PAPERCLIP_TEST_HOST_ROOT: host.target,
        PAPERCLIP_QUALIFICATION_RUNTIME: runtime,
        PAPERCLIP_PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
        COUNCIL_PACKAGE_EVIDENCE_PATH: evidencePath,
      },
    });
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const failedResult = Object.entries(evidence.results ?? {}).find(([, result]) => result !== "PASS");
    if (evidence.proofId !== "paperclip-council-n1-observable-native-qualification-v1"
      || evidence.candidate?.commit !== candidateCommit
      || evidence.outcome !== "N1 OBSERVABLE RESULT VALIDATED"
      || failedResult) {
      throw new Error(`Native N1 evidence did not pass for ${candidateCommit}`);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
