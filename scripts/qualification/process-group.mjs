import { spawn } from "node:child_process";

function signalProcessGroup(child, processGroupId, signal) {
  try {
    if (process.platform !== "win32" && processGroupId) process.kill(-processGroupId, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  if (process.platform === "win32" || !processGroupId) {
    await new Promise((resolve) => setImmediate(resolve));
    return;
  }
  const deadline = Date.now() + Math.max(timeoutMs, 100);
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function runProcessGroup(command, args, {
  cwd,
  env,
  timeoutMs,
  terminationGraceMs = 5_000,
  onFailure = async () => undefined,
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
          await waitForProcessGroupExit(processGroupId, terminationGraceMs);
        } catch (error) {
          forceError = error;
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
      let cleanupError;
      try {
        await onFailure();
      } catch (error) {
        cleanupError = error;
      } finally {
        removeSignalListeners();
      }
      if (forceError || cleanupError) {
        reject(new AggregateError(
          [forceError, cleanupError].filter(Boolean),
          `${command} failed during forced termination or cleanup`,
        ));
      } else {
        reject(new Error(`${command} ${terminationReason}`));
      }
    });
  });
}
