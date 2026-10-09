from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("resumed_usage", Path(__file__).parents[2] / "scripts/operations/resumed_usage_audit.py")
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class ResumedUsageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.events = [{"type": "session_meta", "payload": {"id": "session-1", "cli_version": "0.160.1"}}]
        self.runs = []
        self.append_turn(1, 100, 80, 10, fresh=True)
        self.append_turn(2, 40, 30, 5)

    def tearDown(self):
        self.tmp.cleanup()

    def append_turn(self, index, inp, cache, out, fresh=False):
        turn = f"turn-{index}"
        start = f"2026-10-07T10:0{index}:00Z"
        end = f"2026-10-07T10:0{index}:59Z"
        self.events += [
            {"type": "event_msg", "timestamp": start, "payload": {"type": "task_started", "turn_id": turn}},
            {"type": "token_usage_record", "payload": {"session_id": "session-1", "thread_id": "session-1", "turn_id": turn,
             "response_id": f"response-{index}", "usage": {"input_tokens": inp, "cached_input_tokens": cache,
             "output_tokens": out, "reasoning_output_tokens": 0, "total_tokens": inp + out}}},
            {"type": "event_msg", "timestamp": end, "payload": {"type": "task_complete", "turn_id": turn}}]
        previous = self.runs[-1]["usageJson"] if self.runs else {"inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0}
        self.runs.append({"id": f"run-{index}", "companyId": "company-1", "agentId": "agent-1", "status": "succeeded",
                          "startedAt": start, "finishedAt": end, "sessionIdBefore": None if fresh else "session-1",
                          "sessionIdAfter": "session-1", "usageJson": {"usageSource": "per_run", "freshSession": fresh,
                          "sessionReused": not fresh, "inputTokens": previous["inputTokens"] + inp,
                          "cachedInputTokens": previous["cachedInputTokens"] + cache, "outputTokens": previous["outputTokens"] + out}})

    def paths(self):
        session = self.root / "session.jsonl"
        session.write_text("\n".join(json.dumps(e) for e in self.events) + "\n")
        runs = []
        for n, run in enumerate(self.runs):
            p = self.root / f"run-{n}.json"
            p.write_text(json.dumps(run))
            runs.append(str(p))
        return str(session), runs

    def audit(self):
        return mod.reconcile(*self.paths())

    def test_new_session_matches_response_usage(self):
        self.runs = self.runs[:1]
        self.events = self.events[:4]
        result = self.audit()
        self.assertEqual(result["conclusion"], "per_run_confirmed")
        self.assertEqual(result["selected_run_response_usage"]["total_tokens"], 110)
        self.assertEqual(result["selected_run_response_usage"]["cached_input_tokens"], 80)

    def test_resumed_cumulative_confirmed_against_responses(self):
        result = self.audit()
        self.assertEqual(result["conclusion"], "confirmed")
        self.assertEqual(result["paperclip_reported_usage"]["total_tokens"], 265)
        self.assertEqual(result["selected_run_response_usage"]["total_tokens"], 155)
        self.assertEqual(result["analytical_excess_units"], 110)
        self.assertEqual(result["runs"][1]["response_usage"]["total_tokens"], 45)
        self.assertIsNone(result["assistance"]["codex_supervision_usage"])
        self.assertEqual(result["historical_ledger"], "unchanged")

    def test_fixed_host_per_run_is_recognized_without_differencing(self):
        self.runs[1]["usageJson"].update(inputTokens=40, cachedInputTokens=30, outputTokens=5)
        self.assertEqual(self.audit()["conclusion"], "per_run_confirmed")

    def test_replay_run_and_response_do_not_double_count(self):
        self.events.insert(3, self.events[2])
        session, runs = self.paths()
        result = mod.reconcile(session, runs + runs)
        self.assertEqual(result["repeated_run_snapshots"], 2)
        self.assertEqual(result["source"]["duplicate_responses"], 1)
        self.assertEqual(result["selected_run_response_usage"]["total_tokens"], 155)

    def test_absent_baseline_is_not_inferred_by_subtraction(self):
        self.events = [self.events[0], *self.events[4:]]
        self.runs = self.runs[1:]
        result = self.audit()
        self.assertEqual(result["conclusion"], "non_conclusive")
        self.assertIsNone(result["selected_run_response_usage"])
        self.assertEqual(result["unknown_run_count"], 1)

    def test_terminal_usage_absent_stays_unknown(self):
        self.runs[1]["usageJson"] = None
        result = self.audit()
        self.assertIsNone(result["paperclip_reported_usage"])
        self.assertIsNone(result["selected_run_response_usage"])
        self.assertIsNone(result["analytical_excess_units"])

    def test_mismatched_session_and_missing_cli_version_are_unknown(self):
        self.runs[1]["sessionIdAfter"] = "other-session"
        self.assertEqual(self.audit()["unknown_run_count"], 1)
        self.events[0]["payload"].pop("cli_version")
        self.assertEqual(self.audit()["unknown_run_count"], 2)

    def test_conflicting_response_invalidates_exactness(self):
        duplicate = json.loads(json.dumps(self.events[2]))
        duplicate["payload"]["usage"].update(input_tokens=200, total_tokens=210)
        self.events.insert(3, duplicate)
        self.assertEqual(self.audit()["unknown_run_count"], 2)

    def test_incomplete_or_nonterminal_turn_is_unknown(self):
        self.events.pop()
        self.assertEqual(self.audit()["conclusion"], "non_conclusive")

    def test_overlapping_runs_cannot_both_claim_one_turn(self):
        self.runs.append({**self.runs[0], "id": "run-alias"})
        with self.assertRaisesRegex(ValueError, "multiple runs"):
            self.audit()

    def test_output_refuses_existing_path_and_keeps_inputs(self):
        session, runs = self.paths()
        before = Path(session).read_bytes()
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            code = mod.main(["--session", session, "--run", runs[0], "--output", session])
        self.assertEqual(code, 1)
        self.assertEqual(Path(session).read_bytes(), before)

    def test_missing_cache_is_unknown_not_zero(self):
        self.runs[1]["usageJson"].pop("cachedInputTokens")
        self.assertIsNone(self.audit()["runs"][1]["reported_usage"])

    def test_mixed_agent_identity_is_refused(self):
        self.runs[1]["agentId"] = "agent-2"
        with self.assertRaisesRegex(ValueError, "identities"):
            self.audit()

    def test_conflicting_run_replay_is_refused(self):
        self.runs.append({**self.runs[0], "status": "failed"})
        with self.assertRaisesRegex(ValueError, "conflicting snapshots"):
            self.audit()

    def test_nonterminal_snapshot_stays_unknown(self):
        self.runs[1]["status"] = "running"
        self.assertEqual(self.audit()["unknown_run_count"], 1)

    def test_malformed_usage_does_not_crash(self):
        self.runs[1]["usageJson"] = [100]
        self.assertIsNone(self.audit()["paperclip_reported_usage"])

    def test_report_excludes_prompts_and_unrelated_fields(self):
        self.runs[0]["contextSnapshot"] = {"secret": "PRIVATE-SENTINEL"}
        self.events.insert(2, {"type": "response_item", "payload": {"text": "PRIVATE-SENTINEL"}})
        self.assertNotIn("PRIVATE-SENTINEL", json.dumps(self.audit()))


if __name__ == "__main__":
    unittest.main()
