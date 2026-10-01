import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  verifyIntegratedCandidate,
  type IntegratedCandidateInput,
} from "../src/integration.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: {
  candidateAddThenRevert?: boolean;
  extraCandidateChange?: boolean;
  hiddenAlphaHistory?: boolean;
  transientUnownedAlphaHistory?: boolean;
  oversizedObject?: boolean;
  revertAlpha?: boolean;
  whitespaceError?: boolean;
} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "council-integration-test-"));
  cleanup.push(root);
  const repository = resolve(root, "source");
  execFileSync("git", ["init", "-b", "main", repository]);
  execFileSync("git", ["config", "user.email", "council@example.test"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Council Test"], { cwd: repository });
  await writeFile(resolve(repository, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repository });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  execFileSync("git", ["switch", "-c", "contribution-a"], { cwd: repository });
  if (options.transientUnownedAlphaHistory) {
    await writeFile(resolve(repository, "unowned.txt"), "transient unowned history\n");
    execFileSync("git", ["add", "unowned.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "add transient unowned history"], { cwd: repository });
    execFileSync("git", ["rm", "unowned.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "delete transient unowned history"], { cwd: repository });
  }
  if (options.hiddenAlphaHistory) {
    await writeFile(resolve(repository, "unowned.txt"), "unowned history\n");
    execFileSync("git", ["add", "unowned.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "unowned historical change"], { cwd: repository });
  }
  await writeFile(
    resolve(repository, "alpha.txt"),
    options.oversizedObject
      ? Buffer.alloc((16 * 1024 * 1024) + 1)
      : options.whitespaceError ? "trailing whitespace \n" : "alpha\n",
  );
  execFileSync("git", ["add", "alpha.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "alpha contribution"], { cwd: repository });
  const alphaCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  execFileSync("git", ["switch", "main"], { cwd: repository });
  execFileSync("git", ["switch", "-c", "contribution-b"], { cwd: repository });
  await writeFile(resolve(repository, "beta.txt"), "beta\n");
  execFileSync("git", ["add", "beta.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "beta contribution"], { cwd: repository });
  const betaCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  execFileSync("git", ["switch", "-c", "candidate"], { cwd: repository });
  execFileSync("git", ["merge", "--no-ff", "contribution-a", "-m", "integrate contributions"], { cwd: repository });
  if (options.candidateAddThenRevert) {
    await writeFile(resolve(repository, "transient.txt"), "candidate-only transient content\n");
    execFileSync("git", ["add", "transient.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "add candidate-only transient content"], { cwd: repository });
    execFileSync("git", ["rm", "transient.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "revert candidate-only transient content"], { cwd: repository });
  }
  if (options.revertAlpha) {
    execFileSync("git", ["rm", "alpha.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "drop alpha contribution"], { cwd: repository });
  }
  if (options.extraCandidateChange) {
    await writeFile(resolve(repository, "integration.txt"), "unattributed integration change\n");
    execFileSync("git", ["add", "integration.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "extra integration change"], { cwd: repository });
  }
  const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  execFileSync("git", ["branch", "base", baseCommit], { cwd: repository });
  const bundlePath = resolve(root, "candidate.bundle");
  execFileSync("git", ["bundle", "create", bundlePath, "refs/heads/base", "refs/heads/candidate"], { cwd: repository });
  const bytes = await readFile(bundlePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const attachmentId = randomUUID();
  const ctx = {
    issues: {
      listAttachments: async () => [{ id: attachmentId }],
      getAttachmentContent: async () => ({
        attachmentId,
        contentType: "application/octet-stream",
        byteSize: bytes.byteLength,
        sha256,
        originalFilename: "candidate.bundle",
        contentBase64: bytes.toString("base64"),
      }),
    },
  } as unknown as PluginContext;
  const input: IntegratedCandidateInput = {
    companyId: randomUUID(),
    issueId: randomUUID(),
    attachmentId,
    expectedByteSize: bytes.byteLength,
    expectedSha256: sha256,
    baseCommit,
    candidateCommit,
    contributions: [
      { contributionId: "alpha", commit: alphaCommit, ownedPaths: ["alpha.txt"] },
      { contributionId: "beta", commit: betaCommit, ownedPaths: ["beta.txt"] },
    ],
  };
  return { ctx, input };
}

describe("integrated Git candidate verification", () => {
  it("verifies issue-bound bytes, refs, two contributions, ownership and bounded Git checks", async () => {
    const { ctx, input } = await fixture();

    const result = await verifyIntegratedCandidate(ctx, input);

    expect(result).toMatchObject({
      outcome: "verified",
      publicationEligible: true,
      candidate: {
        attachmentId: input.attachmentId,
        byteSize: input.expectedByteSize,
        sha256: input.expectedSha256,
        baseCommit: input.baseCommit,
        candidateCommit: input.candidateCommit,
      },
      contributions: [
        { contributionId: "alpha", commit: input.contributions[0].commit, changedPaths: ["alpha.txt"] },
        { contributionId: "beta", commit: input.contributions[1].commit, changedPaths: ["beta.txt"] },
      ],
    });
    expect(result.checks.map((check) => check.name)).toEqual([
      "issue-bound-bundle",
      "git-import-configuration",
      "git-bundle-verify",
      "declared-refs",
      "git-object-bounds",
      "git-object-integrity",
      "base-ancestry",
      "contribution-ancestry",
      "contribution-history-topology",
      "write-ownership",
      "contribution-tree-preservation",
      "candidate-delta-attribution",
      "candidate-history-topology",
      "git-diff-check",
    ]);
    expect(result.checks.find((check) => check.name === "git-import-configuration")?.detail).toBe(
      "bounded Git delta cache, packed-file mappings and single-thread pack window configured",
    );
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("blocks publication when a contribution changes a path outside its ownership", async () => {
    const { ctx, input } = await fixture();
    input.contributions[0].ownedPaths = ["elsewhere/"];

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Contribution alpha changed unowned path alpha.txt",
    );
  });

  it("rejects an unowned historical change hidden behind a contribution tip", async () => {
    const { ctx, input } = await fixture({ hiddenAlphaHistory: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Contribution alpha changed unowned path unowned.txt",
    );
  });

  it("rejects an unowned add-then-delete hidden inside contribution history", async () => {
    const { ctx, input } = await fixture({ transientUnownedAlphaHistory: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Contribution alpha changed unowned path unowned.txt",
    );
  });

  it("rejects a candidate change that is not attributed to either contribution", async () => {
    const { ctx, input } = await fixture({ extraCandidateChange: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Candidate changed unattributed path integration.txt",
    );
  });

  it("rejects candidate-only add-then-revert history despite an exact final delta", async () => {
    const { ctx, input } = await fixture({ candidateAddThenRevert: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Candidate-only history must contain exactly the declared integration commit",
    );
  });

  it("rejects an imported object above the expanded-size limit before fsck", async () => {
    const { ctx, input } = await fixture({ oversizedObject: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "git-object-bounds failed: an object exceeds the expanded-size limit",
    );
  });

  it("rejects duplicate contribution commits before inspecting the bundle", async () => {
    const { ctx, input } = await fixture();
    input.contributions[1].commit = input.contributions[0].commit;

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow("Contribution commits must be distinct");
  });

  it("rejects a child commit presented directly as the integrated candidate", async () => {
    const { ctx, input } = await fixture();
    input.candidateCommit = input.contributions[0].commit;

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Candidate commit must be a distinct integration revision",
    );
  });

  it("rejects an integration revision that drops a contribution from the final tree", async () => {
    const { ctx, input } = await fixture({ revertAlpha: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "contribution-tree-preservation failed: alpha changed paths do not survive in the candidate tree",
    );
  });

  it("rejects a candidate whose complete base diff fails git diff --check", async () => {
    const { ctx, input } = await fixture({ whitespaceError: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "git-diff-check failed: candidate contains whitespace errors",
    );
  });

  it("rejects an attachment that is not bound to the root issue", async () => {
    const { ctx, input } = await fixture();
    const unbound = {
      issues: {
        ...ctx.issues,
        listAttachments: async () => [],
      },
    } as unknown as PluginContext;

    await expect(verifyIntegratedCandidate(unbound, input)).rejects.toThrow(
      "Integrated candidate attachment is not attached to this issue",
    );
  });

  it("rejects bytes whose digest does not match the declared candidate", async () => {
    const { ctx, input } = await fixture();
    input.expectedSha256 = "0".repeat(64);

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Integrated candidate attachment SHA-256 mismatch",
    );
  });
});
