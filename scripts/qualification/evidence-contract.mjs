import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const SAFE_PROOF_ID = "paperclip-council-n1-safe-boundary-qualification-v1";
const LIVE_PROOF_ID = "paperclip-council-n1-observable-native-qualification-v1";

const SAFE_OUTCOME = "N1 SAFE BOUNDARY VALIDATED";
const LIVE_OUTCOME = "N1 OBSERVABLE RESULT VALIDATED";

const APP_CLEANUP = "stopped only the plugin worker, listener, and application created by this run";
const DATABASE_CLEANUP = "fresh isolated PostgreSQL cluster removed; parent-owned temporary instance retained";
const SAFE_FIXTURE_BOUNDARY = "agents, issues, policies, and heartbeat runs are synthetic test preparation";
const LIVE_FIXTURE_BOUNDARY = "The safe-boundary suite uses fixtures; the N1 live campaign below uses native APIs, native wakeups, exact Paperclip run IDs, and run-derived terminal token settlement.";
const SAFE_PROVIDER_BOUNDARY = "none; dispatch was deliberately not invoked because it requests native wakeup";
const LIVE_STOP_BOUNDARY = "ready_for_review; N2 not started";

export const SAFE_RESULT_KEYS = Object.freeze([
  "installation",
  "migrationRegistryAndChecksums",
  "ownerAuthorityNoMutation",
  "atomicPairActivationNoPartialMutation",
  "createValidateActivate",
  "missingRosterStructuredRefusal",
  "missionOwnerIdentityReadScopeAndIdempotentCreate",
  "missionCommandCasNoLostUpdate",
  "concurrentPublicationAndImmutability",
  "missionCreateReplayAfterRosterRevision",
  "missionCreationVsLifecycleRace",
  "missionCreateBeforeSuspensionPersistsAndReplays",
  "missionSuspensionBeforeCreateRefusesPersistence",
  "reviseSuspendRetireAndStaleNoMutation",
  "missionPinsSurviveRosterRevisionSuspensionRetirement",
  "missionCreateReplayAfterRosterRetirement",
  "retiredRosterRejectedForNewMission",
  "missionPersistenceAfterRestart",
  "n1AdmissionOwnerAuthAndAtomicActivationRace",
  "n1ActiveMissionPinsRosterRevision",
  "n1AdmissionUnsettledPersistenceAfterRestart",
  "n1AdmissionKnownSettlementRestoresCapacity",
  "n1SharedReservationRetainedOnActivationReplay",
  "n1ManualLeadRunRefusedUntilExplicitFixtureBinding",
  "n1TwoNativeAttributedChildIssues",
  "n1ProhibitedDispatchKeepsContributionAndPublicationBlocked",
  "interCompanyIsolation",
  "installedUiBundleAndAuthenticatedBridge",
  "n1MissionExactLookupBeyondLatestList",
  "n1MissionUiHidesStaleDetailsOnRefreshFailure",
  "installedBrowserPageAndAuthenticatedAction",
  "installedBrowserStates",
  "n1MissionOwnerPageAndFailureStates",
  "migrationAndCompetingCas",
  "ownerWaitAndAttributedResponse",
  "v1Submission",
  "v1Correction",
  "v2Submission",
  "missingManifestRefusal",
  "attachmentBytesAndGitCandidate",
  "candidatePreparation",
  "v2Acceptance",
  "nativeReadback",
]);

export const LIVE_RESULT_KEYS = Object.freeze([
  ...SAFE_RESULT_KEYS,
  "n1NativeLeadAndTwoContributors",
  "n1IntegrationFailureBlocked",
  "n1VerifiedCandidateReadyForReview",
  "n1NativeG4UsageSettled",
  "n1InstalledBrowserObservableState",
]);

function fail(message) {
  throw new Error(`Qualification evidence contract failed: ${message}`);
}

function claimCreateOnly(path, kind) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(`live ${kind} path already exists; refusing to overwrite ${path}`);
    }
    throw error;
  }
}

function rollbackEmptyClaim(path, fd, identity) {
  let current;
  try {
    current = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const openClaim = fstatSync(fd);
  if (!current.isFile()
      || !openClaim.isFile()
      || current.dev !== identity.dev
      || current.ino !== identity.ino
      || openClaim.dev !== identity.dev
      || openClaim.ino !== identity.ino
      || current.size !== 0
      || openClaim.size !== 0) {
    return;
  }
  unlinkSync(path);
}

function requireUnclaimed(path, kind) {
  try {
    lstatSync(path);
    fail(`live ${kind} path already exists; refusing to overwrite ${path}`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function claimLiveEvidencePathsInternal(repositoryRoot, candidateCommit, configuredPath, beforeScreenshotClaim) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) {
    fail("candidate commit must be an exact lowercase 40-character Git SHA");
  }
  const evidencePath = resolve(
    repositoryRoot,
    configuredPath ?? `artifacts/n1-live-${candidateCommit}.json`,
  );
  if (extname(evidencePath) !== ".json" || !basename(evidencePath).includes(candidateCommit)) {
    fail(`live evidence filename must be JSON and contain candidate commit ${candidateCommit}`);
  }
  const screenshotPath = resolve(
    dirname(evidencePath),
    `${basename(evidencePath, ".json")}-ready-for-review.png`,
  );
  const claimLockPath = resolve(
    dirname(evidencePath),
    `.${basename(evidencePath)}.artifact-pair-claim`,
  );
  mkdirSync(dirname(claimLockPath), { recursive: true });
  try {
    mkdirSync(claimLockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(`live artifact pair is already being claimed; refusing concurrent acquisition ${claimLockPath}`);
    }
    throw error;
  }
  let evidenceFd;
  let screenshotFd;
  try {
    requireUnclaimed(evidencePath, "evidence");
    requireUnclaimed(screenshotPath, "screenshot");
    evidenceFd = claimCreateOnly(evidencePath, "evidence");
    const evidenceIdentity = fstatSync(evidenceFd);
    try {
      beforeScreenshotClaim?.({ evidencePath, screenshotPath });
      screenshotFd = claimCreateOnly(screenshotPath, "screenshot");
    } catch (error) {
      rollbackEmptyClaim(evidencePath, evidenceFd, evidenceIdentity);
      throw error;
    }
    return { evidencePath, screenshotPath };
  } finally {
    try {
      if (screenshotFd !== undefined) closeSync(screenshotFd);
    } finally {
      try {
        if (evidenceFd !== undefined) closeSync(evidenceFd);
      } finally {
        rmdirSync(claimLockPath);
      }
    }
  }
}

export function claimLiveEvidencePaths(repositoryRoot, candidateCommit, configuredPath) {
  return claimLiveEvidencePathsInternal(repositoryRoot, candidateCommit, configuredPath, undefined);
}

// Test-only fault injection for the interval between the two O_EXCL claims.
export function __claimLiveEvidencePathsForTest(
  repositoryRoot,
  candidateCommit,
  configuredPath,
  beforeScreenshotClaim,
) {
  return claimLiveEvidencePathsInternal(
    repositoryRoot,
    candidateCommit,
    configuredPath,
    beforeScreenshotClaim,
  );
}

function assertExactResults(results, expectedKeys, mode) {
  if (!results || typeof results !== "object" || Array.isArray(results)) {
    fail(`${mode} results must be a non-empty object`);
  }
  const actualKeys = Object.keys(results);
  const expected = new Set(expectedKeys);
  const actual = new Set(actualKeys);
  const missing = expectedKeys.filter((key) => !actual.has(key));
  const unexpected = actualKeys.filter((key) => !expected.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(`${mode} result set mismatch; missing=[${missing.join(", ")}]; unexpected=[${unexpected.join(", ")}]`);
  }
  const nonPassing = expectedKeys.filter((key) => results[key] !== "PASS");
  if (nonPassing.length > 0) {
    fail(`${mode} results are not PASS: [${nonPassing.join(", ")}]`);
  }
}

function assertFreshness(evidence, notBefore) {
  if (!Number.isFinite(notBefore)) fail("notBefore must be a finite launch timestamp");
  const startedAt = Date.parse(evidence.startedAt);
  const finishedAt = Date.parse(evidence.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    fail("startedAt and finishedAt must be valid timestamps");
  }
  if (startedAt < notBefore) {
    fail(`evidence is stale: startedAt ${evidence.startedAt} predates launcher timestamp ${new Date(notBefore).toISOString()}`);
  }
  if (finishedAt < startedAt) fail("finishedAt predates startedAt");
}

function assertCleanup(evidence) {
  if (evidence.appCleanup !== APP_CLEANUP || evidence.databaseCleanup !== DATABASE_CLEANUP) {
    fail("required appCleanup/databaseCleanup proof is missing or unexpected");
  }
  const cleanupErrors = ["error", "cleanupError", "databaseCleanupError", "runtimeCleanupError"]
    .filter((key) => evidence[key] !== undefined && evidence[key] !== null);
  if (cleanupErrors.length > 0) fail(`error fields are present: [${cleanupErrors.join(", ")}]`);
}

function assertSafeProviderBoundary(evidence) {
  if (evidence.n1Boundary?.providerInvocation !== SAFE_PROVIDER_BOUNDARY
      || evidence.configuration?.fixtureBoundary === undefined) {
    fail("safe fixture/provider boundary proof is missing");
  }
}

function assertSafeCapabilityLists(evidence) {
  if (!Array.isArray(evidence.n1Boundary?.demonstrated) || evidence.n1Boundary.demonstrated.length === 0
      || !Array.isArray(evidence.n1Boundary?.incomplete) || evidence.n1Boundary.incomplete.length === 0) {
    fail("safe boundary must identify demonstrated and incomplete capabilities");
  }
}

function liveReservations(evidence) {
  const admission = evidence.liveN1?.admission?.envelope;
  const reservations = admission?.reservations;
  if (!Array.isArray(reservations) || reservations.length !== 3) {
    fail("live admission must contain exactly three reservations");
  }
  return { admission, reservations };
}

function assertSettledReservation(reservation) {
  if (reservation?.status !== "settled"
      || reservation?.usage?.status !== "known"
      || !Number.isSafeInteger(reservation.usage.units)
      || reservation.usage.units < 1
      || reservation?.remainingExposure?.status !== "known"
      || reservation.remainingExposure.units !== 0) {
    fail("every live reservation must be settled with positive known usage and zero known remaining exposure");
  }
}

function assertKnownUsageTotal(admission, reservations) {
  const knownUsageUnits = admission?.allowance?.knownUsageUnits;
  const summedUsageUnits = reservations.reduce((total, reservation) => total + reservation.usage.units, 0);
  if (admission?.allowance?.status !== "known"
      || !Number.isSafeInteger(knownUsageUnits)
      || knownUsageUnits < 1
      || knownUsageUnits !== summedUsageUnits) {
    fail("allowance.knownUsageUnits must equal the positive settled reservation usage total");
  }
}

function assertLiveSettlement(evidence) {
  const { admission, reservations } = liveReservations(evidence);
  reservations.forEach(assertSettledReservation);
  assertKnownUsageTotal(admission, reservations);
}

function assertSafeBoundary(evidence) {
  assertSafeProviderBoundary(evidence);
  assertSafeCapabilityLists(evidence);
}

export function assertQualificationEvidence(evidence, { mode, candidateCommit, notBefore }) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("evidence must be an object");
  }
  const live = mode === "live";
  if (!live && mode !== "safe") fail(`unsupported mode ${String(mode)}`);
  const expectedProofId = live ? LIVE_PROOF_ID : SAFE_PROOF_ID;
  const expectedOutcome = live ? LIVE_OUTCOME : SAFE_OUTCOME;
  const expectedResults = live ? LIVE_RESULT_KEYS : SAFE_RESULT_KEYS;
  if (evidence.schemaVersion !== 1
      || evidence.proofId !== expectedProofId
      || evidence.outcome !== expectedOutcome
      || evidence.candidate?.commit !== candidateCommit
      || evidence.candidate?.clean !== true) {
    fail(`${mode} identity, candidate, or outcome does not match ${candidateCommit}`);
  }
  assertFreshness(evidence, notBefore);
  assertExactResults(evidence.results, expectedResults, mode);
  assertCleanup(evidence);
  assertSafeBoundary(evidence);
  const expectedFixtureBoundary = live ? LIVE_FIXTURE_BOUNDARY : SAFE_FIXTURE_BOUNDARY;
  if (evidence.configuration.fixtureBoundary !== expectedFixtureBoundary) {
    fail(`${mode} fixture boundary is missing or unexpected`);
  }
  if (live) {
    if (evidence.liveN1?.stopBoundary !== LIVE_STOP_BOUNDARY || evidence.liveN1?.reviewerRunCount !== 0) {
      fail("live ready_for_review/N2 stop boundary proof is missing");
    }
    assertLiveSettlement(evidence);
  }
  return evidence;
}
