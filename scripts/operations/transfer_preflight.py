#!/usr/bin/env python3
"""Provider-free preflight for transferring an exact, self-contained Git bundle."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Sequence


COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
GIT_TIMEOUT_SECONDS = 15


def _check(name: str, ok: bool, detail: str) -> dict[str, Any]:
    return {"name": name, "status": "pass" if ok else "fail", "detail": detail}


def _git(args: Sequence[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    for name in (
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    ):
        env.pop(name, None)
    for name in tuple(env):
        if name.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
            env.pop(name, None)
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_ALLOW_PROTOCOL"] = "file"
    env["GIT_TERMINAL_PROMPT"] = "0"
    command = [
        "git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
        "-c", f"core.hooksPath={os.devnull}", *args,
    ]
    try:
        return subprocess.run(
            command, cwd=cwd, env=env, text=True, timeout=GIT_TIMEOUT_SECONDS,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(command, 124, "", f"git command timed out after {GIT_TIMEOUT_SECONDS} seconds")
    except OSError as exc:
        return subprocess.CompletedProcess(command, 127, "", f"git command failed to start: {exc}")


def _git_failure(result: subprocess.CompletedProcess[str], fallback: str) -> str:
    error = result.stderr.strip()
    return error if error else fallback


def _git_value(args: Sequence[str], cwd: Path) -> tuple[bool, str]:
    result = _git(args, cwd)
    return result.returncode == 0, result.stdout.strip()


def _inside(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


def _path_without_symlinks(path: Path) -> bool:
    current = path if path.is_absolute() else Path.cwd() / path
    for item in (current, *current.parents):
        if item.exists() and item.is_symlink():
            return False
    return True


def _probe_cache(cache_dir: Path) -> tuple[bool, str]:
    try:
        before = os.lstat(cache_dir)
    except OSError as exc:
        return False, f"cache directory is unavailable: {exc.strerror}"
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        return False, "cache path must be an existing non-symlink directory"
    # Root can bypass ordinary Unix mode checks. Treat a directory with no write
    # bit as unwritable even when the preflight itself has elevated privileges.
    if before.st_mode & 0o222 == 0:
        return False, "cache directory has no configured write permission"

    name = f".council-transfer-preflight-{os.getpid()}-{uuid.uuid4().hex}"
    fd: int | None = None
    created = False
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        directory_fd = os.open(cache_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
            created = True
            payload = uuid.uuid4().bytes
            os.write(fd, payload)
            os.fsync(fd)
            os.close(fd)
            fd = None
            read_fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory_fd)
            try:
                observed = os.read(read_fd, len(payload) + 1)
            finally:
                os.close(read_fd)
            if observed != payload:
                return False, "exclusive cache probe readback differed"
            os.unlink(name, dir_fd=directory_fd)
            created = False
        finally:
            if created:
                try:
                    os.unlink(name, dir_fd=directory_fd)
                except OSError:
                    pass
            os.close(directory_fd)
    except OSError as exc:
        return False, f"exclusive cache write/read/delete failed: {exc.strerror}"
    finally:
        if fd is not None:
            os.close(fd)
    return True, "exclusive write/read/delete succeeded and probe was removed"


def run_preflight(
    *, repo: Path, bundle: Path, max_attachment_bytes: int,
    cache_dirs: Sequence[Path], base: str, candidate: str,
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    exact_commits = bool(COMMIT_RE.fullmatch(base) and COMMIT_RE.fullmatch(candidate))
    checks.append(_check("exact_commit_inputs", exact_commits, "base and candidate are 40-character lowercase commit IDs" if exact_commits else "base and candidate must be 40-character lowercase commit IDs"))
    checks.append(_check("candidate_differs_from_base", exact_commits and base != candidate, "candidate is distinct from base" if exact_commits and base != candidate else "candidate must be distinct from base"))

    try:
        repo_abs = repo.resolve(strict=True)
        repo_result = _git(["rev-parse", "--git-dir"], repo_abs)
        repo_ok = repo_abs.is_dir() and repo_result.returncode == 0
    except OSError:
        repo_abs = repo.absolute()
        repo_result = subprocess.CompletedProcess([], 1, "", "repository path could not be resolved")
        repo_ok = False
    checks.append(_check("repository", repo_ok, str(repo_abs) if repo_ok else _git_failure(repo_result, "repository is missing or is not a Git worktree")))

    try:
        bundle_lstat = os.lstat(bundle)
        bundle_abs = bundle.resolve(strict=True)
        bundle_ok = stat.S_ISREG(bundle_lstat.st_mode) and not stat.S_ISLNK(bundle_lstat.st_mode)
        bundle_size = bundle_lstat.st_size
    except OSError:
        bundle_abs = bundle.absolute()
        bundle_ok = False
        bundle_size = -1
    checks.append(_check("bundle_path", bundle_ok, str(bundle_abs) if bundle_ok else "bundle must be an existing regular, non-symlink file"))

    limit_ok = isinstance(max_attachment_bytes, int) and max_attachment_bytes > 0
    checks.append(_check("attachment_limit", limit_ok, f"configured maximum is {max_attachment_bytes} bytes" if limit_ok else "maximum attachment size must be positive"))
    size_ok = bundle_ok and limit_ok and bundle_size <= max_attachment_bytes
    checks.append(_check("bundle_size", size_ok, f"bundle is {bundle_size} bytes; configured maximum is {max_attachment_bytes} bytes"))

    if repo_ok:
        head_ok, head = _git_value(["rev-parse", "HEAD^{commit}"], repo_abs)
        dirty_result = _git(["status", "--porcelain=v1", "--untracked-files=all"], repo_abs)
        clean = dirty_result.returncode == 0 and not dirty_result.stdout.strip()
        checks.append(_check("repo_head", head_ok and exact_commits and head == candidate, f"observed HEAD {head or '<unresolved>'}; expected candidate {candidate}"))
        checks.append(_check("repo_clean", clean, "worktree is clean" if clean else _git_failure(dirty_result, "worktree has tracked or untracked changes")))

        if exact_commits:
            base_ok, observed_base = _git_value(["rev-parse", f"{base}^{{commit}}"], repo_abs)
            candidate_ok, observed_candidate = _git_value(["rev-parse", f"{candidate}^{{commit}}"], repo_abs)
            identity_ok = base_ok and candidate_ok and observed_base == base and observed_candidate == candidate
            checks.append(_check("repo_commit_identity", identity_ok, f"base={observed_base or '<unresolved>'}; candidate={observed_candidate or '<unresolved>'}"))
            ancestry = identity_ok and _git(["merge-base", "--is-ancestor", base, candidate], repo_abs).returncode == 0
            checks.append(_check("repo_base_ancestry", ancestry, "base is an ancestor of candidate" if ancestry else "base is not an ancestor of candidate"))
        else:
            checks.append(_check("repo_commit_identity", False, "commit inputs were invalid"))
            checks.append(_check("repo_base_ancestry", False, "commit inputs were invalid"))

    cache_paths: list[Path] = []
    for raw in cache_dirs:
        cache_abs = raw.absolute()
        safe = repo_ok and _path_without_symlinks(cache_abs) and not _inside(cache_abs.resolve(strict=False), repo_abs)
        if not safe:
            checks.append(_check("cache_probe", False, f"unsafe cache directory: {cache_abs}"))
            continue
        cache_paths.append(cache_abs)
        ok, detail = _probe_cache(cache_abs)
        checks.append(_check("cache_probe", ok, f"{cache_abs}: {detail}"))
    if not cache_dirs:
        checks.append(_check("cache_probe", False, "at least one explicit cache directory is required"))

    if repo_ok and bundle_ok and exact_commits:
        listed = _git(["bundle", "list-heads", str(bundle_abs)], repo_abs)
        advertised: dict[str, str] = {}
        if listed.returncode == 0:
            for line in listed.stdout.splitlines():
                parts = line.split(maxsplit=1)
                if len(parts) == 2:
                    advertised[parts[1]] = parts[0]
        refs_ok = (
            listed.returncode == 0
            and advertised.get("refs/heads/base") == base
            and advertised.get("refs/heads/candidate") == candidate
        )
        refs_detail = f"base={advertised.get('refs/heads/base', '<missing>')}; candidate={advertised.get('refs/heads/candidate', '<missing>')}"
        checks.append(_check("bundle_refs", refs_ok, refs_detail if listed.returncode == 0 else _git_failure(listed, refs_detail)))

        with tempfile.TemporaryDirectory(prefix="council-transfer-preflight-") as temp:
            isolated = Path(temp) / "repository.git"
            init = _git(["init", "--bare", str(isolated)], Path(temp))
            verify = _git(["bundle", "verify", str(bundle_abs)], isolated) if init.returncode == 0 else init
            verify_ok = verify.returncode == 0
            checks.append(_check("bundle_verify", verify_ok, "git bundle verify succeeded in an empty repository" if verify_ok else _git_failure(verify, "git bundle verify rejected prerequisites or format")))

            fetched = _git([
                "fetch", "--quiet", str(bundle_abs),
                "refs/heads/base:refs/council/base",
                "refs/heads/candidate:refs/council/candidate",
            ], isolated) if verify_ok and refs_ok else verify
            imported_ok = verify_ok and refs_ok and fetched.returncode == 0
            checks.append(_check("bundle_integrity", imported_ok, "declared refs imported into an empty repository" if imported_ok else _git_failure(fetched, "bundle is corrupt, thin, incomplete, or has wrong refs")))
            fetched_ok = imported_ok
            observed_isolated_base = ""
            observed_isolated_candidate = ""
            if fetched_ok:
                base_resolved, observed_isolated_base = _git_value(["rev-parse", "refs/council/base^{commit}"], isolated)
                candidate_resolved, observed_isolated_candidate = _git_value(["rev-parse", "refs/council/candidate^{commit}"], isolated)
                fetched_ok = base_resolved and candidate_resolved and observed_isolated_base == base and observed_isolated_candidate == candidate
            checks.append(_check("bundle_exact_identity", fetched_ok, f"base={observed_isolated_base or '<unresolved>'}; candidate={observed_isolated_candidate or '<unresolved>'}"))
            complete = fetched_ok and _git(["fsck", "--full", "--no-dangling"], isolated).returncode == 0
            ancestry = complete and _git(["merge-base", "--is-ancestor", base, candidate], isolated).returncode == 0
            checks.append(_check("bundle_complete", complete and ancestry, "isolated fetch, object traversal, and base ancestry succeeded" if complete and ancestry else "isolated repository could not fully traverse the declared candidate from the declared base"))

    report: dict[str, Any] = {
        "schemaVersion": "council-transfer-preflight.v1",
        "status": "pass" if all(item["status"] == "pass" for item in checks) else "blocked",
        "checks": checks,
    }
    return report


def _write_report(path: Path, repo: Path, bundle: Path, report: dict[str, Any]) -> None:
    destination = path.absolute()
    repo_abs = repo.resolve(strict=True)
    bundle_abs = bundle.resolve(strict=True)
    if not _path_without_symlinks(destination.parent) or _inside(destination.resolve(strict=False), repo_abs) or destination.resolve(strict=False) == bundle_abs:
        raise ValueError("output must be a new non-symlink path outside the source repository and bundle")
    payload = (json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(destination, flags, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--max-attachment-bytes", type=int, required=True)
    parser.add_argument("--cache-dir", type=Path, action="append", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = run_preflight(
        repo=args.repo, bundle=args.bundle,
        max_attachment_bytes=args.max_attachment_bytes,
        cache_dirs=args.cache_dir, base=args.base, candidate=args.candidate,
    )
    if args.output is not None:
        try:
            _write_report(args.output, args.repo, args.bundle, report)
        except (OSError, ValueError) as exc:
            report["checks"].append(_check("output_report", False, str(exc)))
            report["status"] = "blocked"
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
