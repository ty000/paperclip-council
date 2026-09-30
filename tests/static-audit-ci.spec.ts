import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const { resolveAuditBase, validateAuditResult } = createRequire(import.meta.url)("../scripts/ci/run-static-audit.mjs");
const repo = mkdtempSync(join(tmpdir(), "council-static-audit-ci-"));
const git = (...args: string[]) => execFileSync("git", [
  "-c", "user.name=Static audit fixture", "-c", "user.email=fixture@example.test", ...args,
], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "--initial-branch=main");
git("commit", "--allow-empty", "-m", "base fixture");
const base = git("rev-parse", "HEAD");
git("update-ref", "refs/remotes/origin/main", base);
git("commit", "--allow-empty", "-m", "candidate fixture");
const head = git("rev-parse", "HEAD");
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const passing = {
  schema_version: "static-code-audit-gate.v1",
  wrapper_version: "0.4.1",
  status: "pass",
  mode: "diff-gate",
  tool: "fallow",
  tool_version: "fallow 3.23.0",
  base_ref: base,
  blocking_findings: [],
};

describe("blocking static audit CI contract", () => {
  it("accepts a pinned pass and preserves non-blocking inherited debt", () => {
    const payload = { ...passing, non_blocking_findings: [{ rule: "unused-export", introduced: false }] };
    expect(validateAuditResult(JSON.stringify(payload), 0, base)).toEqual(payload);
    expect(validateAuditResult(JSON.stringify({ ...passing, tool_version: "3.23.0" }), 0, base).status).toBe("pass");
  });

  it.each(["skipped", "error", "fail", "blocked"])("rejects %s even with exit code zero", (status) => {
    expect(() => validateAuditResult(JSON.stringify({ ...passing, status }), 0, base)).toThrow(/did not pass/);
  });

  it.each(["3.22.0", "3.23.1", null, ""])("rejects an unverified tool version %s", (tool_version) => {
    expect(() => validateAuditResult(JSON.stringify({ ...passing, tool_version }), 0, base)).toThrow();
  });

  it("rejects malformed JSON, wrong mode/base, blocking findings and abnormal exits", () => {
    for (const output of ["", "not JSON", "null"]) {
      expect(() => validateAuditResult(output, 0, base)).toThrow();
    }
    for (const patch of [
      { mode: "probe" }, { base_ref: head }, { wrapper_version: "0.4.0" },
      { blocking_findings: [{}] }, { blocking_findings: undefined },
    ]) {
      expect(() => validateAuditResult(JSON.stringify({ ...passing, ...patch }), 0, base)).toThrow();
    }
    for (const code of [1, 2, 3, null]) {
      expect(() => validateAuditResult(JSON.stringify(passing), code, base)).toThrow();
    }
  });
});

describe("explicit static audit comparison base", () => {
  it("resolves explicit local refs and the exact pull request base", () => {
    expect(resolveAuditBase(repo, "origin/main")).toBe(base);
    expect(resolveAuditBase(repo, undefined, "pull_request", { pull_request: { base: { sha: base } } })).toBe(base);
  });

  it("uses push-before and handles a new branch with an explicit merge-base", () => {
    expect(resolveAuditBase(repo, undefined, "push", { before: base })).toBe(base);
    expect(resolveAuditBase(repo, undefined, "push", {
      before: "0".repeat(40), repository: { default_branch: "main" },
    })).toBe(base);
  });

  it("refuses absent or invalid history instead of silently producing an empty diff", () => {
    expect(() => resolveAuditBase(repo)).toThrow(/explicit/);
    expect(() => resolveAuditBase(repo, "does-not-exist")).toThrow();
    expect(() => resolveAuditBase(repo, "--help")).toThrow(/Invalid/);
    expect(() => resolveAuditBase(repo, head)).toThrow(/differ from HEAD/);
    expect(() => resolveAuditBase(repo, undefined, "pull_request", {})).toThrow(/base SHA/);
    expect(() => resolveAuditBase(repo, undefined, "push", { before: "missing" })).toThrow(/before SHA/);
    expect(() => resolveAuditBase(repo, undefined, "push", { before: "0".repeat(40) })).toThrow(/Default branch/);
  });

  it("allows an explicit HEAD base for local uncommitted work but never silently for CI", () => {
    const fixture = join(repo, "pending.ts");
    writeFileSync(fixture, "export const pending = true;\n");
    try {
      expect(resolveAuditBase(repo, head)).toBe(head);
      expect(() => resolveAuditBase(repo, undefined, "push", { before: head })).toThrow(/differ from HEAD/);
    } finally {
      rmSync(fixture);
    }
  });
});
