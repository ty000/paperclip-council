import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The runtime qualification CLI is intentionally plain ESM.
import { assertOwnedTarget, inspectHost, materializeHost } from "../scripts/qualification/paperclip-host.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRepository() {
  const root = await mkdtemp(resolve(tmpdir(), "paperclip-host-fixture-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Council Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "council-test@example.invalid"]);
  await writeFile(resolve(root, "package.json"), "{\"packageManager\":\"pnpm@9.15.4\"}\n");
  execFileSync("git", ["-C", root, "add", "package.json"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  return { root, commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

describe("repo-owned Paperclip qualification host", () => {
  it("refuses targets outside the owned qualification root", () => {
    expect(() => assertOwnedTarget("/tmp/not-owned", "/tmp/owned")).toThrow(/must be a child/);
    expect(() => assertOwnedTarget("/tmp/owned", "/tmp/owned")).toThrow(/must be a child/);
  });

  it("materializes and verifies an exact clean pinned checkout", async () => {
    const fixture = await fixtureRepository();
    const ownedRoot = await mkdtemp(resolve(tmpdir(), "paperclip-owned-root-"));
    temporaryRoots.push(ownedRoot);
    const target = resolve(ownedRoot, "paperclip");
    const result = await materializeHost({
      source: fixture.root,
      target,
      expectedCommit: fixture.commit,
      install: false,
      allowedRoot: ownedRoot,
    });
    expect(result).toMatchObject({
      prepared: true, head: fixture.commit, trackedClean: true, owned: true,
      dependenciesInstalled: false, runtimeReady: false,
    });
    expect(inspectHost(target, fixture.commit, ownedRoot)).toMatchObject({ prepared: true });
  });

  it("refuses an existing checkout at another commit", async () => {
    const fixture = await fixtureRepository();
    const ownedRoot = await mkdtemp(resolve(tmpdir(), "paperclip-owned-root-"));
    temporaryRoots.push(ownedRoot);
    const target = resolve(ownedRoot, "paperclip");
    await materializeHost({
      source: fixture.root,
      target,
      expectedCommit: fixture.commit,
      install: false,
      allowedRoot: ownedRoot,
    });
    await writeFile(resolve(fixture.root, "second.txt"), "second\n");
    execFileSync("git", ["-C", fixture.root, "add", "second.txt"]);
    execFileSync("git", ["-C", fixture.root, "commit", "--quiet", "-m", "second"]);
    const secondCommit = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await expect(materializeHost({
      source: fixture.root,
      target,
      expectedCommit: secondCommit,
      install: false,
      allowedRoot: ownedRoot,
    })).rejects.toThrow(/not an owned clean/);
  });
});
