#!/usr/bin/env python3
"""Create a bounded summary of a saved thread, Paperclip inspection, or text log.

The input is one explicit local file.  The tool does not discover files, call an
API, or execute content from the input.  Every summary identifies the complete
source bytes by absolute path and SHA-256, while page entries point back to a
JSON pointer or line number.  Secret redaction covers common credential fields
and token forms only; it is deliberately not advertised as universal detection.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "council.compact-output.v1"
DEFAULT_MAX_BYTES = 16 * 1024
DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024
MIN_OUTPUT_BYTES = 2_048
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_PAGE_SIZE = 100
MAX_DEPTH = 32
MAX_CRITICAL_SAMPLES = 20
PREVIEW_CHARS = 600

SECRET_FIELDS = {
    "password", "passwd", "secret", "client_secret", "access_token",
    "refresh_token", "api_key", "apikey", "private_key", "credential",
    "credentials", "authorization",
}
SECRET_TEXT = re.compile(
    r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+|"
    r"([\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|"
    r"private[_-]?key|password|passwd|credential|secret)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,;}\]]+|"
    r"\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[opusr]_[A-Za-z0-9]{20,})\b"
)
CRITICAL_TEXT = re.compile(
    r"(?i)\b(error|failed|failure|blocked|blocker|needs?[-_ ](?:user[-_ ])?input|"
    r"action required|permission denied|timed? out|outcome unknown|indeterminate)\b"
)
BAD_STATUS = {
    "error", "failed", "failure", "blocked", "cancelled", "canceled",
    "needs_input", "needs-input", "awaiting_input", "indeterminate",
    "outcome_unknown", "timed_out", "timeout", "changes_requested",
    "insufficient_evidence", "waiting_for_input", "requires_input",
}
SELECTED_FIELDS = (
    "id", "identifier", "type", "kind", "name", "title", "role", "status",
    "state", "phase", "priority", "assignee", "agentId", "issueId", "runId",
    "exitCode", "exit_code", "code", "errorCode", "blocked", "needsInput",
    "command", "tool", "toolName", "server", "method", "createdAt", "updatedAt",
)


class CompactError(ValueError):
    """A bounded, user-actionable failure without untrusted source content."""


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _pointer_part(value: Any) -> str:
    return str(value).replace("~", "~0").replace("/", "~1")


def _redact_text(value: str) -> str:
    def replacement(match: re.Match[str]) -> str:
        prefix = match.group(1) or match.group(2) or ""
        return prefix + "[REDACTED]"

    return SECRET_TEXT.sub(replacement, value)


def _clip(value: str, limit: int = PREVIEW_CHARS) -> dict[str, Any]:
    # Redact only the bounded preview window.  Content after it is referenced by
    # locator and never needs to be copied or scanned for preview construction.
    redacted = _redact_text(value[:limit + 512])
    clipped = len(value) > limit or len(redacted) > limit
    return {
        "text": redacted[:limit],
        "characters": len(value),
        "truncated": clipped,
        "redaction": "known_credential_patterns_only",
    }


def _scalar(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        redacted = _redact_text(value[:752])
        return redacted[:240] + ("..." if len(value) > 240 or len(redacted) > 240 else "")
    if isinstance(value, list):
        return {"kind": "array", "items": len(value)}
    if isinstance(value, dict):
        return {"kind": "object", "fields": len(value)}
    return {"kind": "unsupported"}


def _read_file(path: Path, limit: int) -> tuple[Path, bytes]:
    absolute = Path(os.path.abspath(path))
    try:
        metadata = os.lstat(absolute)
    except OSError as exc:
        raise CompactError(f"input is unavailable ({exc.__class__.__name__})") from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise CompactError("input must not be a symbolic link")
    if not stat.S_ISREG(metadata.st_mode):
        raise CompactError("input must be a regular file")
    if metadata.st_size > limit:
        raise CompactError(f"input exceeds max-input-bytes={limit}")
    try:
        with absolute.open("rb") as stream:
            raw = stream.read(limit + 1)
    except OSError as exc:
        raise CompactError(f"input cannot be read ({exc.__class__.__name__})") from exc
    if len(raw) > limit:
        raise CompactError(f"input exceeds max-input-bytes={limit}")
    return absolute, raw


def _json(raw: bytes) -> Any:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate object key")
            result[key] = value
        return result

    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
        raise CompactError("input is not valid finite UTF-8 JSON") from None
    _check_depth(value)
    return value


def _check_depth(root: Any) -> None:
    stack = [(root, 0)]
    while stack:
        value, depth = stack.pop()
        if depth > MAX_DEPTH:
            raise CompactError(f"JSON nesting exceeds {MAX_DEPTH} levels")
        if isinstance(value, float) and not math.isfinite(value):
            raise CompactError("JSON contains a non-finite number")
        if isinstance(value, dict):
            stack.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            stack.extend((item, depth + 1) for item in value)


def _text_from(item: dict[str, Any]) -> str | None:
    for key in (
        "error", "stderr", "message", "reason", "detail", "text", "content",
        "aggregatedOutput", "output", "stdout",
    ):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _status(item: dict[str, Any]) -> str | None:
    for key in ("status", "state", "phase", "outcome"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _normalized_status(value: str) -> str:
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", value)
    return re.sub(r"[-\s]+", "_", value).lower()


def _critical_reason(item: dict[str, Any]) -> str | None:
    status = _status(item)
    if status and _normalized_status(status) in BAD_STATUS:
        return f"status:{status[:80]}"
    item_type = item.get("type")
    if isinstance(item_type, str) and _normalized_status(item_type) in BAD_STATUS:
        return f"type:{item_type[:80]}"
    for key in ("error", "errorCode", "failure", "blocked", "needsInput", "needs_input", "isError"):
        value = item.get(key)
        if value not in (None, False, "", 0):
            return key
    exit_code = item.get("exitCode", item.get("exit_code"))
    if isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code != 0:
        return f"exitCode:{exit_code}"
    text = _text_from(item)
    if text and CRITICAL_TEXT.search(text):
        return "critical_text"
    return None


def _critical_sample(locator: str, item: dict[str, Any], reason: str) -> dict[str, Any]:
    sample: dict[str, Any] = {"locator": locator, "reason": reason}
    for key in ("type", "kind", "id", "identifier", "status", "state", "phase", "exitCode", "errorCode"):
        if key in item:
            sample[key] = _scalar(item[key])
    detail = _text_from(item)
    if detail:
        sample["detailPreview"] = _clip(detail, 240)
    return sample


def _project_item(item: Any, locator: str, *, thread: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"locator": locator}
    if thread:
        result["turn"] = {key: _scalar(thread[key]) for key in ("id", "status") if key in thread}
    if not isinstance(item, dict):
        result["value"] = _scalar(item)
        return result
    for key in SELECTED_FIELDS:
        if key in item and key.lower() not in SECRET_FIELDS:
            result[key] = _scalar(item[key])
    text = _text_from(item)
    if text:
        result["preview"] = _clip(text)
    elif not any(key != "locator" for key in result):
        result["shape"] = {"fields": len(item)}
    return result


def _upstream(root: Any) -> dict[str, Any]:
    if not isinstance(root, dict):
        return {"status": "unknown", "reason": "source has no pagination metadata"}
    page = root.get("page")
    candidates = [root]
    if isinstance(page, dict):
        candidates.append(page)
    has_more_values = [
        obj[key] for obj in candidates for key in ("hasMore", "has_more") if key in obj
    ]
    cursor_values = [
        obj[key] for obj in candidates for key in ("nextCursor", "next_cursor") if key in obj
    ]
    invalid_has_more = any(not isinstance(value, bool) for value in has_more_values)
    invalid_cursor = any(
        value is not None and (isinstance(value, bool) or not isinstance(value, (str, int)))
        for value in cursor_values
    )
    nonempty_cursors = [value for value in cursor_values if value not in (None, "")]
    has_true = any(value is True for value in has_more_values)
    has_false = any(value is False for value in has_more_values)
    contradictory = (has_true and has_false) or (has_false and bool(nonempty_cursors))
    if invalid_has_more or invalid_cursor:
        return {"status": "incomplete", "reason": "saved response has invalid upstream pagination metadata"}
    if contradictory:
        return {"status": "incomplete", "reason": "saved response has contradictory upstream pagination metadata"}
    if has_true or nonempty_cursors:
        result = {"status": "incomplete", "reason": "saved response reports another upstream page"}
        if nonempty_cursors:
            result["nextCursor"] = _scalar(nonempty_cursors[0])
        return result
    if has_more_values and all(value is False for value in has_more_values):
        return {"status": "complete", "reason": "saved response explicitly reports no next page"}
    return {"status": "unknown", "reason": "saved response does not prove upstream completeness"}


def _thread_data(root: Any) -> tuple[list[tuple[str, Any, dict[str, Any] | None]], list[dict[str, Any]], dict[str, Any]]:
    if not isinstance(root, dict) or not isinstance(root.get("turns"), list):
        raise CompactError("thread mode requires an object with a turns array")
    entries: list[tuple[str, Any, dict[str, Any] | None]] = []
    critical: list[dict[str, Any]] = []
    for turn_index, turn in enumerate(root["turns"]):
        turn_locator = f"/turns/{turn_index}"
        if not isinstance(turn, dict):
            entries.append((turn_locator, turn, None))
            continue
        items = turn.get("items", [])
        if not isinstance(items, list):
            reason = "items_not_array"
            critical.append(_critical_sample(turn_locator, turn, reason))
            continue
        for item_index, item in enumerate(items):
            locator = f"{turn_locator}/items/{item_index}"
            entries.append((locator, item, turn))
    for locator, item in _walk_dicts(root):
        reason = _critical_reason(item)
        if reason:
            critical.append(_critical_sample(locator, item, reason))
    identity: dict[str, Any] = {}
    thread_identity = root.get("thread")
    if isinstance(thread_identity, dict):
        identity["thread"] = {
            key: _scalar(thread_identity[key])
            for key in ("id", "title", "status") if key in thread_identity
        }
    elif thread_identity is not None:
        identity["thread"] = _scalar(thread_identity)
    for key in ("status", "error"):
        if key in root:
            identity[key] = _scalar(root[key])
    return entries, critical, identity


def _inspection_collection(root: Any) -> tuple[list[tuple[str, Any, None]], str]:
    if isinstance(root, list):
        return [(f"/{index}", value, None) for index, value in enumerate(root)], "/"
    if not isinstance(root, dict):
        raise CompactError("inspection mode requires a JSON object or array")
    for key in ("issues", "runs", "agents", "missions", "tasks", "results", "items", "data"):
        value = root.get(key)
        if isinstance(value, list):
            base = "/" + _pointer_part(key)
            return [(f"{base}/{index}", item, None) for index, item in enumerate(value)], base
    return [("/", root, None)], "/"


def _walk_dicts(root: Any) -> Iterable[tuple[str, dict[str, Any]]]:
    stack: list[tuple[str, Any]] = [("/", root)]
    while stack:
        locator, value = stack.pop()
        if isinstance(value, dict):
            yield locator, value
            for key, item in reversed(list(value.items())):
                child = ("" if locator == "/" else locator) + "/" + _pointer_part(key)
                stack.append((child, item))
        elif isinstance(value, list):
            for index in range(len(value) - 1, -1, -1):
                child = ("" if locator == "/" else locator) + f"/{index}"
                stack.append((child, value[index]))


def _log_data(raw: bytes) -> tuple[list[tuple[str, Any, None]], list[dict[str, Any]]]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    entries = [(f"line:{index}", line, None) for index, line in enumerate(lines, 1)]
    critical = []
    for index, line in enumerate(lines, 1):
        match = CRITICAL_TEXT.search(line)
        if match:
            critical.append({"locator": f"line:{index}", "reason": match.group(1).lower(), "detailPreview": _clip(line, 240)})
    return entries, critical


def _build(
    *, mode: str, root: Any, raw: bytes, source: Path, cursor: int,
    page_size: int, max_bytes: int,
) -> tuple[dict[str, Any], bytes]:
    collection = None
    identity: dict[str, Any] = {}
    if mode == "thread":
        entries, critical, identity = _thread_data(root)
    elif mode == "inspection":
        entries, collection = _inspection_collection(root)
        critical = []
        for locator, item in _walk_dicts(root):
            reason = _critical_reason(item)
            if reason:
                critical.append(_critical_sample(locator, item, reason))
    else:
        entries, critical = _log_data(raw)

    total = len(entries)
    if cursor > total:
        raise CompactError(f"cursor {cursor} exceeds available item count {total}")
    selected = entries[cursor:cursor + page_size]
    projected = [
        _project_item(value, locator, thread=turn) if mode != "log"
        else {"locator": locator, "preview": _clip(value)}
        for locator, value, turn in selected
    ]
    critical_samples = critical[:MAX_CRITICAL_SAMPLES]
    upstream = _upstream(root) if mode != "log" else {"status": "complete", "reason": "entire bounded file was read"}

    def candidate() -> tuple[dict[str, Any], bytes]:
        critical_omitted = len(critical) - len(critical_samples)
        page_blocked = total > cursor and not projected
        result_status = "needs_inspection" if critical_omitted or upstream["status"] == "incomplete" or page_blocked else "bounded"
        next_cursor = cursor + len(projected) if projected and cursor + len(projected) < total else None
        report: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "status": result_status,
            "mode": mode,
            "notice": "Projection only; consult source locators for full evidence. Redaction covers known credential patterns, not all secrets.",
            "source": {"path": str(source), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)},
            "upstreamCompleteness": upstream,
            "identity": identity,
            "pagination": {
                "cursor": cursor, "requestedPageSize": page_size, "returned": len(projected),
                "totalInSuppliedFile": total, "omittedBefore": cursor,
                "omittedAfter": total - cursor - len(projected), "nextCursor": next_cursor,
                "pageBlocked": page_blocked,
                "blockReason": "max-bytes left no room for a page item; inspect source or raise the finite limit" if page_blocked else None,
                "locatorScheme": "JSON Pointer" if mode != "log" else "one-based line number",
            },
            "criticalSignals": {
                "count": len(critical), "samples": critical_samples,
                "samplesOmitted": critical_omitted,
                "completeScanOfSuppliedFile": True,
            },
            "items": projected,
        }
        if collection is not None:
            report["collectionLocator"] = collection
        encoded = _canonical(report)
        return report, encoded

    report, encoded = candidate()
    while len(encoded) > max_bytes and projected:
        projected.pop()
        report, encoded = candidate()
    while len(encoded) > max_bytes and critical_samples:
        critical_samples.pop()
        report, encoded = candidate()
    if len(encoded) > max_bytes:
        raise CompactError(f"essential summary metadata exceeds max-bytes={max_bytes}")
    return report, encoded


def _write_new(path: Path, data: bytes, input_path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    if absolute == input_path:
        raise CompactError("output must differ from input")
    if absolute.is_symlink():
        raise CompactError("output must not be a symbolic link")
    if not absolute.parent.is_dir():
        raise CompactError("output parent directory does not exist")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd: int | None = None
    created = False
    try:
        fd = os.open(absolute, flags, 0o600)
        created = True
        with os.fdopen(fd, "wb") as stream:
            fd = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        if created:
            try:
                absolute.unlink()
            except OSError:
                pass
        if isinstance(exc, FileExistsError):
            raise CompactError("output already exists; refusing to overwrite") from None
        raise CompactError(f"output cannot be written ({exc.__class__.__name__})") from exc
    finally:
        if fd is not None:
            os.close(fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("thread", "inspection", "log"))
    parser.add_argument("--input", required=True, type=Path, help="one explicit read-only source file")
    parser.add_argument("--cursor", type=int, default=0, help="zero-based item or line offset")
    parser.add_argument("--page-size", type=int, default=20, help=f"requested entries (1-{MAX_PAGE_SIZE})")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES, help="maximum stdout/artifact bytes including newline")
    parser.add_argument("--max-input-bytes", type=int, default=DEFAULT_MAX_INPUT_BYTES, help="maximum source bytes read")
    parser.add_argument("--output", type=Path, help="optional new private summary artifact; existing paths are refused")
    args = parser.parse_args(argv)
    try:
        if args.cursor < 0:
            raise CompactError("cursor must be non-negative")
        if not 1 <= args.page_size <= MAX_PAGE_SIZE:
            raise CompactError(f"page-size must be between 1 and {MAX_PAGE_SIZE}")
        if not MIN_OUTPUT_BYTES <= args.max_bytes <= MAX_OUTPUT_BYTES:
            raise CompactError(f"max-bytes must be between {MIN_OUTPUT_BYTES} and {MAX_OUTPUT_BYTES}")
        if not 1 <= args.max_input_bytes <= MAX_INPUT_BYTES:
            raise CompactError(f"max-input-bytes must be between 1 and {MAX_INPUT_BYTES}")
        source, raw = _read_file(args.input, args.max_input_bytes)
        root = raw if args.mode == "log" else _json(raw)
        report, encoded = _build(
            mode=args.mode, root=root, raw=raw, source=source, cursor=args.cursor,
            page_size=args.page_size, max_bytes=args.max_bytes,
        )
        if args.output:
            _write_new(args.output, encoded, source)
        sys.stdout.buffer.write(encoded)
        return 0
    except CompactError as exc:
        error = _canonical({"schemaVersion": SCHEMA_VERSION, "status": "error", "error": str(exc)[:512]})
        sys.stderr.buffer.write(error[:1024])
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
