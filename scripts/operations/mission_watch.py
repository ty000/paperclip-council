"""Read-only bounded observer. Poll internally; emit once on a useful change."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from observation import bounded_event, digest, encoded, meaningful, project

MAX_INPUT = 4 * 1024 * 1024


def read_json(path: Path) -> dict:
    with path.open("rb") as handle:
        data = handle.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError("input exceeds 4 MiB")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("input must be a JSON object")
    return value


def write_private(path: Path, value: dict, *, replace: bool = False) -> None:
    if path.is_symlink():
        raise ValueError("refusing a symlink output")
    if not path.parent.is_dir():
        raise ValueError("output parent must already exist")
    if not replace:
        with path.open("xb") as handle:
            os.chmod(path, 0o600)
            handle.write(encoded(value) + b"\n")
        return
    fd, temporary = tempfile.mkstemp(prefix=".observation-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded(value) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def validate_urls(urls: list[str]) -> None:
    origins = set()
    for url in urls:
        p = urllib.parse.urlsplit(url)
        if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password or p.fragment:
            raise ValueError("URLs require HTTP(S), no userinfo or fragment")
        credential_fields = {"token", "access_token", "api_key", "apikey", "authorization", "password", "secret", "signature"}
        if any(key.lower() in credential_fields for key, _ in urllib.parse.parse_qsl(p.query)):
            raise ValueError("credentials must be supplied via the named environment variable")
        if p.scheme == "http" and p.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("remote API URLs require HTTPS")
        origins.add((p.scheme, p.hostname, p.port))
    if len(origins) != 1:
        raise ValueError("all explicit read endpoints must share one origin")


def fetch(url: str, key: str | None, timeout: float) -> dict:
    headers = {"Accept": "application/json"}
    if key:
        if "\r" in key or "\n" in key or len(key) > 8192:
            raise ValueError("invalid credential format")
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            data = response.read(MAX_INPUT + 1)
    except urllib.error.HTTPError as exc:
        raise ValueError(f"read endpoint returned HTTP {exc.code}") from None
    except (OSError, urllib.error.URLError, ValueError):
        raise ValueError("read endpoint unavailable") from None
    if len(data) > MAX_INPUT:
        raise ValueError("read endpoint exceeds 4 MiB")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("read endpoint must return an object")
    return value


def collect(args) -> dict:
    if args.snapshot:
        return read_json(args.snapshot)
    key = os.environ.get(args.api_key_env) if args.api_key_env else None
    if args.api_key_env and not key:
        raise ValueError("named API credential environment variable is empty")
    value = fetch(args.mission_url, key, args.request_timeout)
    value = dict(value) if "mission" in value else {"mission": value}
    if args.run_url:
        runs = [fetch(url, key, args.request_timeout) for url in args.run_url]
        value["runs"] = [run.get("run", run) for run in runs]
    if args.admission_url:
        value["admission"] = fetch(args.admission_url, key, args.request_timeout)
    return value


def observe(args, *, collector=collect, sleeper=time.sleep, clock=time.monotonic) -> tuple[dict, int]:
    source = {"missionId": args.mission_id, "snapshot": str(args.snapshot.resolve()) if args.snapshot else None,
              "urls": [args.mission_url, *args.run_url, args.admission_url]}
    source_hash = digest(source)
    previous = None
    if args.state.exists():
        saved = read_json(args.state)
        if saved.get("sourceHash") != source_hash:
            raise ValueError("observer state belongs to another explicit source")
        previous = saved.get("meaningful")
        if not isinstance(previous, dict):
            raise ValueError("observer state has no valid semantic checkpoint")
    started = clock()
    for poll in range(1, args.max_polls + 1):
        view = project(collector(args), args.mission_id)
        state = meaningful(view)
        changed = previous != state
        if changed or args.once:
            # Persist the complete allowlisted view, never credentials/logs from the raw response.
            content = {"sourceHash": source_hash, "observation": view}
            hash_ = digest(content)
            evidence_path = args.evidence_dir / f"observation-{hash_}.json"
            evidence = {"path": str(evidence_path.resolve()), "sha256": hashlib.sha256(encoded(content) + b"\n").hexdigest()}
            event = bounded_event(json.loads(encoded(view)), previous, evidence, args.max_output_bytes - 40)
            if not evidence_path.exists():
                write_private(evidence_path, content)
            elif evidence_path.is_symlink() or evidence_path.read_bytes() != encoded(content) + b"\n":
                raise ValueError("existing evidence does not match its content digest")
            write_private(args.state, {"sourceHash": source_hash, "meaningful": state, "evidence": evidence}, replace=True)
            if previous is not None or args.once or not args.wait_for_change:
                event["polls"] = poll
                return event, 0
            previous = state
        if clock() - started >= args.timeout_seconds or poll == args.max_polls:
            return {"event": "timeout", "missionId": args.mission_id, "changed": False, "polls": poll}, 3
        sleeper(min(args.interval, max(0, args.timeout_seconds - (clock() - started))))
    raise AssertionError("unreachable")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path, help="Explicit snapshot JSON, which a producer may atomically replace")
    source.add_argument("--mission-url", help="Explicit read-only mission inspection endpoint")
    p.add_argument("--mission-id", required=True)
    p.add_argument("--run-url", action="append", default=[], help="Explicit GET endpoint for one selected run; repeatable")
    p.add_argument("--admission-url")
    p.add_argument("--api-key-env", help="Name of environment variable; never the credential itself")
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--evidence-dir", type=Path, required=True)
    p.add_argument("--max-output-bytes", type=int, default=4096)
    p.add_argument("--interval", type=float, default=5)
    p.add_argument("--timeout-seconds", type=float, default=300)
    p.add_argument("--request-timeout", type=float, default=10)
    p.add_argument("--max-polls", type=int, default=120)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--wait-for-change", action="store_true", help="Record a silent baseline on first use")
    return p


def main() -> int:
    args = parser().parse_args()
    try:
        if not (0 < args.interval <= 3600 and 0 < args.timeout_seconds <= 3600 and 0 < args.request_timeout <= 60):
            raise ValueError("timeouts/intervals are outside supported bounds")
        if not (1 <= args.max_polls <= 10000 and 512 <= args.max_output_bytes <= 65536):
            raise ValueError("poll/output bounds are invalid")
        if not args.evidence_dir.is_dir() or args.evidence_dir.is_symlink():
            raise ValueError("evidence directory must exist and not be a symlink")
        if args.state.is_symlink() or (args.snapshot and args.state.resolve() == args.snapshot.resolve()):
            raise ValueError("state cannot overwrite the source or a symlink")
        if args.snapshot and (args.run_url or args.admission_url or args.api_key_env):
            raise ValueError("file snapshots cannot be combined with API options")
        if args.mission_url:
            if len(args.run_url) > 32:
                raise ValueError("at most 32 explicit run endpoints")
            validate_urls([x for x in [args.mission_url, *args.run_url, args.admission_url] if x])
        event, code = observe(args)
        print(encoded(event).decode())
        return code
    except (ValueError, OSError) as exc:
        # Raw response bodies, URLs and environment values never enter diagnostic output.
        print(encoded({"event": "error", "error": str(exc) if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError) else "input/output failure"}).decode())
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
