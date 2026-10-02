import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertN2PrerequisiteEvidence } from "./evidence-contract.mjs";
import { defaultHostRoot, inspectHost, repositoryRoot } from "./paperclip-host.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { prepareQualificationHost, withOwnedQualificationRuntime } from "./run-bounded.mjs";

const functionalTimeoutMs = 15 * 60_000;

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactLocation(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function proofManifest({ candidateCommit, evidencePath, evidenceSha256, proofPath, generatedAt }) {
  return {
    schema_version: "proof-manifest.v1",
    proof_id: `paperclip-council-n2-native-stage-prerequisite-v1:${candidateCommit}`,
    subject: `Provider-free isolated N2 prerequisite on Council candidate ${candidateCommit}`,
    status: "pass",
    summary: "Public Paperclip APIs and fixture-confined public Council commands produced a verified two-contribution N1 candidate at ready_for_review with every reservation settled, zero exposure, and no provider or native agent run.",
    categories: ["functional", "compliance", "operations"],
    evidence: [
      {
        id: "n2-prerequisite-runtime",
        category: "functional",
        kind: "runtime-observation",
        location: artifactLocation(evidencePath),
        replayable: true,
        notes: `Candidate-bound JSON sha256=${evidenceSha256}; inspect the mission, candidate, reservations, run readbacks, stop boundary, and cleanup fields.`,
      },
      {
        id: "owned-runtime-cleanup",
        category: "operations",
        kind: "command-output",
        location: artifactLocation(evidencePath),
        replayable: true,
        notes: "launcherCleanup proves that the exact temporary runtime created by the launcher no longer exists after the functional process exits.",
      },
      {
        id: "provider-and-database-boundary",
        category: "compliance",
        kind: "runtime-observation",
        location: artifactLocation(evidencePath),
        replayable: true,
        notes: "The evidence records zero heartbeat runs for all four identities, zero provider invocations, and no direct mission-table mutation.",
      },
    ],
    replay: {
      preconditions: [
        `Run from clean committed Council candidate ${candidateCommit}.`,
        "The pinned Paperclip qualification host is prepared and runtime-ready.",
        "No LIVE authorization, provider credential, or durable Paperclip instance is used.",
      ],
      steps: [
        "corepack pnpm qualification:preflight:n2",
        `sha256sum ${artifactLocation(evidencePath)}`,
        `python3 /home/davy-lp/.codex/plugins/cache/home-local/proof-gates/0.1.1/skills/proofGateReplayable/scripts/proof_manifest_check.py ${artifactLocation(proofPath)}`,
      ],
      expected_artifacts: [
        `${artifactLocation(evidencePath)} with sha256 ${evidenceSha256}`,
        `${artifactLocation(proofPath)} as a canonical proof-manifest.v1 document`,
        "The evidence contract returns N2 native-stage prerequisite validated and the owned runtime is absent.",
      ],
    },
    closure: {
      decision: "close-final",
      rationale: "The bounded provider-free prerequisite is complete; native N2 model execution remains a separate, explicitly authorized campaign.",
      next_required_actions: [],
    },
    generated_at: generatedAt,
  };
}

// The launcher keeps candidate claiming, execution, cleanup, and proof publication in strict order.
// fallow-ignore-next-line complexity
async function main() {
  const candidateCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("N2 prerequisite qualification requires a clean committed candidate");
  }

  const evidencePath = resolve(repositoryRoot, `artifacts/n2-prerequisite-${candidateCommit}.json`);
  const proofPath = resolve(repositoryRoot, `artifacts/n2-prerequisite-${candidateCommit}.proof.json`);
  if (existsSync(evidencePath) || existsSync(proofPath)) {
    throw new Error(`N2 prerequisite evidence already exists for ${candidateCommit}; refusing to overwrite immutable proof`);
  }

  let host = inspectHost(defaultHostRoot);
  if (!host.prepared || !host.runtimeReady) host = await prepareQualificationHost();
  mkdirSync(dirname(evidencePath), { recursive: true });
  const notBefore = Date.now();
  let ownedRuntime;
  await withOwnedQualificationRuntime(async (qualificationRuntime) => {
    ownedRuntime = qualificationRuntime;
    await runProcessGroup("corepack", ["pnpm", "test:functional"], {
      cwd: repositoryRoot,
      timeoutMs: functionalTimeoutMs,
      env: {
        ...process.env,
        COUNCIL_PACKAGE_EXPECTED_COMMIT: candidateCommit,
        COUNCIL_N2_PREREQUISITE: "1",
        PAPERCLIP_TEST_HOST_ROOT: host.target,
        PAPERCLIP_QUALIFICATION_RUNTIME: qualificationRuntime,
        COUNCIL_PACKAGE_EVIDENCE_PATH: evidencePath,
      },
    });
  });

  if (!ownedRuntime || existsSync(ownedRuntime)) {
    throw new Error("Owned qualification runtime cleanup was not proven");
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  evidence.launcherCleanup = {
    ownedRuntime,
    ownedRuntimeRemoved: true,
    observedAt: new Date().toISOString(),
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(evidencePath, evidenceBytes, { flag: "w" });
  assertN2PrerequisiteEvidence(evidence, { candidateCommit, notBefore });

  const generatedAt = new Date().toISOString();
  const evidenceDigest = sha256(evidenceBytes);
  const provisionalProof = proofManifest({
    candidateCommit,
    evidencePath,
    evidenceSha256: evidenceDigest,
    proofPath,
    generatedAt,
  });
  const proofBytes = Buffer.from(`${JSON.stringify(provisionalProof, null, 2)}\n`);
  writeFileSync(proofPath, proofBytes, { flag: "wx" });
  const proofDigest = sha256(proofBytes);

  console.log(`N2 prerequisite evidence: ${evidencePath} sha256=${evidenceDigest}`);
  console.log(`N2 prerequisite proof manifest: ${proofPath} sha256=${proofDigest}`);
  console.log("N2 native-stage prerequisite validated; no provider or native agent run executed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
