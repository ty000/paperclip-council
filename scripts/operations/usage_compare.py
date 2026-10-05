#!/usr/bin/env python3
"""Compare two explicit council-usage-audit.v1 reports conservatively."""

from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import json
import math
import os
import sys
from pathlib import Path
from typing import Any


REPORT_SCHEMA = "council-usage-audit.v1"
MANIFEST_SCHEMA = "council-usage-comparison-input.v1"
OUTPUT_SCHEMA = "council-usage-comparison.v1"
MAX_REPORT_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_STRING_BYTES = 1024
MAX_REFERENCES = 64
MAX_JSON_DEPTH = 32
USAGE_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)
METRIC_KEYS = (
    "uncached_input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "unique_responses",
)


class CompareError(ValueError):
    """A bounded, user-actionable comparison failure."""


def _authoritative_issue_codes() -> frozenset[str]:
    path = Path(__file__).with_name("usage_audit.py")
    spec = importlib.util.spec_from_file_location("_usage_audit_contract", path)
    if spec is None or spec.loader is None:
        raise CompareError("cannot load usage audit issue contract")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        value = module.AUTHORITATIVE_ISSUE_CODES
    except (OSError, AttributeError) as exc:
        raise CompareError("cannot load usage audit issue contract") from exc
    if not isinstance(value, set) or not all(isinstance(item, str) for item in value):
        raise CompareError("usage audit issue contract is invalid")
    return frozenset(value)


def _bounded_text(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CompareError(f"{label} must be a non-empty string")
    if len(value.encode("utf-8")) > MAX_STRING_BYTES:
        raise CompareError(f"{label} exceeds {MAX_STRING_BYTES} bytes")
    return value


def _nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CompareError(f"{label} must be a non-negative integer")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            rendered = key if len(key) <= 80 else key[:77] + "..."
            raise CompareError(f"duplicate JSON object key: {rendered}")
        result[key] = value
    return result


def _inspect_json(value: Any, label: str, depth: int = 0) -> None:
    if depth > MAX_JSON_DEPTH:
        raise CompareError(f"{label} exceeds JSON nesting depth {MAX_JSON_DEPTH}")
    if value is None or isinstance(value, (bool, int, str)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CompareError(f"{label} contains a non-finite number")
        return
    if isinstance(value, list):
        for item in value:
            _inspect_json(item, label, depth + 1)
        return
    if isinstance(value, dict):
        for item in value.values():
            _inspect_json(item, label, depth + 1)
        return
    raise CompareError(f"{label} contains an unsupported JSON value")


def _read_json(path: Path, limit: int, label: str) -> tuple[dict[str, Any], bytes, Path]:
    try:
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise CompareError(f"{label} is not a regular file")
        size = resolved.stat().st_size
        if size > limit:
            raise CompareError(f"{label} exceeds {limit} bytes")
        with resolved.open("rb") as stream:
            raw = stream.read(limit + 1)
    except CompareError:
        raise
    except OSError as exc:
        raise CompareError(f"cannot read {label}: {exc}") from exc
    if len(raw) > limit:
        raise CompareError(f"{label} exceeds {limit} bytes")
    try:
        value = json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda item: (_ for _ in ()).throw(ValueError(item)),
            object_pairs_hook=_unique_object,
        )
        _inspect_json(value, label)
    except CompareError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise CompareError(f"invalid {label} JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise CompareError(f"{label} root must be an object")
    return value, raw, resolved


def _usage(value: Any, label: str) -> dict[str, int]:
    if not isinstance(value, dict):
        raise CompareError(f"{label} must be an object")
    result = {key: _nonnegative_int(value.get(key), f"{label}.{key}") for key in USAGE_KEYS}
    if result["cached_input_tokens"] > result["input_tokens"]:
        raise CompareError(f"{label}.cached_input_tokens exceeds input_tokens")
    if result["reasoning_output_tokens"] > result["output_tokens"]:
        raise CompareError(f"{label}.reasoning_output_tokens exceeds output_tokens")
    if result["total_tokens"] != result["input_tokens"] + result["output_tokens"]:
        raise CompareError(f"{label}.total_tokens differs from input_tokens plus output_tokens")
    return result


def _add_usage(target: dict[str, int], value: dict[str, int]) -> None:
    for key in USAGE_KEYS:
        target[key] += value[key]


def _validate_groups(
    groups: Any,
    label: str,
    totals: dict[str, int] | None,
    unique_responses: int,
    *,
    require_equal: bool,
) -> None:
    if not isinstance(groups, list):
        raise CompareError(f"{label} must be an array")
    summed = {key: 0 for key in USAGE_KEYS}
    responses = 0
    for index, group in enumerate(groups):
        if not isinstance(group, dict):
            raise CompareError(f"{label}[{index}] must be an object")
        for key in ("thread_id", "session_id"):
            _bounded_text(group.get(key), f"{label}[{index}].{key}")
        if label.endswith("turns"):
            _bounded_text(group.get("turn_id"), f"{label}[{index}].turn_id")
        responses += _nonnegative_int(group.get("response_count"), f"{label}[{index}].response_count")
        _add_usage(summed, _usage(group.get("usage"), f"{label}[{index}].usage"))
    if totals is None:
        if groups:
            raise CompareError(f"{label} must be empty when totals are unavailable")
        return
    if require_equal and (summed != totals or responses != unique_responses):
        raise CompareError(f"{label} does not reconcile with authoritative totals")
    if not require_equal:
        if responses > unique_responses or any(summed[key] > totals[key] for key in USAGE_KEYS):
            raise CompareError(f"{label} exceeds authoritative totals")


def _report_summary(value: dict[str, Any], raw: bytes, path: Path, label: str) -> dict[str, Any]:
    if value.get("schema_version") != REPORT_SCHEMA:
        raise CompareError(f"{label}.schema_version must be {REPORT_SCHEMA}")
    authoritative = value.get("authoritative_usage")
    if not isinstance(authoritative, dict):
        raise CompareError(f"{label}.authoritative_usage must be an object")
    status = authoritative.get("status")
    if not isinstance(status, str) or status not in {"exact", "partial", "unavailable"}:
        raise CompareError(f"{label}.authoritative_usage.status is invalid")
    unique = _nonnegative_int(
        authoritative.get("unique_response_count"),
        f"{label}.authoritative_usage.unique_response_count",
    )
    conflicts = _nonnegative_int(
        authoritative.get("conflicting_response_count"),
        f"{label}.authoritative_usage.conflicting_response_count",
    )
    for key in ("duplicate_record_count", "compacted_duplicate_reference_count"):
        _nonnegative_int(authoritative.get(key), f"{label}.authoritative_usage.{key}")
    raw_totals = authoritative.get("totals")
    totals = None if raw_totals is None else _usage(raw_totals, f"{label}.authoritative_usage.totals")
    if status == "exact" and (totals is None or conflicts != 0 or unique == 0):
        raise CompareError(f"{label} exact status conflicts with totals, responses, or conflicts")
    if status == "unavailable" and (totals is not None or unique != 0):
        raise CompareError(f"{label} unavailable status conflicts with totals or responses")
    if status == "partial" and totals is None:
        raise CompareError(f"{label} partial status requires observed totals")
    _validate_groups(
        authoritative.get("threads"),
        f"{label}.authoritative_usage.threads",
        totals,
        unique,
        require_equal=totals is not None,
    )
    _validate_groups(
        authoritative.get("turns"),
        f"{label}.authoritative_usage.turns",
        totals,
        unique,
        require_equal=status == "exact",
    )
    scope = value.get("scope")
    if not isinstance(scope, dict) or not isinstance(scope.get("sources"), list):
        raise CompareError(f"{label}.scope.sources must be an array")
    if scope.get("selection") != "explicit_files_only":
        raise CompareError(f"{label}.scope.selection must be explicit_files_only")
    source_count = _nonnegative_int(scope.get("source_count"), f"{label}.scope.source_count")
    if source_count != len(scope["sources"]):
        raise CompareError(f"{label}.scope.source_count does not match sources")
    issues = value.get("issues")
    if not isinstance(issues, dict) or not isinstance(issues.get("items"), list) or not isinstance(issues.get("by_code"), dict):
        raise CompareError(f"{label}.issues is malformed")
    issue_count = _nonnegative_int(issues.get("count"), f"{label}.issues.count")
    if issue_count != len(issues["items"]):
        raise CompareError(f"{label}.issues.count does not match items")
    item_counts: collections.Counter[str] = collections.Counter()
    for index, item in enumerate(issues["items"]):
        if not isinstance(item, dict):
            raise CompareError(f"{label}.issues.items[{index}] must be an object")
        code = _bounded_text(item.get("code"), f"{label}.issues.items[{index}].code")
        item_counts[code] += 1
    declared_counts: dict[str, int] = {}
    for code, count in issues["by_code"].items():
        _bounded_text(code, f"{label}.issues.by_code key")
        declared_counts[code] = _nonnegative_int(count, f"{label}.issues.by_code.{code}")
    if dict(item_counts) != declared_counts:
        raise CompareError(f"{label}.issues.items does not reconcile with by_code")
    if status == "exact" and set(item_counts).intersection(_authoritative_issue_codes()):
        raise CompareError(f"{label} exact status contains an authoritative usage issue")

    metrics = None
    if totals is not None:
        metrics = {
            "uncached_input_tokens": totals["input_tokens"] - totals["cached_input_tokens"],
            "cached_input_tokens": totals["cached_input_tokens"],
            "output_tokens": totals["output_tokens"],
            "reasoning_output_tokens": totals["reasoning_output_tokens"],
            "total_tokens": totals["total_tokens"],
            "unique_responses": unique,
        }
    return {
        "path": str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "status": status,
        "source_count": source_count,
        "conflicting_responses": conflicts,
        "metrics": metrics,
    }


def _manifest_side(value: Any, label: str, reasons: list[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        reasons.append(f"{label}_metadata_missing")
        return None
    result: dict[str, Any] = {}
    for key in ("scope_id", "coverage_id", "configuration_id", "data_ref"):
        item = value.get(key)
        if not isinstance(item, str) or not item.strip() or len(item.encode("utf-8")) > MAX_STRING_BYTES:
            reasons.append(f"{label}_{key}_missing_or_invalid")
        else:
            result[key] = item
    task_count = value.get("task_count")
    if isinstance(task_count, bool) or not isinstance(task_count, int) or task_count <= 0:
        reasons.append(f"{label}_task_count_missing_or_invalid")
    else:
        result["task_count"] = task_count
    return result


def _references(value: Any, label: str, reasons: list[str]) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > MAX_REFERENCES:
        reasons.append(f"{label}_missing_or_invalid")
        return []
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip() or len(item.encode("utf-8")) > MAX_STRING_BYTES:
            reasons.append(f"{label}_missing_or_invalid")
            return []
        result.append(item)
    return result


def _manifest_assessment(
    value: dict[str, Any] | None,
    before: dict[str, Any],
    after: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    reasons: list[str] = []
    if value is None:
        return {"status": "missing"}, ["comparison_manifest_missing"]
    if value.get("schema_version") != MANIFEST_SCHEMA:
        raise CompareError(f"comparison.schema_version must be {MANIFEST_SCHEMA}")
    reports = value.get("reports")
    if not isinstance(reports, dict):
        reasons.append("comparison_report_hashes_missing")
    else:
        for name, report in (("before", before), ("after", after)):
            supplied = reports.get(f"{name}_sha256")
            if (
                not isinstance(supplied, str)
                or len(supplied) != 64
                or any(character not in "0123456789abcdefABCDEF" for character in supplied)
            ):
                reasons.append(f"comparison_{name}_hash_missing_or_invalid")
            elif supplied.lower() != report["sha256"]:
                reasons.append(f"comparison_{name}_hash_stale")

    cohort = value.get("cohort")
    before_cohort = after_cohort = None
    cohort_refs: list[str] = []
    if not isinstance(cohort, dict):
        reasons.append("cohort_metadata_missing")
    else:
        before_cohort = _manifest_side(cohort.get("before"), "cohort_before", reasons)
        after_cohort = _manifest_side(cohort.get("after"), "cohort_after", reasons)
        cohort_refs = _references(cohort.get("evidence_refs"), "cohort_evidence_refs", reasons)
        if before_cohort is not None and after_cohort is not None:
            for key in ("scope_id", "task_count", "coverage_id", "configuration_id"):
                if before_cohort.get(key) != after_cohort.get(key):
                    reasons.append(f"cohort_{key}_incompatible")

    quality = value.get("quality")
    quality_result: dict[str, Any] | None = None
    if not isinstance(quality, dict):
        reasons.append("quality_metadata_missing")
    else:
        before_status = quality.get("before_status")
        after_status = quality.get("after_status")
        if not isinstance(before_status, str) or before_status not in {"pass", "fail", "unknown"}:
            reasons.append("quality_before_status_missing_or_invalid")
        if not isinstance(after_status, str) or after_status not in {"pass", "fail", "unknown"}:
            reasons.append("quality_after_status_missing_or_invalid")
        quality_refs = _references(quality.get("evidence_refs"), "quality_evidence_refs", reasons)
        quality_result = {
            "before_status": before_status,
            "after_status": after_status,
            "evidence_refs": quality_refs,
        }
        if before_status != "pass":
            reasons.append("quality_before_not_pass")
        if after_status != "pass":
            reasons.append("quality_after_not_pass")

    return {
        "status": "provided",
        "cohort": {
            "before": before_cohort,
            "after": after_cohort,
            "evidence_refs": cohort_refs,
        },
        "quality": quality_result,
        "notice": "Cohort and quality fields are operator assertions linked to references, not independent verification.",
    }, list(dict.fromkeys(reasons))


def _percentage(before: int, after: int) -> str | None:
    if before == 0:
        return None
    numerator = (before - after) * 1_000_000
    whole, remainder = divmod(abs(numerator), before)
    if remainder * 2 >= before:
        whole += 1
    sign = "-" if numerator < 0 and whole else ""
    return f"{sign}{whole // 10_000}.{whole % 10_000:04d}"


def compare_reports(
    before_value: dict[str, Any],
    before_raw: bytes,
    before_path: Path,
    after_value: dict[str, Any],
    after_raw: bytes,
    after_path: Path,
    comparison: dict[str, Any] | None,
) -> dict[str, Any]:
    before = _report_summary(before_value, before_raw, before_path, "before")
    after = _report_summary(after_value, after_raw, after_path, "after")
    assessment, reasons = _manifest_assessment(comparison, before, after)
    if before["sha256"] == after["sha256"]:
        reasons.append("before_and_after_reports_are_identical")
    if before["status"] != "exact":
        reasons.append(f"before_report_{before['status']}")
    if after["status"] != "exact":
        reasons.append(f"after_report_{after['status']}")
    reasons = list(dict.fromkeys(reasons))

    observed: dict[str, Any] = {
        "accounting": {
            "uncached_input_tokens": "input_tokens minus cached_input_tokens",
            "cached_input_tokens": "subset of input_tokens; not added to total_tokens",
            "output_tokens": "includes reasoning_output_tokens",
            "reasoning_output_tokens": "subset of output_tokens; not added to total_tokens",
            "total_tokens": "input_tokens plus output_tokens",
            "unique_responses": "authoritative unique response deltas",
        },
        "before": before["metrics"],
        "after": after["metrics"],
        "delta_after_minus_before": None,
    }
    if before["metrics"] is not None and after["metrics"] is not None:
        observed["delta_after_minus_before"] = {
            key: after["metrics"][key] - before["metrics"][key] for key in METRIC_KEYS
        }

    percentages = None
    conclusion = "inconclusive"
    if not reasons:
        percentages = {
            key: _percentage(before["metrics"][key], after["metrics"][key])
            for key in METRIC_KEYS
        }
        comparisons = [after["metrics"][key] - before["metrics"][key] for key in METRIC_KEYS]
        if all(delta == 0 for delta in comparisons):
            conclusion = "no_change"
        elif before["metrics"]["total_tokens"] > after["metrics"]["total_tokens"] and all(
            delta <= 0 for delta in comparisons
        ):
            conclusion = "optimization_supported_by_operator_assertions"
        else:
            conclusion = "usage_increased_or_mixed"
    elif "quality_after_not_pass" in reasons:
        conclusion = "quality_regression_or_unknown"

    return {
        "schema_version": OUTPUT_SCHEMA,
        "status": "conclusive" if not reasons else "inconclusive",
        "conclusion": conclusion,
        "reasons": reasons,
        "reports": {
            "before": {key: before[key] for key in ("path", "sha256", "status", "source_count", "conflicting_responses")},
            "after": {key: after[key] for key in ("path", "sha256", "status", "source_count", "conflicting_responses")},
        },
        "comparison_manifest": assessment,
        "observed": observed,
        "reduction_percent": percentages,
        "limitations": [
            "No fallback token_count snapshots are summed or compared.",
            "Cached input and reasoning output remain subsets and are never double-counted.",
            "No price, monetary saving, provider behavior, or independent quality proof is claimed.",
        ],
    }


def _prepare_output(report: dict[str, Any], output: Path, protected: set[Path]) -> tuple[Path, bytes]:
    if os.path.lexists(output):
        raise CompareError(f"--output already exists: {output}")
    try:
        parent = output.parent.resolve(strict=True)
    except OSError as exc:
        raise CompareError(f"cannot resolve --output parent: {exc}") from exc
    candidate = parent / output.name
    if candidate in protected:
        raise CompareError("--output aliases an input")
    encoded = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise CompareError(f"comparison output exceeds {MAX_OUTPUT_BYTES} bytes")
    return candidate, encoded


def _write_new(candidate: Path, encoded: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(candidate, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
    except FileExistsError as exc:
        raise CompareError(f"--output already exists: {candidate}") from exc
    except OSError as exc:
        raise CompareError(f"cannot create --output {candidate}: {exc}") from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", required=True, type=Path, help="complete before usage report")
    parser.add_argument("--after", required=True, type=Path, help="complete after usage report")
    parser.add_argument("--comparison", type=Path, help="explicit cohort and quality manifest")
    parser.add_argument("--output", type=Path, help="new path for the full comparison report")
    return parser


def _error_text(exc: BaseException) -> str:
    text = str(exc).replace("\n", " ")
    return text[:1024]


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        before, before_raw, before_path = _read_json(args.before, MAX_REPORT_BYTES, "before report")
        after, after_raw, after_path = _read_json(args.after, MAX_REPORT_BYTES, "after report")
        comparison = None
        comparison_path = None
        if args.comparison is not None:
            comparison, _, comparison_path = _read_json(args.comparison, MAX_MANIFEST_BYTES, "comparison manifest")
        result = compare_reports(
            before,
            before_raw,
            before_path,
            after,
            after_raw,
            after_path,
            comparison,
        )
        prepared_output: tuple[Path, bytes] | None = None
        if args.output is not None:
            protected = {before_path, after_path}
            if comparison_path is not None:
                protected.add(comparison_path)
            prepared_output = _prepare_output(result, args.output, protected)
        compact = {
            "schema_version": result["schema_version"],
            "status": result["status"],
            "conclusion": result["conclusion"],
            "reasons": result["reasons"],
            "report_sha256": {
                "before": result["reports"]["before"]["sha256"],
                "after": result["reports"]["after"]["sha256"],
            },
            "observed": result["observed"],
            "reduction_percent": result["reduction_percent"],
        }
        if prepared_output is not None:
            compact["output"] = str(prepared_output[0])
        encoded = (json.dumps(compact, sort_keys=True) + "\n").encode("utf-8")
        if len(encoded) > 16 * 1024:
            raise CompareError("compact stdout exceeds 16384 bytes")
        if prepared_output is not None:
            _write_new(*prepared_output)
        sys.stdout.write(encoded.decode("utf-8"))
        return 0 if result["status"] == "conclusive" else 1
    except CompareError as exc:
        print(json.dumps({"status": "error", "error": _error_text(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
