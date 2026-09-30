import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalSha256 } from "../src/l03.js";
import { verifyL03Content, verifyL03Evidence } from "../src/l03-content.js";
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

it("binds the result to real bundle bytes, all artifact identities and native evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "council-l03-content-")); paths.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("config", "user.name", "L03 fixture"); git("config", "user.email", "l03@example.test");
  git("commit", "--allow-empty", "-m", "base"); const base = git("rev-parse", "HEAD"); git("branch", "base");
  git("commit", "--allow-empty", "-m", "candidate"); const candidate = git("rev-parse", "HEAD"); git("branch", "candidate");
  git("bundle", "create", "candidate.bundle", "refs/heads/base", "refs/heads/candidate");
  const bytes = await readFile(join(root, "candidate.bundle")); const digest = createHash("sha256").update(bytes).digest("hex");
  const companyId = randomUUID(), issueId = randomUUID(), attachmentId = randomUUID(), authorAgentId = randomUUID();
  const ref = `attachment:${attachmentId}#sha256:${digest}`;
  const artifacts = [{ ref, sha256: digest, byteVerificationRef: ref }];
  const manifest = { repository: "https://github.com/ty000/l03-fixture", branch: "codex/l03-fixture", baseCommit: base, approvedCommit: candidate,
    bundleAttachmentId: attachmentId, bundleSha256: digest, deliveryWorkspacePath: "/home/davy-lp/workspace/l03-fixture", assigneeAgentId: authorAgentId };
  let nativeBytes = bytes;
  const ctx = { agents: { get: async () => ({ id: authorAgentId, companyId }) }, issues: {
    get: async () => ({ id: issueId, companyId }), documents: { get: async (_issue: string, key: string) => key === "delivery-manifest" ? { body: JSON.stringify(manifest) } : null },
    listAttachments: async () => [{ id: attachmentId, issueId, companyId, sha256: digest }],
    getAttachmentContent: async () => ({ attachmentId, sha256: digest, byteSize: nativeBytes.length, contentBase64: nativeBytes.toString("base64") }),
  } } as unknown as PluginContext;
  const subject = { issueId, authorAgentId, repository: manifest.repository, baseCommit: base, candidateCommit: candidate, attachmentId, sha256: digest, artifacts, artifactSetHash: canonicalSha256(artifacts), evidenceRefs: [ref] };
  await expect(verifyL03Content(ctx, companyId, subject)).resolves.toMatchObject({ sha256: digest });
  await expect(verifyL03Content(ctx, companyId, { ...subject, artifacts: [...artifacts, { ...artifacts[0]!, ref: "unverified" }] })).rejects.toThrow(/exactly the verified/);
  await expect(verifyL03Content(ctx, companyId, { ...subject, evidenceRefs: [ref, "document:missing#sha256:" + "a".repeat(64)] })).rejects.toThrow(/missing/);
  nativeBytes = Buffer.from("changed after manifest publication");
  await expect(verifyL03Content(ctx, companyId, subject)).rejects.toThrow(/SHA-256 mismatch/);
});

it("rejects arbitrary URLs, foreign attachments and mutable document bytes as evidence", async () => {
  const digest = createHash("sha256").update("expected").digest("hex");
  const ctx = { issues: { documents: { get: async () => ({ body: "changed" }) }, listAttachments: async () => [] } } as unknown as PluginContext;
  await expect(verifyL03Evidence(ctx, "company", "issue", ["https://example.test/proof"])).rejects.toThrow(/native document/);
  await expect(verifyL03Evidence(ctx, "company", "issue", [`attachment:foreign#sha256:${digest}`])).rejects.toThrow(/outside/);
  await expect(verifyL03Evidence(ctx, "company", "issue", [`document:proof#sha256:${digest}`])).rejects.toThrow(/digest/);
});
