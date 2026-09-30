import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHostRoot, inspectHost, repositoryRoot } from "./paperclip-host.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { cleanupOwnedRuntime, createOwnedRuntime } from "./runtime-ownership.mjs";

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

const hostPrepareTimeoutMs = 15 * 60_000;
const browserInstallTimeoutMs = 5 * 60_000;
const functionalTimeoutMs = 15 * 60_000;
const hostPreparationScript = resolve(repositoryRoot, "scripts/qualification/paperclip-host.mjs");

export async function prepareQualificationHost({
  run = runProcessGroup,
  inspect = () => inspectHost(defaultHostRoot),
  timeoutMs = hostPrepareTimeoutMs,
  env = process.env,
} = {}) {
  await run(process.execPath, [hostPreparationScript, "prepare"], {
    cwd: repositoryRoot,
    timeoutMs,
    env,
  });
  const host = inspect();
  if (!host.prepared || !host.runtimeReady) {
    throw new Error("Paperclip qualification host did not verify after bounded preparation");
  }
  return host;
}

async function main() {
  const candidateCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("Bounded qualification requires a clean committed candidate");
  }

  const host = await prepareQualificationHost();
  const evidencePath = process.env.COUNCIL_PACKAGE_EVIDENCE_PATH
    ?? resolve(repositoryRoot, "artifacts/functional.json");
  const playwrightBrowsersPath = resolve(repositoryRoot, ".paperclip/qualification/playwright");
  mkdirSync(playwrightBrowsersPath, { recursive: true });
  await runProcessGroup("corepack", ["pnpm", "exec", "playwright", "install", "chromium"], {
    cwd: host.target,
    timeoutMs: browserInstallTimeoutMs,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath },
  });

  const qualificationRuntime = createOwnedRuntime();
  try {
    await runProcessGroup("corepack", ["pnpm", "test:functional"], {
      cwd: repositoryRoot,
      timeoutMs: functionalTimeoutMs,
      onFailure: async () => cleanupOwnedRuntime(qualificationRuntime),
      env: {
        ...process.env,
        COUNCIL_PACKAGE_EXPECTED_COMMIT: candidateCommit,
        PAPERCLIP_TEST_HOST_ROOT: host.target,
        PAPERCLIP_QUALIFICATION_RUNTIME: qualificationRuntime,
        PAPERCLIP_PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
        COUNCIL_PACKAGE_EVIDENCE_PATH: evidencePath,
      },
    });

    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const failedResult = Object.entries(evidence.results ?? {}).find(([, result]) => result !== "PASS");
    if (evidence.candidate?.commit !== candidateCommit
      || evidence.outcome !== "L2 STEP A MISSION PERSISTENCE VALIDATED"
      || failedResult) {
      throw new Error(`Bounded qualification evidence did not pass for ${candidateCommit}`);
    }
  } finally {
    cleanupOwnedRuntime(qualificationRuntime);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
