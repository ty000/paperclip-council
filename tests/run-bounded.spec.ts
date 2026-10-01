import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The qualification launcher is intentionally plain ESM.
import { ProcessGroupDrainError, runProcessGroup } from "../scripts/qualification/process-group.mjs";
// @ts-expect-error The qualification launcher is intentionally plain ESM.
import { prepareQualificationHost, withOwnedQualificationRuntime } from "../scripts/qualification/run-bounded.mjs";
// @ts-expect-error The qualification evidence contract is intentionally plain ESM.
import { __claimLiveEvidencePathsForTest, assertQualificationEvidence, claimLiveEvidencePaths, LIVE_RESULT_KEYS, SAFE_RESULT_KEYS, writeClaimedArtifact } from "../scripts/qualification/evidence-contract.mjs";
import { assertNoReviewerRuns, assertOnlyExpectedAgentRun, n1DeliveryAdapterConfig } from "./functional/n1-live.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveCommit = "a".repeat(40);
const liveScreenshotPath = resolve("/tmp", `n1-live-${liveCommit}-ready-for-review.png`);
const liveScreenshotBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("bounded-png-fixture"),
]);

function liveOptions(notBefore: number) {
  return { mode: "live", candidateCommit: liveCommit, notBefore, screenshotPath: liveScreenshotPath, screenshotBytes: liveScreenshotBytes };
}

function qualificationEvidence(mode: "safe" | "live"): any {
  const live = mode === "live";
  const results = Object.fromEntries((live ? LIVE_RESULT_KEYS : SAFE_RESULT_KEYS).map((key: string) => [key, "PASS"]));
  const reservations = [1, 2, 3].map((ordinal) => ({
    reservationId: `reservation-${ordinal}`,
    status: "settled",
    usage: { status: "known", units: ordinal },
    remainingExposure: { status: "known", units: 0 },
  }));
  return {
    schemaVersion: 1,
    proofId: live
      ? "paperclip-council-n1-observable-native-qualification-v1"
      : "paperclip-council-n1-safe-boundary-qualification-v1",
    startedAt: "2026-10-01T10:00:00.000Z",
    finishedAt: "2026-10-01T10:01:00.000Z",
    head: "61b3fd57a695614dc4a37e2303f426a34a9795cf",
    hostTrackedFilesClean: true,
    candidate: {
      commit: liveCommit,
      branch: "codex/council-n1",
      clean: true,
      source: "git archive of the exact candidate commit, built in an isolated temporary directory",
      sourceArchiveSha256: "b".repeat(64),
      distSha256: "c".repeat(64),
    },
    outcome: live ? "N1 OBSERVABLE RESULT VALIDATED" : "N1 SAFE BOUNDARY VALIDATED",
    results,
    appCleanup: "stopped only the plugin worker, listener, and application created by this run",
    databaseCleanup: "fresh isolated PostgreSQL cluster removed; parent-owned temporary instance retained",
    configuration: {
      models: live ? {
        authorized: { model: "gpt-5.6-sol", effort: "high" },
        observedAgentConfiguration: ["lead", "alpha", "beta"].map((agentId) => ({
          agentId, adapterType: "codex_local", model: "gpt-5.6-sol", effort: "high",
        })),
      } : "none",
      fixtureBoundary: live
        ? "The safe-boundary suite uses fixtures; the N1 live campaign below uses native APIs, native wakeups, exact Paperclip run IDs, and run-derived terminal token settlement."
        : "agents, issues, policies, and heartbeat runs are synthetic test preparation",
    },
    n1Boundary: {
      providerInvocation: "none; dispatch was deliberately not invoked because it requests native wakeup",
      demonstrated: ["safe capability"],
      incomplete: ["live capability"],
    },
    ...(live ? {
      liveN1: {
        companyId: "company",
        missionId: "mission",
        rootIssueId: "root-issue",
        baseCommit: "0".repeat(40),
        agents: { lead: "lead", contributors: ["alpha", "beta"], reviewer: "reviewer" },
        runs: [
          { id: "lead-run", agentId: "lead", status: "succeeded", finishedAt: "2026-10-01T10:00:20.000Z" },
          { id: "alpha-run", agentId: "alpha", status: "succeeded", finishedAt: "2026-10-01T10:00:40.000Z" },
          { id: "beta-run", agentId: "beta", status: "succeeded", finishedAt: "2026-10-01T10:00:50.000Z" },
        ],
        leadRunBarrier: {
          expectedRunId: "lead-run",
          wakeOnDemand: false,
          observedRunIds: ["lead-run"],
        },
        mission: {
          nextAction: "N2 may begin after this N1 stop boundary.",
          n1: {
            nextAction: "N2 may begin after this N1 stop boundary.",
            participants: [
              {
                contributionId: "alpha-contribution", assigneeAgentId: "alpha", dispatchRunId: "alpha-run",
                commit: "1".repeat(40), ownedPaths: ["alpha.txt"],
              },
              {
                contributionId: "beta-contribution", assigneeAgentId: "beta", dispatchRunId: "beta-run",
                commit: "2".repeat(40), ownedPaths: ["beta.txt"],
              },
            ],
            candidate: { outcome: "verified" },
          },
          mission: {
            aggregate: {
              phase: "ready_for_review",
              control: { status: "inactive" },
              journal: [{ action: "integration_check_failed" }],
              n1: {
                rootDispatchRunId: "lead-run",
                contributions: [
                  {
                    contributionId: "alpha-contribution", assigneeAgentId: "alpha", dispatchRunId: "alpha-run",
                    commit: "1".repeat(40), ownedPaths: ["alpha.txt"],
                  },
                  {
                    contributionId: "beta-contribution", assigneeAgentId: "beta", dispatchRunId: "beta-run",
                    commit: "2".repeat(40), ownedPaths: ["beta.txt"],
                  },
                ],
                candidate: {
                  outcome: "verified",
                  publicationEligible: true,
                  candidate: {
                    attachmentId: "attachment", baseCommit: "0".repeat(40), candidateCommit: "3".repeat(40), sha256: "4".repeat(64),
                  },
                  contributions: [
                    { contributionId: "alpha-contribution", commit: "1".repeat(40), ownedPaths: ["alpha.txt"], changedPaths: ["alpha.txt"] },
                    { contributionId: "beta-contribution", commit: "2".repeat(40), ownedPaths: ["beta.txt"], changedPaths: ["beta.txt"] },
                  ],
                  checks: [{ name: "fixture", status: "passed", detail: "checked" }],
                },
              },
            },
          },
        },
        ui: { screenshot: liveScreenshotPath, missionId: "mission", rootIssueId: "root-issue" },
        stopBoundary: "ready_for_review; N2 not started",
        reviewerRunCount: 0,
        admission: {
          envelope: {
            allowance: { status: "known", knownUsageUnits: 6 },
            reservations,
          },
        },
      },
    } : {}),
  };
}

describe("bounded qualification launcher", () => {
  it("atomically gives only one contender the commit-qualified evidence and screenshot paths", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-live-evidence-"));
    const commit = "a".repeat(40);
    try {
      const contenders = await Promise.allSettled([
        Promise.resolve().then(() => claimLiveEvidencePaths(root, commit, undefined)),
        Promise.resolve().then(() => claimLiveEvidencePaths(root, commit, undefined)),
      ]);
      expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(contenders.find((result) => result.status === "fulfilled")).toMatchObject({
        value: {
          evidencePath: resolve(root, `artifacts/n1-live-${commit}.json`),
          screenshotPath: resolve(root, `artifacts/n1-live-${commit}-ready-for-review.png`),
        },
      });
      const winner = contenders.find((result) => result.status === "fulfilled");
      if (winner?.status === "fulfilled") winner.value.release();

      expect(() => claimLiveEvidencePaths(root, commit, resolve(root, "unqualified.json")))
        .toThrow(/must be JSON and contain candidate commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claims live artifact paths after preflight and before provider-capable work", () => {
    const launcherSource = readFileSync(resolve(packageRoot, "scripts/qualification/run-live-n1.mjs"), "utf8");
    const claimAt = launcherSource.indexOf("const claim = claimLiveEvidencePaths(");
    const hostAt = launcherSource.indexOf("const host = preparedHost();");
    const browserAt = launcherSource.indexOf("await installChromium(host");
    const runtimeAt = launcherSource.indexOf("await withOwnedQualificationRuntime", claimAt);
    expect(claimAt).toBeGreaterThan(-1);
    expect(hostAt).toBeLessThan(claimAt);
    expect(browserAt).toBeGreaterThan(hostAt);
    expect(browserAt).toBeLessThan(claimAt);
    expect(runtimeAt).toBeGreaterThan(browserAt);
    expect(runtimeAt).toBeGreaterThan(claimAt);
  });

  it("refuses pre-existing files, directories, and symlinks without overwriting them", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-live-existing-"));
    const commit = "b".repeat(40);
    try {
      const existingFile = resolve(root, `n1-live-${commit}.json`);
      writeFileSync(existingFile, "preserve me");
      expect(() => claimLiveEvidencePaths(root, commit, existingFile))
        .toThrow(/already exists; refusing to overwrite/);
      expect(readFileSync(existingFile, "utf8")).toBe("preserve me");

      const existingDirectory = resolve(root, `n1-live-directory-${commit}.json`);
      mkdirSync(existingDirectory);
      expect(() => claimLiveEvidencePaths(root, commit, existingDirectory))
        .toThrow(/already exists; refusing to overwrite/);

      const existingLink = resolve(root, `n1-live-link-${commit}.json`);
      symlinkSync(resolve(root, "missing-target.json"), existingLink);
      expect(() => claimLiveEvidencePaths(root, commit, existingLink))
        .toThrow(/already exists; refusing to overwrite/);

      const screenshotCommit = "d".repeat(40);
      const existingScreenshot = resolve(root, `artifacts/n1-live-${screenshotCommit}-ready-for-review.png`);
      const absentEvidence = resolve(root, `artifacts/n1-live-${screenshotCommit}.json`);
      mkdirSync(dirname(existingScreenshot), { recursive: true });
      writeFileSync(existingScreenshot, "preserve screenshot");
      expect(() => claimLiveEvidencePaths(root, screenshotCommit, undefined))
        .toThrow(/live screenshot path already exists; refusing to overwrite/);
      expect(existsSync(absentEvidence)).toBe(false);
      expect(readFileSync(existingScreenshot, "utf8")).toBe("preserve screenshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves pre-existing destinations and keeps a successful pair create-only", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-live-pair-"));
    const existingCommit = "e".repeat(40);
    const successCommit = "f".repeat(40);
    try {
      const existingEvidence = resolve(root, `artifacts/n1-live-${existingCommit}.json`);
      const existingScreenshot = resolve(root, `artifacts/n1-live-${existingCommit}-ready-for-review.png`);
      mkdirSync(dirname(existingEvidence), { recursive: true });
      writeFileSync(existingEvidence, "existing evidence");
      writeFileSync(existingScreenshot, "existing screenshot");
      expect(() => claimLiveEvidencePaths(root, existingCommit, undefined))
        .toThrow(/live evidence path already exists; refusing to overwrite/);
      expect(readFileSync(existingEvidence, "utf8")).toBe("existing evidence");
      expect(readFileSync(existingScreenshot, "utf8")).toBe("existing screenshot");

      const claimed = claimLiveEvidencePaths(root, successCommit, undefined);
      expect(existsSync(claimed.evidencePath)).toBe(true);
      expect(existsSync(claimed.screenshotPath)).toBe(true);
      expect(() => claimLiveEvidencePaths(root, successCommit, undefined))
        .toThrow(/already being claimed/);
      writeClaimedArtifact(claimed.evidencePath, claimed.evidenceIdentity, "first evidence", "evidence");
      writeClaimedArtifact(claimed.evidencePath, claimed.evidenceIdentity, "claimed evidence", "evidence");
      writeClaimedArtifact(claimed.screenshotPath, claimed.screenshotIdentity, Buffer.from("claimed screenshot"), "screenshot");
      expect(claimed.readEvidence()).toBe("claimed evidence");
      claimed.release({ validate: true });
      expect(() => claimLiveEvidencePaths(root, successCommit, undefined))
        .toThrow(/already exists; refusing to overwrite/);
      expect(readFileSync(claimed.evidencePath, "utf8")).toBe("claimed evidence");
      expect(readFileSync(claimed.screenshotPath, "utf8")).toBe("claimed screenshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed after claimed JSON or screenshot paths are replaced or deleted", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-live-post-claim-race-"));
    const jsonCommit = "3".repeat(40);
    const screenshotCommit = "4".repeat(40);
    const deletedCommit = "5".repeat(40);
    const deletedScreenshotCommit = "6".repeat(40);
    try {
      const jsonClaim = claimLiveEvidencePaths(root, jsonCommit, undefined);
      const originalJson = resolve(root, "original-json-claim");
      renameSync(jsonClaim.evidencePath, originalJson);
      writeFileSync(jsonClaim.evidencePath, "replacement JSON");
      expect(() => writeClaimedArtifact(
        jsonClaim.evidencePath, jsonClaim.evidenceIdentity, "must not overwrite", "evidence",
      )).toThrow(/identity changed/);
      expect(() => jsonClaim.readEvidence()).toThrow(/identity changed/);
      expect(readFileSync(jsonClaim.evidencePath, "utf8")).toBe("replacement JSON");
      jsonClaim.release();

      const screenshotClaim = claimLiveEvidencePaths(root, screenshotCommit, undefined);
      const originalScreenshot = resolve(root, "original-screenshot-claim");
      renameSync(screenshotClaim.screenshotPath, originalScreenshot);
      writeFileSync(screenshotClaim.screenshotPath, "replacement PNG");
      expect(() => writeClaimedArtifact(
        screenshotClaim.screenshotPath, screenshotClaim.screenshotIdentity, Buffer.from("must not overwrite"), "screenshot",
      )).toThrow(/identity changed/);
      expect(readFileSync(screenshotClaim.screenshotPath, "utf8")).toBe("replacement PNG");
      screenshotClaim.release();

      const deletedClaim = claimLiveEvidencePaths(root, deletedCommit, undefined);
      unlinkSync(deletedClaim.evidencePath);
      expect(() => writeClaimedArtifact(
        deletedClaim.evidencePath, deletedClaim.evidenceIdentity, "must not recreate", "evidence",
      )).toThrow(/could not be opened safely/);
      expect(existsSync(deletedClaim.evidencePath)).toBe(false);
      deletedClaim.release();

      const deletedScreenshotClaim = claimLiveEvidencePaths(root, deletedScreenshotCommit, undefined);
      unlinkSync(deletedScreenshotClaim.screenshotPath);
      expect(() => writeClaimedArtifact(
        deletedScreenshotClaim.screenshotPath,
        deletedScreenshotClaim.screenshotIdentity,
        Buffer.from("must not recreate"),
        "screenshot",
      )).toThrow(/could not be opened safely/);
      expect(existsSync(deletedScreenshotClaim.screenshotPath)).toBe(false);
      deletedScreenshotClaim.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives the N1 reviewer stop proof from an empty native run readback", () => {
    const response = (status: number, body: unknown) => ({ status, body, headers: new Headers() }) as any;
    expect(assertNoReviewerRuns(response(200, []))).toEqual([]);
    expect(() => assertNoReviewerRuns(response(200, [{ id: "unexpected-review-run", status: "queued" }])))
      .toThrow(/reviewer must not run during N1/);
    expect(() => assertNoReviewerRuns(response(200, {}))).toThrow(/must return an array/);
    expect(() => assertNoReviewerRuns(response(403, { error: "forbidden" }))).toThrow();

    const source = readFileSync(resolve(packageRoot, "tests/functional/n1-live.ts"), "utf8");
    expect(source).toContain("/heartbeat-runs?agentId=${encodeURIComponent(reviewer.id)}&limit=1000&summary=1");
    expect(source).toContain("reviewerRunCount: reviewerRuns.length");
    expect(source).not.toContain("reviewerRunCount: 0");
  });

  it("keeps delivery Git access narrow and refuses extra lead runs", () => {
    const repository = resolve("/tmp", "council-n1-repository");
    expect(n1DeliveryAdapterConfig({ model: "gpt-5.6-sol", effort: "high", repository })).toEqual({
      engine: "cli",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      timeoutSec: 1_200,
      dangerouslyBypassApprovalsAndSandbox: false,
      extraArgs: [
        "--sandbox", "workspace-write",
        "-c", "sandbox_workspace_write.network_access=true",
        "--add-dir", resolve(repository, ".git"),
      ],
    });

    const response = (status: number, body: unknown) => ({ status, body, headers: new Headers() }) as any;
    expect(assertOnlyExpectedAgentRun(response(200, [{ id: "lead-run" }]), "lead-run", "lead"))
      .toEqual([{ id: "lead-run" }]);
    expect(() => assertOnlyExpectedAgentRun(
      response(200, [{ id: "lead-run" }, { id: "unexpected-run" }]), "lead-run", "lead",
    )).toThrow(/exactly the expected native run/);
  });

  it("rolls back only its empty JSON claim when the screenshot O_EXCL create fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-live-rollback-"));
    const commit = "1".repeat(40);
    const evidencePath = resolve(root, `artifacts/n1-live-${commit}.json`);
    const screenshotPath = resolve(root, `artifacts/n1-live-${commit}-ready-for-review.png`);
    const claimLockPath = resolve(root, `artifacts/.n1-live-${commit}.json.artifact-pair-claim`);
    try {
      expect(() => __claimLiveEvidencePathsForTest(root, commit, undefined, () => {
        writeFileSync(screenshotPath, "injected screenshot conflict");
      })).toThrow(/live screenshot path already exists; refusing to overwrite/);
      expect(existsSync(evidencePath)).toBe(false);
      expect(existsSync(claimLockPath)).toBe(false);
      expect(readFileSync(screenshotPath, "utf8")).toBe("injected screenshot conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a replacement JSON when the screenshot O_EXCL create fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-live-replacement-"));
    const commit = "2".repeat(40);
    const evidencePath = resolve(root, `artifacts/n1-live-${commit}.json`);
    const originalClaimPath = resolve(root, "original-empty-claim.json");
    const screenshotPath = resolve(root, `artifacts/n1-live-${commit}-ready-for-review.png`);
    const claimLockPath = resolve(root, `artifacts/.n1-live-${commit}.json.artifact-pair-claim`);
    try {
      expect(() => __claimLiveEvidencePathsForTest(root, commit, undefined, () => {
        renameSync(evidencePath, originalClaimPath);
        writeFileSync(evidencePath, "replacement evidence");
        writeFileSync(screenshotPath, "injected screenshot conflict");
      })).toThrow(/live screenshot path already exists; refusing to overwrite/);
      expect(readFileSync(evidencePath, "utf8")).toBe("replacement evidence");
      expect(readFileSync(originalClaimPath)).toHaveLength(0);
      expect(existsSync(claimLockPath)).toBe(false);
      expect(readFileSync(screenshotPath, "utf8")).toBe("injected screenshot conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the exact evidence contract synchronized with functional producer assignments", () => {
    const producerSources = ["tests/functional/run.ts", "tests/functional/n1-live.ts"]
      .map((path) => readFileSync(resolve(packageRoot, path), "utf8"))
      .join("\n");
    const assignedKeys = [...producerSources.matchAll(/\bevidence\.results\.([A-Za-z][A-Za-z0-9_]*)\s*=/g)]
      .map((match) => match[1]);
    expect([...new Set(assignedKeys)].sort()).toEqual([...LIVE_RESULT_KEYS].sort());
    expect(SAFE_RESULT_KEYS).toContain("n1MissionExactLookupBeyondLatestList");
  });

  it("ignores targeted commit-qualified live artifacts while retaining the legacy JSON exclusion", () => {
    const commit = "c".repeat(40);
    for (const path of [
      `artifacts/n1-live-${commit}.json`,
      `artifacts/n1-live-${commit}-ready-for-review.png`,
    ]) {
      expect(() => execFileSync("git", ["check-ignore", "-q", path], { cwd: packageRoot }))
        .not.toThrow();
    }
    expect(() => execFileSync("git", ["check-ignore", "-q", "artifacts/n1-live.json"], { cwd: packageRoot }))
      .not.toThrow();
    expect(() => execFileSync("git", ["check-ignore", "-q", "artifacts/n1-live-ready-for-review.png"], { cwd: packageRoot }))
      .toThrow();
  });

  it("guards delayed mission lookups against refresh and company-context changes", () => {
    const uiSource = readFileSync(resolve(packageRoot, "src/ui/index.tsx"), "utf8");
    expect(uiSource).toContain("lookupControllerRef.current?.abort()");
    expect(uiSource).toContain("lookupContextRef.current.companyId !== lookupContext.companyId");
    expect(uiSource).toContain("lookupContextRef.current.refreshKey !== lookupContext.refreshKey");

    const functionalSource = readFileSync(resolve(packageRoot, "tests/functional/run.ts"), "utf8");
    expect(functionalSource).toContain("a delayed pre-refresh lookup must be discarded");
    expect(functionalSource).toContain("company A lookup must not mutate company B state");
    expect(functionalSource).toContain("Mission lookup failed: Mission not found");
  });

  it("accepts only the exact safe and live result sets", () => {
    const notBefore = Date.parse("2026-10-01T09:59:59.000Z");
    expect(() => assertQualificationEvidence(qualificationEvidence("safe"), {
      mode: "safe", candidateCommit: "a".repeat(40), notBefore,
    })).not.toThrow();
    expect(() => assertQualificationEvidence(qualificationEvidence("live"), {
      ...liveOptions(notBefore),
    })).not.toThrow();

    for (const results of [undefined, {}, { ...qualificationEvidence("safe").results }]) {
      const evidence = qualificationEvidence("safe");
      if (results && Object.keys(results).length > 0) delete results.nativeReadback;
      evidence.results = results;
      expect(() => assertQualificationEvidence(evidence, {
        mode: "safe", candidateCommit: "a".repeat(40), notBefore,
      })).toThrow(/result/);
    }

    const unexpected = qualificationEvidence("live");
    unexpected.results.unexpectedProof = "PASS";
    expect(() => assertQualificationEvidence(unexpected, {
      ...liveOptions(notBefore),
    })).toThrow(/unexpected=\[unexpectedProof\]/);

    const incompleteLive = qualificationEvidence("live");
    delete incompleteLive.results.n1InstalledBrowserObservableState;
    expect(() => assertQualificationEvidence(incompleteLive, {
      ...liveOptions(notBefore),
    })).toThrow(/missing=\[n1InstalledBrowserObservableState\]/);
  });

  it("rejects stale, cleanup-incomplete, boundary-incomplete, and unsettled evidence", () => {
    const options = liveOptions(Date.parse("2026-10-01T09:59:59.000Z"));
    const stale = qualificationEvidence("live");
    stale.startedAt = "2026-09-30T10:00:00.000Z";
    expect(() => assertQualificationEvidence(stale, options)).toThrow(/stale/);

    const missingCleanup = qualificationEvidence("live");
    delete missingCleanup.databaseCleanup;
    expect(() => assertQualificationEvidence(missingCleanup, options)).toThrow(/Cleanup|cleanup/);

    const missingBoundary = qualificationEvidence("live");
    delete missingBoundary.liveN1.stopBoundary;
    expect(() => assertQualificationEvidence(missingBoundary, options)).toThrow(/stop boundary/);

    const unsettled = qualificationEvidence("live");
    unsettled.liveN1.admission.envelope.reservations[1].status = "unsettled";
    expect(() => assertQualificationEvidence(unsettled, options)).toThrow(/every live reservation must be settled/);
  });

  it("binds live proof to host, models, native runs, contributions, candidate, failure refusal, and PNG UI", () => {
    const options = liveOptions(Date.parse("2026-10-01T09:59:59.000Z"));
    const mutations: Array<(evidence: any) => void> = [
      (evidence) => { delete evidence.head; },
      (evidence) => { evidence.configuration.models.observedAgentConfiguration[1].effort = "medium"; },
      (evidence) => { evidence.liveN1.runs.pop(); },
      (evidence) => { delete evidence.liveN1.mission.mission.aggregate.n1.contributions[0].commit; },
      (evidence) => { evidence.liveN1.runs[1].agentId = "beta"; },
      (evidence) => { evidence.configuration.models.observedAgentConfiguration[1].agentId = "someone-else"; },
      (evidence) => { evidence.liveN1.leadRunBarrier.observedRunIds.push("unexpected-lead-run"); },
      (evidence) => { delete evidence.liveN1.mission.mission.aggregate.n1.candidate; },
      (evidence) => { evidence.liveN1.mission.mission.aggregate.n1.candidate.contributions[0].commit = "9".repeat(40); },
      (evidence) => { evidence.liveN1.mission.mission.aggregate.journal = []; },
      (evidence) => { delete evidence.liveN1.ui; },
      (evidence) => {
        evidence.liveN1.mission.n1.participants[1] = structuredClone(evidence.liveN1.mission.n1.participants[0]);
      },
    ];
    for (const mutate of mutations) {
      const evidence = qualificationEvidence("live");
      mutate(evidence);
      expect(() => assertQualificationEvidence(evidence, options)).toThrow(/Qualification evidence contract failed/);
    }
    expect(() => assertQualificationEvidence(qualificationEvidence("live"), {
      ...options, screenshotBytes: Buffer.from("not-a-png"),
    })).toThrow(/PNG signature/);
  });

  it("stops after blocked host preparation without inspecting or starting a later phase", async () => {
    const phases: string[] = [];
    await expect(prepareQualificationHost({
      run: async (command: string, args: string[], options: { timeoutMs: number }) => {
        expect(command).toBe(process.execPath);
        expect(args.at(-1)).toBe("prepare");
        phases.push(`prepare:${options.timeoutMs}`);
        throw new Error("host preparation blocked");
      },
      inspect: () => {
        phases.push("inspect");
        return { prepared: true, runtimeReady: true };
      },
      timeoutMs: 321,
      env: {},
    })).rejects.toThrow(/host preparation blocked/);
    expect(phases).toEqual(["prepare:321"]);
  });

  it("inspects the host only after successful bounded preparation", async () => {
    const phases: string[] = [];
    const host = { prepared: true, runtimeReady: true, target: "/tmp/qualified-paperclip" };
    await expect(prepareQualificationHost({
      run: async () => { phases.push("prepare"); },
      inspect: () => {
        phases.push("inspect");
        return host;
      },
      timeoutMs: 321,
      env: {},
    })).resolves.toBe(host);
    expect(phases).toEqual(["prepare", "inspect"]);
  });

  it("preserves only runtimes whose process group failed to drain", async () => {
    const cleaned: string[] = [];
    const policy = {
      createRuntime: () => "/tmp/owned-qualification-runtime",
      cleanupRuntime: (runtime: string) => { cleaned.push(runtime); },
    };

    await expect(withOwnedQualificationRuntime(async () => "success", policy)).resolves.toBe("success");
    expect(cleaned).toEqual(["/tmp/owned-qualification-runtime"]);

    cleaned.length = 0;
    await expect(withOwnedQualificationRuntime(async () => {
      throw new Error("functional evidence rejected");
    }, policy)).rejects.toThrow(/functional evidence rejected/);
    expect(cleaned).toEqual(["/tmp/owned-qualification-runtime"]);

    cleaned.length = 0;
    const drainFailure = new ProcessGroupDrainError(4242, 250);
    await expect(withOwnedQualificationRuntime(async () => {
      throw drainFailure;
    }, policy)).rejects.toMatchObject({
      code: "PROCESS_GROUP_DRAIN_TIMEOUT",
      preservedRuntime: "/tmp/owned-qualification-runtime",
    });
    expect(drainFailure.message).toMatch(/runtime preserved at \/tmp\/owned-qualification-runtime/);
    expect(cleaned).toEqual([]);
  });

  it("preserves the runtime when the supervisor cannot prove the group drained", async () => {
    const cleaned: string[] = [];
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    let processCleanupCalls = 0;
    const gracefulSignalFailure = Object.assign(new Error("graceful signal denied"), { code: "EPERM" });
    const forcedSignalFailure = Object.assign(new Error("forced signal denied"), { code: "EPERM" });
    const signals: NodeJS.Signals[] = [];

    const failure = await withOwnedQualificationRuntime(async () => {
      await runProcessGroup("/command-that-does-not-exist", [], {
        timeoutMs: 5_000,
        terminationGraceMs: 1,
        signal: (_child: unknown, _processGroupId: number | undefined, signalName: NodeJS.Signals) => {
          signals.push(signalName);
          if (signalName === "SIGTERM") throw gracefulSignalFailure;
          throw forcedSignalFailure;
        },
        waitForExit: async () => { throw new Error("drain must not run after forced signaling fails"); },
        onFailure: async () => { processCleanupCalls += 1; },
      });
    }, {
      createRuntime: () => "/tmp/exact-undrained-runtime",
      cleanupRuntime: (runtime: string) => { cleaned.push(runtime); },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "PROCESS_GROUP_DRAIN_FAILED",
      cause: forcedSignalFailure,
      preservedRuntime: "/tmp/exact-undrained-runtime",
    });
    expect((failure as { cause: unknown }).cause).toBe(forcedSignalFailure);
    expect(String((failure as Error).message)).toMatch(/runtime preserved at \/tmp\/exact-undrained-runtime/);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(processCleanupCalls).toBe(0);
    expect(cleaned).toEqual([]);
    expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
  });

  it("preserves the runtime when a successful leader has an undrained group", async () => {
    const cleaned: string[] = [];
    let processCleanupCalls = 0;

    const failure = await withOwnedQualificationRuntime(async () => {
      await runProcessGroup(process.execPath, ["-e", "process.exit(0)"], {
        timeoutMs: 5_000,
        terminationGraceMs: 25,
        waitForExit: async () => { throw new ProcessGroupDrainError(7331, 25); },
        onFailure: async () => { processCleanupCalls += 1; },
      });
    }, {
      createRuntime: () => "/tmp/exact-success-undrained-runtime",
      cleanupRuntime: (runtime: string) => { cleaned.push(runtime); },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "PROCESS_GROUP_DRAIN_TIMEOUT",
      processGroupId: 7331,
      preservedRuntime: "/tmp/exact-success-undrained-runtime",
    });
    expect(processCleanupCalls).toBe(0);
    expect(cleaned).toEqual([]);
  });
});
