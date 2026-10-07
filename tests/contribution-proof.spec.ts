import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { verifyContributionBundle } from "../src/integration.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(kind = "nominal") {
  const directory = await mkdtemp(join(tmpdir(), "council-child-proof-test-")); directories.push(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet"); git("config", "user.name", "Proof Test"); git("config", "user.email", "proof@example.test");
  git("commit", "--quiet", "--allow-empty", "-m", "base"); const baseCommit = git("rev-parse", "HEAD");
  if (kind === "history") {
    await writeFile(join(directory, "foreign.txt"), "unowned\n"); git("add", "."); git("commit", "--quiet", "-m", "hidden unowned history");
    git("rm", "foreign.txt"); git("commit", "--quiet", "-m", "hide unowned history");
  }
  if (kind !== "empty") { await writeFile(join(directory, "owned.txt"), kind === "whitespace" ? "bad \n" : "verified\n"); git("add", "."); }
  git("commit", "--quiet", "--allow-empty", "-m", "child");
  const candidateCommit = git("rev-parse", "HEAD"), contributionId = randomUUID(), attachmentId = randomUUID();
  const refs = ["base", "candidate"].map(ref => `refs/council/proof/${contributionId}/${ref}`);
  git("update-ref", refs[0]!, baseCommit); git("update-ref", refs[1]!, candidateCommit);
  const path = join(directory, "child.bundle"); git("bundle", "create", path, ...refs);
  const bytes = await readFile(path), sha256 = createHash("sha256").update(bytes).digest("hex");
  const ctx = { issues: { listAttachments: async () => [{ id: attachmentId }], getAttachmentContent: async () => ({ attachmentId, contentBase64: bytes.toString("base64"), sha256, byteSize: bytes.length }) } } as unknown as PluginContext;
  const input = { companyId: randomUUID(), issueId: randomUUID(), attachmentId, expectedSha256: sha256, baseCommit, candidateCommit, contributionId, ownedPaths: ["owned.txt"] };
  return { ctx, input };
}
it("verifies the exact child-bound bundle, digest, source root and attributed changes", async () => {
  const f = await fixture(); const proof = await verifyContributionBundle(f.ctx, f.input);
  expect(proof).toMatchObject({ protocol: "council-contribution-proof-v1", attachmentId: f.input.attachmentId, sha256: f.input.expectedSha256, commit: f.input.candidateCommit, segmentRootCommit: f.input.baseCommit, changedPaths: ["owned.txt"] });
  expect(proof.checks.every(check => check.status === "passed")).toBe(true);
});
it.each(["empty", "history", "whitespace"])("refuses %s contribution despite a succeeded agent", async kind => {
  const f = await fixture(kind); await expect(verifyContributionBundle(f.ctx, f.input)).rejects.toThrow();
});
it.each(["digest", "commit", "ownership", "binding"])("refuses divergent %s proof", async kind => {
  const f = await fixture();
  if (kind === "digest") f.input.expectedSha256 = "f".repeat(64);
  if (kind === "commit") f.input.candidateCommit = "f".repeat(40);
  if (kind === "ownership") f.input.ownedPaths = ["foreign.txt"];
  if (kind === "binding") f.input.attachmentId = randomUUID();
  await expect(verifyContributionBundle(f.ctx, f.input)).rejects.toThrow();
});
