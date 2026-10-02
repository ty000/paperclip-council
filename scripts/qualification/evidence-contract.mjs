import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const SAFE_PROOF_ID = "paperclip-council-n2-synthetic-integration-v1";
const LIVE_PROOF_ID = "paperclip-council-n1-observable-native-qualification-v1";
const N2_LIVE_PROOF_ID = "paperclip-council-n2-observable-native-qualification-v1";
const N2_PREREQUISITE_PROOF_ID = "paperclip-council-n2-native-stage-prerequisite-v1";
const N2_ISOLATED_LIVE_PROOF_ID = "paperclip-council-n2-isolated-observable-native-qualification-v1";

const SAFE_OUTCOME = "N2 SYNTHETIC INTEGRATION VALIDATED";
const LIVE_OUTCOME = "N1 OBSERVABLE RESULT VALIDATED";
const N2_LIVE_OUTCOME = "N2 OBSERVABLE RESULT VALIDATED";
const N2_PREREQUISITE_OUTCOME = "N2 native-stage prerequisite validated";
const N2_ISOLATED_LIVE_OUTCOME = "N2 ISOLATED OBSERVABLE RESULT VALIDATED";

const APP_CLEANUP = "stopped only the plugin worker, listener, and application created by this run";
const DATABASE_CLEANUP = "fresh isolated PostgreSQL cluster removed; parent-owned temporary instance retained";
const SAFE_FIXTURE_BOUNDARY = "agents, issues, policies, and heartbeat runs are synthetic test preparation";
const LIVE_FIXTURE_BOUNDARY = "The safe-boundary suite uses fixtures; the N1 live campaign below uses native APIs, native wakeups, exact Paperclip run IDs, and run-derived terminal token settlement.";
const N2_ISOLATED_FIXTURE_BOUNDARY = "The safe-boundary suite uses fixtures; isolated N2 terminalizes three deterministic heartbeat fixture rows and clears their exact issue locks after building N1 through public APIs without agent execution, then permits only reviewer-correction-reviewer native runs.";
const SAFE_PROVIDER_BOUNDARY = "none; dispatch was deliberately not invoked because it requests native wakeup";
const LIVE_STOP_BOUNDARY = "ready_for_review; N2 not started";
const EXPECTED_HOST_COMMIT = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
const NATIVE_USAGE_SOURCE = "paperclip:issues.summaries.getOrchestration:terminal-token-ledger";
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  "n2SyntheticUuidAdmission",
  "n2SyntheticPreparedOperatorTransition",
  "n2SyntheticUnauthorizedIdentityRefused",
  "n2SyntheticChangedV2Verified",
  "n2SyntheticFreshReviewAccepted",
  "n2SyntheticUsageSettled",
  "n2SyntheticPersistedReadback",
]);

export const LIVE_RESULT_KEYS = Object.freeze([
  ...SAFE_RESULT_KEYS,
  "n1NativeLeadAndTwoContributors",
  "n1IntegrationFailureBlocked",
  "n1VerifiedCandidateReadyForReview",
  "n1NativeG4UsageSettled",
  "n1LeadSingleRunBarrier",
  "n1InstalledBrowserObservableState",
]);

export const N2_LIVE_RESULT_KEYS = Object.freeze([
  ...SAFE_RESULT_KEYS,
  "n1NativeLeadAndTwoContributors",
  "n1IntegrationFailureBlocked",
  "n1VerifiedCandidateReadyForReview",
  "n1NativeG4UsageSettled",
  "n1LeadSingleRunBarrier",
  "n2InitialIndependentReview",
  "n2ChangesRequestedApplied",
  "n2CorrectionRunSettled",
  "n2ChangedV2Verified",
  "n2FreshFinalReviewAccepted",
  "n2AllSixRunsSettled",
  "n2RestartReadback",
  "n2InstalledBrowserObservableState",
]);

export const N2_PREREQUISITE_RESULT_KEYS = Object.freeze([
  "installation",
  "n2PrerequisitePublicMission",
  "n2PrerequisiteDistinctContributions",
  "n2PrerequisiteVerifiedCandidate",
  "n2PrerequisiteN1ReservationsSettled",
  "n2PrerequisiteZeroExposure",
  "n2PrerequisiteZeroProviderOrNativeRuns",
  "n2PrerequisiteStopsBeforeReviewer",
  "n2PrerequisiteFixtureLifecycleFinished",
  "n2PrerequisiteHandoffCommandsConsumable",
]);

const N2_ISOLATED_LIVE_RESULT_KEYS = Object.freeze([
  ...SAFE_RESULT_KEYS,
  ...N2_PREREQUISITE_RESULT_KEYS.filter((key) => !SAFE_RESULT_KEYS.includes(key)),
  "n2InitialIndependentReview",
  "n2ChangesRequestedApplied",
  "n2CorrectionRunSettled",
  "n2ChangedV2Verified",
  "n2FreshFinalReviewAccepted",
  "n2AllThreeRunsSettled",
  "n2RestartReadback",
  "n2InstalledBrowserObservableState",
]);

function fail(message) {
  throw new Error(`Qualification evidence contract failed: ${message}`);
}

function identityOf(status) {
  return { dev: status.dev.toString(), ino: status.ino.toString() };
}

function sameIdentity(status, identity) {
  return status.dev.toString() === identity.dev && status.ino.toString() === identity.ino;
}

function claimedIdentity(fd, kind) {
  const status = fstatSync(fd, { bigint: true });
  if (!status.isFile()) fail(`live ${kind} claim must remain a regular file`);
  return identityOf(status);
}

function assertClaimedPath(path, fd, identity, kind) {
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail(`live ${kind} claim path was removed: ${path}`);
    throw error;
  }
  const openClaim = fstatSync(fd, { bigint: true });
  if (!current.isFile() || !openClaim.isFile()
      || !sameIdentity(current, identity) || !sameIdentity(openClaim, identity)) {
    fail(`live ${kind} claim identity changed; refusing pathname access ${path}`);
  }
  return openClaim;
}

function claimCreateOnly(path, kind) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return openSync(path, "wx+", 0o600);
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
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const openClaim = fstatSync(fd, { bigint: true });
  if (!current.isFile()
      || !openClaim.isFile()
      || !sameIdentity(current, identity)
      || !sameIdentity(openClaim, identity)
      || current.size !== 0n
      || openClaim.size !== 0n) {
    return;
  }
  unlinkSync(path);
}

function closeClaimDescriptors(evidenceFd, screenshotFd) {
  try {
    if (screenshotFd !== undefined) closeSync(screenshotFd);
  } finally {
    if (evidenceFd !== undefined) closeSync(evidenceFd);
  }
}

function releaseClaimLock(claimLockPath, claimLockIdentity) {
  let current;
  try {
    current = lstatSync(claimLockPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail(`live artifact pair claim lock was removed: ${claimLockPath}`);
    throw error;
  }
  if (!current.isDirectory() || !sameIdentity(current, claimLockIdentity)) {
    fail(`live artifact pair claim lock identity changed; refusing cleanup ${claimLockPath}`);
  }
  rmdirSync(claimLockPath);
}

function readOpenClaim(fd, status) {
  if (status.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("live evidence exceeds the readable size limit");
  const buffer = Buffer.alloc(Number(status.size));
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (read === 0) fail("live evidence claim ended before its recorded size");
    offset += read;
  }
  return buffer.toString("utf8");
}

function readOpenClaimBytes(fd, status, kind) {
  if (status.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`live ${kind} exceeds the readable size limit`);
  const buffer = Buffer.alloc(Number(status.size));
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (read === 0) fail(`live ${kind} claim ended before its recorded size`);
    offset += read;
  }
  return buffer;
}

function assertSerializedIdentity(identity, kind) {
  if (!identity || typeof identity !== "object"
      || !/^[0-9]+$/.test(identity.dev) || !/^[0-9]+$/.test(identity.ino)) {
    fail(`live ${kind} claim identity is missing or malformed`);
  }
}

export function writeClaimedArtifact(path, identity, content, kind = "artifact") {
  assertSerializedIdentity(identity, kind);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail(`live ${kind} claim could not be opened safely: ${error?.message ?? String(error)}`);
  }
  try {
    assertClaimedPath(path, fd, identity, kind);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    fsyncSync(fd);
    assertClaimedPath(path, fd, identity, kind);
  } finally {
    closeSync(fd);
  }
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

function claimLiveEvidencePathsInternal(
  repositoryRoot,
  candidateCommit,
  configuredPath,
  beforeScreenshotClaim,
  { prefix = "n1-live", screenshotSuffix = "ready-for-review" } = {},
) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) {
    fail("candidate commit must be an exact lowercase 40-character Git SHA");
  }
  const evidencePath = resolve(
    repositoryRoot,
    configuredPath ?? `artifacts/${prefix}-${candidateCommit}.json`,
  );
  if (extname(evidencePath) !== ".json" || !basename(evidencePath).includes(candidateCommit)) {
    fail(`live evidence filename must be JSON and contain candidate commit ${candidateCommit}`);
  }
  const screenshotPath = resolve(
    dirname(evidencePath),
    `${basename(evidencePath, ".json")}-${screenshotSuffix}.png`,
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
  const claimLockIdentity = identityOf(lstatSync(claimLockPath, { bigint: true }));
  let evidenceFd;
  let screenshotFd;
  try {
    requireUnclaimed(evidencePath, "evidence");
    requireUnclaimed(screenshotPath, "screenshot");
    evidenceFd = claimCreateOnly(evidencePath, "evidence");
    const evidenceIdentity = claimedIdentity(evidenceFd, "evidence");
    try {
      beforeScreenshotClaim?.({ evidencePath, screenshotPath });
      screenshotFd = claimCreateOnly(screenshotPath, "screenshot");
    } catch (error) {
      rollbackEmptyClaim(evidencePath, evidenceFd, evidenceIdentity);
      throw error;
    }
    const screenshotIdentity = claimedIdentity(screenshotFd, "screenshot");
    let released = false;
    return {
      evidencePath,
      screenshotPath,
      evidenceIdentity,
      screenshotIdentity,
      readEvidence() {
        if (released) fail("live artifact pair claim was already released");
        const evidenceStatus = assertClaimedPath(evidencePath, evidenceFd, evidenceIdentity, "evidence");
        const screenshotStatus = assertClaimedPath(screenshotPath, screenshotFd, screenshotIdentity, "screenshot");
        if (evidenceStatus.size === 0n || screenshotStatus.size === 0n) {
          fail("live evidence and screenshot claims must both be populated before validation");
        }
        const serialized = readOpenClaim(evidenceFd, evidenceStatus);
        assertClaimedPath(evidencePath, evidenceFd, evidenceIdentity, "evidence");
        assertClaimedPath(screenshotPath, screenshotFd, screenshotIdentity, "screenshot");
        return serialized;
      },
      readScreenshot() {
        if (released) fail("live artifact pair claim was already released");
        const screenshotStatus = assertClaimedPath(screenshotPath, screenshotFd, screenshotIdentity, "screenshot");
        if (screenshotStatus.size === 0n) fail("live screenshot claim must be populated before validation");
        const screenshot = readOpenClaimBytes(screenshotFd, screenshotStatus, "screenshot");
        assertClaimedPath(screenshotPath, screenshotFd, screenshotIdentity, "screenshot");
        return screenshot;
      },
      release({ validate = false } = {}) {
        if (released) return;
        released = true;
        let validationError;
        try {
          if (validate) {
            assertClaimedPath(evidencePath, evidenceFd, evidenceIdentity, "evidence");
            assertClaimedPath(screenshotPath, screenshotFd, screenshotIdentity, "screenshot");
          }
        } catch (error) {
          validationError = error;
        } finally {
          try {
            closeClaimDescriptors(evidenceFd, screenshotFd);
          } finally {
            releaseClaimLock(claimLockPath, claimLockIdentity);
          }
        }
        if (validationError) throw validationError;
      },
    };
  } catch (error) {
    try {
      closeClaimDescriptors(evidenceFd, screenshotFd);
    } finally {
      releaseClaimLock(claimLockPath, claimLockIdentity);
    }
    throw error;
  }
}

export function claimLiveEvidencePaths(repositoryRoot, candidateCommit, configuredPath) {
  return claimLiveEvidencePathsInternal(repositoryRoot, candidateCommit, configuredPath, undefined);
}

export function claimN2LiveEvidencePaths(repositoryRoot, candidateCommit, configuredPath) {
  return claimLiveEvidencePathsInternal(
    repositoryRoot,
    candidateCommit,
    configuredPath,
    undefined,
    { prefix: "n2-live", screenshotSuffix: "accepted" },
  );
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

function nonemptyString(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function requireProof(condition, message) {
  if (!condition) fail(message);
}

function distinctStrings(values) {
  return values.every(nonemptyString) && new Set(values).size === values.length;
}

function sameStringSet(left, right) {
  return left.length === right.length && distinctStrings(left) && left.every((value) => right.includes(value));
}

function assertObservedModel(item, authorized) {
  requireProof(nonemptyString(item?.agentId), "observed model agent identity is missing");
  requireProof(item?.adapterType === "codex_local", "observed model adapter is not codex_local");
  requireProof(item?.model === authorized.model, "observed model differs from the authorized model");
  requireProof(item?.effort === authorized.effort, "observed effort differs from the authorized effort");
}

function assertLiveHostAndModels(evidence, includeReviewer = false) {
  const models = evidence.configuration?.models;
  const observed = models?.observedAgentConfiguration;
  const agents = evidence.liveN1?.agents;
  const expectedAgentIds = [agents?.lead, ...(agents?.contributors ?? []), ...(includeReviewer ? [agents?.reviewer] : [])];
  requireProof(evidence.head === EXPECTED_HOST_COMMIT, "live host commit is not the pinned candidate");
  requireProof(evidence.hostTrackedFilesClean === true, "live host tracked files were not clean");
  requireProof(models?.authorized?.model === "gpt-5.6-sol", "authorized live model is missing or unexpected");
  requireProof(models?.authorized?.effort === "high", "authorized live effort is missing or unexpected");
  requireProof(Array.isArray(observed) && observed.length === expectedAgentIds.length,
    `${expectedAgentIds.length} observed model settings are required`);
  requireProof(sameStringSet(observed.map((item) => item?.agentId), expectedAgentIds),
    "observed model settings must identify the exact campaign agents");
  observed.forEach((item) => assertObservedModel(item, models.authorized));
}

function assertLiveRun(run, expectedAgentIds) {
  requireProof(nonemptyString(run?.id), "native run identity is missing");
  requireProof(expectedAgentIds.includes(run?.agentId), "native run actor is not an expected N1 agent");
  requireProof(run?.status === "succeeded", "native run did not succeed");
  requireProof(nonemptyString(run?.finishedAt), "native run terminal timestamp is missing");
}

const LIVE_USAGE_COUNTERS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "rawInputTokens",
  "rawCachedInputTokens",
  "rawOutputTokens",
];

function assertLiveUsageAccounting(live) {
  requireProof(live?.usageAccounting?.profile === "codex_local/cli",
    "live usage accounting profile must be codex_local/cli");
  requireProof(live?.usageAccounting?.formula === "inputTokens + outputTokens",
    "live usage accounting formula must be inputTokens + outputTokens");
}

function assertLiveRunUsage(run) {
  const usage = run?.usageJson;
  requireProof(usage && typeof usage === "object" && !Array.isArray(usage),
    "native run usageJson is missing");
  for (const counter of LIVE_USAGE_COUNTERS) {
    requireProof(Number.isSafeInteger(usage[counter]) && usage[counter] >= 0,
      `native run usageJson.${counter} must be a nonnegative safe integer`);
  }
  requireProof(usage.cachedInputTokens <= usage.inputTokens,
    "native run cachedInputTokens exceeds inputTokens");
  requireProof(usage.rawCachedInputTokens <= usage.rawInputTokens,
    "native run rawCachedInputTokens exceeds rawInputTokens");
  requireProof(usage.rawInputTokens === usage.inputTokens
    && usage.rawCachedInputTokens === usage.cachedInputTokens
    && usage.rawOutputTokens === usage.outputTokens,
  "native run raw usage counters do not match normalized per_run counters");
  const allowedKeys = new Set([...LIVE_USAGE_COUNTERS, "usageSource"]);
  requireProof(Object.keys(usage).every((key) => allowedKeys.has(key)),
    "native run usageJson contains non-accounting provider metadata");
  requireProof(usage.usageSource === "per_run",
    "native run usageSource must be per_run for the pinned codex_local/cli profile");
}

function assertRecordedContribution(slot, contributorIds, runById) {
  requireProof(nonemptyString(slot?.contributionId), "contribution identity is missing");
  requireProof(contributorIds.includes(slot?.assigneeAgentId), "contribution assignee is not an expected contributor");
  requireProof(runById.get(slot?.dispatchRunId)?.agentId === slot?.assigneeAgentId,
    "contribution dispatch run is not attributed to its assignee");
  requireProof(COMMIT.test(slot?.commit), "contribution commit is missing or malformed");
  requireProof(Array.isArray(slot?.ownedPaths) && slot.ownedPaths.length > 0,
    "contribution owned paths are missing");
}

function assertLiveIdentities(live) {
  requireProof(nonemptyString(live?.companyId), "live company identity is missing");
  requireProof(nonemptyString(live?.missionId), "live mission identity is missing");
  requireProof(nonemptyString(live?.rootIssueId), "live root issue identity is missing");
  requireProof(COMMIT.test(live?.baseCommit), "live repository base commit is missing or malformed");
}

function assertLiveRunSet(live, runs, expectedAgentIds) {
  requireProof(distinctStrings(expectedAgentIds), "lead and contributor identities must be distinct");
  requireProof(Array.isArray(runs) && runs.length === 3, "exactly three native runs are required");
  runs.forEach((run) => {
    assertLiveRun(run, expectedAgentIds);
    assertLiveRunUsage(run);
  });
  requireProof(sameStringSet(runs.map((run) => run.agentId), expectedAgentIds),
    "native runs must belong to the exact lead and two contributors");
  requireProof(distinctStrings(runs.map((run) => run.id)), "native run identities must be distinct");
}

function isCanonicalPricingField(field) {
  if (field === "monetary-cost=unpriced") return true;
  const prefix = "priced-cost-cents=";
  if (typeof field !== "string" || !field.startsWith(prefix)) return false;
  const rawCents = field.slice(prefix.length);
  const cents = Number(rawCents);
  return Number.isFinite(cents) && cents > 0 && String(cents) === rawCents;
}

function parseReservationSource(source) {
  if (!nonemptyString(source)) return null;
  const fields = source.split(";");
  if (fields.length !== 4 || fields[0] !== NATIVE_USAGE_SOURCE || !isCanonicalPricingField(fields[3])) return null;
  const runPrefix = "run=";
  const baselinePrefix = "issue-baseline=";
  if (!fields[1].startsWith(runPrefix) || !fields[2].startsWith(baselinePrefix)) return null;
  return {
    runId: fields[1].slice(runPrefix.length),
    baseline: fields[2].slice(baselinePrefix.length),
  };
}

function assertReservationSource(source, runId, baseline) {
  const parsed = parseReservationSource(source);
  requireProof(parsed?.runId === runId && parsed?.baseline === String(baseline),
  "reservation usage source must identify the exact native run and usage baseline");
}

function assertRunReservation(live, reservationById, input) {
  requireProof(nonemptyString(input.reservationId), `${input.label} reservation identity is missing`);
  requireProof(Number.isSafeInteger(input.baseline) && input.baseline >= 0,
    `${input.label} usage baseline is missing or invalid`);
  requireProof(input.run && typeof input.run === "object" && !Array.isArray(input.run),
    `${input.label} native run is missing from live evidence`);
  const reservation = reservationById.get(input.reservationId);
  requireProof(Boolean(reservation), `${input.label} reservation is missing from live admission`);
  requireProof(reservation.missionId === live.missionId,
    `${input.label} reservation mission identity does not match`);
  requireProof(input.effectId === undefined
      ? nonemptyString(reservation.effectId)
      : reservation.effectId === input.effectId,
  `${input.label} reservation effect identity does not match`);
  const usage = input.run.usageJson;
  const expectedUnits = usage.inputTokens + usage.outputTokens;
  requireProof(Number.isSafeInteger(expectedUnits) && expectedUnits > 0,
    `${input.label} native run usage delta must be positive`);
  requireProof(reservation.usage?.units === expectedUnits,
    `${input.label} reservation usage does not equal per-run inputTokens + outputTokens`);
  assertReservationSource(reservation.usage?.source, input.run.id, input.baseline);
}

function activationEffectId(live, aggregate) {
  const activationReceipts = Array.isArray(aggregate?.commandReceipts)
    ? aggregate.commandReceipts.filter((receipt) => receipt?.command === "activate")
    : [];
  requireProof(activationReceipts.length === 1,
    "live mission must contain exactly one applied activation command receipt");
  const activationReceipt = activationReceipts[0];
  requireProof(UUID.test(activationReceipt?.commandId)
      && Number.isSafeInteger(activationReceipt?.appliedVersion)
      && activationReceipt.appliedVersion > 0
      && activationReceipt?.result?.missionId === live.missionId
      && activationReceipt?.result?.version === activationReceipt.appliedVersion,
  "live activation command receipt is malformed or not bound to the mission");
  return activationReceipt.commandId;
}

function assertLiveRunReservations(evidence) {
  const live = evidence.liveN1;
  const aggregate = live?.mission?.mission?.aggregate;
  const state = aggregate?.n1;
  const runs = live?.runs;
  const reservations = liveReservations(evidence).reservations;
  const reservationById = new Map(reservations.map((reservation) => [reservation?.reservationId, reservation]));
  requireProof(reservationById.size === reservations.length,
    "live reservation identities must be distinct");
  const runById = new Map(runs.map((run) => [run.id, run]));
  assertRunReservation(live, reservationById, {
    label: "lead",
    reservationId: state?.activationReservationId,
    baseline: state?.rootUsageBaselineUnits,
    run: runById.get(state?.rootDispatchRunId),
    effectId: activationEffectId(live, aggregate),
  });
  for (const slot of state.contributions) {
    assertRunReservation(live, reservationById, {
      label: `contribution ${slot.contributionId}`,
      reservationId: slot.dispatchReservationId,
      baseline: slot.dispatchUsageBaselineUnits,
      run: runById.get(slot.dispatchRunId),
      effectId: slot.contributionId,
    });
  }
}

function assertLiveContributionSet(live, state, contributions, runs) {
  const runById = new Map(runs.map((run) => [run.id, run]));
  requireProof(Array.isArray(contributions) && contributions.length === 2, "exactly two contributions are required");
  contributions.forEach((slot) => assertRecordedContribution(slot, live.agents.contributors, runById));
  requireProof(distinctStrings(contributions.map((slot) => slot.contributionId)), "contribution identities must be distinct");
  requireProof(distinctStrings(contributions.map((slot) => slot.dispatchRunId)), "contribution runs must be distinct");
  requireProof(distinctStrings(contributions.map((slot) => slot.commit)), "contribution commits must be distinct");
  requireProof(runById.get(state?.rootDispatchRunId)?.agentId === live.agents.lead,
    "root dispatch run is not attributed to the Integration Lead");
}

function assertLeadSingleRunBarrier(live, state) {
  const leadBarrier = live?.leadRunBarrier;
  requireProof(leadBarrier?.expectedRunId === state?.rootDispatchRunId,
    "lead single-run barrier is not bound to the root dispatch run");
  requireProof(leadBarrier?.wakeOnDemand === false,
    "lead wake-on-demand barrier was not observed disabled");
  requireProof(Array.isArray(leadBarrier?.observedRunIds)
      && leadBarrier.observedRunIds.length === 1
      && leadBarrier.observedRunIds[0] === state?.rootDispatchRunId,
    "lead run readback must contain exactly the expected root dispatch run");
}

function assertLiveRunsAndContributions(evidence) {
  const live = evidence.liveN1;
  const runs = live?.runs;
  const state = live?.mission?.mission?.aggregate?.n1;
  const contributions = state?.contributions;
  const expectedAgentIds = [live?.agents?.lead, ...(live?.agents?.contributors ?? [])];
  assertLiveIdentities(live);
  assertLiveUsageAccounting(live);
  assertLiveRunSet(live, runs, expectedAgentIds);
  assertLiveContributionSet(live, state, contributions, runs);
  assertLeadSingleRunBarrier(live, state);
  assertLiveRunReservations(evidence);
}

function sameContribution(left, right) {
  return left?.contributionId === right?.contributionId
    && left?.commit === right?.commit
    && JSON.stringify(left?.ownedPaths) === JSON.stringify(right?.ownedPaths);
}

function assertVerifiedContributions(recorded, verified) {
  requireProof(Array.isArray(verified) && verified.length === 2, "verified candidate must contain two contributions");
  requireProof(recorded.every((slot) => verified.some((item) => sameContribution(slot, item))),
    "verified candidate contributions do not match the recorded contribution ID, commit, and owned paths");
}

function assertCandidateCheck(check) {
  requireProof(nonemptyString(check?.name), "candidate check name is missing");
  requireProof(check?.status === "passed", "candidate check did not pass");
  requireProof(nonemptyString(check?.detail), "candidate check detail is missing");
}

function assertCandidateIdentity(live, aggregate, verified, candidate) {
  requireProof(aggregate?.phase === "ready_for_review", "live mission is not ready_for_review");
  requireProof(aggregate?.control?.status === "inactive", "live mission control did not stop");
  requireProof(verified?.outcome === "verified", "integrated candidate is not verified");
  requireProof(verified?.publicationEligible === true, "integrated candidate is not publication eligible");
  requireProof(candidate?.baseCommit === live?.baseCommit, "candidate base does not match the live repository base");
  requireProof(COMMIT.test(candidate?.candidateCommit), "candidate commit is missing or malformed");
  requireProof(DIGEST.test(candidate?.sha256), "candidate bundle digest is missing or malformed");
  requireProof(nonemptyString(candidate?.attachmentId), "candidate attachment identity is missing");
}

function assertCandidateChecksAndFailure(aggregate, verified) {
  assertVerifiedContributions(aggregate?.n1?.contributions, verified?.contributions);
  requireProof(Array.isArray(verified?.checks) && verified.checks.length > 0, "candidate checks are missing");
  verified.checks.forEach(assertCandidateCheck);
  requireProof(Array.isArray(aggregate?.journal), "mission journal is missing");
  requireProof(aggregate.journal.some((entry) => entry?.action === "integration_check_failed"),
    "failed integration refusal is not recorded in the mission journal");
}

function assertLiveCandidate(evidence) {
  const live = evidence.liveN1;
  const aggregate = live?.mission?.mission?.aggregate;
  const verified = aggregate?.n1?.candidate;
  const candidate = verified?.candidate;
  assertCandidateIdentity(live, aggregate, verified, candidate);
  assertCandidateChecksAndFailure(aggregate, verified);
}

function assertObservedParticipant(participant, recorded) {
  const match = recorded.find((slot) => slot?.contributionId === participant?.contributionId);
  requireProof(Boolean(match), "rendered participant is not a recorded contribution");
  requireProof(participant?.assigneeAgentId === match.assigneeAgentId, "rendered participant assignee does not match");
  requireProof(participant?.dispatchRunId === match.dispatchRunId, "rendered participant run does not match");
  requireProof(participant?.commit === match.commit, "rendered participant commit does not match");
  requireProof(JSON.stringify(participant?.ownedPaths) === JSON.stringify(match.ownedPaths),
    "rendered participant owned paths do not match");
}

function assertScreenshotClaim(ui, live, candidateCommit, screenshotPath, screenshotBytes) {
  requireProof(nonemptyString(screenshotPath), "live screenshot path is missing");
  requireProof(ui?.screenshot === screenshotPath, "live UI evidence does not identify the claimed screenshot");
  requireProof(screenshotPath.endsWith(".png"), "live screenshot claim is not a PNG path");
  requireProof(screenshotPath.includes(candidateCommit), "live screenshot path is not commit-qualified");
  requireProof(ui?.missionId === live?.missionId, "live UI mission identity does not match");
  requireProof(ui?.rootIssueId === live?.rootIssueId, "live UI root issue identity does not match");
  requireProof(Buffer.isBuffer(screenshotBytes), "live screenshot bytes are missing");
  requireProof(screenshotBytes.length > PNG_SIGNATURE.length, "live screenshot PNG is empty");
  requireProof(screenshotBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    "live screenshot claim does not contain a PNG signature");
}

function assertUiMissionBinding(observed, recorded) {
  requireProof(Array.isArray(observed?.participants) && observed.participants.length === 2,
    "live UI must expose exactly two participants");
  requireProof(Array.isArray(recorded) && recorded.length === 2,
    "live mission must retain exactly two recorded contributions for UI binding");
  requireProof(sameStringSet(
    observed.participants.map((participant) => participant?.contributionId),
    recorded.map((slot) => slot?.contributionId),
  ), "live UI participant IDs must exactly cover the two recorded contributions");
  observed.participants.forEach((participant) => assertObservedParticipant(participant, recorded));
  requireProof(nonemptyString(observed?.nextAction), "live UI next action is missing");
  requireProof(observed?.candidate?.outcome === "verified", "live UI candidate is not verified");
}

function assertLiveUiProof(evidence, candidateCommit, screenshotPath, screenshotBytes) {
  const live = evidence.liveN1;
  const ui = live?.ui;
  const observed = live?.mission?.n1;
  const recorded = live?.mission?.mission?.aggregate?.n1?.contributions;
  assertScreenshotClaim(ui, live, candidateCommit, screenshotPath, screenshotBytes);
  assertUiMissionBinding(observed, recorded);
}

function assertLiveNativeProof(evidence, candidateCommit, screenshotPath, screenshotBytes) {
  assertLiveHostAndModels(evidence);
  assertLiveRunsAndContributions(evidence);
  assertLiveCandidate(evidence);
  assertLiveUiProof(evidence, candidateCommit, screenshotPath, screenshotBytes);
}

function assertN2Settlement(evidence) {
  const admission = evidence.liveN2?.admission?.envelope;
  const reservations = admission?.reservations;
  requireProof(Array.isArray(reservations) && reservations.length === 6,
    "N2 admission must contain exactly six reservations");
  reservations.forEach(assertSettledReservation);
  assertKnownUsageTotal(admission, reservations);
}

function n2CampaignAgentIds(evidence) {
  if (evidence.liveN1) {
    return { lead: evidence.liveN1.agents?.lead, reviewer: evidence.liveN1.agents?.reviewer };
  }
  return {
    lead: evidence.n2Prerequisite?.agents?.lead?.id,
    reviewer: evidence.n2Prerequisite?.agents?.reviewer?.id,
  };
}

// This gate intentionally keeps the complete six-reservation invariant visible in one place.
// fallow-ignore-next-line complexity
function assertN2IsolatedSettlement(evidence) {
  const admission = evidence.liveN2?.admission?.envelope;
  const reservations = admission?.reservations;
  const prerequisiteState = evidence.n2Prerequisite?.mission?.mission?.aggregate?.n1;
  const prerequisiteReservationIds = new Set([
    prerequisiteState?.activationReservationId,
    ...(prerequisiteState?.contributions ?? []).map((slot) => slot?.dispatchReservationId),
  ]);
  requireProof(Array.isArray(reservations) && reservations.length === 6,
    "isolated N2 admission must contain three prerequisite and three native reservations");
  requireProof(prerequisiteReservationIds.size === 3 && !prerequisiteReservationIds.has(undefined),
    "isolated N2 prerequisite reservation identities are incomplete");
  for (const reservation of reservations) {
    if (prerequisiteReservationIds.has(reservation?.reservationId)) {
      requireProof(reservation?.status === "settled"
          && reservation?.usage?.status === "known" && reservation.usage.units === 0
          && reservation?.remainingExposure?.status === "known" && reservation.remainingExposure.units === 0,
      "isolated N1 prerequisite reservations must remain settled at zero usage and exposure");
    } else {
      assertSettledReservation(reservation);
    }
  }
  assertKnownUsageTotal(admission, reservations);
}

function assertN2RunSet(evidence) {
  const liveN2 = evidence.liveN2;
  const runs = liveN2?.runs;
  const agents = n2CampaignAgentIds(evidence);
  const expectedAgentIds = [agents.reviewer, agents.lead, agents.reviewer];
  requireProof(Array.isArray(runs) && runs.length === 3, "N2 must record reviewer, correction, and reviewer runs");
  runs.forEach((run, index) => {
    assertLiveRun(run, [expectedAgentIds[index]]);
    assertLiveRunUsage(run);
  });
  requireProof(distinctStrings(runs.map((run) => run.id)), "N2 native run identities must be distinct");
  const allNativeRuns = [...(evidence.liveN1?.runs ?? []), ...runs];
  requireProof(distinctStrings(allNativeRuns.map((run) => run.id)),
    "all native run identities must be distinct");
}

function assertN2State(evidence) {
  const liveN2 = evidence.liveN2;
  const inspection = liveN2?.mission;
  const state = inspection?.mission?.aggregate?.n2;
  const agents = n2CampaignAgentIds(evidence);
  requireProof(inspection?.mission?.aggregate?.phase === "accepted", "N2 mission phase is not accepted");
  requireProof(inspection?.mission?.aggregate?.control?.status === "inactive", "accepted N2 mission control did not stop");
  requireProof(state?.status === "accepted" && state?.correctionLimit === 1 && state?.correctionsUsed === 1,
    "N2 accepted state or correction bound is missing");
  requireProof(Array.isArray(state?.submissions) && state.submissions.length === 2,
    "N2 must retain exactly two immutable submissions");
  const [v1, v2] = state.submissions;
  requireProof(v1?.ordinal === 1 && v2?.ordinal === 2 && v2?.predecessorSubmissionId === v1?.submissionId,
    "N2 V2 is not linked to V1");
  requireProof(COMMIT.test(v1?.candidateCommit) && COMMIT.test(v2?.candidateCommit)
      && v1.candidateCommit !== v2.candidateCommit,
  "N2 V1 and V2 commit identities are missing or unchanged");
  requireProof(DIGEST.test(v1?.sha256) && DIGEST.test(v2?.sha256) && v1.sha256 !== v2.sha256,
    "N2 V1 and V2 bundle digests are missing or unchanged");
  requireProof(v1?.baseCommit === v2?.baseCommit && v1?.mandateHash === v2?.mandateHash,
    "N2 correction changed the base or mandate subject");
  requireProof(Array.isArray(state?.rounds) && state.rounds.length === 2,
    "N2 must retain exactly two review rounds");
  const [round1, round2] = state.rounds;
  requireProof(round1?.round === 1 && round1?.submissionId === v1.submissionId
      && round1?.verdict?.verdict === "changes_requested",
  "N2 initial review verdict is not changes_requested on V1");
  requireProof(round2?.round === 2 && round2?.submissionId === v2.submissionId
      && round2?.verdict?.verdict === "approved",
  "N2 final review verdict is not approved on V2");
  for (const round of state.rounds) {
    requireProof(round.reviewerAgentId === agents.reviewer
        && round.handoff?.state === "confirmed"
        && round.handoff?.reviewerRunId === round.verdict?.runId
        && round.handoff?.usageSettledAt,
    "N2 review round is not bound to the independent reviewer run and terminal settlement");
  }
  requireProof(state?.correction?.executorAgentId === agents.lead
      && state?.correction?.runId === liveN2?.runs?.[1]?.id
      && state?.correction?.usageSettledAt
      && JSON.stringify(state?.correction?.correctedPaths) === JSON.stringify(["alpha.txt"]),
  "N2 correction is not bound to the lead run, settlement, and attributed path");
  requireProof(state?.application?.state === "observed"
      && state?.application?.submissionId === v2.submissionId
      && state?.application?.receiptState === "native_observed",
  "N2 final native acceptance was not observed for V2");
  requireProof(inspection?.n2?.usage?.complete === true, "N2 usage inspection is not complete");
}

function assertN2Reservations(evidence) {
  const live = evidence.liveN2;
  const state = live?.mission?.mission?.aggregate?.n2;
  const reservations = live?.admission?.envelope?.reservations ?? [];
  const reservationById = new Map(reservations.map((reservation) => [reservation?.reservationId, reservation]));
  const runById = new Map((live?.runs ?? []).map((run) => [run.id, run]));
  for (const round of state?.rounds ?? []) {
    assertRunReservation({ missionId: live.missionId }, reservationById, {
      label: `N2 review round ${round.round}`,
      reservationId: round.handoff?.reservationId,
      baseline: round.handoff?.baselineTokenTotal,
      run: runById.get(round.handoff?.reviewerRunId),
      effectId: round.submissionId,
    });
  }
  assertRunReservation({ missionId: live.missionId }, reservationById, {
    label: "N2 correction",
    reservationId: state?.correction?.reservationId,
    baseline: state?.correction?.baselineTokenTotal,
    run: runById.get(state?.correction?.runId),
    effectId: state?.correction?.requestedByOperationId,
  });
}

function assertN2Receipts(evidence) {
  const receipts = evidence.liveN2?.decisionReceipts;
  const state = evidence.liveN2?.mission?.mission?.aggregate?.n2;
  const agents = n2CampaignAgentIds(evidence);
  requireProof(Array.isArray(receipts) && receipts.length === 2,
    "N2 must retain exactly two decision receipts");
  requireProof(receipts[0]?.verdict === "changes_requested" && receipts[1]?.verdict === "approved",
    "N2 decision receipt sequence is unexpected");
  receipts.forEach((receipt, index) => requireProof(
    receipt?.state === "native_observed"
      && receipt?.actorAgentId === agents.reviewer
      && receipt?.runId === state?.rounds?.[index]?.handoff?.reviewerRunId
      && receipt?.operationId === state?.rounds?.[index]?.verdict?.operationId,
    "N2 decision receipt is not bound to its reviewer run and verdict",
  ));
}

function assertN2RestartAndUi(evidence, candidateCommit, screenshotPath, screenshotBytes) {
  const live = evidence.liveN2;
  requireProof(JSON.stringify(live?.restartReadback?.mission?.aggregate?.n2)
      === JSON.stringify(live?.mission?.mission?.aggregate?.n2),
  "N2 restart readback does not preserve the accepted aggregate");
  requireProof(live?.restartReadback?.mission?.aggregate?.phase === "accepted",
    "N2 restart readback is not accepted");
  assertScreenshotClaim(live?.ui, live, candidateCommit, screenshotPath, screenshotBytes);
  requireProof(screenshotPath.endsWith("-accepted.png"), "N2 screenshot is not the accepted-state artifact");
}

function assertN2NativeProof(evidence, candidateCommit, screenshotPath, screenshotBytes) {
  assertLiveHostAndModels(evidence, true);
  assertLiveRunsAndContributions(evidence);
  assertLiveCandidate(evidence);
  assertN2Settlement(evidence);
  assertN2RunSet(evidence);
  assertN2State(evidence);
  assertN2Reservations(evidence);
  assertN2Receipts(evidence);
  assertN2RestartAndUi(evidence, candidateCommit, screenshotPath, screenshotBytes);
}

function assertN2IsolatedHostAndModels(evidence) {
  const models = evidence.configuration?.models;
  const observed = models?.observedAgentConfiguration;
  const agents = n2CampaignAgentIds(evidence);
  const expectedAgentIds = [agents.lead, agents.reviewer];
  requireProof(evidence.head === EXPECTED_HOST_COMMIT, "isolated N2 host commit is not pinned");
  requireProof(evidence.hostTrackedFilesClean === true, "isolated N2 host tracked files were not clean");
  requireProof(models?.authorized?.model === "gpt-5.6-sol", "isolated N2 authorized model is unexpected");
  requireProof(models?.authorized?.effort === "high", "isolated N2 authorized effort is unexpected");
  requireProof(Array.isArray(observed) && observed.length === 2
      && sameStringSet(observed.map((item) => item?.agentId), expectedAgentIds),
  "isolated N2 must observe model settings for the lead and reviewer only");
  observed.forEach((item) => assertObservedModel(item, models.authorized));
}

function assertN2IsolatedNativeProof(evidence, candidateCommit, screenshotPath, screenshotBytes) {
  assertN2PrerequisiteState(evidence.n2Prerequisite);
  assertN2IsolatedHostAndModels(evidence);
  requireProof(evidence.liveN2?.limits?.runCount === 3
      && evidence.liveN2?.limits?.maxRetries === 0
      && evidence.liveN2?.limits?.maxCorrections === 1,
  "isolated N2 native run bounds are missing");
  assertN2IsolatedSettlement(evidence);
  assertN2RunSet(evidence);
  assertN2State(evidence);
  assertN2Reservations(evidence);
  assertN2Receipts(evidence);
  assertN2RestartAndUi(evidence, candidateCommit, screenshotPath, screenshotBytes);
}

function assertSafeBoundary(evidence) {
  assertSafeProviderBoundary(evidence);
  assertSafeCapabilityLists(evidence);
}

function assertSyntheticN2Boundary(synthetic) {
  requireProof(synthetic?.proofClass === "synthetic-provider-free-integration",
    "synthetic N2 proof class is missing");
  requireProof(synthetic?.operatorBoundary?.preparedExecutor
      === "authenticated human operator through PATCH /api/issues/:id",
  "synthetic N2 prepared executor is missing");
  requireProof(synthetic?.operatorBoundary?.automationStatus
      === "human-assisted; no autonomous executor consumes prepared in this mini-lot",
  "synthetic N2 automation boundary is missing");
}

function assertSyntheticN2Regressions(synthetic) {
  requireProof(synthetic?.regressions?.uuidEffectAccepted === true,
    "synthetic N2 UUID admission evidence is incomplete");
  requireProof(synthetic?.regressions?.publicTransitionActorsObserved === true,
    "synthetic N2 transition actor evidence is incomplete");
  requireProof(synthetic?.regressions?.unauthorizedReviewerPatchStatus === 409,
    "synthetic N2 unauthorized identity refusal is incomplete");
  requireProof(synthetic?.regressions?.intendedHumanPatchStatus === 200,
    "synthetic N2 intended operator transition is incomplete");
}

function assertSyntheticN2Candidates(synthetic) {
  requireProof(COMMIT.test(synthetic?.candidates?.v1?.commit),
    "synthetic N2 V1 commit identity is missing");
  requireProof(COMMIT.test(synthetic?.candidates?.v2?.commit),
    "synthetic N2 V2 commit identity is missing");
  requireProof(synthetic.candidates.v1.commit !== synthetic.candidates.v2.commit,
    "synthetic N2 V1/V2 commits are unchanged");
  requireProof(DIGEST.test(synthetic?.candidates?.v1?.sha256),
    "synthetic N2 V1 digest is missing");
  requireProof(DIGEST.test(synthetic?.candidates?.v2?.sha256),
    "synthetic N2 V2 digest is missing");
  requireProof(synthetic.candidates.v1.sha256 !== synthetic.candidates.v2.sha256,
    "synthetic N2 V1/V2 digests are unchanged");
}

function assertSyntheticN2AcceptedState(synthetic) {
  const inspection = synthetic?.mission;
  requireProof(inspection?.mission?.aggregate?.phase === "accepted",
    "synthetic N2 mission phase is not accepted");
  requireProof(inspection?.n2?.status === "accepted",
    "synthetic N2 inspection status is not accepted");
  requireProof(inspection?.mission?.aggregate?.n2?.correctionsUsed === 1,
    "synthetic N2 correction count is unexpected");
  requireProof(inspection?.n2?.submissions?.length === 2,
    "synthetic N2 submission count is unexpected");
  requireProof(inspection?.n2?.usage?.complete === true,
    "synthetic N2 usage settlement is incomplete");
  return inspection;
}

function assertSyntheticN2Receipts(synthetic) {
  requireProof(synthetic?.decisionReceipts?.length === 2,
    "synthetic N2 decision receipt count is unexpected");
  requireProof(synthetic.decisionReceipts[0]?.verdict === "changes_requested",
    "synthetic N2 first verdict is unexpected");
  requireProof(synthetic.decisionReceipts[1]?.verdict === "approved",
    "synthetic N2 second verdict is unexpected");
  requireProof(synthetic.decisionReceipts.every((receipt) => receipt.state === "native_observed"),
    "synthetic N2 decision receipts are not native-observed");
}

function assertSyntheticN2Restart(synthetic, inspection) {
  requireProof(synthetic?.restartReadback?.mission?.aggregate?.phase === "accepted",
    "synthetic N2 restart phase is not accepted");
  requireProof(JSON.stringify(synthetic.restartReadback.mission.aggregate.n2)
      === JSON.stringify(inspection.mission.aggregate.n2),
  "synthetic N2 restart readback does not match the persisted accepted state");
}

function assertSyntheticN2Proof(evidence) {
  const synthetic = evidence.syntheticN2;
  assertSyntheticN2Boundary(synthetic);
  assertSyntheticN2Regressions(synthetic);
  assertSyntheticN2Candidates(synthetic);
  const inspection = assertSyntheticN2AcceptedState(synthetic);
  assertSyntheticN2Receipts(synthetic);
  assertSyntheticN2Restart(synthetic, inspection);
}

export function assertQualificationEvidence(evidence, {
  mode, candidateCommit, notBefore, screenshotPath, screenshotBytes,
}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("evidence must be an object");
  }
  const live = mode === "live";
  const liveN2 = mode === "live-n2";
  const isolatedLiveN2 = mode === "live-n2-isolated";
  if (!live && !liveN2 && !isolatedLiveN2 && mode !== "safe") fail(`unsupported mode ${String(mode)}`);
  const expectedProofId = isolatedLiveN2
    ? N2_ISOLATED_LIVE_PROOF_ID
    : liveN2 ? N2_LIVE_PROOF_ID : live ? LIVE_PROOF_ID : SAFE_PROOF_ID;
  const expectedOutcome = isolatedLiveN2
    ? N2_ISOLATED_LIVE_OUTCOME
    : liveN2 ? N2_LIVE_OUTCOME : live ? LIVE_OUTCOME : SAFE_OUTCOME;
  const expectedResults = isolatedLiveN2
    ? N2_ISOLATED_LIVE_RESULT_KEYS
    : liveN2 ? N2_LIVE_RESULT_KEYS : live ? LIVE_RESULT_KEYS : SAFE_RESULT_KEYS;
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
  assertSyntheticN2Proof(evidence);
  const expectedFixtureBoundary = isolatedLiveN2
    ? N2_ISOLATED_FIXTURE_BOUNDARY
    : live || liveN2 ? LIVE_FIXTURE_BOUNDARY : SAFE_FIXTURE_BOUNDARY;
  if (evidence.configuration.fixtureBoundary !== expectedFixtureBoundary) {
    fail(`${mode} fixture boundary is missing or unexpected`);
  }
  if (live) {
    if (evidence.liveN1?.stopBoundary !== LIVE_STOP_BOUNDARY || evidence.liveN1?.reviewerRunCount !== 0) {
      fail("live ready_for_review/N2 stop boundary proof is missing");
    }
    assertLiveSettlement(evidence);
    assertLiveNativeProof(evidence, candidateCommit, screenshotPath, screenshotBytes);
  }
  if (liveN2) assertN2NativeProof(evidence, candidateCommit, screenshotPath, screenshotBytes);
  if (isolatedLiveN2) {
    assertN2IsolatedNativeProof(evidence, candidateCommit, screenshotPath, screenshotBytes);
  }
  return evidence;
}

function matchesN2FixtureReadback(entry, fixtureRuns) {
  if (entry?.runs?.length !== 1) return false;
  const run = entry.runs[0];
  const fixture = fixtureRuns.find((candidate) => candidate?.runId === entry?.fixtureRunId);
  if (!fixture) return false;
  return [
    run?.id === fixture.runId,
    run?.companyId === fixture.companyId,
    run?.agentId === fixture.agentId,
    run?.status === "succeeded",
    nonemptyString(run?.finishedAt),
    run?.invocationSource === "on_demand",
    run?.triggerDetail === fixture.fixtureSource,
    run?.issueId === fixture.issueId,
    run?.wakeupRequestId === null,
    run?.processStartedAt === null,
  ].every(Boolean);
}

// This assertion block mirrors the evidence contract as one auditable prerequisite checklist.
// fallow-ignore-next-line complexity
function assertN2PrerequisiteState(prerequisite) {
  const aggregate = prerequisite?.mission?.mission?.aggregate;
  const participants = prerequisite?.mission?.n1?.participants;
  const candidate = prerequisite?.mission?.n1?.candidate;
  const reservations = prerequisite?.admission?.envelope?.reservations;
  requireProof(prerequisite?.proofClass === N2_PREREQUISITE_OUTCOME,
    "N2 prerequisite proof class is missing");
  requireProof(aggregate?.phase === "ready_for_review" && aggregate?.control?.status === "inactive",
    "N1 prerequisite is not stopped at ready_for_review");
  requireProof(prerequisite?.mission?.n2 === null && aggregate?.n2 === undefined,
    "N2 state must be absent before the first reviewer");
  requireProof(Array.isArray(participants) && participants.length === 2,
    "N2 prerequisite needs exactly two contributions");
  requireProof(distinctStrings(participants.map((entry) => entry?.contributionId))
      && distinctStrings(participants.map((entry) => entry?.assigneeAgentId))
      && distinctStrings(participants.map((entry) => entry?.commit)),
  "N2 prerequisite contribution, assignee, and commit identities must be distinct");
  requireProof(candidate?.outcome === "verified" && candidate?.publicationEligible === true,
    "N2 prerequisite candidate is not verified and publication eligible");
  requireProof(COMMIT.test(candidate?.candidate?.candidateCommit)
      && DIGEST.test(candidate?.candidate?.sha256)
      && candidate?.candidate?.candidateCommit === prerequisite?.candidate?.candidateCommit
      && candidate?.candidate?.sha256 === prerequisite?.candidate?.sha256,
  "N2 prerequisite candidate identity is missing or inconsistent");
  requireProof(Array.isArray(reservations) && reservations.length === 3,
    "N2 prerequisite must retain exactly three deterministic N1 reservations");
  requireProof(reservations.every((entry) => entry?.status === "settled"
      && entry?.usage?.status === "known" && entry.usage.units === 0
      && entry?.remainingExposure?.status === "known" && entry.remainingExposure.units === 0),
  "every deterministic N1 reservation must be settled with zero usage and exposure");
  requireProof(prerequisite?.admission?.envelope?.exposure?.status === "known"
      && prerequisite.admission.envelope.exposure.units === 0,
  "N2 prerequisite admission exposure must be known and zero");
  const fixtureRuns = prerequisite?.fixtureHeartbeatRuns;
  const fixtureReadbacks = prerequisite?.runReadbacks?.filter((entry) => entry?.runCount === 1);
  const reviewerReadback = prerequisite?.runReadbacks?.find(
    (entry) => entry?.agentId === prerequisite?.agents?.reviewer?.id,
  );
  requireProof(Array.isArray(fixtureRuns) && fixtureRuns.length === 3
      && distinctStrings(fixtureRuns.map((entry) => entry?.runId))
      && fixtureRuns.every((entry) => UUID.test(entry?.runId)
        && entry?.companyId === prerequisite?.companyId
        && entry?.createdStatus === "running"
        && entry?.fixtureSource === "fixture:n2-prerequisite:deterministic-heartbeat")
      && Array.isArray(prerequisite?.runReadbacks)
      && prerequisite.runReadbacks.length === 4
      && fixtureReadbacks?.length === 3
      && fixtureReadbacks.every((entry) => matchesN2FixtureReadback(entry, fixtureRuns))
      && reviewerReadback?.runCount === 0
      && reviewerReadback?.fixtureRunId === null,
  "three correctly attributed, unexecuted fixture heartbeat rows are not proven");
  const lifecycle = prerequisite?.fixtureLifecycle;
  requireProof(lifecycle?.fixtureSource === "fixture:n2-prerequisite:deterministic-heartbeat"
      && nonemptyString(lifecycle?.completedAfter)
      && Array.isArray(lifecycle?.terminalRuns) && lifecycle.terminalRuns.length === 3
      && lifecycle.terminalRuns.every((run) => run?.status === "succeeded"
        && nonemptyString(run?.finishedAt)
        && run?.wakeupRequestId === null
        && run?.processStartedAt === null)
      && Array.isArray(lifecycle?.issueLocks) && lifecycle.issueLocks.length === 3
      && lifecycle.activeRunCount === 0
      && lifecycle.openCheckoutCount === 0
      && lifecycle.openExecutionCount === 0,
  "N2 prerequisite fixture lifecycle is not terminal and lock-free");
  requireProof(prerequisite?.providerBoundary?.providerInvocationCount === 0
      && prerequisite?.providerBoundary?.nativeAgentExecutionCount === 0
      && prerequisite?.providerBoundary?.prerequisiteFixtureHeartbeatRowCount === 3
      && prerequisite?.providerBoundary?.wakeupCount === 0
      && prerequisite?.providerBoundary?.reviewerRunCount === 0,
  "zero provider, wakeup, reviewer, and native-agent execution is not proven");
  requireProof(prerequisite?.databaseBoundary
      === "the primary prerequisite seam inserts and terminalizes exactly three heartbeat fixtures, clears only their exact issue locks, and uses public Paperclip and installed Council APIs for business transitions",
  "public-command database boundary is missing");
  requireProof(prerequisite?.stopBoundary === "ready_for_review; N2 state absent; reviewer not started",
    "N2 prerequisite did not stop before reviewer dispatch");
}

function hasExpectedN2HandoffCommands(guard) {
  return Array.isArray(guard?.publicCommands)
    && guard.publicCommands.includes("start-review")
    && guard.publicCommands.includes("PATCH /api/issues/:id");
}

function hasProviderFreeN2HandoffBoundary(guard) {
  const {
    proofClass,
    fixtureBoundary,
    reviewerHeartbeatConfiguration = {},
    wakeupCount,
    processCount,
  } = guard ?? {};
  return proofClass === "synthetic-provider-free-n2-handoff-guard"
    && fixtureBoundary === "distinct ephemeral fixture; no provider, process, or native reviewer execution"
    && reviewerHeartbeatConfiguration.wakeOnDemand === false
    && wakeupCount === 0
    && processCount === 0;
}

function hasPreparedN2HandoffState(guard) {
  return hasExpectedN2HandoffCommands(guard)
    && guard?.startReviewOutcome === "prepared"
    && guard?.operatorTransitionStatus === 200
    && guard?.mission?.n2?.status === "reviewing";
}

function hasSettledN2HandoffReservation(guard) {
  const reservations = guard?.admission?.envelope?.reservations;
  return reservations?.length === 1
    && reservations[0]?.status === "settled"
    && reservations[0]?.remainingExposure?.units === 0;
}

function hasTerminalN2HandoffFixtures(guard) {
  return Array.isArray(guard?.fixtureRuns)
    && guard.fixtureRuns.length === 2
    && guard.fixtureRuns.every((run) => run?.status === "succeeded"
      && nonemptyString(run?.finishedAt)
      && run?.wakeupRequestId === null
      && run?.processStartedAt === null);
}

function hasLockFreeN2HandoffReadback(guard) {
  return guard?.issueReadback?.checkoutRunId === null
    && guard?.issueReadback?.executionRunId === null;
}

function assertN2HandoffGuard(guard) {
  requireProof(hasProviderFreeN2HandoffBoundary(guard)
      && hasPreparedN2HandoffState(guard)
      && hasSettledN2HandoffReservation(guard)
      && hasTerminalN2HandoffFixtures(guard)
      && hasLockFreeN2HandoffReadback(guard),
  "synthetic public N2 handoff guard is not consumable, settled, and lock-free");
}

export function assertN2PrerequisiteEvidence(evidence, { candidateCommit, notBefore }) {
  if (evidence?.schemaVersion !== 1
      || evidence?.proofId !== N2_PREREQUISITE_PROOF_ID
      || evidence?.outcome !== N2_PREREQUISITE_OUTCOME
      || evidence?.candidate?.commit !== candidateCommit
      || evidence?.candidate?.clean !== true) {
    fail(`N2 prerequisite identity or outcome does not match ${candidateCommit}`);
  }
  assertFreshness(evidence, notBefore);
  assertCleanup(evidence);
  assertExactResults(evidence.results, N2_PREREQUISITE_RESULT_KEYS, "n2-prerequisite");
  assertN2PrerequisiteState(evidence.n2Prerequisite);
  assertN2HandoffGuard(evidence.n2Prerequisite?.handoffGuard);
  requireProof(evidence?.launcherCleanup?.ownedRuntimeRemoved === true,
    "owned qualification runtime cleanup is not proven");
  return evidence;
}
