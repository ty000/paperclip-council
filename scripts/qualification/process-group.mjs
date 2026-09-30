import { spawn } from "node:child_process";

function signalProcessGroup(child, processGroupId, signal) {
  try {
    if (process.platform !== "win32" && processGroupId) process.kill(-processGroupId, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export class ProcessGroupDrainError extends Error {
  constructor(processGroupId, timeoutMs, cause) {
    const boundedTimeoutMs = Math.max(timeoutMs, 100);
    super(cause
      ? `Could not prove process group ${processGroupId} drained after SIGKILL: ${cause.message ?? String(cause)}`
      : `Process group ${processGroupId} did not drain within ${boundedTimeoutMs} ms after SIGKILL`);
    this.name = "ProcessGroupDrainError";
    this.code = cause ? "PROCESS_GROUP_DRAIN_FAILED" : "PROCESS_GROUP_DRAIN_TIMEOUT";
    this.processGroupId = processGroupId;
    this.timeoutMs = boundedTimeoutMs;
    if (cause) this.cause = cause;
  }
}

export function isProcessGroupDrainError(error) {
  return error instanceof ProcessGroupDrainError
    || error?.code === "PROCESS_GROUP_DRAIN_TIMEOUT"
    || error?.code === "PROCESS_GROUP_DRAIN_FAILED";
}

function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function waitForProcessGroupExit(processGroupId, timeoutMs, {
  isAlive = processGroupIsAlive,
  now = Date.now,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (process.platform === "win32" || !processGroupId) {
    await new Promise((resolve) => setImmediate(resolve));
    return;
  }
  const boundedTimeoutMs = Math.max(timeoutMs, 100);
  const deadline = now() + boundedTimeoutMs;
  while (now() < deadline) {
    if (!isAlive(processGroupId)) return;
    await sleep(10);
  }
  if (!isAlive(processGroupId)) return;
  throw new ProcessGroupDrainError(processGroupId, boundedTimeoutMs);
}

export function runProcessGroup(command, args, {
  cwd,
  env,
  timeoutMs,
  terminationGraceMs = 5_000,
  onFailure = async () => undefined,
  waitForExit = waitForProcessGroupExit,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    const processGroupId = process.platform !== "win32" ? child.pid : undefined;
    let terminationReason;
    let forceTimer;
    let forceError;
    let forceComplete;
    const forced = new Promise((resolve) => { forceComplete = resolve; });
    let listenersRemoved = false;
    const removeSignalListeners = () => {
      if (listenersRemoved) return;
      listenersRemoved = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      signalProcessGroup(child, processGroupId, "SIGTERM");
      forceTimer = setTimeout(async () => {
        try {
          signalProcessGroup(child, processGroupId, "SIGKILL");
          await waitForExit(processGroupId, terminationGraceMs);
        } catch (error) {
          forceError = isProcessGroupDrainError(error)
            ? error
            : new ProcessGroupDrainError(processGroupId, terminationGraceMs, error);
        } finally {
          forceComplete();
        }
      }, terminationGraceMs);
    };
    const timeout = setTimeout(() => terminate(`timed out after ${timeoutMs} ms`), timeoutMs);
    timeout.unref();
    const onSigint = () => terminate("cancelled by SIGINT");
    const onSigterm = () => terminate("cancelled by SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", (error) => {
      terminate(error.message);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !terminationReason) {
        clearTimeout(forceTimer);
        removeSignalListeners();
        resolve();
        return;
      }
      if (!terminationReason) terminate(`exited ${code ?? signal}`);
      await forced;
      if (forceError) {
        removeSignalListeners();
        reject(forceError);
        return;
      }
      let cleanupError;
      try {
        await onFailure();
      } catch (error) {
        cleanupError = error;
      } finally {
        removeSignalListeners();
      }
      if (cleanupError) {
        reject(new AggregateError(
          [cleanupError],
          `${command} failed during cleanup`,
        ));
      } else {
        reject(new Error(`${command} ${terminationReason}`));
      }
    });
  });
}
