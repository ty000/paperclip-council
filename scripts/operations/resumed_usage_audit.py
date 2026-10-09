#!/usr/bin/env python3
"""Read-only reconciliation of explicit Paperclip run snapshots and one Codex session.

Analytical evidence only: never writes a ledger, infers billing or authorizes runs.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_spec = importlib.util.spec_from_file_location("_response_audit", Path(__file__).with_name("usage_audit.py"))
assert _spec and _spec.loader
_response = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_response)
KEYS = ("input_tokens", "cached_input_tokens", "output_tokens")
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out", "interrupted"}
MAX_BYTES = 64 * 1024 * 1024


def timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("missing timestamp")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timestamp must include timezone")
    return result


def read(path: str) -> bytes:
    selected = Path(path)
    if not selected.is_absolute() or not selected.is_file():
        raise ValueError("inputs must be explicit absolute files")
    with selected.open("rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("input exceeds 64 MiB")
    return raw


def usage(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None
    result = {k: value.get(k) for k in KEYS}
    if any(type(v) is not int or v < 0 for v in result.values()):
        return None
    if result["cached_input_tokens"] > result["input_tokens"]:
        return None
    result["total_tokens"] = result["input_tokens"] + result["output_tokens"]
    return result


def add(values: list[dict]) -> dict:
    return {k: sum(v[k] for v in values) for k in (*KEYS, "total_tokens")}


def reconcile(session_path: str, run_paths: list[str]) -> dict:
    if not run_paths or len(run_paths) > 64:
        raise ValueError("select between 1 and 64 run snapshots")
    raw = read(session_path)
    response_report = _response.audit_sessions([session_path], prefix_bytes=len(raw))
    source = response_report["scope"]["sources"][0]
    if source["prefix_sha256"] != hashlib.sha256(raw).hexdigest():
        raise ValueError("session changed between bounded reads")
    audited = response_report["authoritative_usage"]
    metadata = []
    bounds: dict[str, dict] = {}
    invalid_bounds = False
    for line in raw.splitlines():
        try:
            event = json.loads(line)
            payload = event.get("payload") or {}
            if event.get("type") == "session_meta":
                if not isinstance(payload, dict):
                    invalid_bounds = True
                else:
                    metadata.append(payload)
            if event.get("type") == "event_msg" and payload.get("type") in {"task_started", "task_complete"}:
                turn = payload.get("turn_id")
                kind = "start" if payload["type"] == "task_started" else "end"
                bound = bounds.setdefault(turn, {})
                value = timestamp(event.get("timestamp"))
                if kind in bound and bound[kind] != value:
                    invalid_bounds = True
                bound[kind] = value
        except (ValueError, TypeError, AttributeError):
            invalid_bounds = True
    meta = metadata[0] if len(metadata) == 1 else {}
    session_id = meta.get("id")
    version = meta.get("cli_version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+.][\w.-]+)?", version):
        version = None
    turns = {t["turn_id"]: t for t in audited["turns"] if t["session_id"] == session_id and t["thread_id"] == session_id}
    complete_bounds = all(set(b) == {"start", "end"} and b["start"] <= b["end"] for b in bounds.values())
    ordered = sorted(bounds, key=lambda t: bounds[t].get("start", datetime.max.replace(tzinfo=timezone.utc)))
    nonoverlapping = complete_bounds and all(bounds[a]["end"] <= bounds[b]["start"] for a, b in zip(ordered, ordered[1:]))
    qualified = (audited["status"] == "exact" and version is not None and bool(session_id)
                 and not invalid_bounds and nonoverlapping and set(turns) == set(bounds))
    seen: dict[str, bytes] = {}
    rows = []
    repeats = 0
    actor = None
    for path in run_paths:
        run_raw = read(path)
        run = json.loads(run_raw)
        if not isinstance(run, dict):
            raise ValueError("run snapshot must be an object")
        identity = (run.get("companyId"), run.get("agentId"))
        if not all(isinstance(v, str) and v for v in identity) or (actor is not None and actor != identity):
            raise ValueError("run company/agent identities are absent or differ")
        actor = identity
        run_id = run.get("id")
        if not isinstance(run_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", run_id):
            raise ValueError("run identity is missing or invalid")
        if run_id in seen:
            if seen[run_id] != run_raw:
                raise ValueError("conflicting snapshots of the same run")
            repeats += 1
            continue
        seen[run_id] = run_raw
        reported = run.get("usageJson") or {}
        if not isinstance(reported, dict):
            reported = {}
        observed = usage({"input_tokens": reported.get("inputTokens"),
                          "cached_input_tokens": reported.get("cachedInputTokens"),
                          "output_tokens": reported.get("outputTokens")})
        row = {"run_id": run_id, "snapshot_sha256": hashlib.sha256(run_raw).hexdigest(),
               "reported_usage": observed, "response_usage": None, "classification": "non_conclusive",
               "reason": "identity_or_terminal_usage_unavailable"}
        rows.append(row)
        try:
            start, end = timestamp(run.get("startedAt")), timestamp(run.get("finishedAt"))
        except ValueError:
            continue
        matches = [t for t, b in bounds.items() if set(b) == {"start", "end"} and start <= b["start"] <= b["end"] <= end]
        if (not qualified or run.get("status") not in TERMINAL or observed is None
                or run.get("sessionIdAfter") != session_id or len(matches) != 1
                or reported.get("usageSource") != "per_run"):
            continue
        turn_id = matches[0]
        row["turn_id"] = turn_id
        delta = usage(turns[turn_id]["usage"])
        row["response_usage"] = delta
        row["response_count"] = turns[turn_id]["response_count"]
        if observed == delta:
            row.update(classification="per_run_confirmed", reason="matches_unique_response_deltas")
            continue
        index = ordered.index(turn_id)
        baseline = [usage(turns[t]["usage"]) for t in ordered[:index]]
        if (index and run.get("sessionIdBefore") == session_id and reported.get("sessionReused") is True
                and all(b is not None for b in baseline) and observed == add([*baseline, delta])):
            row.update(classification="cumulative_mislabeled_confirmed", reason="matches_prior_and_current_unique_response_deltas")
        else:
            row["reason"] = "baseline_absent_or_counter_mismatch"
    mapped = [r.get("turn_id") for r in rows if r.get("turn_id")]
    if len(set(mapped)) != len(mapped):
        raise ValueError("multiple runs map to the same Codex turn")
    complete = all(r["classification"] != "non_conclusive" for r in rows)
    reported_rows = [r["reported_usage"] for r in rows if r["reported_usage"] is not None]
    response_rows = [r["response_usage"] for r in rows if r["response_usage"] is not None]
    observed_total = add(reported_rows) if len(reported_rows) == len(rows) else None
    response_total = add(response_rows) if complete else None
    return {
        "schema_version": "council-resumed-usage-audit.v1", "mode": "read_only_analysis",
        "conclusion": "confirmed" if complete and any(r["classification"] == "cumulative_mislabeled_confirmed" for r in rows) else "per_run_confirmed" if complete else "non_conclusive",
        "source": {"session_sha256": source["prefix_sha256"], "session_bytes": len(raw), "session_id": session_id,
                   "cli_version": version, "response_audit_status": audited["status"],
                   "unique_responses": audited["unique_response_count"], "duplicate_responses": audited["duplicate_record_count"],
                   "conflicting_responses": audited["conflicting_response_count"], "issue_counts": response_report["issues"]["by_code"]},
        "runs": rows, "repeated_run_snapshots": repeats,
        "paperclip_reported_usage": observed_total, "selected_run_response_usage": response_total,
        "analytical_excess_units": observed_total["total_tokens"] - response_total["total_tokens"] if observed_total and response_total else None,
        "unknown_run_count": sum(r["classification"] == "non_conclusive" for r in rows),
        "assistance": {"codex_supervision_usage": None, "status": "not_selected_separate_scope"},
        "billing": "not_inferred", "historical_ledger": "unchanged", "savings": None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True)
    parser.add_argument("--run", action="append", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        report = reconcile(args.session, args.run)
        if args.output:
            # Reuse the exclusive private writer; selected inputs cannot be overwritten.
            wrapped = {**report, "scope": {"sources": []}}
            _response._write_report_exclusive(wrapped, args.output)
        print(json.dumps(report, sort_keys=True))
        return 1 if report["conclusion"] == "non_conclusive" else 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "refused", "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
