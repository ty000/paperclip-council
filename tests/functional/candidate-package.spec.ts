import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestDirectory, exportCandidateSource } from "./candidate-package.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("candidate package provenance", () => {
  it("exports only bytes tracked by the selected commit", async () => {
    const repository = await mkdtemp(resolve(tmpdir(), "council-candidate-repository-"));
    const exported = await mkdtemp(resolve(tmpdir(), "council-candidate-export-"));
    temporaryRoots.push(repository, exported);
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "candidate@example.test"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Candidate Test"], { cwd: repository });
    await writeFile(resolve(repository, ".gitignore"), "dist/\n");
    await mkdir(resolve(repository, "src"));
    await writeFile(resolve(repository, "src", "worker.ts"), "export const value = 'tracked';\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repository });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

    await mkdir(resolve(repository, "dist"));
    await writeFile(resolve(repository, "dist", "worker.js"), "export const value = 'stale';\n");
    const archiveDigest = await exportCandidateSource(repository, commit, exported);

    expect(archiveDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => digestDirectory(resolve(exported, "dist"))).toThrow();
    expect(digestDirectory(resolve(exported, "src"))).toMatch(/^[0-9a-f]{64}$/);
  });
});
