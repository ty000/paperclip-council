import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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

  it("cleans only the exact launcher-owned runtime", async () => {
    const owned = createOwnedRuntime();
    const foreign = createOwnedRuntime();
    roots.push(foreign);
    cleanupOwnedRuntime(owned);
    expect(existsSync(owned)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });
});
