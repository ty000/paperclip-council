import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Vendored static_audit_gate.py: codex-tooling static-code-audit plugin 0.4.1.
// Source: plugins/static-code-audit/scripts/static_audit_gate.py, installed bundle 0.4.1.
// Upstream SHA-256: 815818bf4b02e2dfb8b6ecd6b2d480119e8992b2fec91eaf5b62a0a2bfde7a1e.
// Local compatibility patch: normalize Fallow 3.23 complexity findings and fail closed on unknown diff failures.
// Keep the wrapper policy intact; this adapter makes skipped results fail in CI.
const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, "../..");
const sha = /^[0-9a-f]{40}$/i;

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function eventSha(value, label) {
  if (!sha.test(value ?? "")) throw new Error(`${label} SHA is missing or invalid`);
  return value;
}

function newBranchBase(repo, event) {
  const branch = event?.repository?.default_branch;
  if (typeof branch !== "string" || !branch) throw new Error("Default branch is required for a new-branch push");
  git(repo, ["check-ref-format", `refs/heads/${branch}`]);
  return git(repo, ["merge-base", "HEAD", `refs/remotes/origin/${branch}`]);
}

function ensureCommitAvailable(repo, commit) {
  try {
    resolveCommit(repo, commit);
  } catch {
    git(repo, ["fetch", "--no-tags", "origin", commit]);
  }
}

function pushBase(repo, event) {
  const before = eventSha(event?.before, "Push before");
  if (/^0+$/.test(before)) return newBranchBase(repo, event);
  ensureCommitAvailable(repo, before);
  return before;
}

function eventBase(repo, eventName, event) {
  if (eventName === "pull_request") return eventSha(event?.pull_request?.base?.sha, "Pull request base");
  if (eventName === "push") return pushBase(repo, event);
  throw new Error("An explicit --base-ref is required outside pull_request/push CI events");
}

function resolveCommit(repo, base) {
  if (typeof base !== "string" || !base || base.startsWith("-")) throw new Error("Invalid audit base");
  const commit = git(repo, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (!sha.test(commit)) throw new Error("Invalid resolved commit");
  return commit;
}

function requireComparison(repo, commit, explicitBase) {
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (commit !== head) return;
  if (!explicitBase || !git(repo, ["status", "--porcelain"])) {
    throw new Error("Audit base must differ from HEAD unless explicitly auditing local changes");
  }
}

export function resolveAuditBase(repo, explicitBase, eventName, event) {
  const base = explicitBase || eventBase(repo, eventName, event);
  const commit = resolveCommit(repo, base);
  requireComparison(repo, commit, explicitBase);
  git(repo, ["merge-base", commit, "HEAD"]);
  return commit;
}

function matchesEnvelope(result, base) {
  const expected = {
    schema_version: "static-code-audit-gate.v1", wrapper_version: "0.4.1",
    status: "pass", mode: "diff-gate", tool: "fallow", base_ref: base,
  };
  return Object.entries(expected).every(([key, value]) => result?.[key] === value);
}

function noBlockingFindings(result) {
  return Array.isArray(result?.blocking_findings) && result.blocking_findings.length === 0;
}

export function validateAuditResult(stdout, exitCode, expectedBase) {
  const result = JSON.parse(stdout);
  const checks = [
    exitCode === 0, matchesEnvelope(result, expectedBase), noBlockingFindings(result),
    /^(?:fallow\s+)?3\.23\.0$/.test(result?.tool_version),
  ];
  if (!checks.every(Boolean)) {
    throw new Error(`Static audit did not pass the pinned CI contract (status=${result?.status ?? "missing"}, exit=${exitCode})`);
  }
  return result;
}

function argumentBase(args) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--base-ref")) {
    throw new Error("Usage: pnpm audit:static --base-ref <ref> (or CI event metadata)");
  }
  return args[1];
}

function readEvent(env) {
  return env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : undefined;
}

function executeWrapper(base, env) {
  return spawnSync("python3", [
    resolve(directory, "static_audit_gate.py"), "diff-gate", "--repo", repository,
    "--base-ref", base, "--timeout-seconds", "120",
  ], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 135_000,
    env: {
      ...env,
      FALLOW_BIN: resolve(repository, "node_modules/.bin/fallow"),
      FALLOW_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    },
  });
}

export function runStaticAudit(args = process.argv.slice(2), env = process.env) {
  const explicitBase = argumentBase(args);
  const event = explicitBase ? undefined : readEvent(env);
  const base = resolveAuditBase(repository, explicitBase, env.GITHUB_EVENT_NAME, event);
  const result = executeWrapper(base, env);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  validateAuditResult(result.stdout, result.status, base);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runStaticAudit();
  } catch (error) {
    console.error(`[static-audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
