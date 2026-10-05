from __future__ import annotations

import hashlib
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[2] / "scripts" / "operations" / "usage_audit.py"
SPEC = importlib.util.spec_from_file_location("usage_audit", MODULE_PATH)
assert SPEC and SPEC.loader
usage_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage_audit)


def usage(input_tokens: int, cached: int, output: int, reasoning: int = 0) -> dict[str, int]:
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached,
        "output_tokens": output,
        "reasoning_output_tokens": reasoning,
        "total_tokens": input_tokens + output,
    }


def meta(session: str = "session-1") -> dict:
    return {"type": "session_meta", "payload": {"id": session, "session_id": session}}


def record(
    response: str,
    values: dict[str, int],
    *,
    session: str = "session-1",
    thread: str = "thread-1",
    turn: str | None = "turn-1",
) -> dict:
    return {
        "type": "token_usage_record",
        "payload": {
            "session_id": session,
            "thread_id": thread,
            "turn_id": turn,
            "response_id": response,
            "usage": values,
        },
    }


def compacted(payload: dict) -> dict:
    return {"type": "compacted", "payload": {"latest_token_usage_record": payload}}


class UsageAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write(self, name: str, events: list[dict], *, final_newline: bool = True) -> Path:
        path = self.root / name
        data = b"\n".join(json.dumps(event).encode() for event in events)
        if final_newline:
            data += b"\n"
        path.write_bytes(data)
        return path

    def audit(self, *paths: Path, prefix_bytes: int | None = None) -> dict:
        return usage_audit.audit_sessions(
            [str(path.resolve()) for path in paths], prefix_bytes=prefix_bytes
        )

    def test_deduplicates_compaction_and_excludes_conflicting_identity(self) -> None:
        first = record("r1", usage(10, 4, 3, 2))
        conflict = record("r1", usage(11, 4, 3, 2))
        independent = record("r2", usage(5, 2, 1))
        path = self.write(
            "duplicates.jsonl",
            [meta(), first, compacted(first["payload"]), conflict, independent],
        )

        report = self.audit(path)
        authoritative = report["authoritative_usage"]

        self.assertEqual(authoritative["unique_response_count"], 1)
        self.assertEqual(authoritative["duplicate_record_count"], 1)
        self.assertEqual(authoritative["compacted_duplicate_reference_count"], 1)
        self.assertEqual(authoritative["conflicting_response_count"], 1)
        self.assertEqual(authoritative["totals"], usage(5, 2, 1))
        self.assertEqual(authoritative["status"], "partial")
        self.assertEqual(report["issues"]["by_code"], {"conflicting_usage": 1})

    def test_surfaces_malformed_json_usage_and_cache_invariant(self) -> None:
        valid = json.dumps(meta()).encode()
        missing = record("missing", {"input_tokens": 1})
        bad_cache = record("cache", usage(3, 4, 1))
        path = self.root / "malformed.jsonl"
        path.write_bytes(
            valid
            + b"\n{not-json}\n"
            + json.dumps(missing).encode()
            + b"\n"
            + json.dumps(bad_cache).encode()
            + b"\n"
        )

        report = self.audit(path)

        self.assertEqual(report["authoritative_usage"]["unique_response_count"], 0)
        self.assertEqual(
            report["issues"]["by_code"],
            {"malformed_json": 1, "malformed_usage": 2},
        )

    def test_token_count_is_latest_lower_confidence_snapshot_not_a_sum(self) -> None:
        def count(total: dict[str, int], last: dict[str, int], window: int) -> dict:
            return {
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": total,
                        "last_token_usage": last,
                        "model_context_window": window,
                    },
                },
            }

        path = self.write(
            "fallback.jsonl",
            [
                meta(),
                count(usage(10, 2, 2), usage(10, 2, 2), 1000),
                count(usage(30, 8, 5, 1), usage(20, 6, 3, 1), 1000),
            ],
        )

        report = self.audit(path)
        fallback = report["fallback_token_count"]["sessions"][0]

        self.assertIsNone(report["authoritative_usage"]["totals"])
        self.assertEqual(report["authoritative_usage"]["status"], "unavailable")
        self.assertEqual(fallback["event_count"], 2)
        self.assertEqual(
            fallback["latest_cumulative_snapshot"]["total_token_usage"],
            usage(30, 8, 5, 1),
        )
        self.assertEqual(
            fallback["latest_cumulative_snapshot"]["model_context_window"], 1000
        )

    def test_multi_file_dedup_uses_thread_session_response_key(self) -> None:
        shared = record("same-response", usage(9, 3, 2), turn="turn-a")
        other_session = record(
            "same-response",
            usage(4, 1, 1),
            session="session-2",
            thread="thread-2",
            turn="turn-b",
        )
        one = self.write("one.jsonl", [meta(), shared])
        two = self.write("two.jsonl", [meta(), shared, other_session])

        report = self.audit(one, two)
        authoritative = report["authoritative_usage"]

        self.assertEqual(authoritative["unique_response_count"], 2)
        self.assertEqual(authoritative["duplicate_record_count"], 1)
        self.assertEqual(authoritative["totals"], usage(13, 4, 3))
        self.assertEqual(len(authoritative["threads"]), 2)
        self.assertEqual(len(authoritative["turns"]), 2)

    def test_compacted_duplicate_count_is_independent_of_source_order(self) -> None:
        normal = record("r1", usage(9, 3, 2), turn="turn-a")
        compact = compacted(normal["payload"])
        normal_first = self.write("normal-first.jsonl", [meta(), normal, compact])
        compact_first = self.write("compact-first.jsonl", [meta(), compact, normal])

        first = self.audit(normal_first)["authoritative_usage"]
        second = self.audit(compact_first)["authoritative_usage"]

        for result in (first, second):
            self.assertEqual(result["status"], "exact")
            self.assertEqual(result["unique_response_count"], 1)
            self.assertEqual(result["duplicate_record_count"], 1)
            self.assertEqual(result["compacted_duplicate_reference_count"], 1)

    def test_conflicting_session_meta_aliases_make_usage_partial(self) -> None:
        ambiguous_meta = {
            "type": "session_meta",
            "payload": {"id": "session-a", "session_id": "session-b"},
        }
        path = self.write(
            "ambiguous-meta.jsonl",
            [ambiguous_meta, record("r1", usage(2, 1, 1), session="session-b")],
        )

        report = self.audit(path)

        self.assertEqual(report["authoritative_usage"]["status"], "partial")
        self.assertEqual(report["issues"]["by_code"], {"conflicting_session_meta": 1})

    def test_prefix_boundary_hashes_exact_bytes_and_drops_partial_record(self) -> None:
        path = self.write("prefix.jsonl", [meta(), record("r1", usage(7, 2, 1))])
        data = path.read_bytes()
        first_boundary = data.index(b"\n") + 1

        exact = self.audit(path, prefix_bytes=first_boundary)
        self.assertEqual(
            exact["scope"]["sources"][0]["prefix_sha256"],
            hashlib.sha256(data[:first_boundary]).hexdigest(),
        )
        self.assertEqual(exact["issues"]["count"], 0)

        partial_size = first_boundary + 12
        partial = self.audit(path, prefix_bytes=partial_size)
        source = partial["scope"]["sources"][0]
        self.assertEqual(source["prefix_bytes"], partial_size)
        self.assertTrue(source["trailing_partial_line"])
        self.assertEqual(partial["issues"]["by_code"], {"partial_prefix_line": 1})
        self.assertEqual(partial["authoritative_usage"]["unique_response_count"], 0)

    def test_implicit_full_read_marks_growth_partial_but_explicit_prefix_stays_exact(self) -> None:
        events = [meta(), record("r1", usage(7, 2, 1))]
        appended = record("r2", usage(4, 1, 1), turn="turn-2")

        def audit_while_appending(path: Path, prefix_bytes: int | None) -> dict:
            original = usage_audit._bounded_lines

            def read_then_append(handle, limit, digest):
                result = original(handle, limit, digest)
                with path.open("ab") as stream:
                    stream.write(json.dumps(appended).encode() + b"\n")
                return result

            with mock.patch.object(usage_audit, "_bounded_lines", read_then_append):
                return self.audit(path, prefix_bytes=prefix_bytes)

        implicit = self.write("growing-implicit.jsonl", events)
        implicit_opened_size = implicit.stat().st_size
        implicit_report = audit_while_appending(implicit, None)
        implicit_source = implicit_report["scope"]["sources"][0]
        self.assertEqual(implicit_report["authoritative_usage"]["status"], "partial")
        self.assertEqual(implicit_report["issues"]["by_code"], {"source_changed_during_read": 1})
        self.assertEqual(implicit_source["opened_size_bytes"], implicit_opened_size)
        self.assertGreater(implicit_source["final_size_bytes"], implicit_opened_size)
        self.assertEqual(implicit_report["authoritative_usage"]["unique_response_count"], 1)

        explicit = self.write("growing-explicit.jsonl", events)
        explicit_prefix = explicit.stat().st_size
        explicit_report = audit_while_appending(explicit, explicit_prefix)
        explicit_source = explicit_report["scope"]["sources"][0]
        self.assertEqual(explicit_report["authoritative_usage"]["status"], "exact")
        self.assertEqual(explicit_report["issues"]["count"], 0)
        self.assertEqual(explicit_source["prefix_bytes"], explicit_prefix)
        self.assertGreater(explicit_source["final_size_bytes"], explicit_source["opened_size_bytes"])
        self.assertEqual(explicit_report["authoritative_usage"]["unique_response_count"], 1)

    def test_requires_absolute_paths_and_single_source_prefix(self) -> None:
        path = self.write("input.jsonl", [meta()])
        with self.assertRaises(usage_audit.AuditInputError):
            usage_audit.audit_sessions([path.name])
        with self.assertRaises(usage_audit.AuditInputError):
            self.audit(path, path, prefix_bytes=1)

    def test_output_is_exclusive_and_cannot_overwrite_a_session(self) -> None:
        path = self.write("source.jsonl", [meta(), record("r1", usage(2, 1, 1))])
        original = path.read_bytes()
        with self.assertRaises(SystemExit):
            usage_audit.main(["--session", str(path.resolve()), "--output", str(path)])
        self.assertEqual(path.read_bytes(), original)

        existing = self.root / "existing.json"
        existing.write_text("keep", encoding="utf-8")
        with self.assertRaises(SystemExit):
            usage_audit.main(
                ["--session", str(path.resolve()), "--output", str(existing)]
            )
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")

    def test_cli_exit_distinguishes_exact_partial_and_unavailable(self) -> None:
        exact_path = self.write("exact.jsonl", [meta(), record("r1", usage(2, 1, 1))])
        conflicting = self.write(
            "partial.jsonl",
            [meta(), record("r1", usage(2, 1, 1)), record("r1", usage(3, 1, 1))],
        )
        unavailable = self.write("unavailable.jsonl", [meta()])

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(usage_audit.main(["--session", str(exact_path)]), 0)
            self.assertEqual(usage_audit.main(["--session", str(conflicting)]), 1)
            self.assertEqual(usage_audit.main(["--session", str(unavailable)]), 1)


if __name__ == "__main__":
    unittest.main()
