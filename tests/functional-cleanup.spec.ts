import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFunctionalRuntimeCleanup } from "./functional/runtime-cleanup.js";

const roots: string[] = [];

async function runtime() {
  const root = await mkdtemp(resolve(tmpdir(), "paperclip-council-package-cleanup-"));
  roots.push(root);
  return root;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("functional runtime cleanup ownership", () => {
  it("never deletes a supplied parent-owned runtime after an early failure", async () => {
    const parentOwnedRuntime = await runtime();
    let lateDatabaseCleanupCalls = 0;
    let removalCalls = 0;
    const cleanup = createFunctionalRuntimeCleanup({
      runtime: parentOwnedRuntime,
      parentOwned: true,
      removeRuntime: async () => { removalCalls += 1; },
    });

    const result = await cleanup.runEarlyFailure();
    await cleanup.runAfterShutdown({
      appShutdownSafe: false,
      cleanupDatabase: async () => { lateDatabaseCleanupCalls += 1; },
    });

    expect(result).toEqual({ databaseCleaned: true, appShutdownSafe: true, runtimeRemoved: false });
    expect(lateDatabaseCleanupCalls).toBe(0);
    expect(removalCalls).toBe(0);
    expect(existsSync(parentOwnedRuntime)).toBe(true);
  });

  it("never deletes a supplied parent-owned runtime after database cleanup failure", async () => {
    const parentOwnedRuntime = await runtime();
    const cleanupFailure = new Error("parent database cleanup failed");
    const cleanup = createFunctionalRuntimeCleanup({ runtime: parentOwnedRuntime, parentOwned: true });
    const result = await cleanup.runAfterShutdown({
      appShutdownSafe: true,
      cleanupDatabase: async () => { throw cleanupFailure; },
    });

    expect(result.error).toBe(cleanupFailure);
    expect(result.runtimeRemoved).toBe(false);
    expect(existsSync(parentOwnedRuntime)).toBe(true);
  });

  it("preserves a standalone runtime when database cleanup fails", async () => {
    const standaloneRuntime = await runtime();
    const cleanupFailure = new Error("embedded database cleanup failed");

    const cleanup = createFunctionalRuntimeCleanup({
      runtime: standaloneRuntime,
      parentOwned: false,
    });
    const result = await cleanup.runAfterShutdown({
      appShutdownSafe: true,
      cleanupDatabase: async () => { throw cleanupFailure; },
    });

    expect(result).toEqual({
      databaseCleaned: false,
      appShutdownSafe: true,
      runtimeRemoved: false,
      failureStage: "database",
      error: cleanupFailure,
    });
    expect(result.error).toBe(cleanupFailure);
    expect(existsSync(standaloneRuntime)).toBe(true);
  });

  it("removes a standalone runtime once after successful shutdown", async () => {
    const standaloneRuntime = await runtime();
    let databaseCleanupCalls = 0;
    const cleanup = createFunctionalRuntimeCleanup({ runtime: standaloneRuntime, parentOwned: false });
    await expect(cleanup.runAfterShutdown({
      appShutdownSafe: true,
      cleanupDatabase: async () => { databaseCleanupCalls += 1; },
    })).resolves.toEqual({ databaseCleaned: true, appShutdownSafe: true, runtimeRemoved: true });
    await cleanup.runEarlyFailure();
    expect(databaseCleanupCalls).toBe(1);
    expect(existsSync(standaloneRuntime)).toBe(false);
  });

  it("removes a standalone runtime after a safe early failure", async () => {
    const standaloneRuntime = await runtime();
    const cleanup = createFunctionalRuntimeCleanup({ runtime: standaloneRuntime, parentOwned: false });
    await expect(cleanup.runEarlyFailure()).resolves.toEqual({
      databaseCleaned: true,
      appShutdownSafe: true,
      runtimeRemoved: true,
    });
    expect(existsSync(standaloneRuntime)).toBe(false);
  });

  it("retains a standalone runtime when application shutdown is not proven", async () => {
    const standaloneRuntime = await runtime();
    let databaseCleanupCalls = 0;
    const cleanup = createFunctionalRuntimeCleanup({ runtime: standaloneRuntime, parentOwned: false });

    await expect(cleanup.runAfterShutdown({
      appShutdownSafe: false,
      cleanupDatabase: async () => { databaseCleanupCalls += 1; },
    })).resolves.toEqual({ databaseCleaned: true, appShutdownSafe: false, runtimeRemoved: false });

    expect(databaseCleanupCalls).toBe(1);
    expect(existsSync(standaloneRuntime)).toBe(true);
  });

  it("reports a standalone runtime removal failure without claiming cleanup", async () => {
    const standaloneRuntime = await runtime();
    const removalFailure = new Error("runtime removal denied");
    let databaseCleanupCalls = 0;
    let removalCalls = 0;
    const cleanup = createFunctionalRuntimeCleanup({
      runtime: standaloneRuntime,
      parentOwned: false,
      removeRuntime: async () => {
        removalCalls += 1;
        throw removalFailure;
      },
    });
    const result = await cleanup.runAfterShutdown({
      appShutdownSafe: true,
      cleanupDatabase: async () => { databaseCleanupCalls += 1; },
    });
    await cleanup.runEarlyFailure();

    expect(result).toEqual({
      databaseCleaned: true,
      appShutdownSafe: true,
      runtimeRemoved: false,
      failureStage: "runtime",
      error: removalFailure,
    });
    expect(databaseCleanupCalls).toBe(1);
    expect(removalCalls).toBe(1);
    expect(result.error).toBe(removalFailure);
    expect(existsSync(standaloneRuntime)).toBe(true);
  });
});
