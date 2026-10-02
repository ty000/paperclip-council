import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultHostRoot, inspectHost, repositoryRoot } from "./paperclip-host.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { withOwnedQualificationRuntime } from "./run-bounded.mjs";
import {
  assertQualificationEvidence,
  claimLiveEvidencePaths,
  claimN2LiveEvidencePaths,
} from "./evidence-contract.mjs";

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function campaignContract(campaign) {
  if (campaign === "n1") {
    return {
      envPrefix: "COUNCIL_N1_LIVE",
      mode: "live",
      runCount: 3,
      timeoutMs: 45 * 60_000,
      claim: claimLiveEvidencePaths,
      label: "N1",
    };
  }
  if (campaign === "n2") {
    return {
      envPrefix: "COUNCIL_N2_LIVE",
      mode: "live-n2",
      runCount: 6,
      timeoutMs: 90 * 60_000,
      claim: claimN2LiveEvidencePaths,
      label: "N2",
    };
  }
  if (campaign === "n2-isolated") {
    return {
      envPrefix: "COUNCIL_N2_ISOLATED_LIVE",
      mode: "live-n2-isolated",
      runCount: 3,
      timeoutMs: 60 * 60_000,
      claim: claimN2LiveEvidencePaths,
      label: "isolated N2",
      exactCandidateRequired: true,
    };
  }
  throw new Error(`Unsupported live campaign ${String(campaign)}`);
}

// fallow-ignore-next-line complexity
function authorizedProfile(contract) {
  if (required(`${contract.envPrefix}_AUTHORIZED`) !== "1") {
    throw new Error(`${contract.envPrefix}_AUTHORIZED=1 is the explicit provider-run authorization gate`);
  }
  if (required(`${contract.envPrefix}_MODEL`) !== "gpt-5.6-sol"
      || required(`${contract.envPrefix}_EFFORT`) !== "high") {
    throw new Error(`The authorized ${contract.label} live profile is gpt-5.6-sol/high; no silent substitution is allowed`);
  }
  const runUnits = Number(required(`${contract.envPrefix}_RUN_UNITS`));
  const periodUnits = Number(required(`${contract.envPrefix}_PERIOD_UNITS`));
  if (!Number.isSafeInteger(runUnits) || runUnits < 1 || !Number.isSafeInteger(periodUnits)
      || (contract.label === "N1" ? periodUnits < runUnits * contract.runCount : periodUnits !== runUnits * contract.runCount)) {
    throw new Error(`${contract.label} requires ${contract.runCount} positive per-run reservations inside its explicit period allowance`);
  }
}

function assertCodexAuthentication() {
  const authPath = resolve(process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex"), "auth.json");
  if (!existsSync(authPath)) throw new Error(`Codex authentication is unavailable at ${authPath}`);
}

function committedCandidate(contract) {
  const candidateCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error(`Native ${contract.label} qualification requires a clean committed candidate`);
  }
  if (contract.exactCandidateRequired
      && required(`${contract.envPrefix}_CANDIDATE_SHA`) !== candidateCommit) {
    throw new Error(`${contract.envPrefix}_CANDIDATE_SHA must equal exact HEAD ${candidateCommit}`);
  }
  return candidateCommit;
}

function preparedHost(contract) {
  const host = inspectHost(defaultHostRoot);
  if (!host.prepared || !host.runtimeReady) {
    throw new Error(`Run pnpm qualification:host:prepare before the provider-authorized ${contract.label} qualification`);
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

function assertPassingEvidence(contract, serializedEvidence, candidateCommit, notBefore, screenshotPath, screenshotBytes) {
  const evidence = JSON.parse(serializedEvidence);
  assertQualificationEvidence(evidence, {
    mode: contract.mode,
    candidateCommit,
    notBefore,
    screenshotPath,
    screenshotBytes,
  });
}

async function runNativeQualification(runtime, contract, options) {
  const notBefore = Date.now();
  await runProcessGroup("corepack", ["pnpm", "test:functional"], {
    cwd: repositoryRoot,
    timeoutMs: contract.timeoutMs,
    env: {
      ...process.env,
      COUNCIL_PACKAGE_EXPECTED_COMMIT: options.candidateCommit,
      PAPERCLIP_TEST_HOST_ROOT: options.host.target,
      PAPERCLIP_QUALIFICATION_RUNTIME: runtime,
      PAPERCLIP_PLAYWRIGHT_BROWSERS_PATH: options.playwrightBrowsersPath,
      PLAYWRIGHT_BROWSERS_PATH: options.playwrightBrowsersPath,
      COUNCIL_PACKAGE_EVIDENCE_PATH: options.evidencePath,
      [`${contract.envPrefix}_SCREENSHOT_PATH`]: options.screenshotPath,
      [`${contract.envPrefix}_EVIDENCE_IDENTITY`]: JSON.stringify(options.evidenceIdentity),
      [`${contract.envPrefix}_SCREENSHOT_IDENTITY`]: JSON.stringify(options.screenshotIdentity),
    },
  });
  return notBefore;
}

export async function runLiveQualification(campaign) {
  const contract = campaignContract(campaign);
  authorizedProfile(contract);
  assertCodexAuthentication();
  const candidateCommit = committedCandidate(contract);
  const host = preparedHost(contract);
  const playwrightBrowsersPath = resolve(repositoryRoot, ".paperclip/qualification/playwright");
  await installChromium(host, playwrightBrowsersPath);
  const claim = contract.claim(
    repositoryRoot,
    candidateCommit,
    process.env.COUNCIL_PACKAGE_EVIDENCE_PATH,
  );
  let validated = false;
  try {
    const notBefore = await withOwnedQualificationRuntime((runtime) => runNativeQualification(runtime, contract, {
      candidateCommit,
      host,
      playwrightBrowsersPath,
      evidencePath: claim.evidencePath,
      screenshotPath: claim.screenshotPath,
      evidenceIdentity: claim.evidenceIdentity,
      screenshotIdentity: claim.screenshotIdentity,
    }));
    assertPassingEvidence(
      contract,
      claim.readEvidence(),
      candidateCommit,
      notBefore,
      claim.screenshotPath,
      claim.readScreenshot(),
    );
    validated = true;
  } finally {
    claim.release({ validate: validated });
  }
}
