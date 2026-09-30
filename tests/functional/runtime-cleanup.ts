import { rm } from "node:fs/promises";

type RuntimeCleanupOptions = {
  runtime: string;
  parentOwned: boolean;
  appShutdownSafe: boolean;
  cleanupDatabase: () => Promise<void>;
  removeRuntime?: (runtime: string) => Promise<void>;
};

type RuntimeCleanupResult = {
  databaseCleaned: boolean;
  appShutdownSafe: boolean;
  runtimeRemoved: boolean;
  failureStage?: "database" | "runtime";
  error?: unknown;
};

async function cleanupFunctionalRuntime({
  runtime,
  parentOwned,
  appShutdownSafe,
  cleanupDatabase,
  removeRuntime = (target) => rm(target, { recursive: true, force: true }),
}: RuntimeCleanupOptions): Promise<RuntimeCleanupResult> {
  try {
    await cleanupDatabase();
  } catch (error) {
    return { databaseCleaned: false, appShutdownSafe, runtimeRemoved: false, failureStage: "database", error };
  }

  if (parentOwned || !appShutdownSafe) {
    return { databaseCleaned: true, appShutdownSafe, runtimeRemoved: false };
  }

  try {
    await removeRuntime(runtime);
    return { databaseCleaned: true, appShutdownSafe, runtimeRemoved: true };
  } catch (error) {
    return { databaseCleaned: true, appShutdownSafe, runtimeRemoved: false, failureStage: "runtime", error };
  }
}

export function createFunctionalRuntimeCleanup({
  runtime,
  parentOwned,
  removeRuntime,
}: Pick<RuntimeCleanupOptions, "runtime" | "parentOwned" | "removeRuntime">) {
  let result: Promise<RuntimeCleanupResult> | undefined;
  const runOnce = (options: Pick<RuntimeCleanupOptions, "appShutdownSafe" | "cleanupDatabase">) => {
    result ??= cleanupFunctionalRuntime({ runtime, parentOwned, removeRuntime, ...options });
    return result;
  };
  return {
    runAfterShutdown: runOnce,
    runEarlyFailure: () => runOnce({ appShutdownSafe: true, cleanupDatabase: async () => undefined }),
  };
}
