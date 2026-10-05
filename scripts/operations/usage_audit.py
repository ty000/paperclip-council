#!/usr/bin/env python3
"""Audit response token usage from an explicit, finite set of Codex JSONL files.

Only structured accounting records are retained. Message and tool content is never
copied into the result.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
from typing import Any, BinaryIO, Iterable


USAGE_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)
CHUNK_BYTES = 1024 * 1024
AUTHORITATIVE_ISSUE_CODES = {
    "short_read",
    "source_changed_during_read",
    "partial_prefix_line",
    "malformed_json",
    "unknown_record",
    "malformed_session_meta",
    "conflicting_session_meta",
    "unknown_usage_record",
    "malformed_usage",
    "unknown_usage_identity",
    "unknown_turn_identity",
    "session_identity_mismatch",
    "conflicting_usage",
}


class AuditInputError(ValueError):
    """Raised when the explicitly selected audit input is invalid."""


def _zero_usage() -> dict[str, int]:
    return {key: 0 for key in USAGE_KEYS}


def _add_usage(target: dict[str, int], usage: dict[str, int]) -> None:
    for key in USAGE_KEYS:
        target[key] += usage[key]


def _safe_usage(value: Any) -> tuple[dict[str, int] | None, str | None]:
    if not isinstance(value, dict):
        return None, "usage is not an object"
    missing = [key for key in USAGE_KEYS if key not in value]
    if missing:
        return None, "missing usage fields: " + ",".join(missing)
    usage: dict[str, int] = {}
    for key in USAGE_KEYS:
        item = value[key]
        if isinstance(item, bool) or not isinstance(item, int) or item < 0:
            return None, f"{key} is not a non-negative integer"
        usage[key] = item
    if usage["cached_input_tokens"] > usage["input_tokens"]:
        return None, "cached_input_tokens exceeds input_tokens"
    if usage["reasoning_output_tokens"] > usage["output_tokens"]:
        return None, "reasoning_output_tokens exceeds output_tokens"
    if usage["total_tokens"] != usage["input_tokens"] + usage["output_tokens"]:
        return None, "total_tokens differs from input_tokens plus output_tokens"
    return usage, None


def _bounded_lines(
    handle: BinaryIO, limit: int, digest: Any
) -> tuple[list[tuple[int, bytes]], bytes, int]:
    """Read exactly at most limit bytes and return complete lines plus a tail."""
    lines: list[tuple[int, bytes]] = []
    pending = b""
    remaining = limit
    line_number = 0
    bytes_read = 0
    while remaining:
        block = handle.read(min(CHUNK_BYTES, remaining))
        if not block:
            break
        digest.update(block)
        bytes_read += len(block)
        remaining -= len(block)
        pending += block
        parts = pending.split(b"\n")
        pending = parts.pop()
        for raw in parts:
            line_number += 1
            lines.append((line_number, raw))
    return lines, pending, bytes_read


def _issue(
    issues: list[dict[str, Any]], code: str, source: int, line: int | None, detail: str
) -> None:
    item: dict[str, Any] = {"code": code, "source_index": source, "detail": detail}
    if line is not None:
        item["line"] = line
    issues.append(item)


def _validate_paths(
    paths: Iterable[str], prefix_bytes: int | None
) -> list[tuple[str, Path]]:
    selected = list(paths)
    if not selected:
        raise AuditInputError("at least one --session is required")
    if prefix_bytes is not None and len(selected) != 1:
        raise AuditInputError("--prefix-bytes requires exactly one --session")
    if prefix_bytes is not None and prefix_bytes < 0:
        raise AuditInputError("--prefix-bytes must be non-negative")
    resolved: list[tuple[str, Path]] = []
    for raw in selected:
        path = Path(raw)
        if not path.is_absolute():
            raise AuditInputError(f"--session must be absolute: {raw}")
        try:
            actual = path.resolve(strict=True)
        except OSError as exc:
            raise AuditInputError(f"cannot resolve session {raw}: {exc}") from exc
        if not actual.is_file():
            raise AuditInputError(f"session is not a regular file: {raw}")
        resolved.append((raw, actual))
    return resolved


def audit_sessions(
    session_paths: Iterable[str], *, prefix_bytes: int | None = None
) -> dict[str, Any]:
    """Audit explicitly selected session files without discovering other files."""
    paths = _validate_paths(session_paths, prefix_bytes)
    issues: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    records: dict[tuple[str, str, str], dict[str, Any]] = {}
    conflicted: set[tuple[str, str, str]] = set()
    duplicate_records = 0
    compacted_records: collections.Counter[tuple[Any, ...]] = collections.Counter()
    normal_records: set[tuple[Any, ...]] = set()
    fallback: list[dict[str, Any]] = []

    for source_index, (requested_path, path) in enumerate(paths):
        with path.open("rb") as handle:
            opened_size = os.fstat(handle.fileno()).st_size
            limit = opened_size if prefix_bytes is None else prefix_bytes
            if limit > opened_size:
                raise AuditInputError(
                    f"--prefix-bytes {limit} exceeds opened file size {opened_size}"
                )
            digest = hashlib.sha256()
            lines, tail, bytes_read = _bounded_lines(handle, limit, digest)
            final_size = os.fstat(handle.fileno()).st_size
        if bytes_read != limit:
            _issue(issues, "short_read", source_index, None, "source shrank during bounded read")
        if prefix_bytes is None and final_size != opened_size:
            _issue(
                issues,
                "source_changed_during_read",
                source_index,
                None,
                f"source size changed from {opened_size} to {final_size} bytes; only the opened prefix was audited",
            )

        is_partial_prefix = limit < opened_size
        if tail and not is_partial_prefix:
            lines.append((len(lines) + 1, tail))
        elif tail:
            _issue(
                issues,
                "partial_prefix_line",
                source_index,
                len(lines) + 1,
                "trailing partial JSONL record was not parsed",
            )

        session_meta_id: str | None = None
        parsed_lines = 0
        malformed_lines = 0
        latest_fallback: dict[str, Any] | None = None
        fallback_events = 0

        for line_number, raw in lines:
            if not raw.strip():
                _issue(issues, "blank_line", source_index, line_number, "blank JSONL record")
                continue
            try:
                event = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                malformed_lines += 1
                _issue(
                    issues,
                    "malformed_json",
                    source_index,
                    line_number,
                    "record is not valid JSON",
                )
                continue
            parsed_lines += 1
            if not isinstance(event, dict):
                _issue(
                    issues,
                    "unknown_record",
                    source_index,
                    line_number,
                    "top-level JSON value is not an object",
                )
                continue
            event_type = event.get("type")
            payload = event.get("payload")

            if event_type == "session_meta":
                if not isinstance(payload, dict):
                    _issue(issues, "malformed_session_meta", source_index, line_number, "payload is not an object")
                    continue
                session_alias = payload.get("session_id")
                id_alias = payload.get("id")
                if session_alias is not None and id_alias is not None and session_alias != id_alias:
                    _issue(issues, "conflicting_session_meta", source_index, line_number, "payload id and session_id differ")
                    continue
                candidate = session_alias if session_alias is not None else id_alias
                if not isinstance(candidate, str) or not candidate:
                    _issue(issues, "malformed_session_meta", source_index, line_number, "session identity is missing")
                elif session_meta_id is not None and session_meta_id != candidate:
                    _issue(issues, "conflicting_session_meta", source_index, line_number, "session identity changed")
                else:
                    session_meta_id = candidate
                continue

            if event_type == "event_msg" and isinstance(payload, dict) and payload.get("type") == "token_count":
                fallback_events += 1
                info = payload.get("info")
                if not isinstance(info, dict):
                    _issue(issues, "malformed_token_count", source_index, line_number, "info is not an object")
                    continue
                cumulative, error = _safe_usage(info.get("total_token_usage"))
                last, last_error = _safe_usage(info.get("last_token_usage"))
                context_window = info.get("model_context_window")
                if error or last_error:
                    _issue(
                        issues,
                        "malformed_token_count",
                        source_index,
                        line_number,
                        error or last_error or "invalid token_count",
                    )
                    continue
                if isinstance(context_window, bool) or not isinstance(context_window, int) or context_window < 0:
                    context_window = None
                    _issue(issues, "malformed_context_window", source_index, line_number, "context window is not a non-negative integer")
                latest_fallback = {
                    "line": line_number,
                    "total_token_usage": cumulative,
                    "last_token_usage": last,
                    "model_context_window": context_window,
                }
                continue

            usage_source: str | None = None
            record: Any = None
            if event_type == "token_usage_record":
                usage_source = "token_usage_record"
                record = payload
            elif event_type == "compacted":
                usage_source = "compacted.latest_token_usage_record"
                if isinstance(payload, dict):
                    record = payload.get("latest_token_usage_record")
                if record is None:
                    _issue(issues, "unknown_usage_record", source_index, line_number, "compacted record has no latest token usage")
                    continue
            else:
                continue

            if not isinstance(record, dict):
                _issue(issues, "unknown_usage_record", source_index, line_number, "usage record is not an object")
                continue
            usage, error = _safe_usage(record.get("usage"))
            if error:
                _issue(issues, "malformed_usage", source_index, line_number, error)
                continue
            session_id = record.get("session_id") or session_meta_id
            thread_id = record.get("thread_id") or session_id
            response_id = record.get("response_id")
            turn_id = record.get("turn_id")
            if not all(isinstance(value, str) and value for value in (thread_id, session_id, response_id)):
                _issue(issues, "unknown_usage_identity", source_index, line_number, "thread/session/response identity is incomplete")
                continue
            if session_meta_id is not None and record.get("session_id") not in (None, session_meta_id):
                _issue(issues, "session_identity_mismatch", source_index, line_number, "record session differs from file metadata")
            if not isinstance(turn_id, str) or not turn_id:
                turn_id = None
                _issue(issues, "unknown_turn_identity", source_index, line_number, "turn identity is missing")

            key = (thread_id, session_id, response_id)
            signature = (key, turn_id, *(usage[name] for name in USAGE_KEYS))
            candidate = {
                "thread_id": thread_id,
                "session_id": session_id,
                "response_id": response_id,
                "turn_id": turn_id,
                "usage": usage,
                "source": usage_source,
                "source_index": source_index,
                "line": line_number,
            }
            previous = records.get(key)
            if previous is None:
                records[key] = candidate
            elif previous["usage"] == usage and previous["turn_id"] == turn_id:
                duplicate_records += 1
            else:
                conflicted.add(key)
                _issue(issues, "conflicting_usage", source_index, line_number, "same identity has different usage or turn")
            if usage_source == "compacted.latest_token_usage_record":
                compacted_records[signature] += 1
            else:
                normal_records.add(signature)

        source_result = {
            "source_index": source_index,
            "requested_path": requested_path,
            "resolved_path": str(path),
            "opened_size_bytes": opened_size,
            "final_size_bytes": final_size,
            "prefix_bytes": limit,
            "prefix_sha256": digest.hexdigest(),
            "parsed_lines": parsed_lines,
            "malformed_lines": malformed_lines,
            "trailing_partial_line": bool(tail and is_partial_prefix),
        }
        sources.append(source_result)
        fallback.append(
            {
                "source_index": source_index,
                "session_id": session_meta_id,
                "event_count": fallback_events,
                "latest_cumulative_snapshot": latest_fallback,
            }
        )

    trusted = [record for key, record in records.items() if key not in conflicted]
    compacted_duplicate_references = sum(
        count
        for signature, count in compacted_records.items()
        if signature in normal_records
    )
    totals = _zero_usage()
    thread_groups: dict[tuple[str, str], dict[str, Any]] = {}
    turn_groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for record in trusted:
        _add_usage(totals, record["usage"])
        thread_key = (record["thread_id"], record["session_id"])
        thread = thread_groups.setdefault(
            thread_key,
            {"thread_id": thread_key[0], "session_id": thread_key[1], "response_count": 0, "usage": _zero_usage()},
        )
        thread["response_count"] += 1
        _add_usage(thread["usage"], record["usage"])
        if record["turn_id"] is not None:
            turn_key = (record["thread_id"], record["session_id"], record["turn_id"])
            turn = turn_groups.setdefault(
                turn_key,
                {
                    "thread_id": turn_key[0],
                    "session_id": turn_key[1],
                    "turn_id": turn_key[2],
                    "response_count": 0,
                    "usage": _zero_usage(),
                },
            )
            turn["response_count"] += 1
            _add_usage(turn["usage"], record["usage"])

    issue_counts = dict(sorted(collections.Counter(item["code"] for item in issues).items()))
    if not trusted:
        authoritative_status = "unavailable"
        reported_totals: dict[str, int] | None = None
    elif any(item["code"] in AUTHORITATIVE_ISSUE_CODES for item in issues):
        authoritative_status = "partial"
        reported_totals = totals
    else:
        authoritative_status = "exact"
        reported_totals = totals
    return {
        "schema_version": "council-usage-audit.v1",
        "scope": {
            "selection": "explicit_files_only",
            "source_count": len(sources),
            "sources": sources,
        },
        "authoritative_usage": {
            "status": authoritative_status,
            "accounting": "sum of unique response usage deltas; cached input is included in input and reasoning output is included in output",
            "unique_response_count": len(trusted),
            "duplicate_record_count": duplicate_records,
            "compacted_duplicate_reference_count": compacted_duplicate_references,
            "conflicting_response_count": len(conflicted),
            "totals": reported_totals,
            "threads": sorted(thread_groups.values(), key=lambda item: (item["thread_id"], item["session_id"])),
            "turns": sorted(turn_groups.values(), key=lambda item: (item["thread_id"], item["session_id"], item["turn_id"])),
        },
        "fallback_token_count": {
            "confidence": "lower",
            "accounting": "latest cumulative snapshot per source/session; events are never summed and context windows are not token usage",
            "sessions": fallback,
        },
        "issues": {"count": len(issues), "by_code": issue_counts, "items": issues},
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", action="append", required=True, help="absolute JSONL file path; repeat for a finite set")
    parser.add_argument("--prefix-bytes", type=int, help="read exactly this source prefix; valid with one session")
    parser.add_argument("--output", type=Path, help="write the full JSON report to this path")
    return parser


def _write_report_exclusive(report: dict[str, Any], output: Path) -> Path:
    """Create a new report without following or replacing an existing path."""
    if os.path.lexists(output):
        raise AuditInputError(f"--output already exists: {output}")
    try:
        parent = output.parent.resolve(strict=True)
    except OSError as exc:
        raise AuditInputError(f"cannot resolve --output parent: {exc}") from exc
    candidate = parent / output.name
    selected = {Path(item["resolved_path"]) for item in report["scope"]["sources"]}
    if candidate in selected:
        raise AuditInputError("--output aliases a selected session")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(candidate, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except FileExistsError as exc:
        raise AuditInputError(f"--output already exists: {output}") from exc
    except OSError as exc:
        raise AuditInputError(f"cannot create --output {output}: {exc}") from exc
    return candidate


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = audit_sessions(args.session, prefix_bytes=args.prefix_bytes)
    except AuditInputError as exc:
        raise SystemExit(f"usage_audit: {exc}") from exc
    written_output: Path | None = None
    if args.output:
        try:
            written_output = _write_report_exclusive(report, args.output)
        except AuditInputError as exc:
            raise SystemExit(f"usage_audit: {exc}") from exc
    authoritative = report["authoritative_usage"]
    compact = {
        "status": authoritative["status"],
        "source_count": report["scope"]["source_count"],
        "prefixes": [
            {"bytes": source["prefix_bytes"], "sha256": source["prefix_sha256"]}
            for source in report["scope"]["sources"]
        ],
        "unique_responses": authoritative["unique_response_count"],
        "duplicate_records": authoritative["duplicate_record_count"],
        "compacted_duplicate_references": authoritative["compacted_duplicate_reference_count"],
        "conflicting_responses": authoritative["conflicting_response_count"],
        "usage": authoritative["totals"],
        "issues": report["issues"]["by_code"],
    }
    if written_output:
        compact["output"] = str(written_output)
    print(json.dumps(compact, sort_keys=True))
    return 0 if authoritative["status"] == "exact" else 1


if __name__ == "__main__":
    raise SystemExit(main())
