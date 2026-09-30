import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The runtime qualification CLI is intentionally plain ESM.
import { assertOwnedTarget, inspectHost, materializeHost, updateMarker } from "../scripts/qualification/paperclip-host.mjs";

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
    expect((await readdir(ownedRoot)).filter((name) => name.startsWith("paperclip.partial-"))).toEqual([]);
  });

  it("does not reuse or clean a predictable legacy staging directory", async () => {
    const fixture = await fixtureRepository();
    const ownedRoot = await mkdtemp(resolve(tmpdir(), "paperclip-owned-root-"));
    temporaryRoots.push(ownedRoot);
    const target = resolve(ownedRoot, "paperclip");
    const legacyStagingName = `paperclip.partial-${process.pid}`;
    const legacyStaging = resolve(ownedRoot, legacyStagingName);
    const sentinel = resolve(legacyStaging, "sentinel.txt");
    await mkdir(legacyStaging);
    await writeFile(sentinel, "must remain untouched\n");

    await expect(materializeHost({
      source: resolve(fixture.root, "missing-source"),
      target,
      expectedCommit: fixture.commit,
      install: false,
      allowedRoot: ownedRoot,
    })).rejects.toThrow();

    expect(await readFile(sentinel, "utf8")).toBe("must remain untouched\n");
    expect(await readdir(legacyStaging)).toEqual(["sentinel.txt"]);
    expect((await readdir(ownedRoot)).filter((name) => name.startsWith("paperclip.partial-"))).toEqual([
      legacyStagingName,
    ]);
    expect(await readdir(ownedRoot)).not.toContain("paperclip");
  });

  it("refuses a foreign marker or a different source identity", async () => {
    const fixture = await fixtureRepository();
    const ownedRoot = await mkdtemp(resolve(tmpdir(), "paperclip-owned-root-"));
    temporaryRoots.push(ownedRoot);
    const target = resolve(ownedRoot, "paperclip");
    await materializeHost({
      source: fixture.root, target, expectedCommit: fixture.commit, install: false, allowedRoot: ownedRoot,
    });
    const markerPath = resolve(target, ".paperclip-council-owned.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, `${JSON.stringify({ ...marker, source: "https://example.invalid/foreign.git" })}\n`);
    await expect(materializeHost({
      source: fixture.root, target, expectedCommit: fixture.commit, install: false, allowedRoot: ownedRoot,
    })).rejects.toThrow(/not an owned clean/);
    await writeFile(markerPath, `${JSON.stringify({ ...marker, environmentClass: "integrated-recipe" })}\n`);
    await expect(materializeHost({
      source: fixture.root, target, expectedCommit: fixture.commit, install: false, allowedRoot: ownedRoot,
    })).rejects.toThrow(/not an owned clean/);
  });

  it("refuses a symlink that redirects a target outside the owned root", async () => {
    const ownedRoot = await mkdtemp(resolve(tmpdir(), "paperclip-owned-root-"));
    const externalRoot = await mkdtemp(resolve(tmpdir(), "paperclip-external-root-"));
    temporaryRoots.push(ownedRoot, externalRoot);
    await mkdir(resolve(externalRoot, "checkout"));
    await symlink(resolve(externalRoot, "checkout"), resolve(ownedRoot, "paperclip"));
    expect(() => assertOwnedTarget(resolve(ownedRoot, "paperclip"), ownedRoot)).toThrow(/symbolic-link/);
  });

  it("refuses a symlinked ownership marker without overwriting its external target", async () => {
    const fixture = await fixtureRepository();
    const ownedRoot = await mkdtemp(resolve(tmpdir(), "paperclip-owned-root-"));
    const externalRoot = await mkdtemp(resolve(tmpdir(), "paperclip-external-root-"));
    temporaryRoots.push(ownedRoot, externalRoot);
    const target = resolve(ownedRoot, "paperclip");
    await materializeHost({
      source: fixture.root, target, expectedCommit: fixture.commit, install: false, allowedRoot: ownedRoot,
    });
    const markerPath = resolve(target, ".paperclip-council-owned.json");
    const externalMarker = resolve(externalRoot, "external-marker.json");
    const originalMarker = JSON.parse(await readFile(markerPath, "utf8"));
    const externalMarkerBytes = `${JSON.stringify({
      ...originalMarker,
      testSentinel: "external marker must remain unchanged",
    }, null, 2)}\n`;
    await writeFile(externalMarker, externalMarkerBytes);
    await rm(markerPath);
    await symlink(externalMarker, markerPath);

    expect(() => inspectHost(target, fixture.commit, ownedRoot)).toThrow(/ownership marker.*symbolic link/);
    await expect(materializeHost({
      source: fixture.root, target, expectedCommit: fixture.commit, install: true, allowedRoot: ownedRoot,
    })).rejects.toThrow(/ownership marker.*symbolic link/);
    expect(await readFile(externalMarker, "utf8")).toBe(externalMarkerBytes);
  });

  it("atomically replaces a hard-linked ownership marker without mutating the external inode", async () => {
    const fixture = await fixtureRepository();
    const ownedRoot = await mkdtemp(resolve(tmpdir(), "paperclip-owned-root-"));
    const externalRoot = await mkdtemp(resolve(tmpdir(), "paperclip-external-root-"));
    temporaryRoots.push(ownedRoot, externalRoot);
    const target = resolve(ownedRoot, "paperclip");
    await materializeHost({
      source: fixture.root, target, expectedCommit: fixture.commit, install: false, allowedRoot: ownedRoot,
    });
    const markerPath = resolve(target, ".paperclip-council-owned.json");
    const externalMarker = resolve(externalRoot, "external-marker.json");
    const originalMarkerBytes = await readFile(markerPath, "utf8");
    await link(markerPath, externalMarker);

    updateMarker(target, { regressionUpdate: "preserved external hard link" });

    expect(await readFile(externalMarker, "utf8")).toBe(originalMarkerBytes);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
      regressionUpdate: "preserved external hard link",
    });
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(target)).filter((name) => name.startsWith(".paperclip-council-owned.json.tmp-"))).toEqual([]);
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
