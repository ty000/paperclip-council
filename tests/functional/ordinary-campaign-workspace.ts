import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digestDirectory } from "./candidate-package.js";

/** Add Git identity to the already isolated, frozen-lockfile-installed package; this exact path stays installed. */
export async function prepareOrdinaryWorkspace(repository: string, source: string, profile: any) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("fetch", "--no-tags", source, profile.candidateSha); git("reset", "--mixed", "FETCH_HEAD");
  git("switch", "-c", profile.headRef); git("remote", "add", "origin", `https://github.com/${profile.repository}.git`);
  git("config", "user.name", "Council Delivery Campaign"); git("config", "user.email", "council-delivery@localhost");
  assert.equal(git("rev-parse", "HEAD"), profile.candidateSha); assert.equal(git("status", "--porcelain"), "");
  const dependency = await realpath(resolve(repository, "node_modules/typescript"));
  assert(dependency.startsWith(repository + "/"), "Mission dependencies must not link into the source checkout");
  const lockHash = await readFile(resolve(repository, "pnpm-lock.yaml"));
  const output = profile.mode === "prepare"
    ? execFileSync(process.execPath, ["scripts/ci/run-checks.mjs"], { cwd: repository, encoding: "utf8", timeout: 120000 })
    : execFileSync("pnpm", ["build"], { cwd: repository, encoding: "utf8", timeout: 120000 });
  assert.deepEqual(await readFile(resolve(repository, "pnpm-lock.yaml")), lockHash);
  assert.equal(git("status", "--porcelain"), "");
  await writeFile(resolve(repository, "../ordinary-workspace-checks.log"), output);
  return { sourceCommit: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), packagePath: repository,
    dependencyMode: "existing isolated frozen-lockfile installation; internal dependency links only; no source checkout link or auth copy",
    checksOutput: output, checks: profile.mode === "prepare" ? "typecheck/test/build passed inside mission workspace" : "build passed inside mission workspace; canonical suite belongs to prepare proof", distSha256: digestDirectory(resolve(repository, "dist")) };
}
