import { spawn } from "node:child_process";

function signalProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
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
    let terminationReason;
    let forceTimer;
    let forceComplete;
    const forced = new Promise((resolve) => { forceComplete = resolve; });
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      signalProcessGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
        forceComplete();
      }, terminationGraceMs);
      forceTimer.unref();
    };
    const timeout = setTimeout(() => terminate(`timed out after ${timeoutMs} ms`), timeoutMs);
    timeout.unref();
    const onSigint = () => terminate("cancelled by SIGINT");
    const onSigterm = () => terminate("cancelled by SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", (error) => {
      terminate(error.message);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (code === 0 && !terminationReason) {
        clearTimeout(forceTimer);
        resolve();
        return;
      }
      if (terminationReason) await forced;
      else clearTimeout(forceTimer);
      try {
        await onFailure();
      } catch (cleanupError) {
        reject(new AggregateError([cleanupError], `${command} failed and cleanup failed`));
        return;
      }
      reject(new Error(`${command} ${terminationReason ?? `exited ${code ?? signal}`}`));
    });
  });
}
