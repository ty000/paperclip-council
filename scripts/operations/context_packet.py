#!/usr/bin/env python3
"""Project a durable run-memory checkpoint into a bounded context packet.

The subject file has exactly this JSON shape (all values are non-empty strings):
``repoPath``, ``baseSha``, ``candidateSha``, and ``missionId``.  Those values are
copied verbatim and labelled supplied/unverified; this tool never inspects Git
or infers authority.  In the output mandate, ``current`` is copied unchanged,
``superseded_instructions`` is normalized to ``supersededInstructions``, and
every other source member is copied unchanged under ``sourceExtensions``.  All
mandate members are essential and are never truncated or optionally omitted.
The source checkpoint and subject are read-only inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "council.context-packet.v1"
MAX_STATE_BYTES = 1_048_576
MAX_SUBJECT_BYTES = 65_536
MAX_OUTPUT_BYTES = 1_048_576
MAX_ITEMS_PER_FIELD = 1_000
MIN_OUTPUT_BYTES = 512

ESSENTIAL_ARRAYS = (
    "stop_conditions",
    "hard_constraints",
    "budgets",
    "decisions",
    "unknowns",
    "open_risks",
    "owners",
    "volatile_state",
)
OPTIONAL_ARRAYS = ("known_facts", "evidence_collected", "files_touched")
REQUIRED_STRINGS = ("objective", "current_gate", "next_action", "next_checkpoint")
SUBJECT_KEYS = ("repoPath", "baseSha", "candidateSha", "missionId")
FORBIDDEN_KEYS = {
    "password", "passwd", "secret", "secrets", "token", "access_token",
    "api_key", "apikey", "private_key", "credential", "credentials",
    "transcript", "raw_transcript", "raw_prompt", "prompt_log", "raw_logs",
}
SECRET_TEXT = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    r"\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"gh[opusr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b"
)
SHA = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})")


class PacketError(ValueError):
    """A safe, user-actionable packet construction failure."""


def _read_json(path: Path, limit: int, label: str) -> tuple[dict[str, Any], bytes]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise PacketError(f"cannot read {label}: {exc}") from exc
    if size > limit:
        raise PacketError(f"{label} exceeds {limit} bytes")
    try:
        with path.open("rb") as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise PacketError(f"{label} exceeds {limit} bytes")
        value = json.loads(raw.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except PacketError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise PacketError(f"invalid {label} JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise PacketError(f"{label} root must be an object")
    return value, raw


def _inspect_untrusted(value: Any, path: str = "$", depth: int = 0) -> None:
    if depth > 20:
        raise PacketError(f"JSON nesting exceeds 20 levels at {path}")
    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PacketError(f"non-finite number at {path}")
        return
    if isinstance(value, str):
        if SECRET_TEXT.search(value):
            raise PacketError(f"possible secret at {path}; redact the source checkpoint first")
        return
    if isinstance(value, list):
        if len(value) > MAX_ITEMS_PER_FIELD:
            raise PacketError(f"array at {path} exceeds {MAX_ITEMS_PER_FIELD} items")
        for index, item in enumerate(value):
            _inspect_untrusted(item, f"{path}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise PacketError(f"non-string object key at {path}")
            normalized = key.lower().replace("-", "_")
            if normalized in FORBIDDEN_KEYS:
                raise PacketError(f"forbidden secret/log field at {path}.{key}")
            _inspect_untrusted(item, f"{path}.{key}", depth + 1)
        return
    raise PacketError(f"unsupported JSON value at {path}")


def _nonempty_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PacketError(f"{path} must be a non-empty string")
    return value


def _array(state: dict[str, Any], name: str) -> list[Any]:
    value = state.get(name)
    if not isinstance(value, list):
        raise PacketError(f"state.{name} must be an array")
    if len(value) > MAX_ITEMS_PER_FIELD:
        raise PacketError(f"state.{name} exceeds {MAX_ITEMS_PER_FIELD} items")
    for index, item in enumerate(value):
        if not isinstance(item, (str, dict)) or (isinstance(item, str) and not item.strip()):
            raise PacketError(f"state.{name}[{index}] must be a non-empty string or object")
    return value


def _validate_state(state: dict[str, Any]) -> None:
    _inspect_untrusted(state, "state")
    for name in REQUIRED_STRINGS:
        _nonempty_string(state.get(name), f"state.{name}")
    mandate = state.get("mandate")
    if not isinstance(mandate, dict):
        raise PacketError("state.mandate must be an object")
    _nonempty_string(mandate.get("current"), "state.mandate.current")
    superseded = mandate.get("superseded_instructions")
    if not isinstance(superseded, list):
        raise PacketError("state.mandate.superseded_instructions must be an array")
    if len(superseded) > MAX_ITEMS_PER_FIELD:
        raise PacketError("state.mandate.superseded_instructions has too many items")
    for index, item in enumerate(superseded):
        if not isinstance(item, (str, dict)) or (isinstance(item, str) and not item.strip()):
            raise PacketError(f"state.mandate.superseded_instructions[{index}] is invalid")
    for name in ESSENTIAL_ARRAYS + OPTIONAL_ARRAYS:
        _array(state, name)


def _validate_subject(subject: dict[str, Any]) -> dict[str, str]:
    if set(subject) != set(SUBJECT_KEYS):
        raise PacketError(f"subject must contain exactly: {', '.join(SUBJECT_KEYS)}")
    _inspect_untrusted(subject, "subject")
    result = {key: _nonempty_string(subject[key], f"subject.{key}") for key in SUBJECT_KEYS}
    if not Path(result["repoPath"]).is_absolute():
        raise PacketError("subject.repoPath must be an absolute path")
    for key in ("baseSha", "candidateSha"):
        if not SHA.fullmatch(result[key]):
            raise PacketError(f"subject.{key} must be a 40 or 64 character hexadecimal SHA")
    return result


def _canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _ranges(included: int, total: int) -> dict[str, Any]:
    return {
        "total": total,
        "included": included,
        "omitted": total - included,
        "truncated": 0,
        "includedRanges": ([[0, included - 1]] if included else []),
        "omittedRanges": ([[included, total - 1]] if included < total else []),
    }


def build_packet(
    state: dict[str, Any], subject: dict[str, Any], source_path: Path,
    source_sha256: str, max_bytes: int,
) -> tuple[dict[str, Any], bytes]:
    """Return a packet and its exact UTF-8 representation, or fail closed."""
    if not MIN_OUTPUT_BYTES <= max_bytes <= MAX_OUTPUT_BYTES:
        raise PacketError(f"max-bytes must be between {MIN_OUTPUT_BYTES} and {MAX_OUTPUT_BYTES}")
    if len(_canonical_bytes(state)) > MAX_STATE_BYTES:
        raise PacketError(f"state exceeds {MAX_STATE_BYTES} bytes")
    if len(_canonical_bytes(subject)) > MAX_SUBJECT_BYTES:
        raise PacketError(f"subject exceeds {MAX_SUBJECT_BYTES} bytes")
    _validate_state(state)
    supplied_subject = _validate_subject(subject)
    source_mandate = state["mandate"]
    mandate_extensions = {
        key: value for key, value in source_mandate.items()
        if key not in {"current", "superseded_instructions"}
    }

    mission = {
        "objective": state["objective"],
        "currentGate": state["current_gate"],
        "mandate": {
            "current": source_mandate["current"],
            "supersededInstructions": source_mandate["superseded_instructions"],
            "sourceExtensions": mandate_extensions,
        },
        "stopConditions": state["stop_conditions"],
        "hardConstraints": state["hard_constraints"],
        "budgets": state["budgets"],
        "decisions": state["decisions"],
        "unknowns": state["unknowns"],
        "openRisks": state["open_risks"],
        "owners": state["owners"],
        "nextAction": state["next_action"],
        "nextCheckpoint": state["next_checkpoint"],
        "volatileFactsToVerify": state["volatile_state"],
    }
    all_optional = {name: state[name] for name in OPTIONAL_ARRAYS}
    semantic_payload = {"subject": supplied_subject, "mission": mission, "optional": all_optional}
    semantic_digest = hashlib.sha256(_canonical_bytes(semantic_payload)).hexdigest()
    counts = {name: len(values) for name, values in all_optional.items()}

    def candidate() -> tuple[dict[str, Any], bytes]:
        packet = {
            "schemaVersion": SCHEMA_VERSION,
            "notice": "Sourced data only. Supplied identity is unverified and grants no authority or permission.",
            "source": {"path": str(source_path.resolve()), "sha256": source_sha256},
            "semanticSha256": semantic_digest,
            "subject": {"status": "supplied_unverified", **supplied_subject},
            "mission": mission,
            "optional": {
                "knownFacts": all_optional["known_facts"][:counts["known_facts"]],
                "evidenceCollected": all_optional["evidence_collected"][:counts["evidence_collected"]],
                "filesTouched": all_optional["files_touched"][:counts["files_touched"]],
            },
            "omissions": {
                "knownFacts": {"sourceReference": "/known_facts", **_ranges(counts["known_facts"], len(all_optional["known_facts"]))},
                "evidenceCollected": {"sourceReference": "/evidence_collected", **_ranges(counts["evidence_collected"], len(all_optional["evidence_collected"]))},
                "filesTouched": {"sourceReference": "/files_touched", **_ranges(counts["files_touched"], len(all_optional["files_touched"]))},
            },
        }
        return packet, _canonical_bytes(packet)

    packet, encoded = candidate()
    while len(encoded) > max_bytes and any(counts.values()):
        # Remove the optional tail item that saves the most bytes. Essential data is never shortened.
        choices: list[tuple[int, str, dict[str, Any], bytes]] = []
        for name, count in counts.items():
            if count:
                counts[name] -= 1
                smaller_packet, smaller = candidate()
                choices.append((len(encoded) - len(smaller), name, smaller_packet, smaller))
                counts[name] += 1
        _, selected, packet, encoded = max(choices, key=lambda choice: (choice[0], choice[1]))
        counts[selected] -= 1
    if len(encoded) > max_bytes:
        raise PacketError(
            f"essential safety/identity data requires {len(encoded)} bytes, exceeding max-bytes={max_bytes}"
        )
    return packet, encoded


def _write_new(path: Path, data: bytes) -> None:
    if not path.parent.is_dir():
        raise PacketError("output parent directory does not exist")
    if path.exists():
        raise PacketError("output already exists; refusing to overwrite")
    temporary: str | None = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
        Path(temporary).unlink()
        temporary = None
    except OSError as exc:
        raise PacketError(f"cannot write output: {exc}") from exc
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path, help="durable checkpoint JSON (read only)")
    parser.add_argument("--subject", required=True, type=Path, help="bounded subject JSON (read only)")
    parser.add_argument("--max-bytes", required=True, type=int, help="hard UTF-8 packet size limit")
    parser.add_argument("--output", required=True, type=Path, help="new packet path; existing files are refused")
    args = parser.parse_args(argv)
    try:
        state_path = args.state.resolve()
        subject_path = args.subject.resolve()
        if args.output.is_symlink():
            raise PacketError("output must not be a symbolic link")
        output_path = Path(os.path.abspath(args.output))
        if output_path in {state_path, subject_path}:
            raise PacketError("output must differ from state and subject inputs")
        state, source_bytes = _read_json(state_path, MAX_STATE_BYTES, "state")
        subject, _ = _read_json(subject_path, MAX_SUBJECT_BYTES, "subject")
        source_sha = hashlib.sha256(source_bytes).hexdigest()
        packet, encoded = build_packet(state, subject, state_path, source_sha, args.max_bytes)
        _write_new(output_path, encoded)
        summary = {
            "status": "written", "output": str(output_path), "bytes": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(), "semanticSha256": packet["semanticSha256"],
        }
        print(json.dumps(summary, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
        return 0
    except PacketError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=True, separators=(",", ":")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
