import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The qualification process runner is intentionally plain ESM.
import { runProcessGroup } from "../scripts/qualification/process-group.mjs";
// @ts-expect-error The qualification runtime helper is intentionally plain ESM.
import { cleanupOwnedRuntime, createOwnedRuntime } from "../scripts/qualification/runtime-ownership.mjs";

const roots: string[] = [];
const termResistantDescendantScript = `
  const { writeFileSync } = require("node:fs");
  const [readyPath] = process.argv.slice(1);
  process.on("SIGTERM", () => {});
  writeFileSync(readyPath, "ready");
  setInterval(() => {}, 1_000);
`;
function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const stateOffset = stat.lastIndexOf(") ") + 2;
      return !["Z", "X"].includes(stat.at(stateOffset) ?? "");
    }
    return true;
  } catch {
    return false;
  }
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded qualification process groups", () => {
  it("kills descendants and runs bounded cleanup after a timeout", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-process-group-"));
    roots.push(root);
    const pidPath = resolve(root, "descendant.pid");
    const runtimePath = resolve(root, "paperclip-council-package-timeout");
    await expect(runProcessGroup("bash", ["-lc", '(trap "" TERM; while :; do sleep 1; done) & echo "$!" > "$1"; mkdir "$2"; wait', "bash", pidPath, runtimePath], {
      timeoutMs: 500,
      terminationGraceMs: 100,
      onFailure: async () => rmSync(runtimePath, { recursive: true, force: true }),
    })).rejects.toThrow(/timed out/);
    const descendantPid = Number(readFileSync(pidPath, "utf8").trim());
    expect(() => execFileSync("kill", ["-0", String(descendantPid)])).toThrow();
    expect(existsSync(runtimePath)).toBe(false);
  });

  it("keeps forced termination alive after the group leader exits", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-process-group-leader-exit-"));
    roots.push(root);
    const pidPath = resolve(root, "descendant.pid");
    const runtimePath = resolve(root, "paperclip-council-package-timeout");
    const cleanupPath = resolve(root, "cleanup-complete");
    const readyPath = resolve(root, "leader-ready");
    const descendantReadyPath = resolve(root, "descendant-ready");
    const processGroupModule = pathToFileURL(resolve("scripts/qualification/process-group.mjs")).href;
    const leaderScript = `
      const { spawn } = require("node:child_process");
      const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
      const [pidPath, runtimePath, readyPath, descendantReadyPath, descendantScript] = process.argv.slice(1);
      const descendant = spawn(process.execPath, ["-e", descendantScript, descendantReadyPath], { stdio: "ignore" });
      writeFileSync(pidPath, String(descendant.pid));
      mkdirSync(runtimePath);
      process.on("SIGTERM", () => process.exit(0));
      const readiness = setInterval(() => {
        if (existsSync(descendantReadyPath)) {
          clearInterval(readiness);
          writeFileSync(readyPath, "ready");
        }
      }, 5);
    `;
    const runnerScript = `
      import { appendFileSync, existsSync, rmSync } from "node:fs";
      import { runProcessGroup } from ${JSON.stringify(processGroupModule)};
      const [pidPath, runtimePath, cleanupPath, readyPath, descendantReadyPath, leaderScript, descendantScript] = process.argv.slice(1);
      const initialSigintListeners = process.listenerCount("SIGINT");
      const initialSigtermListeners = process.listenerCount("SIGTERM");
      const run = runProcessGroup(process.execPath, ["-e", leaderScript, pidPath, runtimePath, readyPath, descendantReadyPath, descendantScript], {
        timeoutMs: 5_000,
        terminationGraceMs: 150,
        onFailure: async () => {
          rmSync(runtimePath, { recursive: true, force: true });
          appendFileSync(cleanupPath, "start\\n");
          process.kill(process.pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 50));
          appendFileSync(cleanupPath, "complete\\n");
        },
      });
      const readiness = setInterval(() => {
        if (existsSync(readyPath)) {
          clearInterval(readiness);
          process.kill(process.pid, "SIGTERM");
          setTimeout(() => process.kill(process.pid, "SIGINT"), 25);
        }
      }, 10);
      try {
        await run;
      } catch (error) {
        if (!String(error).includes("cancelled by SIGTERM")) throw error;
      } finally {
        clearInterval(readiness);
      }
      if (process.listenerCount("SIGINT") !== initialSigintListeners
        || process.listenerCount("SIGTERM") !== initialSigtermListeners) {
        throw new Error("qualification signal listeners were not removed exactly once");
      }
    `;

    let runnerError: unknown;
    let descendantPid: number | undefined;
    try {
      execFileSync(process.execPath, [
        "--input-type=module", "-e", runnerScript, pidPath, runtimePath, cleanupPath, readyPath,
        descendantReadyPath, leaderScript, termResistantDescendantScript,
      ], { stdio: "ignore", timeout: 10_000 });
    } catch (error) {
      runnerError = error;
    }
    if (existsSync(pidPath)) descendantPid = Number(readFileSync(pidPath, "utf8").trim());
    try {
      expect(runnerError).toBeUndefined();
      expect(descendantPid).toBeTypeOf("number");
      expect(readFileSync(descendantReadyPath, "utf8")).toBe("ready");
      expect(readFileSync(readyPath, "utf8")).toBe("ready");
      expect(processIsRunning(descendantPid!)).toBe(false);
      expect(existsSync(runtimePath)).toBe(false);
      expect(readFileSync(cleanupPath, "utf8")).toBe("start\ncomplete\n");
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already terminated as expected. */ }
      }
    }
  });

  it("terminates descendants before cleanup after a spontaneous leader failure", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-process-group-spontaneous-"));
    roots.push(root);
    const pidPath = resolve(root, "descendant.pid");
    const runtimePath = resolve(root, "paperclip-council-package-spontaneous");
    const descendantReadyPath = resolve(root, "descendant-ready");
    const leaderScript = `
      const { spawn } = require("node:child_process");
      const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
      const [pidPath, runtimePath, descendantReadyPath, descendantScript] = process.argv.slice(1);
      const descendant = spawn(process.execPath, ["-e", descendantScript, descendantReadyPath], { stdio: "ignore" });
      writeFileSync(pidPath, String(descendant.pid));
      mkdirSync(runtimePath);
      const readiness = setInterval(() => {
        if (existsSync(descendantReadyPath)) {
          clearInterval(readiness);
          process.exit(7);
        }
      }, 5);
    `;
    let descendantPid: number | undefined;
    try {
      await expect(runProcessGroup(process.execPath, [
        "-e", leaderScript, pidPath, runtimePath, descendantReadyPath, termResistantDescendantScript,
      ], {
        timeoutMs: 5_000,
        terminationGraceMs: 100,
        onFailure: async () => rmSync(runtimePath, { recursive: true, force: true }),
      })).rejects.toThrow(/exited 7/);
      descendantPid = Number(readFileSync(pidPath, "utf8").trim());
      expect(readFileSync(descendantReadyPath, "utf8")).toBe("ready");
      expect(processIsRunning(descendantPid!)).toBe(false);
      expect(existsSync(runtimePath)).toBe(false);
    } finally {
      if (!descendantPid && existsSync(pidPath)) descendantPid = Number(readFileSync(pidPath, "utf8").trim());
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already terminated as expected. */ }
      }
    }
  });

  it("converges spawn errors through exactly one cleanup and restores signal listeners", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-process-group-spawn-error-"));
    roots.push(root);
    const missingCommand = resolve(root, "command-does-not-exist");
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    let cleanupCalls = 0;

    await expect(runProcessGroup(missingCommand, [], {
      timeoutMs: 5_000,
      terminationGraceMs: 25,
      onFailure: async () => { cleanupCalls += 1; },
    })).rejects.toThrow(/ENOENT/);

    expect(cleanupCalls).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
  });

  it("terminates descendants before cleanup after a signal-terminated leader", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-process-group-signal-exit-"));
    roots.push(root);
    const pidPath = resolve(root, "descendant.pid");
    const runtimePath = resolve(root, "paperclip-council-package-signal-exit");
    const descendantReadyPath = resolve(root, "descendant-ready");
    const leaderScript = `
      const { spawn } = require("node:child_process");
      const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
      const [pidPath, runtimePath, descendantReadyPath, descendantScript] = process.argv.slice(1);
      const descendant = spawn(process.execPath, ["-e", descendantScript, descendantReadyPath], { stdio: "ignore" });
      writeFileSync(pidPath, String(descendant.pid));
      mkdirSync(runtimePath);
      const readiness = setInterval(() => {
        if (existsSync(descendantReadyPath)) {
          clearInterval(readiness);
          process.kill(process.pid, "SIGTERM");
        }
      }, 5);
    `;
    let descendantPid: number | undefined;
    let descendantDeadBeforeCleanup = false;
    try {
      await expect(runProcessGroup(process.execPath, [
        "-e", leaderScript, pidPath, runtimePath, descendantReadyPath, termResistantDescendantScript,
      ], {
        timeoutMs: 5_000,
        terminationGraceMs: 100,
        onFailure: async () => {
          descendantPid = Number(readFileSync(pidPath, "utf8").trim());
          descendantDeadBeforeCleanup = !processIsRunning(descendantPid);
          rmSync(runtimePath, { recursive: true, force: true });
        },
      })).rejects.toThrow(/exited SIGTERM/);
      expect(readFileSync(descendantReadyPath, "utf8")).toBe("ready");
      expect(descendantDeadBeforeCleanup).toBe(true);
      expect(existsSync(runtimePath)).toBe(false);
    } finally {
      if (!descendantPid && existsSync(pidPath)) descendantPid = Number(readFileSync(pidPath, "utf8").trim());
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already terminated as expected. */ }
      }
    }
  });

  it("cleans only the exact launcher-owned runtime", async () => {
    const owned = createOwnedRuntime();
    const foreign = createOwnedRuntime();
    roots.push(foreign);
    cleanupOwnedRuntime(owned);
    expect(existsSync(owned)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });
});
