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
    const processGroupModule = pathToFileURL(resolve("scripts/qualification/process-group.mjs")).href;
    const leaderScript = `
      const { spawn } = require("node:child_process");
      const { mkdirSync, writeFileSync } = require("node:fs");
      const [pidPath, runtimePath, readyPath] = process.argv.slice(1);
      const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], { stdio: "ignore" });
      writeFileSync(pidPath, String(descendant.pid));
      mkdirSync(runtimePath);
      process.on("SIGTERM", () => process.exit(0));
      writeFileSync(readyPath, "ready");
      setInterval(() => {}, 1_000);
    `;
    const runnerScript = `
      import { existsSync, rmSync, writeFileSync } from "node:fs";
      import { runProcessGroup } from ${JSON.stringify(processGroupModule)};
      const [pidPath, runtimePath, cleanupPath, readyPath, leaderScript] = process.argv.slice(1);
      const run = runProcessGroup(process.execPath, ["-e", leaderScript, pidPath, runtimePath, readyPath], {
        timeoutMs: 5_000,
        terminationGraceMs: 150,
        onFailure: async () => {
          rmSync(runtimePath, { recursive: true, force: true });
          writeFileSync(cleanupPath, "complete");
        },
      });
      const readiness = setInterval(() => {
        if (existsSync(readyPath)) {
          clearInterval(readiness);
          process.kill(process.pid, "SIGTERM");
        }
      }, 10);
      try {
        await run;
      } catch (error) {
        if (!String(error).includes("cancelled by SIGTERM")) throw error;
      } finally {
        clearInterval(readiness);
      }
    `;

    let runnerError: unknown;
    let descendantPid: number | undefined;
    try {
      execFileSync(process.execPath, [
        "--input-type=module", "-e", runnerScript, pidPath, runtimePath, cleanupPath, readyPath, leaderScript,
      ], { stdio: "ignore", timeout: 10_000 });
    } catch (error) {
      runnerError = error;
    }
    if (existsSync(pidPath)) descendantPid = Number(readFileSync(pidPath, "utf8").trim());
    try {
      expect(runnerError).toBeUndefined();
      expect(descendantPid).toBeTypeOf("number");
      expect(readFileSync(readyPath, "utf8")).toBe("ready");
      expect(() => process.kill(descendantPid!, 0)).toThrow();
      expect(existsSync(runtimePath)).toBe(false);
      expect(readFileSync(cleanupPath, "utf8")).toBe("complete");
    } finally {
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
