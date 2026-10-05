from __future__ import annotations

import hashlib
import importlib.util
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "operations" / "compact_output.py"
SPEC = importlib.util.spec_from_file_location("compact_output", SCRIPT)
assert SPEC and SPEC.loader
compact_output = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compact_output)


def thread(items: list[dict], **extra: object) -> dict:
    return {
        "thread": {"id": "thread-1", "title": "Saved thread"},
        "page": {"hasMore": False},
        "turns": [{"id": "turn-1", "status": "completed", "items": items}],
        **extra,
    }


class CompactOutputTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_json(self, name: str, value: object) -> Path:
        path = self.root / name
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        return path

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments], check=False,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def test_unicode_stdout_obeys_exact_byte_cap_including_newline(self) -> None:
        items = [
            {"type": "agentMessage", "text": ("é🙂" * 500) + str(index)}
            for index in range(30)
        ]
        source = self.write_json("unicode.json", thread(items))
        result = self.run_cli(
            "--mode", "thread", "--input", str(source), "--page-size", "30",
            "--max-bytes", "4096",
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue(result.stdout.endswith(b"\n"))
        self.assertLessEqual(len(result.stdout), 4096)
        report = json.loads(result.stdout)
        self.assertLess(report["pagination"]["returned"], 30)
        if report["pagination"]["returned"]:
            self.assertEqual(report["pagination"]["nextCursor"], report["pagination"]["returned"])
        else:
            self.assertTrue(report["pagination"]["pageBlocked"])
            self.assertIsNone(report["pagination"]["nextCursor"])
            self.assertEqual(report["status"], "needs_inspection")

    def test_huge_nested_command_output_is_bounded_and_not_echoed(self) -> None:
        sentinel = "RAW-SENTINEL-DO-NOT-ECHO-"
        huge = sentinel + ("x" * 1_500_000)
        source = self.write_json(
            "huge-thread.json",
            thread([{
                "type": "commandExecution", "status": "completed", "exitCode": 0,
                "command": "tool --safe", "aggregatedOutput": huge,
                "metadata": {"deep": {"completeRaw": huge}},
            }]),
        )
        result = self.run_cli("--mode", "thread", "--input", str(source))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertLessEqual(len(result.stdout), 16 * 1024)
        self.assertNotIn((sentinel + "x" * 1000).encode(), result.stdout)
        report = json.loads(result.stdout)
        preview = report["items"][0]["preview"]
        self.assertEqual(report["items"][0]["command"], "tool --safe")
        self.assertTrue(preview["truncated"])
        self.assertEqual(preview["characters"], len(huge))
        self.assertEqual(report["source"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())

    def test_failed_command_outside_requested_page_is_still_signaled(self) -> None:
        items = [{"type": "agentMessage", "text": f"ordinary {index}"} for index in range(40)]
        items.append({
            "type": "commandExecution", "status": "failed", "exitCode": 7,
            "output": "benign standard output", "stderr": "blocked: operator input required",
        })
        source = self.write_json("outside-page.json", thread(items))
        result = self.run_cli(
            "--mode", "thread", "--input", str(source), "--cursor", "0", "--page-size", "3",
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        report = json.loads(result.stdout)
        self.assertEqual(report["pagination"]["returned"], 3)
        self.assertEqual(report["criticalSignals"]["count"], 1)
        self.assertEqual(report["criticalSignals"]["samples"][0]["locator"], "/turns/0/items/40")
        self.assertEqual(report["criticalSignals"]["samples"][0]["exitCode"], 7)
        self.assertIn("operator input required", report["criticalSignals"]["samples"][0]["detailPreview"]["text"])

    def test_nested_thread_failures_and_needs_input_status_are_scanned(self) -> None:
        source = self.write_json("nested-thread.json", {
            "thread": {"id": "thread-nested"},
            "page": {"hasMore": False},
            "turns": [{
                "id": "turn-1",
                "status": {"type": "needsInput", "message": "owner decision required"},
                "items": [{
                    "type": "mcpToolCall",
                    "status": "completed",
                    "result": {"isError": True, "output": {"text": "failure in nested tool result"}},
                }],
            }],
        })
        result = self.run_cli("--mode", "thread", "--input", str(source))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        report = json.loads(result.stdout)
        locators = {sample["locator"] for sample in report["criticalSignals"]["samples"]}
        self.assertIn("/turns/0/status", locators)
        self.assertIn("/turns/0/items/0/result", locators)
        self.assertIn("/turns/0/items/0/result/output", locators)

    def test_many_critical_signals_fail_closed_when_samples_do_not_fit(self) -> None:
        items = [
            {"type": "commandExecution", "status": "failed", "error": "failure " + "z" * 500}
            for _ in range(80)
        ]
        source = self.write_json("critical.json", thread(items))
        result = self.run_cli(
            "--mode", "thread", "--input", str(source), "--max-bytes", "3000",
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "needs_inspection")
        self.assertEqual(report["criticalSignals"]["count"], 80)
        self.assertGreater(report["criticalSignals"]["samplesOmitted"], 0)
        self.assertLessEqual(len(result.stdout), 3000)
        if report["pagination"]["returned"] == 0:
            self.assertTrue(report["pagination"]["pageBlocked"])
            self.assertIsNone(report["pagination"]["nextCursor"])
            self.assertIn("max-bytes", report["pagination"]["blockReason"])

    def test_evidence_locator_hash_and_pagination_are_deterministic(self) -> None:
        items = [{"type": "agentMessage", "id": f"item-{index}", "text": f"message {index}"} for index in range(9)]
        source = self.write_json("pages.json", thread(items))
        arguments = (
            "--mode", "thread", "--input", str(source), "--cursor", "3", "--page-size", "2",
        )
        first = self.run_cli(*arguments)
        second = self.run_cli(*arguments)
        self.assertEqual(first.returncode, 0, first.stderr.decode())
        self.assertEqual(first.stdout, second.stdout)
        report = json.loads(first.stdout)
        self.assertEqual(report["identity"]["thread"]["id"], "thread-1")
        self.assertEqual(report["source"]["path"], str(source.resolve()))
        self.assertEqual(report["source"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual([item["locator"] for item in report["items"]], ["/turns/0/items/3", "/turns/0/items/4"])
        self.assertEqual(report["pagination"]["nextCursor"], 5)
        self.assertEqual(report["pagination"]["omittedBefore"], 3)
        self.assertEqual(report["pagination"]["omittedAfter"], 4)

    def test_upstream_partial_thread_is_explicitly_incomplete(self) -> None:
        value = thread([{"type": "agentMessage", "text": "page one"}])
        value["page"] = {"hasMore": True, "nextCursor": "opaque-next"}
        source = self.write_json("partial.json", value)
        result = self.run_cli("--mode", "thread", "--input", str(source))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "needs_inspection")
        self.assertEqual(report["upstreamCompleteness"]["status"], "incomplete")
        self.assertEqual(report["upstreamCompleteness"]["nextCursor"], "opaque-next")

    def test_upstream_metadata_is_aggregated_and_invalid_or_conflicting_values_never_complete(self) -> None:
        cases = {
            "root_false_page_true": {
                "hasMore": False,
                "page": {"hasMore": True},
            },
            "snake_case_cursor_conflicts_with_false": {
                "has_more": False,
                "page": {"next_cursor": "snake-next"},
            },
            "invalid_has_more_type": {
                "page": {"hasMore": "false"},
            },
            "invalid_cursor_type": {
                "page": {"next_cursor": {"opaque": "cursor"}},
            },
        }
        for label, pagination in cases.items():
            with self.subTest(case=label):
                value = thread([])
                value.pop("page")
                value.update(pagination)
                source = self.write_json(f"{label}.json", value)
                result = self.run_cli("--mode", "thread", "--input", str(source))
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                report = json.loads(result.stdout)
                self.assertEqual(report["status"], "needs_inspection")
                self.assertEqual(report["upstreamCompleteness"]["status"], "incomplete")

        complete = thread([])
        complete["has_more"] = False
        complete["page"] = {"hasMore": False, "next_cursor": ""}
        source = self.write_json("aggregated-complete.json", complete)
        result = self.run_cli("--mode", "thread", "--input", str(source))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout)["upstreamCompleteness"]["status"], "complete")

    def test_paperclip_inspection_projects_fields_and_redacts_known_credentials(self) -> None:
        source = self.write_json("inspection.json", {
            "issues": [
                {"id": "ISS-1", "title": "Nominal", "status": "done", "password": "do-not-leak"},
                {"id": "ISS-2", "title": "Needs owner", "status": "blocked", "error": 'api_key=secret-value {"password":"json-secret"}'},
            ],
            "hasMore": False,
        })
        result = self.run_cli("--mode", "inspection", "--input", str(source))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertNotIn(b"do-not-leak", result.stdout)
        self.assertNotIn(b"secret-value", result.stdout)
        self.assertNotIn(b"json-secret", result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report["collectionLocator"], "/issues")
        self.assertEqual(report["criticalSignals"]["count"], 1)
        self.assertEqual(report["criticalSignals"]["samples"][0]["locator"], "/issues/1")

    def test_log_mode_uses_line_locators_and_preserves_errors(self) -> None:
        source = self.root / "command.log"
        source.write_text(
            "starting\nall good\nERROR blocked waiting for input\ndone\n"
            + ("x" * 25_000) + " ERROR after long prefix\n",
            encoding="utf-8",
        )
        result = self.run_cli(
            "--mode", "log", "--input", str(source), "--cursor", "1", "--page-size", "1",
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        report = json.loads(result.stdout)
        self.assertEqual(report["items"][0]["locator"], "line:2")
        self.assertEqual(report["criticalSignals"]["samples"][0]["locator"], "line:3")
        self.assertEqual(report["criticalSignals"]["count"], 2)
        self.assertIn("line:5", {sample["locator"] for sample in report["criticalSignals"]["samples"]})
        self.assertEqual(report["upstreamCompleteness"]["status"], "complete")

    def test_page_block_does_not_return_an_unchanged_cursor(self) -> None:
        source = self.write_json(
            "no-room.json",
            thread([{"type": "agentMessage", "text": "🙂" * 2_000}]),
        )
        result = self.run_cli(
            "--mode", "thread", "--input", str(source), "--max-bytes", "2048",
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        report = json.loads(result.stdout)
        self.assertEqual(report["pagination"]["returned"], 0)
        self.assertTrue(report["pagination"]["pageBlocked"])
        self.assertIsNone(report["pagination"]["nextCursor"])
        self.assertEqual(report["status"], "needs_inspection")

    def test_malformed_oversized_deep_and_out_of_range_inputs_are_bounded_errors(self) -> None:
        malformed = self.root / "malformed.json"
        malformed.write_bytes(b'{"secret":"RAW-UNTRUSTED-CONTENT"')
        result = self.run_cli("--mode", "inspection", "--input", str(malformed))
        self.assertEqual(result.returncode, 2)
        self.assertLessEqual(len(result.stderr), 1024)
        self.assertNotIn(b"RAW-UNTRUSTED-CONTENT", result.stderr)

        oversized = self.root / "oversized.log"
        oversized.write_bytes(b"x" * 65)
        result = self.run_cli(
            "--mode", "log", "--input", str(oversized), "--max-input-bytes", "64",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"exceeds max-input-bytes=64", result.stderr)

        deep: object = "leaf"
        for _ in range(40):
            deep = {"child": deep}
        deep_path = self.write_json("deep.json", deep)
        result = self.run_cli("--mode", "inspection", "--input", str(deep_path))
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"nesting exceeds", result.stderr)

        source = self.write_json("cursor.json", thread([]))
        result = self.run_cli("--mode", "thread", "--input", str(source), "--cursor", "1")
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"cursor 1 exceeds available item count 0", result.stderr)

    def test_non_finite_numbers_and_duplicate_keys_are_rejected(self) -> None:
        non_finite = self.root / "infinite.json"
        non_finite.write_bytes(b'{"issues":[{"status":"done","value":1e999}]}')
        result = self.run_cli("--mode", "inspection", "--input", str(non_finite))
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"non-finite", result.stderr)

        duplicate = self.root / "duplicate.json"
        duplicate.write_bytes(b'{"turns":[],"status":"completed","status":"failed"}')
        result = self.run_cli("--mode", "thread", "--input", str(duplicate))
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"not valid finite UTF-8 JSON", result.stderr)

    def test_output_is_private_exclusive_and_symlinks_are_refused(self) -> None:
        source = self.write_json("source.json", thread([{"type": "agentMessage", "text": "ok"}]))
        output = self.root / "summary.json"
        first = self.run_cli("--mode", "thread", "--input", str(source), "--output", str(output))
        self.assertEqual(first.returncode, 0, first.stderr.decode())
        self.assertEqual(first.stdout, output.read_bytes())
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        before = output.read_bytes()
        second = self.run_cli("--mode", "thread", "--input", str(source), "--output", str(output))
        self.assertEqual(second.returncode, 2)
        self.assertEqual(output.read_bytes(), before)
        self.assertIn(b"refusing to overwrite", second.stderr)

        dangling = self.root / "dangling.json"
        dangling.symlink_to(self.root / "missing-target.json")
        result = self.run_cli("--mode", "thread", "--input", str(source), "--output", str(dangling))
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"symbolic link", result.stderr)
        self.assertFalse((self.root / "missing-target.json").exists())

        alias = self.root / "input-alias.json"
        alias.symlink_to(source)
        result = self.run_cli("--mode", "thread", "--input", str(alias))
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"input must not be a symbolic link", result.stderr)

    def test_help_smoke_lists_all_modes_and_defaults(self) -> None:
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b"{thread,inspection,log}", result.stdout)
        self.assertIn(b"--max-bytes", result.stdout)
        self.assertIn(b"--output", result.stdout)


if __name__ == "__main__":
    unittest.main()
