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
const EXPECTED_HOST_COMMIT = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
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

function assertLiveHostAndModels(evidence) {
  const models = evidence.configuration?.models;
  const observed = models?.observedAgentConfiguration;
  const agents = evidence.liveN1?.agents;
  const expectedAgentIds = [agents?.lead, ...(agents?.contributors ?? [])];
  requireProof(evidence.head === EXPECTED_HOST_COMMIT, "live host commit is not the pinned candidate");
  requireProof(evidence.hostTrackedFilesClean === true, "live host tracked files were not clean");
  requireProof(models?.authorized?.model === "gpt-5.6-sol", "authorized live model is missing or unexpected");
  requireProof(models?.authorized?.effort === "high", "authorized live effort is missing or unexpected");
  requireProof(Array.isArray(observed) && observed.length === 3, "three observed model settings are required");
  requireProof(sameStringSet(observed.map((item) => item?.agentId), expectedAgentIds),
    "observed model settings must identify the exact lead and two contributors");
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
  const allowedKeys = new Set([...LIVE_USAGE_COUNTERS, "usageSource"]);
  requireProof(Object.keys(usage).every((key) => allowedKeys.has(key)),
    "native run usageJson contains non-accounting provider metadata");
  if (usage.usageSource !== undefined) {
    requireProof(nonemptyString(usage.usageSource), "native run usageSource is malformed");
  }
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

function assertReservationSource(source, runId, baseline) {
  requireProof(nonemptyString(source)
      && source.includes(`;run=${runId};`)
      && source.includes(`;issue-baseline=${baseline};`),
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
  const expectedUnits = usage.inputTokens + usage.outputTokens - input.baseline;
  requireProof(Number.isSafeInteger(expectedUnits) && expectedUnits > 0,
    `${input.label} native run usage delta must be positive`);
  requireProof(reservation.usage?.units === expectedUnits,
    `${input.label} reservation usage does not equal inputTokens + outputTokens - baseline`);
  assertReservationSource(reservation.usage?.source, input.run.id, input.baseline);
}

function assertLiveRunReservations(evidence) {
  const live = evidence.liveN1;
  const state = live?.mission?.mission?.aggregate?.n1;
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

function assertSafeBoundary(evidence) {
  assertSafeProviderBoundary(evidence);
  assertSafeCapabilityLists(evidence);
}

export function assertQualificationEvidence(evidence, {
  mode, candidateCommit, notBefore, screenshotPath, screenshotBytes,
}) {
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
    assertLiveNativeProof(evidence, candidateCommit, screenshotPath, screenshotBytes);
  }
  return evidence;
}
