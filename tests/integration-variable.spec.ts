import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { verifyIntegratedCandidate, type IntegratedCandidateInput } from "../src/integration.js";
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(count: number, independent: boolean) {
  const repo = await mkdtemp(resolve(tmpdir(), "council-variable-git-")); cleanup.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Council Test");
  await writeFile(resolve(repo, "README.md"), "base\n"); git("add", "."); git("commit", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD"); git("branch", "base");
  const contributions = [];
  for (let index = 0; index < count; index++) {
    if (independent) git("switch", "main");
    git("switch", "-c", `part-${index}`);
    await writeFile(resolve(repo, `${index}.txt`), `Part ${index}\n`); git("add", `${index}.txt`); git("commit", "-m", `part ${index}`);
    contributions.push({ contributionId: `part-${index}`, commit: git("rev-parse", "HEAD"), ownedPaths: [`${index}.txt`] });
  }
  git("switch", "-c", "candidate");
  if (independent && count > 1) git("merge", "--no-ff", ...contributions.slice(0, -1).map(item => item.commit), "-m", "integration");
  else git("commit", "--allow-empty", "-m", "integration");
  const candidateCommit = git("rev-parse", "HEAD");
  const bundle = resolve(repo, "candidate.bundle"); git("bundle", "create", bundle, "refs/heads/base", "refs/heads/candidate");
  const bytes = await readFile(bundle), attachmentId = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex");
  const ctx = { issues: { listAttachments: async () => [{ id: attachmentId }], getAttachmentContent: async () => ({ attachmentId,
    contentType: "application/octet-stream", originalFilename: "candidate.bundle", byteSize: bytes.length, sha256, contentBase64: bytes.toString("base64") }) } } as unknown as PluginContext;
  const input: IntegratedCandidateInput = { companyId: randomUUID(), issueId: randomUUID(), attachmentId, expectedSha256: sha256,
    baseCommit, candidateCommit, contributions, contributionPolicy: { protocol: "council-hierarchy-v1", maxContributions: 3 } };
  return { ctx, input };
}
describe("variable attributed Git candidate", () => {
  it.each([[1, false], [3, false], [3, true]])("verifies %i contributions with independent=%s", async (count, independent) => {
    const f = await fixture(count as number, independent as boolean), result = await verifyIntegratedCandidate(f.ctx, f.input);
    expect(result.contributions).toHaveLength(count as number);
    expect(result.contributions.flatMap(item => item.changedPaths).sort()).toEqual(f.input.contributions.flatMap(item => item.ownedPaths).sort());
    delete f.input.contributionPolicy;
    await expect(verifyIntegratedCandidate(f.ctx, f.input)).rejects.toThrow("Exactly two");
  });
  it("rejects reverse ancestral order and overlapping third-party ownership", async () => {
    const f = await fixture(3, false); f.input.contributions.reverse();
    await expect(verifyIntegratedCandidate(f.ctx, f.input)).rejects.toThrow();
    f.input.contributions.reverse(); f.input.contributions[2]!.ownedPaths = ["0.txt"];
    await expect(verifyIntegratedCandidate(f.ctx, f.input)).rejects.toThrow("overlaps");
  });
});
