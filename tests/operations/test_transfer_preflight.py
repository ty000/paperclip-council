from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "operations" / "transfer_preflight.py"
SPEC = importlib.util.spec_from_file_location("transfer_preflight", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def statuses(report: dict) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for item in report["checks"]:
        result.setdefault(item["name"], []).append(item["status"])
    return result


class TransferPreflightTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "source"
        self.repo.mkdir()
        git(self.repo, "init", "--initial-branch=main")
        git(self.repo, "config", "user.name", "Council test")
        git(self.repo, "config", "user.email", "council@example.invalid")
        (self.repo / "result.txt").write_text("base\n", encoding="utf-8")
        git(self.repo, "add", "result.txt")
        git(self.repo, "commit", "-m", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "result.txt").write_text("candidate\n", encoding="utf-8")
        git(self.repo, "commit", "-am", "candidate")
        self.candidate = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "branch", "base", self.base)
        git(self.repo, "branch", "candidate", self.candidate)
        self.bundle = self.root / "candidate.bundle"
        git(self.repo, "bundle", "create", str(self.bundle), "refs/heads/base", "refs/heads/candidate")
        self.cache = self.root / "cache"
        self.cache.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_check(self, **changes: object) -> dict:
        inputs = {
            "repo": self.repo,
            "bundle": self.bundle,
            "max_attachment_bytes": self.bundle.stat().st_size + 1,
            "cache_dirs": [self.cache],
            "base": self.base,
            "candidate": self.candidate,
        }
        inputs.update(changes)
        return MODULE.run_preflight(**inputs)

    def source_snapshot(self) -> dict[str, tuple[int, bytes]]:
        return {
            str(path.relative_to(self.repo)): (path.stat().st_mode, path.read_bytes())
            for path in self.repo.rglob("*")
            if path.is_file()
        }

    def test_actual_full_bundle_passes_without_source_or_cache_residue(self) -> None:
        before = self.source_snapshot()
        report = self.run_check()
        self.assertEqual(report["status"], "pass", report)
        self.assertEqual(self.source_snapshot(), before)
        self.assertEqual(list(self.cache.iterdir()), [])
        observed = statuses(report)
        for name in (
            "repo_head", "repo_clean", "repo_commit_identity", "repo_base_ancestry",
            "bundle_refs", "bundle_integrity", "bundle_exact_identity", "bundle_complete",
            "cache_probe",
        ):
            self.assertEqual(observed[name], ["pass"], name)

    def test_git_commands_are_local_only_config_isolated_and_time_bounded(self) -> None:
        completed = subprocess.CompletedProcess([], 0, "git version test", "")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            MODULE._git(["--version"], self.repo)
        kwargs = run.call_args.kwargs
        command = run.call_args.args[0]
        self.assertEqual(kwargs["timeout"], MODULE.GIT_TIMEOUT_SECONDS)
        self.assertEqual(kwargs["env"]["GIT_ALLOW_PROTOCOL"], "file")
        self.assertEqual(kwargs["env"]["GIT_CONFIG_GLOBAL"], os.devnull)
        self.assertEqual(kwargs["env"]["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertNotIn("GIT_ALTERNATE_OBJECT_DIRECTORIES", kwargs["env"])
        self.assertIn(f"core.hooksPath={os.devnull}", command)

    def test_git_timeout_is_reported_as_blocked(self) -> None:
        with mock.patch.object(
            MODULE.subprocess, "run",
            side_effect=subprocess.TimeoutExpired(["git"], MODULE.GIT_TIMEOUT_SECONDS),
        ):
            report = self.run_check()
        self.assertEqual(report["status"], "blocked")
        repository = next(item for item in report["checks"] if item["name"] == "repository")
        self.assertIn("timed out", repository["detail"])

    def test_modeled_attachment_limit_blocks_oversize_bundle(self) -> None:
        # The same comparison models 21.5 MB > 10 MB without allocating either size.
        report = self.run_check(max_attachment_bytes=self.bundle.stat().st_size - 1)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(statuses(report)["bundle_size"], ["fail"])

    def test_missing_declared_base_head_is_blocked(self) -> None:
        candidate_only = self.root / "candidate-only.bundle"
        git(self.repo, "bundle", "create", str(candidate_only), "refs/heads/candidate")
        report = self.run_check(bundle=candidate_only, max_attachment_bytes=candidate_only.stat().st_size + 1)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(statuses(report)["bundle_refs"], ["fail"])

    def test_wrong_exact_candidate_is_blocked(self) -> None:
        report = self.run_check(candidate=self.base)
        observed = statuses(report)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(observed["repo_head"], ["fail"])
        self.assertEqual(observed["bundle_refs"], ["fail"])

    def test_corrupt_bundle_is_blocked(self) -> None:
        corrupt = self.root / "corrupt.bundle"
        shutil.copyfile(self.bundle, corrupt)
        with corrupt.open("r+b") as handle:
            handle.truncate(max(1, corrupt.stat().st_size // 2))
        report = self.run_check(bundle=corrupt, max_attachment_bytes=corrupt.stat().st_size + 1)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(statuses(report)["bundle_integrity"], ["fail"])

    def test_thin_bundle_cannot_use_objects_from_source_repository(self) -> None:
        thin = self.root / "thin.bundle"
        git(self.repo, "bundle", "create", str(thin), "refs/heads/candidate", f"^{self.base}")
        report = self.run_check(bundle=thin, max_attachment_bytes=thin.stat().st_size + 1)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(statuses(report)["bundle_integrity"], ["fail"])

    def test_unwritable_cache_is_blocked_even_for_privileged_caller(self) -> None:
        self.cache.chmod(0o500)
        try:
            report = self.run_check()
        finally:
            self.cache.chmod(0o700)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(statuses(report)["cache_probe"], ["fail"])
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_cache_inside_source_and_symlink_cache_are_rejected(self) -> None:
        inside = self.repo / "cache"
        inside.mkdir()
        symlink = self.root / "cache-link"
        symlink.symlink_to(self.cache, target_is_directory=True)
        report = self.run_check(cache_dirs=[inside, symlink])
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(statuses(report)["cache_probe"], ["fail", "fail"])
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_cli_emits_json_nonzero_and_refuses_output_overwrite(self) -> None:
        output = self.root / "report.json"
        output.write_text("keep", encoding="utf-8")
        result = subprocess.run([
            sys.executable, str(SCRIPT),
            "--repo", str(self.repo), "--bundle", str(self.bundle),
            "--max-attachment-bytes", str(self.bundle.stat().st_size + 1),
            "--cache-dir", str(self.cache), "--base", self.base,
            "--candidate", self.candidate, "--output", str(output),
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(output.read_text(encoding="utf-8"), "keep")

    def test_cli_writes_new_compact_report_outside_source(self) -> None:
        output = self.root / "report.json"
        result = subprocess.run([
            sys.executable, str(SCRIPT),
            "--repo", str(self.repo), "--bundle", str(self.bundle),
            "--max-attachment-bytes", str(self.bundle.stat().st_size + 1),
            "--cache-dir", str(self.cache), "--base", self.base,
            "--candidate", self.candidate, "--output", str(output),
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "pass")
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["status"], "pass")
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
