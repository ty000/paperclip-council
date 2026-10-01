import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const execFileAsync = promisify(execFile);

const MAX_INTEGRATED_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_IMPORTED_GIT_OBJECTS = 8_192;
const MAX_SINGLE_GIT_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_GIT_OBJECT_BYTES = 128 * 1024 * 1024;
const MAX_COMMITS_PER_CONTRIBUTION = 256;
const MAX_CHANGED_PATHS_PER_CONTRIBUTION = 256;
const MAX_OWNED_PATHS_PER_CONTRIBUTION = 64;
const GIT_IMPORT_CONFIG = [
  ["core.deltaBaseCacheLimit", "16m"],
  ["core.packedGitWindowSize", "8m"],
  ["core.packedGitLimit", "64m"],
  ["pack.windowMemory", "16m"],
  ["pack.threads", "1"],
] as const;

export type IntegratedContributionInput = {
  contributionId: string;
  commit: string;
  ownedPaths: string[];
};

export type IntegratedCandidateInput = {
  companyId: string;
  issueId: string;
  attachmentId: string;
  expectedByteSize?: number;
  expectedSha256: string;
  baseCommit: string;
  candidateCommit: string;
  contributions: [IntegratedContributionInput, IntegratedContributionInput];
};

export type IntegratedCandidateCheck = {
  name: string;
  status: "passed";
  detail: string;
};

export type IntegratedCandidateVerification = {
  outcome: "verified";
  publicationEligible: true;
  candidate: {
    attachmentId: string;
    byteSize: number;
    sha256: string;
    baseCommit: string;
    candidateCommit: string;
  };
  contributions: Array<{
    contributionId: string;
    commit: string;
    ownedPaths: string[];
    changedPaths: string[];
  }>;
  checks: IntegratedCandidateCheck[];
};

function requiredString(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${label}`);
  if (value !== value.trim() || value.length > maxLength || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function commit(value: unknown, label: string): string {
  const parsed = requiredString(value, label, 40);
  if (!/^[a-f0-9]{40}$/.test(parsed)) {
    throw new Error(`${label} must be a lowercase 40-character Git commit`);
  }
  return parsed;
}

function digest(value: unknown): string {
  const parsed = requiredString(value, "expectedSha256", 64);
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error("expectedSha256 must be a lowercase SHA-256 digest");
  }
  return parsed;
}

function ownedPath(value: unknown, label: string): string {
  const parsed = requiredString(value, label, 512);
  if (parsed.startsWith("/") || parsed.includes("\\") || parsed.includes("//")) {
    throw new Error(`${label} must be a repository-relative POSIX path`);
  }
  const withoutTrailingSlash = parsed.endsWith("/") ? parsed.slice(0, -1) : parsed;
  const parts = withoutTrailingSlash.split("/");
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return parsed;
}

function pathIsOwned(declared: string, changed: string): boolean {
  return declared.endsWith("/") ? changed.startsWith(declared) : changed === declared;
}

function ownershipsOverlap(left: string, right: string): boolean {
  return pathIsOwned(left, right.endsWith("/") ? right.slice(0, -1) : right)
    || pathIsOwned(right, left.endsWith("/") ? left.slice(0, -1) : left)
    || (left.endsWith("/") && right.endsWith("/") && (left.startsWith(right) || right.startsWith(left)));
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  return result.stdout;
}

async function requireGitCheck(
  name: string,
  args: readonly string[],
  cwd: string,
  failureMessage: string,
): Promise<void> {
  try {
    await git(args, cwd);
  } catch {
    throw new Error(`${name} failed: ${failureMessage}`);
  }
}

async function configureGitImportBounds(cwd: string): Promise<void> {
  for (const [name, value] of GIT_IMPORT_CONFIG) {
    try {
      await git(["config", "--local", name, value], cwd);
      const observed = (await git(["config", "--local", "--get", name], cwd)).trim();
      if (observed !== value) throw new Error("configuration readback mismatch");
    } catch {
      throw new Error(`git-import-configuration failed: unable to apply ${name}`);
    }
  }
}

async function inspectGitObjectBounds(cwd: string): Promise<{
  objectCount: number;
  expandedBytes: number;
}> {
  let output: string;
  try {
    output = await git([
      "cat-file",
      "--batch-all-objects",
      "--unordered",
      "--batch-check=%(objectname) %(objecttype) %(objectsize)",
    ], cwd);
  } catch {
    throw new Error("git-object-bounds failed: unable to inspect imported objects within resource limits");
  }

  const lines = output.split("\n").filter((line) => line !== "");
  if (lines.length === 0) {
    throw new Error("git-object-bounds failed: imported repository contains no objects");
  }
  if (lines.length > MAX_IMPORTED_GIT_OBJECTS) {
    throw new Error("git-object-bounds failed: imported object count exceeds the bounded limit");
  }

  let expandedBytes = 0;
  for (const line of lines) {
    const match = /^[a-f0-9]{40} (?:blob|commit|tag|tree) ([0-9]+)$/.exec(line);
    if (!match) {
      throw new Error("git-object-bounds failed: imported object metadata is malformed");
    }
    const objectBytes = Number(match[1]);
    if (!Number.isSafeInteger(objectBytes)) {
      throw new Error("git-object-bounds failed: imported object size is invalid");
    }
    if (objectBytes > MAX_SINGLE_GIT_OBJECT_BYTES) {
      throw new Error("git-object-bounds failed: an object exceeds the expanded-size limit");
    }
    expandedBytes += objectBytes;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_GIT_OBJECT_BYTES) {
      throw new Error("git-object-bounds failed: total expanded object size exceeds the bounded limit");
    }
  }

  return { objectCount: lines.length, expandedBytes };
}

async function changedPathsBetween(
  baseCommit: string,
  targetCommit: string,
  repositoryPath: string,
): Promise<string[]> {
  const output = await git([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    baseCommit,
    targetCommit,
  ], repositoryPath);
  return output.split("\0").filter((path) => path !== "").sort();
}

async function inspectContributionHistory(
  baseCommit: string,
  contribution: { contributionId: string; commit: string; ownedPaths: string[] },
  repositoryPath: string,
): Promise<void> {
  const commits = (await git([
    "rev-list",
    "--reverse",
    `--max-count=${MAX_COMMITS_PER_CONTRIBUTION + 1}`,
    contribution.commit,
    "--not",
    baseCommit,
  ], repositoryPath)).split("\n").filter((entry) => entry !== "");
  if (commits.length === 0 || commits.at(-1) !== contribution.commit) {
    throw new Error(`Contribution ${contribution.contributionId} history does not terminate at its declared commit`);
  }
  if (commits.length > MAX_COMMITS_PER_CONTRIBUTION) {
    throw new Error(`Contribution ${contribution.contributionId} exceeds the commit-history limit`);
  }
  let expectedParent = baseCommit;
  for (const contributionCommit of commits) {
    const commitAndParents = (await git([
      "rev-list",
      "--parents",
      "-n",
      "1",
      contributionCommit,
    ], repositoryPath)).trim().split(" ");
    if (commitAndParents.length !== 2 || commitAndParents[0] !== contributionCommit
        || commitAndParents[1] !== expectedParent) {
      throw new Error(`Contribution ${contribution.contributionId} must be a linear history rooted at the declared base`);
    }
    const commitPaths = await changedPathsBetween(expectedParent, contributionCommit, repositoryPath);
    if (commitPaths.length > MAX_CHANGED_PATHS_PER_CONTRIBUTION) {
      throw new Error(`Contribution ${contribution.contributionId} exceeds the changed-path limit in one commit`);
    }
    const outsideOwnership = commitPaths.find((path) => (
      !contribution.ownedPaths.some((declared) => pathIsOwned(declared, path))
    ));
    if (outsideOwnership) {
      throw new Error(`Contribution ${contribution.contributionId} changed unowned path ${outsideOwnership}`);
    }
    expectedParent = contributionCommit;
  }
}

function validateContributions(input: IntegratedCandidateInput): Array<{
  contributionId: string;
  commit: string;
  ownedPaths: string[];
}> {
  if (!Array.isArray(input.contributions) || input.contributions.length !== 2) {
    throw new Error("Exactly two contributions are required for an integrated candidate");
  }
  const parsed = input.contributions.map((contribution, index) => {
    const contributionId = requiredString(contribution?.contributionId, `contributions[${index}].contributionId`);
    const contributionCommit = commit(contribution?.commit, `contributions[${index}].commit`);
    if (!Array.isArray(contribution?.ownedPaths) || contribution.ownedPaths.length === 0) {
      throw new Error(`contributions[${index}].ownedPaths must not be empty`);
    }
    if (contribution.ownedPaths.length > MAX_OWNED_PATHS_PER_CONTRIBUTION) {
      throw new Error(`contributions[${index}].ownedPaths exceeds the bounded limit`);
    }
    const ownedPaths = contribution.ownedPaths.map((path, pathIndex) => (
      ownedPath(path, `contributions[${index}].ownedPaths[${pathIndex}]`)
    ));
    if (new Set(ownedPaths).size !== ownedPaths.length) {
      throw new Error(`contributions[${index}].ownedPaths contains duplicates`);
    }
    return { contributionId, commit: contributionCommit, ownedPaths };
  });
  if (parsed[0].contributionId === parsed[1].contributionId) {
    throw new Error("Contribution IDs must be distinct");
  }
  if (parsed[0].commit === parsed[1].commit) {
    throw new Error("Contribution commits must be distinct");
  }
  for (const left of parsed[0].ownedPaths) {
    for (const right of parsed[1].ownedPaths) {
      if (ownershipsOverlap(left, right)) {
        throw new Error(`Contribution ownership overlaps at ${left} and ${right}`);
      }
    }
  }
  return parsed;
}

export async function verifyIntegratedCandidate(
  ctx: PluginContext,
  input: IntegratedCandidateInput,
): Promise<IntegratedCandidateVerification> {
  const expectedSha256 = digest(input.expectedSha256);
  const baseCommit = commit(input.baseCommit, "baseCommit");
  const candidateCommit = commit(input.candidateCommit, "candidateCommit");
  if (baseCommit === candidateCommit) throw new Error("Candidate commit must differ from base commit");
  if (input.expectedByteSize !== undefined
    && (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize < 1
      || input.expectedByteSize > MAX_INTEGRATED_BUNDLE_BYTES)) {
    throw new Error("expectedByteSize must be a positive bounded integer");
  }
  const contributions = validateContributions(input);
  if (contributions.some((contribution) => contribution.commit === baseCommit)) {
    throw new Error("Contribution commits must differ from the base commit");
  }
  if (contributions.some((contribution) => contribution.commit === candidateCommit)) {
    throw new Error("Candidate commit must be a distinct integration revision");
  }

  const attachments = await ctx.issues.listAttachments(input.issueId, input.companyId);
  if (!attachments.some((attachment) => attachment.id === input.attachmentId)) {
    throw new Error("Integrated candidate attachment is not attached to this issue");
  }
  const attachment = await ctx.issues.getAttachmentContent(
    input.attachmentId,
    input.companyId,
    { maxBytes: MAX_INTEGRATED_BUNDLE_BYTES },
  );
  if (!attachment || attachment.attachmentId !== input.attachmentId) {
    throw new Error("Integrated candidate attachment is unavailable in this company");
  }
  const bytes = Buffer.from(attachment.contentBase64, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INTEGRATED_BUNDLE_BYTES) {
    throw new Error("Integrated candidate bundle size is outside the bounded limit");
  }
  if (bytes.byteLength !== attachment.byteSize
    || (input.expectedByteSize !== undefined && bytes.byteLength !== input.expectedByteSize)) {
    throw new Error("Integrated candidate attachment byte size mismatch");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== attachment.sha256 || sha256 !== expectedSha256) {
    throw new Error("Integrated candidate attachment SHA-256 mismatch");
  }

  const checks: IntegratedCandidateCheck[] = [
    { name: "issue-bound-bundle", status: "passed", detail: `${bytes.byteLength} bytes; SHA-256 verified` },
  ];
  const root = await mkdtemp(resolve(tmpdir(), "paperclip-council-integration-"));
  try {
    const bundlePath = resolve(root, "candidate.bundle");
    const repositoryPath = resolve(root, "repository.git");
    await writeFile(bundlePath, bytes, { mode: 0o600 });
    await git(["init", "--bare", repositoryPath], root);
    await configureGitImportBounds(repositoryPath);
    checks.push({
      name: "git-import-configuration",
      status: "passed",
      detail: "bounded Git delta cache, packed-file mappings and single-thread pack window configured",
    });
    await requireGitCheck("git-bundle-verify", ["bundle", "verify", bundlePath], repositoryPath, "invalid or incomplete Git bundle");
    checks.push({ name: "git-bundle-verify", status: "passed", detail: "self-contained bundle verified" });

    await requireGitCheck("git-ref-import", [
      "fetch",
      "--no-tags",
      bundlePath,
      "refs/heads/base:refs/council/base",
      "refs/heads/candidate:refs/council/candidate",
    ], repositoryPath, "required base or candidate ref is missing");
    const observedBase = (await git(["rev-parse", "refs/council/base^{commit}"], repositoryPath)).trim();
    const observedCandidate = (await git(["rev-parse", "refs/council/candidate^{commit}"], repositoryPath)).trim();
    if (observedBase !== baseCommit || observedCandidate !== candidateCommit) {
      throw new Error("Integrated candidate bundle refs do not match the declared commits");
    }
    checks.push({ name: "declared-refs", status: "passed", detail: "base and candidate refs match declared commits" });

    const objectBounds = await inspectGitObjectBounds(repositoryPath);
    checks.push({
      name: "git-object-bounds",
      status: "passed",
      detail: `${objectBounds.objectCount} objects; ${objectBounds.expandedBytes} expanded bytes`,
    });

    await requireGitCheck("git-object-integrity", ["fsck", "--strict", "--no-reflogs"], repositoryPath, "Git object integrity check rejected the bundle");
    checks.push({ name: "git-object-integrity", status: "passed", detail: "git fsck --strict passed" });

    await requireGitCheck("base-ancestry", ["merge-base", "--is-ancestor", baseCommit, candidateCommit], repositoryPath, "base is not an ancestor of candidate");
    checks.push({ name: "base-ancestry", status: "passed", detail: "candidate descends from declared base" });

    const verifiedContributions: IntegratedCandidateVerification["contributions"] = [];
    for (const contribution of contributions) {
      await requireGitCheck(
        "contribution-ancestry",
        ["merge-base", "--is-ancestor", baseCommit, contribution.commit],
        repositoryPath,
        `${contribution.contributionId} does not descend from base`,
      );
      await requireGitCheck(
        "contribution-integration",
        ["merge-base", "--is-ancestor", contribution.commit, candidateCommit],
        repositoryPath,
        `${contribution.contributionId} is not included in candidate`,
      );
      await inspectContributionHistory(baseCommit, contribution, repositoryPath);
      const changedPaths = await changedPathsBetween(baseCommit, contribution.commit, repositoryPath);
      if (changedPaths.length === 0) {
        throw new Error(`Contribution ${contribution.contributionId} has no changed paths`);
      }
      if (changedPaths.length > MAX_CHANGED_PATHS_PER_CONTRIBUTION) {
        throw new Error(`Contribution ${contribution.contributionId} exceeds the changed-path limit`);
      }
      const outsideOwnership = changedPaths.find((path) => (
        !contribution.ownedPaths.some((declared) => pathIsOwned(declared, path))
      ));
      if (outsideOwnership) {
        throw new Error(`Contribution ${contribution.contributionId} changed unowned path ${outsideOwnership}`);
      }
      await requireGitCheck(
        "contribution-tree-preservation",
        ["diff", "--quiet", contribution.commit, candidateCommit, "--", ...changedPaths],
        repositoryPath,
        `${contribution.contributionId} changed paths do not survive in the candidate tree`,
      );
      verifiedContributions.push({ ...contribution, changedPaths });
    }
    checks.push({ name: "contribution-ancestry", status: "passed", detail: "two distinct contribution commits are included" });
    checks.push({ name: "contribution-history-topology", status: "passed", detail: "each contribution is a bounded linear history rooted at base" });
    checks.push({ name: "write-ownership", status: "passed", detail: "every contribution commit changed only its declared paths" });
    checks.push({ name: "contribution-tree-preservation", status: "passed", detail: "both contributions survive in the candidate tree" });

    const attributedPaths = new Set(verifiedContributions.flatMap((contribution) => contribution.changedPaths));
    const candidateChangedPaths = await changedPathsBetween(baseCommit, candidateCommit, repositoryPath);
    const unattributedPath = candidateChangedPaths.find((path) => !attributedPaths.has(path));
    if (unattributedPath) {
      throw new Error(`Candidate changed unattributed path ${unattributedPath}`);
    }
    const omittedPath = [...attributedPaths].find((path) => !candidateChangedPaths.includes(path));
    if (omittedPath) {
      throw new Error(`Candidate omits attributed path ${omittedPath}`);
    }
    checks.push({
      name: "candidate-delta-attribution",
      status: "passed",
      detail: "complete candidate delta equals the union of attributed contribution deltas",
    });

    const candidateOnlyCommits = (await git([
      "rev-list",
      "--max-count=2",
      candidateCommit,
      "--not",
      baseCommit,
      ...contributions.map((contribution) => contribution.commit),
    ], repositoryPath)).split("\n").filter((candidate) => candidate !== "");
    if (candidateOnlyCommits.length !== 1 || candidateOnlyCommits[0] !== candidateCommit) {
      throw new Error("Candidate-only history must contain exactly the declared integration commit");
    }
    checks.push({
      name: "candidate-history-topology",
      status: "passed",
      detail: "candidate-only history contains exactly the declared integration commit",
    });

    await requireGitCheck("git-diff-check", ["diff", "--check", baseCommit, candidateCommit], repositoryPath, "candidate contains whitespace errors");
    checks.push({ name: "git-diff-check", status: "passed", detail: "candidate diff passed git diff --check" });

    return {
      outcome: "verified",
      publicationEligible: true,
      candidate: {
        attachmentId: input.attachmentId,
        byteSize: bytes.byteLength,
        sha256,
        baseCommit,
        candidateCommit,
      },
      contributions: verifiedContributions,
      checks,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
