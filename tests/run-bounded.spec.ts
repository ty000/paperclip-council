import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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
import { __claimLiveEvidencePathsForTest, assertQualificationEvidence, claimLiveEvidencePaths, LIVE_RESULT_KEYS, SAFE_RESULT_KEYS } from "../scripts/qualification/evidence-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    candidate: { commit: "a".repeat(40), clean: true },
    outcome: live ? "N1 OBSERVABLE RESULT VALIDATED" : "N1 SAFE BOUNDARY VALIDATED",
    results,
    appCleanup: "stopped only the plugin worker, listener, and application created by this run",
    databaseCleanup: "fresh isolated PostgreSQL cluster removed; parent-owned temporary instance retained",
    configuration: {
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

      expect(() => claimLiveEvidencePaths(root, commit, resolve(root, "unqualified.json")))
        .toThrow(/must be JSON and contain candidate commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claims live artifact paths before host inspection or provider-capable work", () => {
    const launcherSource = readFileSync(resolve(packageRoot, "scripts/qualification/run-live-n1.mjs"), "utf8");
    const claimAt = launcherSource.indexOf("const { evidencePath, screenshotPath } = claimLiveEvidencePaths(");
    const hostAt = launcherSource.indexOf("const host = preparedHost();", claimAt);
    const browserAt = launcherSource.indexOf("await installChromium(host", claimAt);
    const runtimeAt = launcherSource.indexOf("await withOwnedQualificationRuntime", claimAt);
    expect(claimAt).toBeGreaterThan(-1);
    expect(hostAt).toBeGreaterThan(claimAt);
    expect(browserAt).toBeGreaterThan(hostAt);
    expect(runtimeAt).toBeGreaterThan(browserAt);
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
      writeFileSync(claimed.evidencePath, "claimed evidence");
      writeFileSync(claimed.screenshotPath, "claimed screenshot");
      expect(() => claimLiveEvidencePaths(root, successCommit, undefined))
        .toThrow(/already exists; refusing to overwrite/);
      expect(readFileSync(claimed.evidencePath, "utf8")).toBe("claimed evidence");
      expect(readFileSync(claimed.screenshotPath, "utf8")).toBe("claimed screenshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      mode: "live", candidateCommit: "a".repeat(40), notBefore,
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
      mode: "live", candidateCommit: "a".repeat(40), notBefore,
    })).toThrow(/unexpected=\[unexpectedProof\]/);

    const incompleteLive = qualificationEvidence("live");
    delete incompleteLive.results.n1InstalledBrowserObservableState;
    expect(() => assertQualificationEvidence(incompleteLive, {
      mode: "live", candidateCommit: "a".repeat(40), notBefore,
    })).toThrow(/missing=\[n1InstalledBrowserObservableState\]/);
  });

  it("rejects stale, cleanup-incomplete, boundary-incomplete, and unsettled evidence", () => {
    const options = { mode: "live", candidateCommit: "a".repeat(40), notBefore: Date.parse("2026-10-01T09:59:59.000Z") };
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
