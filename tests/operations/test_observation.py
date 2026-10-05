import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "operations"))
from observation import bounded_event, encoded, meaningful, project
from mission_watch import observe, parser, validate_urls


def snapshot(status="running", tokens=None):
    return {"mission": {"missionId": "mission-1", "version": 1, "aggregate": {
        "phase": "reviewing", "control": {"status": "active"},
        "n2": {"status": "reviewing", "activeSubmissionId": "s1", "submissions": [
            {"submissionId": "s1", "candidateCommit": "a" * 40, "evidenceHash": "b" * 64}]} }},
        "runs": [{"id": "run-1", "status": status, "usage": {"inputTokens": tokens}}],
        "admission": {"status": "admissible", "blockers": [], "availablePeriodUnits": 100}}


class ObservationTests(unittest.TestCase):
    def test_timestamp_order_and_running_token_changes_do_not_notify(self):
        first = snapshot(tokens=10)
        after = copy.deepcopy(first)
        after["at"] = "later"
        after["mission"]["version"] = 99
        after["runs"][0]["usage"]["inputTokens"] = 999
        after["admission"]["availablePeriodUnits"] = 50
        self.assertEqual(meaningful(project(first, "mission-1")), meaningful(project(after, "mission-1")))

    def test_terminal_unknown_usage_and_later_receipt_are_distinct(self):
        values = [meaningful(project(x, "mission-1")) for x in [snapshot(), snapshot("succeeded"), snapshot("succeeded", 50)]]
        self.assertNotEqual(values[0], values[1])
        self.assertNotEqual(values[1], values[2])
        self.assertIsNone(values[1]["runs"][0]["usage"]["inputTokens"])

    def test_candidate_budget_and_control_changes_notify(self):
        original = snapshot()
        before = meaningful(project(original, "mission-1"))
        for update in ("candidate", "budget", "control"):
            value = copy.deepcopy(original)
            if update == "candidate":
                value["mission"]["aggregate"]["n2"]["submissions"][0]["candidateCommit"] = "c" * 40
            elif update == "budget":
                value["admission"]["availablePeriodUnits"] = -1
            else:
                value["mission"]["aggregate"]["control"]["status"] = "blocked"
            self.assertNotEqual(before, meaningful(project(value, "mission-1")))

    def test_oversized_entities_are_referenced_and_secrets_never_returned(self):
        value = snapshot()
        value["apiKey"] = "must-not-leak"
        value["runs"] = [{"id": f"r-{n}", "status": "running", "error": "must-not-leak"} for n in range(200)]
        view = project(value, "mission-1")
        event = bounded_event(view, None, {"path": "/evidence.json", "sha256": "a" * 64}, 4096)
        self.assertLessEqual(len(encoded(event)), 4096)
        self.assertEqual(event["omitted"]["runs"]["count"], 200)
        self.assertNotIn("must-not-leak", encoded(event).decode())

    def test_wrong_mission_and_missing_fields_fail(self):
        with self.assertRaises(ValueError):
            project(snapshot(), "other")
        with self.assertRaises(ValueError):
            project({"missionId": "mission-1"}, "mission-1")
        with self.assertRaises(ValueError):
            bounded_event(project(snapshot(), "mission-1"), None, {}, 20)

    def test_real_review_round_and_publication_states_are_observed(self):
        source = snapshot()
        aggregate = source["mission"]["aggregate"]
        aggregate["n3"] = {"rounds": [{"review": {"subject": {"submissionId": "s1", "candidateCommit": "a" * 40},
                                                     "opinions": [{"opinionId": "o1", "slotId": "quality", "outcome": "support"}]}}]}
        aggregate["n5"] = {"publication": {"state": "opened", "checks": {"headSha": "a" * 40, "state": "pending"}}}
        before = project(source, "mission-1")
        self.assertEqual(before["reviewSubject"]["submissionId"], "s1")
        self.assertEqual(before["opinions"][0]["outcome"], "support")
        aggregate["n5"]["publication"]["checks"]["state"] = "failed"
        self.assertNotEqual(meaningful(before), meaningful(project(source, "mission-1")))
        del source["runs"]
        self.assertEqual(project(source, "mission-1")["coverage"]["runs"], "not_requested")

    def test_endpoint_boundaries(self):
        validate_urls(["http://127.0.0.1:3100/api/mission", "http://127.0.0.1:3100/api/run"])
        validate_urls(["http://127.0.0.1:3100/api/admission?periodKey=period-1"])
        for urls in (["http://example.com/a"], ["https://a.example/a", "https://b.example/b"],
                     ["https://user:password@example.com/a"], ["https://a.example/a?token=secret"]):
            with self.assertRaises(ValueError):
                validate_urls(urls)

    def test_canonical_inspection_uncertainty_settlement_and_freshness_notify(self):
        source = snapshot()
        source.update({"n2": {"correction": {"wakeState": "claimed"},
                              "application": {"state": "none"}, "usage": {"complete": False}},
                       "n3": {"specialists": [{"slotId": "quality", "runId": "specialist-1"}],
                              "usageUnknown": ["quality"]},
                       "n5": {"ready": True, "nativeReadbackFresh": True}})
        before = meaningful(project(source, "mission-1"))
        transitions = [("n2", "correction", "wakeState", "unknown"),
                       ("n2", "application", "state", "unknown"),
                       ("n2", "usage", "complete", True)]
        for stage, section, key, value in transitions:
            after = copy.deepcopy(source)
            after[stage][section][key] = value
            self.assertNotEqual(before, meaningful(project(after, "mission-1")))
        after = copy.deepcopy(source)
        after["n3"]["specialists"][0]["settledAt"] = "2026-10-05T15:00:00Z"
        after["n3"]["usageUnknown"] = []
        self.assertNotEqual(before, meaningful(project(after, "mission-1")))
        for key in ("ready", "nativeReadbackFresh"):
            after = copy.deepcopy(source)
            after["n5"][key] = False
            self.assertNotEqual(before, meaningful(project(after, "mission-1")))

    def test_raw_snapshot_correction_and_specialist_settlement_notify(self):
        source = snapshot()
        aggregate = source["mission"]["aggregate"]
        aggregate["n2"]["correction"] = {"wakeState": "claimed"}
        aggregate["n3"] = {"rounds": [{"review": {"subject": {"submissionId": "s1"}},
                                       "specialists": [{"slotId": "quality"}]}]}
        before = meaningful(project(source, "mission-1"))
        aggregate["n2"]["correction"]["wakeState"] = "unknown"
        self.assertNotEqual(before, meaningful(project(source, "mission-1")))
        before = meaningful(project(source, "mission-1"))
        aggregate["n3"]["rounds"][0]["specialists"][0]["settledAt"] = "now"
        self.assertNotEqual(before, meaningful(project(source, "mission-1")))


class WatchTests(unittest.TestCase):
    def args(self, directory):
        return parser().parse_args(["--snapshot", str(directory / "source.json"), "--mission-id", "mission-1",
                                   "--state", str(directory / "state.json"), "--evidence-dir", str(directory),
                                   "--wait-for-change", "--max-polls", "5"])

    def test_many_unchanged_polls_emit_one_terminal_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = self.args(root)
            args.max_polls = 101
            inputs = iter([snapshot(tokens=count) for count in range(100)] + [snapshot("succeeded", 150)])
            sleeps = []
            event, code = observe(args, collector=lambda _: next(inputs), sleeper=sleeps.append, clock=lambda: 0)
            self.assertEqual(code, 0)
            self.assertEqual(event["event"], "changed")
            self.assertEqual(event["polls"], 101)
            self.assertEqual(len(sleeps), 100)
            self.assertLessEqual(len(encoded(event)) + 1, args.max_output_bytes)
            self.assertEqual(len(list(root.glob("observation-*.json"))), 2)
            # Resume using persisted semantic state: the same terminal result is quiet.
            args.max_polls = 2
            event, code = observe(args, collector=lambda _: snapshot("succeeded", 150), sleeper=lambda _: None, clock=lambda: 0)
            self.assertEqual((event["event"], code), ("timeout", 3))

    def test_error_does_not_advance_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.args(Path(tmp))
            args.once = True
            observe(args, collector=lambda _: snapshot())
            before = args.state.read_bytes()
            with self.assertRaises(ValueError):
                observe(args, collector=lambda _: {"missionId": "wrong"})
            self.assertEqual(args.state.read_bytes(), before)

    def test_state_cannot_be_reused_for_another_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.args(Path(tmp))
            args.once = True
            observe(args, collector=lambda _: snapshot())
            args.snapshot = Path(tmp) / "another.json"
            with self.assertRaises(ValueError):
                observe(args, collector=lambda _: snapshot())

    def test_http_cli_uses_only_explicit_gets_and_emits_bounded_event(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                requests.append((self.command, self.path, self.headers.get("Authorization")))
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/mission")
                    self.end_headers()
                    return
                payload = {"/mission": {"mission": snapshot()["mission"]},
                           "/run": {"run": snapshot()["runs"][0]},
                           "/budget?periodKey=test": {"envelope": snapshot()["admission"]}}.get(self.path)
                self.send_response(200 if payload else 404)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                base = f"http://127.0.0.1:{server.server_port}"
                command = [sys.executable, str(Path(__file__).resolve().parents[2] / "scripts/operations/mission_watch.py"),
                           "--mission-url", base + "/mission", "--run-url", base + "/run",
                           "--admission-url", base + "/budget?periodKey=test", "--mission-id", "mission-1",
                           "--api-key-env", "COUNCIL_TEST_CREDENTIAL", "--state", str(root / "state.json"),
                           "--evidence-dir", str(root), "--once"]
                env = {**os.environ, "COUNCIL_TEST_CREDENTIAL": "test-private-value"}
                result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertLessEqual(len(result.stdout.encode()), 4097)
                self.assertNotIn("test-private-value", result.stdout)
                self.assertEqual(len(requests), 3)
                self.assertTrue(all(x[0] == "GET" and x[2] == "Bearer test-private-value" for x in requests))
                old_state = (root / "state.json").read_bytes()
                command[command.index(base + "/mission")] = base + "/redirect"
                # Clear explicit state mismatch so the request reaches the redirect test.
                command[command.index(str(root / "state.json"))] = str(root / "redirect-state.json")
                result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertIn("HTTP 302", result.stdout)
                self.assertEqual(len(requests), 4)
                self.assertEqual((root / "state.json").read_bytes(), old_state)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
