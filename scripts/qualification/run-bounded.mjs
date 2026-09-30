import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { materializeHost, repositoryRoot } from "./paperclip-host.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { cleanupOwnedRuntime, createOwnedRuntime } from "./runtime-ownership.mjs";

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

const candidateCommit = git(["rev-parse", "HEAD"]);
if (git(["status", "--porcelain"]) !== "") {
  throw new Error("Bounded qualification requires a clean committed candidate");
}

const host = await materializeHost({ source: process.env.PAPERCLIP_QUALIFICATION_SOURCE });
const evidencePath = process.env.COUNCIL_PACKAGE_EVIDENCE_PATH
  ?? resolve(repositoryRoot, "artifacts/functional.json");
const playwrightBrowsersPath = resolve(repositoryRoot, ".paperclip/qualification/playwright");
const browserInstallTimeoutMs = 5 * 60_000;
const functionalTimeoutMs = 15 * 60_000;
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
