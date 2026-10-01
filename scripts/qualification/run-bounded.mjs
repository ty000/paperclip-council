import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHostRoot, inspectHost, repositoryRoot } from "./paperclip-host.mjs";
import { isProcessGroupDrainError, runProcessGroup } from "./process-group.mjs";
import { cleanupOwnedRuntime, createOwnedRuntime } from "./runtime-ownership.mjs";
import { assertQualificationEvidence } from "./evidence-contract.mjs";

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

export async function withOwnedQualificationRuntime(action, {
  createRuntime = createOwnedRuntime,
  cleanupRuntime = cleanupOwnedRuntime,
} = {}) {
  const runtime = createRuntime();
  let preserveRuntime = false;
  try {
    return await action(runtime);
  } catch (error) {
    if (isProcessGroupDrainError(error)) {
      preserveRuntime = true;
      error.preservedRuntime = runtime;
      error.message = `${error.message}; qualification runtime preserved at ${runtime}`;
    }
    throw error;
  } finally {
    if (!preserveRuntime) cleanupRuntime(runtime);
  }
}

async function main() {
  const candidateCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("Bounded qualification requires a clean committed candidate");
  }

  const host = await prepareQualificationHost();
  const evidencePath = process.env.COUNCIL_PACKAGE_EVIDENCE_PATH
    ?? resolve(repositoryRoot, `artifacts/functional-${candidateCommit}.json`);
  const proofManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "qualification/proof-manifest.json"), "utf8"));
  if (proofManifest.schema_version !== "proof-manifest.v1"
      || proofManifest.proof_id !== "paperclip-council-n1-safe-boundary-qualification-v1"
      || proofManifest.status !== "partial"
      || proofManifest.closure?.decision !== "keep-open") {
    throw new Error("N1 qualification proof manifest must remain canonical and keep-open");
  }
  const playwrightBrowsersPath = resolve(repositoryRoot, ".paperclip/qualification/playwright");
  mkdirSync(playwrightBrowsersPath, { recursive: true });
  await runProcessGroup("corepack", ["pnpm", "exec", "playwright", "install", "chromium"], {
    cwd: host.target,
    timeoutMs: browserInstallTimeoutMs,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath },
  });

  await withOwnedQualificationRuntime(async (qualificationRuntime) => {
    const notBefore = Date.now();
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

    const evidenceBytes = readFileSync(evidencePath);
    const evidence = JSON.parse(evidenceBytes.toString("utf8"));
    assertQualificationEvidence(evidence, { mode: "safe", candidateCommit, notBefore });
    const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
    console.log(`Bounded qualification evidence: ${evidencePath} sha256=${evidenceSha256}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
