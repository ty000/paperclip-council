import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/operations/publisher_preflight.py"
SPEC = importlib.util.spec_from_file_location("publisher_preflight", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PublisherPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="council-publisher-probe-")
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.head = "a" * 40
        self.base = "b" * 40
        self.remote_head = None
        self.permission = True
        self.remote_base = self.base
        self.dirty = False
        self.origin = "https://github.com/test/product.git"
        self.calls = []
        self.failure = None
        self.inputs = {"repo": self.repo, "repository": "test/product", "candidate": self.head,
                       "base_ref": "main", "base_sha": self.base, "head_ref": "codex/delivery",
                       "expected_remote_head": None,
                       **{key: str(uuid.uuid4()) for key in ["mission_id", "intent_id", "issue_id", "run_id"]}}
        self.patcher = patch.object(MODULE, "command", self.command)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def command(self, argv, cwd, allowed=(0,)):
        self.calls.append(argv)
        if self.failure and self.failure in argv:
            raise MODULE.Refused("read_command_failed")
        if argv[0] == "gh":
            if argv[1] == "--version":
                return 0, "gh version fixture"
            self.assertEqual(["api", "repos/test/product"], argv[1:3])
            self.assertNotIn("--method", argv)
            return 0, json.dumps({"full_name": "test/product", "permissions": {"push": self.permission}})
        self.assertEqual("git", argv[0])
        args = argv[3:]
        if args == ["--version"]:
            return 0, "git version fixture"
        if args == ["rev-parse", "--show-toplevel"]:
            return 0, str(self.repo)
        if args == ["rev-parse", "HEAD"]:
            return 0, self.head
        if args == ["remote", "get-url", "origin"]:
            return 0, self.origin
        if args[0] == "status":
            return 0, " M source.ts" if self.dirty else ""
        if args[0] == "ls-remote":
            ref = args[-1]
            if ref == "refs/heads/main":
                return 0, self.remote_base + "\t" + ref
            return (0, self.remote_head + "\t" + ref) if self.remote_head else (2, "")
        raise AssertionError(f"Unexpected/read-write Git command: {args}")

    def probe(self):
        return MODULE.probe(**self.inputs)

    def test_new_head_uses_only_reads_and_does_not_claim_publication_success(self):
        report = self.probe()
        self.assertEqual("pass", report["status"])
        self.assertTrue(all(report["checks"].values()))
        self.assertFalse(report["publicationWriteObserved"])
        self.assertEqual(0, report["providerTurnsStartedByProbe"])
        self.assertEqual("publisher_run_report", report["provenance"])
        self.assertIsNone(report["remoteHead"])
        self.assertFalse(any("push" in argv or "create" in argv for argv in self.calls))

    def test_update_requires_the_exact_previous_remote_head(self):
        self.remote_head = "c" * 40
        self.inputs["expected_remote_head"] = self.remote_head
        self.assertEqual("pass", self.probe()["status"])
        self.remote_head = "d" * 40
        report = self.probe()
        self.assertEqual("blocked", report["status"])
        self.assertEqual("remote_candidate_or_lease_changed", report["reason"])

    def test_existing_head_for_create_and_changed_base_refuse(self):
        self.remote_head = "c" * 40
        self.assertEqual("blocked", self.probe()["status"])
        self.remote_head = None
        self.remote_base = "d" * 40
        self.assertEqual("blocked", self.probe()["status"])

    def test_read_only_or_unknown_push_permission_is_not_publication_authority(self):
        for permission in [False, None, "true"]:
            self.permission = permission
            report = self.probe()
            self.assertEqual("blocked", report["status"])
            self.assertEqual("github_read_or_push_permission_unconfirmed", report["reason"])

    def test_dirty_candidate_and_wrong_origin_stop_before_github_access(self):
        self.dirty = True
        self.assertEqual("blocked", self.probe()["status"])
        self.assertFalse(any(argv[0] == "gh" and "api" in argv for argv in self.calls))
        self.dirty = False
        self.calls = []
        self.origin = "https://github.com/other/product.git"
        self.assertEqual("blocked", self.probe()["status"])
        self.assertFalse(any(argv[0] == "gh" and "api" in argv for argv in self.calls))

    def test_credentials_in_remote_and_transport_diagnostics_are_never_reported(self):
        self.origin = "https://private-value@github.com/test/product.git"
        report = self.probe()
        self.assertEqual("blocked", report["status"])
        self.assertNotIn("private-value", json.dumps(report))
        self.origin = "git@github.com:test/product.git"
        self.failure = "api"
        self.assertEqual("blocked", self.probe()["status"])

    def test_invalid_bindings_refuse_before_any_process(self):
        for key, value in [("repository", "../escape"), ("head_ref", "--force"), ("base_ref", "bad..ref"),
                           ("candidate", "not-a-sha"), ("run_id", "")]:
            inputs = {**self.inputs, key: value}
            with self.assertRaises(ValueError):
                MODULE.probe(**inputs)
        self.assertEqual([], self.calls)


if __name__ == "__main__":
    unittest.main()
