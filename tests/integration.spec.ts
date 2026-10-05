import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

type FixtureOptions = {
  candidateAddThenRevert?: boolean;
  candidateRewritesAlpha?: boolean;
  extraCandidateChange?: boolean;
  hiddenAlphaHistory?: boolean;
  literalPathspecAlpha?: boolean;
  reverseContributionOrder?: boolean;
  stacked?: boolean;
  stackedBetaChangesAlpha?: boolean;
  stackedNonlinear?: boolean;
  stackedUnownedIntermediate?: boolean;
  transientUnownedAlphaHistory?: boolean;
  oversizedObject?: boolean;
  revertAlpha?: boolean;
  whitespaceError?: boolean;
  directoryAlpha?: boolean;
  ownerIntegrationAdjustments?: boolean;
};

function currentCommit(repository: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
}

async function createAlphaContribution(repository: string, options: FixtureOptions): Promise<string> {
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
  const alphaPath = options.directoryAlpha ? "app/alpha.txt" : options.literalPathspecAlpha ? ":(exclude)*" : "alpha.txt";
  if (options.directoryAlpha) await mkdir(resolve(repository, "app"));
  await writeFile(
    resolve(repository, alphaPath),
    options.oversizedObject
      ? Buffer.alloc((16 * 1024 * 1024) + 1)
      : options.whitespaceError ? "trailing whitespace \n" : "alpha\n",
  );
  execFileSync("git", ["--literal-pathspecs", "add", alphaPath], { cwd: repository });
  execFileSync("git", ["commit", "-m", "alpha contribution"], { cwd: repository });
  return currentCommit(repository);
}

async function createBetaContribution(repository: string, options: FixtureOptions): Promise<string> {
  execFileSync("git", ["switch", options.stacked ? "contribution-a" : "main"], { cwd: repository });
  execFileSync("git", ["switch", "-c", "contribution-b"], { cwd: repository });
  if (options.stackedUnownedIntermediate) {
    await writeFile(resolve(repository, "unowned.txt"), "transient unowned beta history\n");
    execFileSync("git", ["add", "unowned.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "add transient unowned beta history"], { cwd: repository });
    execFileSync("git", ["rm", "unowned.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "delete transient unowned beta history"], { cwd: repository });
  }
  if (options.stackedNonlinear) {
    execFileSync("git", ["switch", "-c", "contribution-b-side"], { cwd: repository });
    execFileSync("git", ["commit", "--allow-empty", "-m", "parallel beta history"], { cwd: repository });
    execFileSync("git", ["switch", "contribution-b"], { cwd: repository });
  }
  await writeFile(resolve(repository, "beta.txt"), "beta\n");
  if (options.stackedBetaChangesAlpha) {
    await writeFile(resolve(repository, "alpha.txt"), "beta changed alpha\n");
  }
  execFileSync("git", ["add", "beta.txt", ...(options.stackedBetaChangesAlpha ? ["alpha.txt"] : [])], { cwd: repository });
  execFileSync("git", ["commit", "-m", "beta contribution"], { cwd: repository });
  if (options.stackedNonlinear) {
    execFileSync("git", ["merge", "--no-ff", "contribution-b-side", "-m", "nonlinear beta contribution"], { cwd: repository });
  }
  return currentCommit(repository);
}

async function createCandidate(repository: string, options: FixtureOptions): Promise<string> {
  execFileSync("git", ["switch", "-c", "candidate"], { cwd: repository });
  if (options.stacked) {
    execFileSync("git", ["commit", "--allow-empty", "-m", "integrate contributions"], { cwd: repository });
  } else if (options.candidateRewritesAlpha) {
    execFileSync("git", ["merge", "--no-ff", "--no-commit", "contribution-a"], { cwd: repository });
    const alphaPath = options.literalPathspecAlpha ? ":(exclude)*" : "alpha.txt";
    await writeFile(resolve(repository, alphaPath), "integration replaced alpha\n");
    execFileSync("git", ["--literal-pathspecs", "add", alphaPath], { cwd: repository });
    execFileSync("git", ["commit", "-m", "integrate contributions"], { cwd: repository });
  } else {
    execFileSync("git", ["merge", "--no-ff", "contribution-a", "-m", "integrate contributions"], { cwd: repository });
  }
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
  if (options.ownerIntegrationAdjustments) {
    await writeFile(resolve(repository, "alpha.txt"), "assembled alpha\n");
    await writeFile(resolve(repository, "integration.md"), "Assembly evidence\n");
    execFileSync("git", ["rm", "beta.txt"], { cwd: repository });
    execFileSync("git", ["add", "alpha.txt", "integration.md"], { cwd: repository });
    execFileSync("git", ["commit", "--amend", "--no-edit"], { cwd: repository });
  }
  return currentCommit(repository);
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "council-integration-test-"));
  cleanup.push(root);
  const repository = resolve(root, "source");
  execFileSync("git", ["init", "-b", "main", repository]);
  execFileSync("git", ["config", "user.email", "council@example.test"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Council Test"], { cwd: repository });
  await writeFile(resolve(repository, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repository });
  const baseCommit = currentCommit(repository);
  const alphaCommit = await createAlphaContribution(repository, options);
  const betaCommit = await createBetaContribution(repository, options);
  const candidateCommit = await createCandidate(repository, options);

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
      {
        contributionId: "alpha",
        commit: alphaCommit,
        ownedPaths: [options.directoryAlpha ? "app" : options.literalPathspecAlpha ? ":(exclude)*" : "alpha.txt"],
      },
      { contributionId: "beta", commit: betaCommit, ownedPaths: ["beta.txt"] },
    ],
  };
  if (options.reverseContributionOrder) input.contributions.reverse();
  return { ctx, input };
}

describe("integrated Git candidate verification", () => {
  it("retains original Git attribution while requiring every owner-declared assembly adjustment", async () => {
    const { ctx, input } = await fixture({ ownerIntegrationAdjustments: true });
    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow("contribution-tree-preservation");
    input.integrationAdjustedPaths = ["alpha.txt", "beta.txt", "integration.md"];
    const result = await verifyIntegratedCandidate(ctx, input);
    expect(result.integrationAdjustedPaths).toEqual(input.integrationAdjustedPaths);
    expect(result.contributions.map(entry => entry.commit)).toEqual(input.contributions.map(entry => entry.commit));
    input.integrationAdjustedPaths = ["alpha.txt", "beta.txt"];
    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow("unattributed path integration.md");
    input.integrationAdjustedPaths = ["alpha.txt", "beta.txt", "integration.md", "missing.txt"];
    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow("exact changed file: missing.txt");
  });

  it.each(["app", "app/"])("verifies a directory root %s without accepting sibling prefixes or overlapping owners", async (root) => {
    const { ctx, input } = await fixture({ directoryAlpha: true });
    input.contributions[0].ownedPaths = [root];
    expect((await verifyIntegratedCandidate(ctx, input)).contributions[0].changedPaths).toEqual(["app/alpha.txt"]);
    input.contributions[0].ownedPaths = ["ap"];
    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow("unowned path app/alpha.txt");
    input.contributions[0].ownedPaths = [root];
    input.contributions[1].ownedPaths = ["app/alpha.txt"];
    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow("Contribution ownership overlaps");
  });

  it("checks the missing old reference while verifying both real contributions for owner recovery", async () => {
    const { ctx, input } = await fixture({ stacked: true });
    const result = await verifyIntegratedCandidate(ctx, { ...input, missingReference: "71b5f95145410736c691552b836df8f20df3880e" });
    expect(result.checks.some(check => check.name === "missing-recorded-reference")).toBe(true);
    await expect(verifyIntegratedCandidate(ctx, { ...input, missingReference: input.contributions[0].commit }))
      .rejects.toThrow("cannot replace a reference present");
  });
  it("verifies issue-bound bytes, refs, two contributions, ownership and bounded Git checks", async () => {
    const { ctx, input } = await fixture();

    const result = await verifyIntegratedCandidate(ctx, input);

    expect(result).toMatchObject({
      outcome: "verified",
      publicationEligible: true,
      subject: { companyId: input.companyId, issueId: input.issueId },
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

  it("verifies ordered contributions stacked in one shared workspace", async () => {
    const { ctx, input } = await fixture({ stacked: true });

    const result = await verifyIntegratedCandidate(ctx, input);

    expect(result.contributions).toEqual([
      { contributionId: "alpha", commit: input.contributions[0].commit, ownedPaths: ["alpha.txt"], changedPaths: ["alpha.txt"] },
      { contributionId: "beta", commit: input.contributions[1].commit, ownedPaths: ["beta.txt"], changedPaths: ["beta.txt"] },
    ]);
  });

  it("rejects a stacked contribution that changes a prior contribution's owned path", async () => {
    const { ctx, input } = await fixture({ stacked: true, stackedBetaChangesAlpha: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Contribution beta changed unowned path alpha.txt",
    );
  });

  it("rejects an unowned add-then-delete inside a stacked contribution segment", async () => {
    const { ctx, input } = await fixture({ stacked: true, stackedUnownedIntermediate: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Contribution beta changed unowned path unowned.txt",
    );
  });

  it("rejects stacked contributions declared in reverse ancestry order", async () => {
    const { ctx, input } = await fixture({ stacked: true, reverseContributionOrder: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Contribution order must declare an ancestor before its descendant",
    );
  });

  it("rejects a nonlinear history inside a stacked contribution segment", async () => {
    const { ctx, input } = await fixture({ stacked: true, stackedNonlinear: true });

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Contribution beta must be a linear history rooted at the declared base",
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

  it("accepts one explicitly bounded material correction on an attributed path", async () => {
    const { ctx, input } = await fixture({ candidateRewritesAlpha: true });
    input.correctedPaths = ["alpha.txt"];

    const result = await verifyIntegratedCandidate(ctx, input);

    expect(result.checks).toContainEqual({
      name: "bounded-material-correction",
      status: "passed",
      detail: "changed attributed paths: alpha.txt",
    });
  });

  it("rejects a declared correction outside the attributed contribution paths", async () => {
    const { ctx, input } = await fixture({ candidateRewritesAlpha: true });
    input.correctedPaths = ["README.md"];

    await expect(verifyIntegratedCandidate(ctx, input)).rejects.toThrow(
      "Corrected path is not attributed to an N1 contribution: README.md",
    );
  });

  it("treats magic-looking changed paths literally when checking tree preservation", async () => {
    const { ctx, input } = await fixture({
      candidateRewritesAlpha: true,
      literalPathspecAlpha: true,
    });

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
