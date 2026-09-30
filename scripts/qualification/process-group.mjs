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
      ? `Could not prove process group ${processGroupId} drained: ${cause.message ?? String(cause)}`
      : `Process group ${processGroupId} did not drain within ${boundedTimeoutMs} ms`);
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
  signal = signalProcessGroup,
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
    let settled = false;
    let listenersRemoved = false;
    const removeSignalListeners = () => {
      if (listenersRemoved) return;
      listenersRemoved = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const rejectOnce = (error, { unrefChild = false } = {}) => {
      if (settled) return;
      settled = true;
      removeSignalListeners();
      if (unrefChild) child.unref();
      reject(error);
    };
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      try {
        signal(child, processGroupId, "SIGTERM");
      } catch {
        // A failed graceful signal must not prevent the forced drain attempt.
      }
      forceTimer = setTimeout(async () => {
        try {
          signal(child, processGroupId, "SIGKILL");
          await waitForExit(processGroupId, terminationGraceMs);
        } catch (error) {
          forceError = isProcessGroupDrainError(error)
            ? error
            : new ProcessGroupDrainError(processGroupId, terminationGraceMs, error);
        } finally {
          forceComplete();
        }
        if (forceError) rejectOnce(forceError, { unrefChild: true });
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
      if (settled) return;
      if (code === 0 && !terminationReason) {
        clearTimeout(forceTimer);
        try {
          await waitForExit(processGroupId, terminationGraceMs);
        } catch (error) {
          const drainError = isProcessGroupDrainError(error)
            ? error
            : new ProcessGroupDrainError(processGroupId, terminationGraceMs, error);
          rejectOnce(drainError, { unrefChild: true });
          return;
        }
        if (!terminationReason) {
          settled = true;
          removeSignalListeners();
          resolve();
          return;
        }
      }
      if (!terminationReason) terminate(`exited ${code ?? signal}`);
      await forced;
      if (settled) return;
      let cleanupError;
      try {
        await onFailure();
      } catch (error) {
        cleanupError = error;
      } finally {
        removeSignalListeners();
      }
      if (cleanupError) {
        rejectOnce(new AggregateError(
          [cleanupError],
          `${command} failed during cleanup`,
        ));
      } else {
        rejectOnce(new Error(`${command} ${terminationReason}`));
      }
    });
  });
}
