import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./paperclip-host.mjs";
import { runProcessGroup } from "./process-group.mjs";
import { withOwnedQualificationRuntime } from "./run-bounded.mjs";

const expectedHostCommit = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
const functionalTimeoutMs = 8 * 60_000;
const hostDigestFiles = [
  "server/src/app.ts",
  "server/src/routes/issues.ts",
  "server/src/services/plugin-host-services.ts",
  "packages/db/src/test-embedded-postgres.ts",
  "pnpm-lock.yaml",
];
const conflictingExecutionFlags = [
  "COUNCIL_N1_LIVE_AUTHORIZED",
  "COUNCIL_N2_LIVE_AUTHORIZED",
  "COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED",
  "COUNCIL_N2_NATIVE_LIFECYCLE",
  "COUNCIL_N2_PREREQUISITE",
  "COUNCIL_ORDINARY_CAMPAIGN_PROFILE",
  "COUNCIL_N45_PROFILE",
];
const providerCredentialKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "GROQ_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactLocation(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function hostIdentity(hostRoot) {
  const commit = git(hostRoot, ["rev-parse", "HEAD"]);
  const status = git(hostRoot, ["status", "--porcelain", "--untracked-files=no"]);
  const digest = createHash("sha256");
  for (const path of hostDigestFiles) {
    digest.update(`${path}\0`);
    digest.update(readFileSync(resolve(hostRoot, path)));
    digest.update("\0");
  }
  return { commit, trackedStatus: status, selectedTrackedSourceSha256: digest.digest("hex"), files: hostDigestFiles };
}

function qualificationEnvironment() {
  const conflicts = conflictingExecutionFlags.filter((key) => process.env[key] === "1" || process.env[key]);
  if (conflicts.length > 0) throw new Error(`Draft upload proof refuses other execution modes: ${conflicts.join(", ")}`);
  const environment = { ...process.env };
  for (const key of providerCredentialKeys) delete environment[key];
  return environment;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertProofIdentity(evidence, candidateCommit, notBefore) {
  requireCondition(evidence.proofId === "paperclip-council-draft-upload-publication-proof-v1", "Draft upload proof ID mismatch");
  requireCondition(evidence.outcome === "DRAFT UPLOAD PUBLICATION PROOF VALIDATED", "Draft upload outcome mismatch");
  requireCondition(evidence.candidate?.commit === candidateCommit, "Draft upload candidate mismatch");
  requireCondition(Date.parse(evidence.startedAt) >= notBefore, "Draft upload evidence predates its launcher");
  requireCondition(evidence.head === expectedHostCommit, "Draft upload host mismatch");
  const expectedResults = [
    "installation",
    "draftUploadIntegratorIdentity",
    "draftUploadSameBundleVerified",
    "draftUploadForeignTaskRefused",
    "draftUploadPublicRouteReadyForReview",
    "draftUploadZeroProviderUsage",
    "draftUploadFixtureLifecycleFinished",
  ];
  requireCondition(expectedResults.every((key) => evidence.results?.[key] === "PASS"), "Draft upload evidence is missing a PASS result");
}

// The launcher intentionally checks every independent artifact binding before it publishes a proof manifest.
// fallow-ignore-next-line complexity
function assertAttachmentBinding(proof) {
  requireCondition(proof && proof.rootIssueId !== proof.integrationIssueId, "Draft upload tasks are not distinct");
  requireCondition(proof.integrator?.authentication === "agent API key plus Paperclip-Agent-Run-Id", "Draft upload integrator identity mismatch");
  requireCondition(proof.wrongAttachment?.issueId === proof.rootIssueId, "Foreign attachment is not bound to the product task");
  requireCondition(proof.wrongAttachment?.publishStatus === 422 && proof.wrongAttachment?.publishCode === "integration_failed", "Foreign attachment was not refused");
  requireCondition(proof.admittedAttachment?.issueId === proof.integrationIssueId && proof.admittedAttachment?.publishStatus === 200, "Admitted attachment was not published");
  requireCondition(proof.wrongAttachment?.sha256 === proof.candidate?.sha256, "Foreign attachment digest mismatch");
  requireCondition(proof.admittedAttachment?.sha256 === proof.candidate?.sha256, "Admitted attachment digest mismatch");
  requireCondition(proof.publicReadback?.phase === "ready_for_review", "Public readback did not reach ready_for_review");
  requireCondition(proof.publicReadback?.productSubjectIssueId === proof.rootIssueId, "Product subject changed during publication");
  requireCondition(proof.publicReadback?.attachmentIssueId === proof.integrationIssueId, "Candidate attachment task readback mismatch");
}

// The fixture boundary is a conjunction of cleanup and zero-usage observations, kept adjacent for auditability.
// fallow-ignore-next-line complexity
function assertFixtureBoundary(proof) {
  requireCondition(proof.fixtureLifecycle?.runCount === 1, "Draft upload requires exactly one fixture run");
  requireCondition(proof.fixtureLifecycle?.activeRunCount === 0, "Draft upload fixture run remained active");
  requireCondition(proof.fixtureLifecycle?.openCheckoutCount === 0, "Draft upload checkout remained open");
  requireCondition(proof.fixtureLifecycle?.openExecutionCount === 0, "Draft upload execution remained open");
  requireCondition(proof.usage?.classification === "fixture" && proof.usage?.heartbeatRows === 1, "Draft upload usage is not fixture-bound");
  const zeroUsage = ["providerInvocations", "modelRuns", "inputTokens", "cachedInputTokens", "outputTokens", "costCents"];
  requireCondition(zeroUsage.every((key) => proof.usage?.[key] === 0), "Draft upload fixture reports nonzero usage");
  requireCondition(proof.stopBoundary === "ready_for_review; no reviewer or publisher run", "Draft upload crossed its stop boundary");
}

function assertEvidence(evidence, candidateCommit, hostBefore, notBefore) {
  assertProofIdentity(evidence, candidateCommit, notBefore);
  assertAttachmentBinding(evidence.draftUploadProof);
  assertFixtureBoundary(evidence.draftUploadProof);
  requireCondition(evidence.launcherCleanup?.ownedRuntimeRemoved, "Owned draft upload runtime was not removed");
  requireCondition(evidence.hostIdentity?.before?.selectedTrackedSourceSha256 === hostBefore.selectedTrackedSourceSha256, "Host before digest mismatch");
  requireCondition(evidence.hostIdentity?.after?.selectedTrackedSourceSha256 === hostBefore.selectedTrackedSourceSha256, "Host after digest mismatch");
  requireCondition(JSON.stringify(evidence.launcherBoundary?.conflictingExecutionFlagsRefused) === JSON.stringify(conflictingExecutionFlags), "Execution-mode refusal boundary mismatch");
  requireCondition(JSON.stringify(evidence.launcherBoundary?.providerCredentialKeysRemovedBeforeHostStart) === JSON.stringify(providerCredentialKeys), "Provider credential sanitization boundary mismatch");
}

function proofManifest({ candidateCommit, evidencePath, evidenceSha256, proofPath, generatedAt }) {
  return {
    schema_version: "proof-manifest.v1",
    proof_id: `paperclip-council-draft-upload-publication-proof-v1:${candidateCommit}`,
    subject: `Authenticated admitted integrator draft upload on Council candidate ${candidateCommit}`,
    status: "pass",
    summary: "A fixture integrator authenticated with its native API key and run ID uploaded one real Git bundle. Publication refused identical bytes attached to the product task, then verified the attachment on the admitted integration task and stopped at ready_for_review.",
    categories: ["functional", "compliance", "operations"],
    evidence: [
      {
        id: "public-draft-upload-runtime",
        category: "functional",
        kind: "runtime-observation",
        location: artifactLocation(evidencePath),
        replayable: true,
        notes: `Candidate-bound JSON sha256=${evidenceSha256}; inspect authenticated request attribution, equal bundle digests, refused foreign-task attachment, verified admitted attachment, and public mission readback.`,
      },
      {
        id: "fixture-and-provider-boundary",
        category: "compliance",
        kind: "runtime-observation",
        location: artifactLocation(evidencePath),
        replayable: true,
        notes: "One unexecuted heartbeat fixture supplies the admitted integrator identity. Its terminal readback records zero tokens; no wakeup, model, provider, reviewer or publisher run occurs.",
      },
      {
        id: "owned-runtime-and-host-immutability",
        category: "operations",
        kind: "command-output",
        location: artifactLocation(evidencePath),
        replayable: true,
        notes: "The launcher removes its exact temporary runtime and records the pinned host commit, tracked status, and selected tracked-source digest before and after execution.",
      },
    ],
    replay: {
      preconditions: [
        `Run from clean committed Council candidate ${candidateCommit}.`,
        `Set PAPERCLIP_TEST_HOST_ROOT to the prepared, tracked-clean Paperclip host at ${expectedHostCommit}.`,
        "Use no LIVE flag, provider credential, durable instance, reviewer, or publisher.",
      ],
      steps: [
        "PAPERCLIP_TEST_HOST_ROOT=<pinned-host> corepack pnpm qualification:proof:draft-upload",
        `sha256sum ${artifactLocation(evidencePath)}`,
        `python3 <proof-gates-install>/scripts/proof_manifest_check.py --manifest ${artifactLocation(proofPath)}`,
      ],
      expected_artifacts: [
        `${artifactLocation(evidencePath)} with sha256 ${evidenceSha256}`,
        `${artifactLocation(proofPath)} as a canonical proof-manifest.v1 document`,
        "The evidence ends at ready_for_review, reports one terminal zero-usage fixture run, and proves the host source digest unchanged.",
      ],
    },
    closure: {
      decision: "close-provisional",
      rationale: "This bounded criterion is functionally proven; issue #85 closure still depends on contextual review of the full issue criteria.",
      next_required_actions: ["Contextual review and aggregate reconciliation of issue #85"],
    },
    generated_at: generatedAt,
  };
}

// fallow-ignore-next-line complexity
async function main() {
  const candidateCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (git(repositoryRoot, ["status", "--porcelain"]) !== "") {
    throw new Error("Draft upload qualification requires a clean committed candidate");
  }
  const hostRootInput = process.env.PAPERCLIP_TEST_HOST_ROOT;
  if (!hostRootInput) throw new Error("PAPERCLIP_TEST_HOST_ROOT must name the explicitly authorized prepared host");
  const childEnvironment = qualificationEnvironment();
  const hostRoot = resolve(hostRootInput);
  const hostBefore = hostIdentity(hostRoot);
  if (hostBefore.commit !== expectedHostCommit || hostBefore.trackedStatus !== "") {
    throw new Error(`Draft upload qualification requires tracked-clean Paperclip ${expectedHostCommit}`);
  }

  const evidencePath = resolve(repositoryRoot, `artifacts/draft-upload-proof-${candidateCommit}.json`);
  const proofPath = resolve(repositoryRoot, `artifacts/draft-upload-proof-${candidateCommit}.proof.json`);
  if (existsSync(evidencePath) || existsSync(proofPath)) {
    throw new Error(`Draft upload proof already exists for ${candidateCommit}; refusing to overwrite immutable evidence`);
  }
  mkdirSync(dirname(evidencePath), { recursive: true });
  const notBefore = Date.now();
  let ownedRuntime;
  await withOwnedQualificationRuntime(async (qualificationRuntime) => {
    ownedRuntime = qualificationRuntime;
    await runProcessGroup("corepack", ["pnpm", "test:functional"], {
      cwd: repositoryRoot,
      timeoutMs: functionalTimeoutMs,
      env: {
        ...childEnvironment,
        COUNCIL_PACKAGE_EXPECTED_COMMIT: candidateCommit,
        COUNCIL_DRAFT_UPLOAD_PROOF: "1",
        PAPERCLIP_TEST_HOST_ROOT: hostRoot,
        PAPERCLIP_QUALIFICATION_RUNTIME: qualificationRuntime,
        COUNCIL_PACKAGE_EVIDENCE_PATH: evidencePath,
      },
    });
  });
  if (!ownedRuntime || existsSync(ownedRuntime)) throw new Error("Owned qualification runtime cleanup was not proven");

  const hostAfter = hostIdentity(hostRoot);
  if (JSON.stringify(hostAfter) !== JSON.stringify(hostBefore)) {
    throw new Error("Pinned Paperclip host identity changed during draft upload qualification");
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  evidence.launcherCleanup = { ownedRuntime, ownedRuntimeRemoved: true, observedAt: new Date().toISOString() };
  evidence.hostIdentity = { before: hostBefore, after: hostAfter };
  evidence.launcherBoundary = {
    conflictingExecutionFlagsRefused: conflictingExecutionFlags,
    providerCredentialKeysRemovedBeforeHostStart: providerCredentialKeys,
  };
  assertEvidence(evidence, candidateCommit, hostBefore, notBefore);
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(evidencePath, evidenceBytes, { flag: "w" });
  const evidenceDigest = sha256(evidenceBytes);
  const generatedAt = new Date().toISOString();
  const proofBytes = Buffer.from(`${JSON.stringify(proofManifest({
    candidateCommit, evidencePath, evidenceSha256: evidenceDigest, proofPath, generatedAt,
  }), null, 2)}\n`);
  writeFileSync(proofPath, proofBytes, { flag: "wx" });
  const proofDigest = sha256(proofBytes);
  console.log(`Draft upload evidence: ${evidencePath} sha256=${evidenceDigest}`);
  console.log(`Draft upload proof manifest: ${proofPath} sha256=${proofDigest}`);
  console.log("Draft upload publication proof validated at ready_for_review with one zero-usage fixture integrator run");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
