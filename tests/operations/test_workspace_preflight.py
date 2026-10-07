from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/operations/workspace_preflight.py"
SPEC = importlib.util.spec_from_file_location("workspace_preflight", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
REAL_RPC = MODULE.Rpc


class FakeRpc:
    calls = []
    success = True
    policy = None
    closed = False

    def __init__(self, command, repo, home, path):
        self.repo = repo
        self.home = home

    def request(self, method, params):
        self.calls.append((method, params))
        if method == "initialize":
            return {"userAgent": "deterministic-provider-free-fixture"}
        if method == "config/read":
            return {"config": self.policy or {"sandbox_mode": "workspace-write",
                    "sandbox_workspace_write": {"network_access": False, "writable_roots": [str(self.repo / ".git")]}},
                    "layers": [{"name": {"type": "project", "dotCodexFolder": str(self.repo / ".codex")}, "version": "fixture"}]}
        if method == "command/exec":
            if not self.success:
                return {"exitCode": 128, "stdout": "", "stderr": "private transport diagnostic"}
            result = subprocess.run(params["command"], cwd=params["cwd"],
                                    env={**MODULE.environment(), **{k: v for k, v in params["env"].items() if v is not None}}, capture_output=True)
            return {"exitCode": result.returncode}
        raise AssertionError("Unexpected method")

    def close(self):
        type(self).closed = True


class WorkspacePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="council-test-preflight-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.home = self.root / "home"
        self.repo.mkdir()
        self.home.mkdir()
        self.git("init", "-q")
        (self.repo / "source.txt").write_text("candidate\n")
        self.git("add", "source.txt")
        self.git("-c", "user.name=Probe", "-c", "user.email=probe@example.test", "commit", "-qm", "seed")
        FakeRpc.calls = []
        FakeRpc.success = True
        FakeRpc.policy = None
        FakeRpc.closed = False
        self.fake = patch.object(MODULE, "Rpc", FakeRpc)
        self.fake.start()
        self.addCleanup(self.fake.stop)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, env=MODULE.environment(), stderr=subprocess.DEVNULL).decode().strip()

    def state(self):
        return {str(path.relative_to(self.root)): (path.read_bytes(), path.stat().st_mode)
                for path in self.root.rglob("*") if path.is_file()}

    def probe(self, **kwargs):
        return MODULE.probe(self.repo, self.home, **kwargs)

    def test_temporary_index_write_preserves_dirty_and_staged_candidate_and_config(self):
        MODULE.prepare_policy(self.repo)
        (self.repo / "source.txt").write_text("staged\n")
        self.git("add", "source.txt")
        (self.repo / "source.txt").write_text("dirty\n")
        (self.home / "config.toml").write_text("# existing native configuration\n")
        before = self.state()
        report = self.probe()
        self.assertEqual("pass", report["status"])
        self.assertTrue(all(report["checks"].values()))
        self.assertEqual(before, self.state())
        self.assertEqual(["initialize", "config/read", "command/exec"], [method for method, _ in FakeRpc.calls])
        self.assertFalse(report["nativeAgentExecutionObserved"])
        self.assertFalse(report["githubAccessObserved"])
        self.assertTrue(FakeRpc.closed)

    def test_protected_git_refuses_and_cleans_only_owned_probe_files(self):
        FakeRpc.success = False
        (self.repo / ".git" / "index.lock").write_text("operator lock")
        before = self.state()
        report = self.probe()
        self.assertEqual("blocked", report["status"])
        self.assertEqual("sandbox_git_write_failed", report["reason"])
        self.assertEqual(before, self.state())
        self.assertNotIn("private transport diagnostic", str(report))

    def test_creation_is_exclusive_and_does_not_overwrite_foreign_policy(self):
        folder = self.repo / ".codex"
        folder.mkdir()
        (folder / "config.toml").write_text("foreign = true\n")
        before = self.state()
        with self.assertRaisesRegex(MODULE.Blocked, "project_config_exists"):
            MODULE.prepare_policy(self.repo)
        self.assertEqual(before, self.state())

    def test_fresh_policy_grants_only_this_clone_git_and_no_home_changes(self):
        before_head = self.git("rev-parse", "HEAD")
        before_index = (self.repo / ".git" / "index").read_bytes()
        result = MODULE.prepare_policy(self.repo, before_head)
        self.assertEqual("prepared", result["status"])
        self.assertEqual(0, result["providerTurns"])
        self.assertFalse(result["launchReadinessObserved"])
        policy = (self.repo / ".codex" / "config.toml").read_text()
        self.assertIn(str(self.repo / ".git"), policy)
        self.assertNotIn(str(self.home), policy)
        self.assertEqual(before_head, self.git("rev-parse", "HEAD"))
        self.assertEqual(before_index, (self.repo / ".git" / "index").read_bytes())

    def test_scope_and_candidate_mismatches_refuse_before_subprocess(self):
        cases = [lambda: MODULE.prepare_policy(self.repo, "0" * 40),
                 lambda: MODULE.probe(self.repo, self.root / "missing"),
                 lambda: MODULE.workspace(self.repo / ".git")]
        for action in cases:
            with self.assertRaises(MODULE.Blocked):
                action()
        self.assertEqual([], FakeRpc.calls)

    def test_symlinked_workspace_and_project_config_are_refused(self):
        linked = self.root / "alias"
        linked.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(MODULE.Blocked, "canonical_absolute"):
            MODULE.prepare_policy(linked)
        (self.repo / ".codex").symlink_to(self.home, target_is_directory=True)
        with self.assertRaisesRegex(MODULE.Blocked, "symlink_project_config"):
            MODULE.prepare_policy(self.repo)

    def test_linked_worktree_does_not_grant_shared_git_metadata(self):
        target = self.root / "worktree"
        self.git("worktree", "add", "-qb", "secondary", str(target))
        with self.assertRaisesRegex(MODULE.Blocked, "standalone_clone_required"):
            MODULE.prepare_policy(target)

    def test_wider_or_disabled_sandbox_never_executes_probe(self):
        for mode, roots in [("danger-full-access", []), ("workspace-write", [str(self.root)]),
                            ("workspace-write", [str(self.repo / ".git"), str(self.home)])]:
            FakeRpc.calls = []
            FakeRpc.policy = {"sandbox_mode": mode, "sandbox_workspace_write": {"network_access": False, "writable_roots": roots}}
            report = self.probe()
            self.assertEqual("blocked", report["status"])
            self.assertEqual("sandbox_policy_out_of_scope", report["reason"])
            self.assertNotIn("command/exec", [method for method, _ in FakeRpc.calls])
            self.assertFalse(list((self.repo / ".git").glob("council-preflight-*")))

    def test_failed_transport_is_cleaned_and_never_retried(self):
        def fail(self, method, params):
            raise MODULE.Blocked("codex_transport_closed")
        with patch.object(FakeRpc, "request", fail):
            with self.assertRaisesRegex(MODULE.Blocked, "codex_transport_closed"):
                self.probe()
        self.assertTrue(FakeRpc.closed)
        self.assertFalse(list((self.repo / ".git").glob("council-preflight-*")))

    def test_rpc_method_allowlist_and_credential_environment(self):
        with patch.dict(os.environ, {"GIT_DIR": "/foreign", "OPENAI_API_KEY": "never-forward", "GH_TOKEN": "never-forward"}):
            self.assertNotIn("GIT_DIR", MODULE.environment())
            self.assertNotIn("OPENAI_API_KEY", MODULE.environment())
            self.assertNotIn("GH_TOKEN", MODULE.environment())
        self.assertEqual({"initialize", "config/read", "command/exec"}, REAL_RPC.METHODS)
        with self.assertRaisesRegex(MODULE.Blocked, "rpc_method_forbidden"):
            REAL_RPC.request(object.__new__(REAL_RPC), "turn/start", {})


if __name__ == "__main__":
    unittest.main()
