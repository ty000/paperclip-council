from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import stat
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout


ROOT = Path(__file__).resolve().parents[2]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


usage_audit = load("usage_audit_for_compare", ROOT / "scripts/operations/usage_audit.py")
usage_compare = load("usage_compare", ROOT / "scripts/operations/usage_compare.py")


def usage(input_tokens: int, cached: int, output: int, reasoning: int = 0) -> dict[str, int]:
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached,
        "output_tokens": output,
        "reasoning_output_tokens": reasoning,
        "total_tokens": input_tokens + output,
    }


def events(values: list[dict[str, int]], *, session: str) -> list[dict]:
    result = [{"type": "session_meta", "payload": {"id": session, "session_id": session}}]
    for index, value in enumerate(values):
        result.append({
            "type": "token_usage_record",
            "payload": {
                "session_id": session,
                "thread_id": f"thread-{session}",
                "turn_id": f"turn-{index}",
                "response_id": f"response-{index}",
                "usage": value,
            },
        })
    return result


class UsageCompareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def audit_report(self, name: str, values: list[dict[str, int]]) -> Path:
        session = self.root / f"{name}.jsonl"
        session.write_text(
            "".join(json.dumps(item) + "\n" for item in events(values, session=name)),
            encoding="utf-8",
        )
        report = usage_audit.audit_sessions([str(session.resolve())])
        path = self.root / f"{name}.report.json"
        path.write_text(json.dumps(report, sort_keys=True) + "\n", encoding="utf-8")
        return path

    def manifest(
        self,
        before: Path,
        after: Path,
        *,
        quality_after: str = "pass",
        after_scope: str = "nominal-v1",
        after_tasks: int = 2,
    ) -> dict:
        return {
            "schema_version": "council-usage-comparison-input.v1",
            "reports": {
                "before_sha256": hashlib.sha256(before.read_bytes()).hexdigest(),
                "after_sha256": hashlib.sha256(after.read_bytes()).hexdigest(),
            },
            "cohort": {
                "before": {
                    "scope_id": "nominal-v1",
                    "task_count": 2,
                    "coverage_id": "coverage-v1",
                    "configuration_id": "config-v1",
                    "data_ref": "evidence/before-run.json",
                },
                "after": {
                    "scope_id": after_scope,
                    "task_count": after_tasks,
                    "coverage_id": "coverage-v1",
                    "configuration_id": "config-v1",
                    "data_ref": "evidence/after-run.json",
                },
                "evidence_refs": ["evidence/cohort-readback.json"],
            },
            "quality": {
                "before_status": "pass",
                "after_status": quality_after,
                "evidence_refs": ["evidence/quality-before.json", "evidence/quality-after.json"],
            },
        }

    def write_manifest(self, value: dict, name: str = "comparison.json") -> Path:
        path = self.root / name
        path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
        return path

    def run_cli(self, before: Path, after: Path, comparison: Path | None = None, output: Path | None = None):
        argv = ["--before", str(before), "--after", str(after)]
        if comparison is not None:
            argv += ["--comparison", str(comparison)]
        if output is not None:
            argv += ["--output", str(output)]
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = usage_compare.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_exact_compatible_reports_separate_subsets_and_responses(self) -> None:
        before = self.audit_report("before", [usage(100, 60, 40, 10), usage(50, 20, 10, 2)])
        after = self.audit_report("after", [usage(70, 50, 25, 5), usage(40, 20, 5, 1)])
        comparison = self.write_manifest(self.manifest(before, after))

        code, stdout, stderr = self.run_cli(before, after, comparison)
        result = json.loads(stdout)

        self.assertEqual(code, 0, stderr)
        self.assertEqual(result["status"], "conclusive")
        self.assertEqual(result["conclusion"], "optimization_supported_by_operator_assertions")
        self.assertEqual(
            result["observed"]["before"],
            {
                "uncached_input_tokens": 70,
                "cached_input_tokens": 80,
                "output_tokens": 50,
                "reasoning_output_tokens": 12,
                "total_tokens": 200,
                "unique_responses": 2,
            },
        )
        self.assertEqual(result["observed"]["after"]["total_tokens"], 140)
        self.assertEqual(result["reduction_percent"]["total_tokens"], "30.0000")
        self.assertLess(len(stdout.encode("utf-8")), 16 * 1024)

    def test_missing_manifest_partial_report_or_unknown_quality_is_inconclusive(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])

        code, stdout, _ = self.run_cli(before, after)
        self.assertEqual(code, 1)
        self.assertIn("comparison_manifest_missing", json.loads(stdout)["reasons"])
        self.assertIsNone(json.loads(stdout)["reduction_percent"])

        partial = json.loads(after.read_text(encoding="utf-8"))
        partial["authoritative_usage"]["status"] = "partial"
        after.write_text(json.dumps(partial, sort_keys=True) + "\n", encoding="utf-8")
        manifest = self.write_manifest(self.manifest(before, after), "partial-comparison.json")
        code, stdout, _ = self.run_cli(before, after, manifest)
        self.assertEqual(code, 1)
        self.assertIn("after_report_partial", json.loads(stdout)["reasons"])
        self.assertIsNone(json.loads(stdout)["reduction_percent"])

        after = self.audit_report("after-quality", [usage(8, 3, 2)])
        value = self.manifest(before, after, quality_after="unknown")
        manifest = self.write_manifest(value, "unknown-quality.json")
        code, stdout, _ = self.run_cli(before, after, manifest)
        result = json.loads(stdout)
        self.assertEqual(code, 1)
        self.assertEqual(result["conclusion"], "quality_regression_or_unknown")
        self.assertIsNone(result["reduction_percent"])

        after = self.audit_report("after-no-cohort", [usage(8, 3, 2)])
        value = self.manifest(before, after)
        del value["cohort"]
        manifest = self.write_manifest(value, "missing-cohort.json")
        code, stdout, _ = self.run_cli(before, after, manifest)
        result = json.loads(stdout)
        self.assertEqual(code, 1)
        self.assertIn("cohort_metadata_missing", result["reasons"])
        self.assertIsNone(result["reduction_percent"])

    def test_incompatible_cohort_and_stale_hash_preserve_observed_metrics(self) -> None:
        before = self.audit_report("before", [usage(20, 5, 5)])
        after = self.audit_report("after", [usage(10, 4, 3)])
        value = self.manifest(before, after, after_scope="correction-v2", after_tasks=3)
        value["reports"]["after_sha256"] = "0" * 64
        manifest = self.write_manifest(value)

        code, stdout, _ = self.run_cli(before, after, manifest)
        result = json.loads(stdout)

        self.assertEqual(code, 1)
        self.assertIn("comparison_after_hash_stale", result["reasons"])
        self.assertIn("cohort_scope_id_incompatible", result["reasons"])
        self.assertIn("cohort_task_count_incompatible", result["reasons"])
        self.assertEqual(result["observed"]["delta_after_minus_before"]["total_tokens"], -12)
        self.assertIsNone(result["reduction_percent"])

    def test_quality_failure_blocks_success_but_keeps_usage_delta_visible(self) -> None:
        before = self.audit_report("before", [usage(30, 10, 10, 4)])
        after = self.audit_report("after", [usage(10, 5, 2, 1)])
        manifest = self.write_manifest(self.manifest(before, after, quality_after="fail"))

        code, stdout, _ = self.run_cli(before, after, manifest)
        result = json.loads(stdout)

        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "inconclusive")
        self.assertEqual(result["conclusion"], "quality_regression_or_unknown")
        self.assertIn("quality_after_not_pass", result["reasons"])
        self.assertEqual(result["observed"]["delta_after_minus_before"]["total_tokens"], -28)
        self.assertIsNone(result["reduction_percent"])

    def test_invalid_report_and_output_safety(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        broken = json.loads(after.read_text(encoding="utf-8"))
        broken["authoritative_usage"]["totals"]["cached_input_tokens"] = 99
        after.write_text(json.dumps(broken) + "\n", encoding="utf-8")
        code, _, stderr = self.run_cli(before, after)
        self.assertEqual(code, 2)
        self.assertIn("cached_input_tokens exceeds", stderr)

        after = self.audit_report("after-safe", [usage(8, 3, 2)])
        manifest = self.write_manifest(self.manifest(before, after))
        existing = self.root / "existing.json"
        existing.write_text("keep", encoding="utf-8")
        code, _, _ = self.run_cli(before, after, manifest, existing)
        self.assertEqual(code, 2)
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")

        target = self.root / "target.json"
        symlink = self.root / "symlink.json"
        symlink.symlink_to(target)
        code, _, _ = self.run_cli(before, after, manifest, symlink)
        self.assertEqual(code, 2)
        self.assertFalse(target.exists())

        output = self.root / "output.json"
        code, _, stderr = self.run_cli(before, after, manifest, output)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertTrue(before.exists())
        self.assertTrue(after.exists())
        self.assertTrue(manifest.exists())

    def test_exact_report_with_authoritative_issue_is_rejected_before_output(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        changed = json.loads(after.read_text(encoding="utf-8"))
        issue = {
            "code": "conflicting_usage",
            "source_index": 0,
            "line": 2,
            "detail": "same identity has different usage or turn",
        }
        changed["issues"] = {
            "count": 1,
            "by_code": {"conflicting_usage": 1},
            "items": [issue],
        }
        after.write_text(json.dumps(changed, sort_keys=True) + "\n", encoding="utf-8")
        manifest = self.write_manifest(self.manifest(before, after))
        output = self.root / "must-not-exist.json"

        code, stdout, stderr = self.run_cli(before, after, manifest, output)

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("exact status contains an authoritative usage issue", stderr)
        self.assertFalse(output.exists())

    def test_issue_items_must_reconcile_exactly_with_by_code(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        changed = json.loads(after.read_text(encoding="utf-8"))
        changed["issues"] = {
            "count": 1,
            "by_code": {"blank_line": 1},
            "items": [{"code": "malformed_token_count", "source_index": 0, "line": 2, "detail": "invalid"}],
        }
        after.write_text(json.dumps(changed, sort_keys=True) + "\n", encoding="utf-8")

        code, stdout, stderr = self.run_cli(before, after)

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("issues.items does not reconcile with by_code", stderr)

    def test_exact_report_keeps_non_authoritative_warning(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        changed = json.loads(after.read_text(encoding="utf-8"))
        warning = {
            "code": "malformed_token_count",
            "source_index": 0,
            "line": 2,
            "detail": "fallback snapshot is invalid",
        }
        changed["issues"] = {
            "count": 1,
            "by_code": {"malformed_token_count": 1},
            "items": [warning],
        }
        after.write_text(json.dumps(changed, sort_keys=True) + "\n", encoding="utf-8")
        manifest = self.write_manifest(self.manifest(before, after))

        code, stdout, stderr = self.run_cli(before, after, manifest)

        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout)["status"], "conclusive")

    def test_bool_negative_and_nonfinite_numbers_are_rejected(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        original = json.loads(before.read_text(encoding="utf-8"))
        for label, invalid in (("bool", True), ("negative", -1)):
            with self.subTest(value=label):
                changed = json.loads(json.dumps(original))
                changed["authoritative_usage"]["totals"]["input_tokens"] = invalid
                path = self.root / f"{label}.json"
                path.write_text(json.dumps(changed) + "\n", encoding="utf-8")
                code, _, stderr = self.run_cli(path, before)
                self.assertEqual(code, 2)
                self.assertIn("non-negative integer", stderr)

        nonfinite = self.root / "nonfinite.json"
        nonfinite.write_text('{"schema_version":"council-usage-audit.v1","value":NaN}\n', encoding="utf-8")
        code, _, stderr = self.run_cli(nonfinite, before)
        self.assertEqual(code, 2)
        self.assertIn("invalid before report JSON", stderr)

    def test_duplicate_manifest_key_cannot_mask_quality_failure(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        value = self.manifest(before, after)
        prefix = json.dumps({
            "schema_version": value["schema_version"],
            "reports": value["reports"],
            "cohort": value["cohort"],
        })[:-1]
        duplicate = self.root / "duplicate-quality.json"
        duplicate.write_text(
            prefix
            + ',"quality":{"before_status":"pass","after_status":"fail","evidence_refs":["failure.json"]}'
            + ',"quality":{"before_status":"pass","after_status":"pass","evidence_refs":["masked.json"]}}\n',
            encoding="utf-8",
        )
        output = self.root / "must-not-exist.json"

        code, stdout, stderr = self.run_cli(before, after, duplicate, output)

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("duplicate JSON object key: quality", stderr)
        self.assertFalse(output.exists())

    def test_non_scalar_quality_status_is_bounded_and_inconclusive(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        value = self.manifest(before, after)
        value["quality"]["after_status"] = []
        manifest = self.write_manifest(value)

        code, stdout, stderr = self.run_cli(before, after, manifest)
        result = json.loads(stdout)

        self.assertEqual(code, 1, stderr)
        self.assertEqual(result["status"], "inconclusive")
        self.assertIn("quality_after_status_missing_or_invalid", result["reasons"])
        self.assertIn("quality_after_not_pass", result["reasons"])
        self.assertIsNone(result["reduction_percent"])

    def test_nonfinite_number_in_unused_report_field_is_rejected_before_output(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        raw = after.read_text(encoding="utf-8").rstrip()
        after.write_text(raw[:-1] + ',"unused_overflow":1e999}\n', encoding="utf-8")
        manifest = self.write_manifest(self.manifest(before, after))
        output = self.root / "must-not-exist.json"

        code, stdout, stderr = self.run_cli(before, after, manifest, output)

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("contains a non-finite number", stderr)
        self.assertFalse(output.exists())

    def test_excessive_json_nesting_is_rejected(self) -> None:
        before = self.audit_report("before", [usage(10, 4, 3)])
        after = self.audit_report("after", [usage(8, 3, 2)])
        value = json.loads(after.read_text(encoding="utf-8"))
        nested: object = "leaf"
        for _ in range(34):
            nested = [nested]
        value["unused_nested"] = nested
        after.write_text(json.dumps(value) + "\n", encoding="utf-8")

        code, stdout, stderr = self.run_cli(before, after)

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("exceeds JSON nesting depth", stderr)

    def test_zero_baseline_and_identical_reports_have_no_infinite_percentage(self) -> None:
        zero = self.audit_report("zero", [usage(0, 0, 0)])
        after = self.audit_report("after", [usage(0, 0, 0)])
        manifest = self.write_manifest(self.manifest(zero, after))
        code, stdout, _ = self.run_cli(zero, after, manifest)
        result = json.loads(stdout)
        self.assertEqual(code, 0)
        self.assertEqual(result["conclusion"], "no_change")
        self.assertIsNone(result["reduction_percent"]["total_tokens"])
        self.assertFalse(any(
            isinstance(value, float) and not math.isfinite(value)
            for value in result["reduction_percent"].values()
        ))

        same_manifest = self.write_manifest(self.manifest(zero, zero), "same.json")
        code, stdout, _ = self.run_cli(zero, zero, same_manifest)
        result = json.loads(stdout)
        self.assertEqual(code, 1)
        self.assertIn("before_and_after_reports_are_identical", result["reasons"])
        self.assertIsNone(result["reduction_percent"])


if __name__ == "__main__":
    unittest.main()
