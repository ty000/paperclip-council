import { describe, expect, it } from "vitest";
// @ts-expect-error The qualification launcher is intentionally plain ESM.
import { ProcessGroupDrainError, runProcessGroup } from "../scripts/qualification/process-group.mjs";
// @ts-expect-error The qualification launcher is intentionally plain ESM.
import { prepareQualificationHost, withOwnedQualificationRuntime } from "../scripts/qualification/run-bounded.mjs";

describe("bounded qualification launcher", () => {
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
