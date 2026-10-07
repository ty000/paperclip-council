"""Read-only preflight inside an already admitted publisher's native environment.

No credential discovery/copy, permission change, push, PR creation or model call.
The resulting report is attributed by Council to the active publisher run; it
is not an independent attestation of a future write.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.parse
import uuid


class Refused(ValueError):
    pass


def command(argv: list[str], cwd: Path, allowed: tuple[int, ...] = (0,)) -> tuple[int, str]:
    # Preserve native GitHub credential/helper projection. Never print the env
    # or subprocess stderr, which can contain authentication diagnostics.
    result = subprocess.run(argv, cwd=cwd, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "GH_PROMPT_DISABLED": "1"},
                            capture_output=True, timeout=12, check=False)
    if result.returncode not in allowed:
        raise Refused("read_command_failed")
    if len(result.stdout) > 128 * 1024:
        raise Refused("read_response_too_large")
    return result.returncode, result.stdout.decode("utf-8", errors="strict").strip()


def git(repo: Path, *args: str, allowed: tuple[int, ...] = (0,)) -> tuple[int, str]:
    return command(["git", "-c", "core.fsmonitor=false", *args], repo, allowed)


def safe_repository(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value) or any(part in {".", ".."} for part in value.split("/")):
        raise Refused("invalid_repository")
    return value


def safe_ref(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]*", value) or ".." in value:
        raise Refused("invalid_ref")
    return value


def sha(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise Refused("invalid_sha")
    return value


def remote_repository(value: str) -> str:
    # Credentials in a remote URL are refused without including that URL in
    # the report. GitHub's native Git helper remains responsible for access.
    if value.startswith("git@github.com:"):
        path = value.removeprefix("git@github.com:")
    else:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.port:
            raise Refused("origin_not_canonical_github")
        path = parsed.path.removeprefix("/")
    return safe_repository(path.removesuffix(".git"))


def probe(*, repo: Path, repository: str, candidate: str, base_ref: str, base_sha: str,
          head_ref: str, expected_remote_head: str | None, mission_id: str,
          intent_id: str, issue_id: str, run_id: str) -> dict:
    repository = safe_repository(repository)
    base_ref, head_ref = safe_ref(base_ref), safe_ref(head_ref)
    candidate, base_sha = sha(candidate), sha(base_sha)
    if expected_remote_head is not None:
        sha(expected_remote_head)
    for identity in [mission_id, intent_id, issue_id, run_id]:
        if str(uuid.UUID(identity)) != identity:
            raise Refused("invalid_identity")
    if base_ref == head_ref or not repo.is_absolute() or repo.resolve() != repo:
        raise Refused("invalid_workspace_or_refs")
    report = {"protocol": "publisher-run-report-v1", "status": "blocked",
              "missionId": mission_id, "intentId": intent_id, "issueId": issue_id,
              "runId": run_id, "repository": repository, "candidateCommit": candidate,
              "baseRef": base_ref, "baseCommit": base_sha, "headRef": head_ref,
              "remoteHead": expected_remote_head, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "provenance": "publisher_run_report", "checks": {},
              "publicationWriteObserved": False, "providerTurnsStartedByProbe": 0}
    checks = report["checks"]
    try:
        checks["gitTool"] = git(repo, "--version")[1].startswith("git version ")
        checks["ghTool"] = command(["gh", "--version"], repo)[1].startswith("gh version ")
        checks["workspaceIdentity"] = Path(git(repo, "rev-parse", "--show-toplevel")[1]) == repo
        checks["localCandidate"] = git(repo, "rev-parse", "HEAD")[1] == candidate
        checks["originIdentity"] = remote_repository(git(repo, "remote", "get-url", "origin")[1]) == repository
        checks["trackedFilesClean"] = not git(repo, "status", "--porcelain=v1", "--untracked-files=no")[1]
        if not all(checks.values()):
            raise Refused("local_publication_prerequisite_failed")
        # This uses the publisher's current native gh projection, not an
        # operator token or another agent's grant. Report only selected fields.
        response = json.loads(command(["gh", "api", f"repos/{repository}", "--jq", "{full_name,permissions:{push:.permissions.push}}"], repo)[1])
        if not isinstance(response, dict):
            raise Refused("github_response_invalid")
        permissions = response.get("permissions")
        checks["repositoryRead"] = response.get("full_name") == repository
        checks["pushPermissionReported"] = isinstance(permissions, dict) and permissions.get("push") is True
        if not checks["repositoryRead"] or not checks["pushPermissionReported"]:
            raise Refused("github_read_or_push_permission_unconfirmed")
        _, base = git(repo, "ls-remote", "--exit-code", "origin", "refs/heads/" + base_ref)
        checks["remoteBase"] = base == base_sha + "\trefs/heads/" + base_ref
        code, head = git(repo, "ls-remote", "--exit-code", "origin", "refs/heads/" + head_ref, allowed=(0, 2))
        checks["remoteHeadLease"] = (code == 2 and not head) if expected_remote_head is None else (code == 0 and head == expected_remote_head + "\trefs/heads/" + head_ref)
        if not checks["remoteBase"] or not checks["remoteHeadLease"]:
            raise Refused("remote_candidate_or_lease_changed")
        report["status"] = "pass"
    except (Refused, OSError, UnicodeError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        report["reason"] = str(error) if isinstance(error, Refused) else type(error).__name__
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-ref", required=True)
    parser.add_argument("--expected-remote-head")
    parser.add_argument("--mission-id", required=True)
    parser.add_argument("--intent-id", required=True)
    args = parser.parse_args()
    try:
        report = probe(repo=args.repo, repository=args.repository, candidate=args.candidate,
            base_ref=args.base_ref, base_sha=args.base_sha, head_ref=args.head_ref,
            expected_remote_head=args.expected_remote_head, mission_id=args.mission_id,
            intent_id=args.intent_id, issue_id=os.environ.get("PAPERCLIP_TASK_ID", ""),
            run_id=os.environ.get("PAPERCLIP_RUN_ID", ""))
    except (Refused, ValueError, OSError) as error:
        report = {"protocol": "publisher-run-report-v1", "status": "blocked",
                  "reason": str(error) if isinstance(error, Refused) else type(error).__name__}
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
