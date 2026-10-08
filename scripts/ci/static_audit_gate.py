#!/usr/bin/env python3
"""Local Fallow static audit gate wrapper.

This wrapper deliberately avoids installing or configuring Fallow. It only
resolves an already-available CLI, disables telemetry, runs a bounded static
command, and emits normalized JSON for Codex gates.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


WRAPPER_VERSION = "0.4.1"
PINNED_FALLOW_NPM_SPEC = "fallow@3.23.0"
PINNED_FALLOW_VERSION = "3.23.0"
MODES = {"bootstrap", "diff-gate", "repo-audit", "probe", "metrics", "metrics-delta"}
EXIT_PASS_OR_SKIPPED = 0
EXIT_GATE_FAIL = 1
EXIT_USAGE_OR_CONFIG = 2
EXIT_TOOL_UNINTERPRETABLE = 3

JS_TS_EXTENSIONS = {
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
}
JS_TS_INDICATORS = {
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "tsconfig.json",
    "jsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.ts",
}
FINDING_LIST_KEYS = {
    "issues",
    "findings",
    "diagnostics",
    "violations",
    "problems",
}
FALLOW_CHECK_FINDING_TYPES = {
    "unused_files",
    "unused_exports",
    "unused_types",
    "private_type_leaks",
    "unused_dependencies",
    "unused_dev_dependencies",
    "unused_optional_dependencies",
    "unused_enum_members",
    "unused_class_members",
    "unresolved_imports",
    "unlisted_dependencies",
    "duplicate_exports",
    "type_only_dependencies",
    "test_only_dependencies",
    "circular_dependencies",
    "re_export_cycles",
    "boundary_violations",
    "stale_suppressions",
    "unused_catalog_entries",
    "empty_catalog_groups",
    "unresolved_catalog_references",
    "unused_dependency_overrides",
    "misconfigured_dependency_overrides",
}
FALLOW_HEALTH_FINDING_TYPES = {
    "findings",
    "hotspots",
    "large_functions",
    "targets",
}
FALLOW_COMPLEXITY_FINDING_TYPES = {"findings"}
FALLOW_KNOWN_TOP_LEVEL_SECTIONS = {
    "_meta",
    "actions",
    "attribution",
    "base_ref",
    "changed_files_count",
    "check",
    "command",
    "complexity",
    "dead_code",
    "duplication",
    "dupes",
    "elapsed_ms",
    "geometry",
    "head_sha",
    "health",
    "health_score",
    "kind",
    "next_steps",
    "remediation",
    "remediations",
    "schema_version",
    "styling",
    "summary",
    "verdict",
    "version",
}
FALLOW_KNOWN_ATTRIBUTION_DOMAINS = {
    "check",
    "complexity",
    "dead_code",
    "duplication",
    "health",
    "styling",
}
REPO_AUDIT_TOP_LIMIT = 10
REPO_AUDIT_SAMPLE_LIMIT = 20
NEXT_ROUTE_METHOD_EXPORTS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
PATH_KEYS = (
    "path",
    "file",
    "filepath",
    "file_path",
    "filePath",
    "filename",
    "source_path",
    "sourcePath",
)
MESSAGE_KEYS = (
    "message",
    "detail",
    "description",
    "title",
    "reason",
    "summary",
    "recommendation",
)
RULE_KEYS = ("rule", "rule_id", "ruleId", "code", "kind", "type", "check")
SEVERITY_KEYS = ("severity", "level", "priority")
INTRODUCED_KEYS = ("introduced", "is_introduced", "isIntroduced", "new", "is_new", "isNew")
METRIC_PATHS = (
    "imports.unresolved_imports",
    "dependencies.unlisted",
    "dependencies.unused",
    "dependencies.unused_dev",
    "dependencies.unused_optional",
    "dependencies.override_issues",
    "dead_code.unused_files",
    "dead_code.unused_exports",
    "dead_code.unused_types",
    "dead_code.unused_enum_members",
    "dead_code.unused_class_members",
    "cycles.circular_dependencies",
    "cycles.re_export_cycles",
    "architecture.boundary_violations",
    "catalog.unused_entries",
    "catalog.empty_groups",
    "catalog.unresolved_references",
    "complexity.health_score",
    "complexity.targets",
    "complexity.hotspots",
    "complexity.large_functions",
    "complexity.critical_findings",
    "duplication.clone_groups",
    "duplication.duplicated_lines",
    "duplication.max_group_lines",
    "duplication.max_instance_count",
    "framework.suspected_false_positives",
    "audit.unclassified_count",
    "audit.nullquad_count",
    "audit.unavailable_sections_count",
)
DEFAULT_REGRESSION_METRICS = {
    "imports.unresolved_imports",
    "dependencies.unlisted",
    "dependencies.unused",
    "dependencies.unused_dev",
    "dependencies.unused_optional",
    "dead_code.unused_files",
    "dead_code.unused_exports",
    "dead_code.unused_types",
    "dead_code.unused_enum_members",
    "dead_code.unused_class_members",
    "cycles.circular_dependencies",
    "cycles.re_export_cycles",
    "architecture.boundary_violations",
    "complexity.health_score",
    "complexity.critical_findings",
    "duplication.clone_groups",
    "duplication.duplicated_lines",
    "audit.unclassified_count",
    "audit.nullquad_count",
}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # pragma: no cover - argparse glue
        payload = base_output(
            status="error",
            mode="diff-gate",
            repo=str(Path.cwd().resolve()),
            base_ref=None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": message, "error_kind": "usage"},
        )
        print_json(payload)
        raise SystemExit(EXIT_USAGE_OR_CONFIG)


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        description="Run a local Fallow static audit gate and emit normalized JSON."
    )
    parser.add_argument(
        "mode",
        nargs="?",
        default="diff-gate",
        choices=sorted(MODES),
        help="Gate mode (default: diff-gate).",
    )
    parser.add_argument(
        "--repo",
        default=".",
        help="Repository root to audit (default: current directory).",
    )
    parser.add_argument(
        "--bootstrap-root",
        help=(
            "Dedicated Fallow tool cache root. Audit modes read an existing binary there; "
            "only bootstrap mode installs into it."
        ),
    )
    parser.add_argument(
        "--fallow-package",
        default=PINNED_FALLOW_NPM_SPEC,
        help=f"Exact npm package spec for bootstrap mode (default: {PINNED_FALLOW_NPM_SPEC}).",
    )
    parser.add_argument(
        "--npm-bin",
        help="npm executable for explicit bootstrap mode (default: NPM_BIN or npm on PATH).",
    )
    parser.add_argument(
        "--base-ref",
        help="Base git ref for diff-gate. When omitted, Fallow auto-detects.",
    )
    parser.add_argument(
        "--input",
        help="Existing normalized static-code-audit JSON for metrics mode.",
    )
    parser.add_argument(
        "--baseline",
        help="Baseline normalized static-code-audit JSON for metrics-delta mode.",
    )
    parser.add_argument(
        "--current",
        help="Current normalized static-code-audit JSON for metrics-delta mode.",
    )
    parser.add_argument(
        "--threshold",
        action="append",
        default=[],
        metavar="METRIC=NUMBER",
        help=(
            "Per-metric allowed regression threshold for metrics-delta. "
            "May be repeated, for example --threshold duplication.duplicated_lines=25."
        ),
    )
    parser.add_argument(
        "--allow-missing-baseline",
        action="store_true",
        help=(
            "For metrics-delta only, emit controlled not-applicable/skipped when "
            "--baseline is absent instead of blocking."
        ),
    )
    parser.add_argument(
        "--not-applicable-reason",
        help="Reason recorded when --allow-missing-baseline controls a missing baseline.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=120,
        help="Maximum seconds for Fallow audit execution (default: 120).",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print normalized JSON.",
    )
    return parser


def policy_payload() -> dict[str, Any]:
    return {
        "phase": "integration-stable",
        "telemetry_disabled": True,
        "cloud_runtime_saas_disabled": True,
        "auto_fix_forbidden": True,
        "missing_fallow": "skipped",
        "pinned_fallow_npm_spec": PINNED_FALLOW_NPM_SPEC,
        "bootstrap": "explicit-only",
        "supported_install_strategies": [
            "repo devDependency with exact fallow@3.23.0 and lockfile",
            "dedicated Codex tool cache with exact fallow@3.23.0",
        ],
        "implicit_install_forbidden_modes": [
            "probe",
            "diff-gate",
            "repo-audit",
            "metrics",
            "metrics-delta",
        ],
        "diff_gate_blocks": [
            "introduced unresolved imports",
            "introduced unlisted dependencies",
            "introduced unused dependencies",
            "introduced unused exports or dead-code regressions",
            "introduced cycles or boundary violations",
            "critical complexity attributed to the current diff",
            "uninterpretable Fallow JSON after execution",
        ],
        "non_blocking": [
            "pre-existing debt outside the diff",
            "inherited findings on touched files unless Fallow marks them introduced",
            "unattributed findings on touched files when Fallow does not report a failing diff signal",
            "framework convention warnings and suspected framework entry-point false positives",
            "non-JS/TS repository",
            "missing Fallow during stable integration",
            "low-severity warnings",
            "probable false positives",
        ],
        "forbidden": [
            "license activate",
            "telemetry enable",
            "coverage upload-*",
            "--cloud",
            "fix --yes",
            "runtime or production coverage activation",
        ],
    }


def base_output(
    *,
    status: str,
    mode: str,
    repo: str,
    base_ref: str | None,
    command: list[str],
    tool_version: str | None,
    blocking_findings: list[dict[str, Any]],
    non_blocking_findings: list[dict[str, Any]],
    raw_summary: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": "static-code-audit-gate.v1",
        "wrapper_version": WRAPPER_VERSION,
        "status": status,
        "mode": mode,
        "tool": "fallow",
        "tool_version": tool_version,
        "command": command,
        "repo": repo,
        "base_ref": base_ref,
        "blocking_findings": blocking_findings,
        "non_blocking_findings": non_blocking_findings,
        "raw_summary": raw_summary,
        "policy": policy_payload(),
    }


def print_json(payload: dict[str, Any], pretty: bool = False) -> None:
    indent = 2 if pretty else None
    print(json.dumps(payload, indent=indent, sort_keys=pretty))


def tail_text(value: str | bytes | None, limit: int = 4000) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
    else:
        text = value
    if len(text) <= limit:
        return text
    return text[-limit:]


def exact_fallow_package_version(package_spec: str) -> str | None:
    match = re.fullmatch(r"fallow@([0-9]+\.[0-9]+\.[0-9]+)", package_spec.strip())
    return match.group(1) if match else None


def default_bootstrap_root() -> Path:
    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        return (
            Path(codex_home).expanduser()
            / "static-code-audit"
            / "fallow"
            / PINNED_FALLOW_VERSION
        )
    xdg_cache = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg_cache).expanduser() if xdg_cache else Path.home() / ".cache"
    return base / "codex" / "static-code-audit" / "fallow" / PINNED_FALLOW_VERSION


def bootstrap_root_from_arg(raw_path: str | None) -> Path:
    if raw_path and raw_path.strip():
        return Path(raw_path).expanduser().resolve(strict=False)
    env_path = os.environ.get("STATIC_CODE_AUDIT_FALLOW_ROOT")
    if env_path and env_path.strip():
        return Path(env_path).expanduser().resolve(strict=False)
    return default_bootstrap_root().resolve(strict=False)


def bootstrap_fallow_bin(root: Path) -> Path | None:
    for relative in (
        Path("node_modules") / ".bin" / "fallow",
        Path("node_modules") / ".bin" / "fallow.cmd",
        Path("node_modules") / "fallow" / "bin" / "fallow",
    ):
        candidate = root / relative
        if is_executable_file(candidate):
            return candidate.resolve(strict=False)
    return None


def resolve_repo(repo_arg: str) -> Path:
    repo = Path(repo_arg).expanduser().resolve()
    if not repo.is_dir():
        raise ValueError(f"repo is not a directory: {repo}")
    return repo


def normalize_base_ref(value: str | None) -> str:
    if value is None or not value.strip():
        return "auto"
    return value.strip()


def is_executable_file(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def resolve_fallow_binary(repo: Path, bootstrap_root: Path) -> tuple[str | None, str]:
    env_bin = os.environ.get("FALLOW_BIN")
    if env_bin:
        env_path = Path(env_bin).expanduser()
        if env_path.is_absolute() or env_path.parent != Path("."):
            resolved = env_path.resolve(strict=False)
            if is_executable_file(resolved):
                return str(resolved), "FALLOW_BIN"
            return None, "FALLOW_BIN set but not executable"
        found = shutil.which(env_bin)
        if found:
            return found, "FALLOW_BIN"
        return None, "FALLOW_BIN set but not found on PATH"

    local_bin = repo / "node_modules" / ".bin" / "fallow"
    if is_executable_file(local_bin):
        return str(local_bin), "repo node_modules"

    local_cmd = repo / "node_modules" / ".bin" / "fallow.cmd"
    if is_executable_file(local_cmd):
        return str(local_cmd), "repo node_modules"

    bootstrap_bin = bootstrap_fallow_bin(bootstrap_root)
    if bootstrap_bin is not None:
        return str(bootstrap_bin), f"bootstrap cache {bootstrap_root}"

    found = shutil.which("fallow")
    if found:
        return found, "PATH"

    return None, f"not found; bootstrap cache missing at {bootstrap_root}"


def safe_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in list(env):
        upper = key.upper()
        if upper.startswith("FALLOW_CLOUD"):
            env.pop(key, None)
        elif upper.startswith("FALLOW_RUNTIME"):
            env.pop(key, None)
        elif upper.startswith("FALLOW_PRODUCTION"):
            env.pop(key, None)
        elif upper in {
            "FALLOW_COVERAGE",
            "FALLOW_COVERAGE_ROOT",
            "FALLOW_COMMENT",
            "FALLOW_REVIEW",
            "FALLOW_UPLOAD",
            "FALLOW_TELEMETRY",
        }:
            env.pop(key, None)
    env["FALLOW_TELEMETRY_DISABLED"] = "1"
    env["DO_NOT_TRACK"] = "1"
    return env


def safe_npm_env() -> dict[str, str]:
    env = safe_env()
    env["npm_config_audit"] = "false"
    env["npm_config_fund"] = "false"
    return env


def policy_violation(tokens: list[str]) -> str | None:
    lowered = [token.lower() for token in tokens]
    joined = " ".join(lowered)
    if "--cloud" in lowered or any(token.startswith("--cloud=") for token in lowered):
        return "--cloud is forbidden"
    if "license activate" in joined:
        return "license activate is forbidden"
    if "telemetry enable" in joined:
        return "telemetry enable is forbidden"
    if "fix" in lowered and "--yes" in lowered:
        return "fallow fix --yes is forbidden"
    for index, token in enumerate(lowered[:-1]):
        if token == "coverage" and lowered[index + 1].startswith("upload-"):
            return "coverage upload-* is forbidden"
    forbidden_runtime_flags = {
        "--runtime-coverage",
        "--production",
        "--production-health",
        "--production-dead-code",
        "--production-dupes",
    }
    for token in lowered:
        flag = token.split("=", 1)[0]
        if flag in forbidden_runtime_flags:
            return f"{flag} is forbidden by static-only policy"
    return None


def command_for_mode(fallow_bin: str, mode: str, base_ref: str | None) -> list[str]:
    if mode == "diff-gate":
        command = [fallow_bin, "audit"]
        if base_ref and base_ref.strip():
            command.extend(["--base", base_ref.strip()])
        command.extend(["--format", "json", "--quiet"])
        return command
    if mode == "repo-audit":
        return [fallow_bin, "--format", "json", "--quiet"]
    return [fallow_bin, "--version"]


def get_tool_version(fallow_bin: str, repo: Path) -> str | None:
    command = [fallow_bin, "--version"]
    if policy_violation(command):
        return None
    try:
        proc = subprocess.run(
            command,
            cwd=str(repo),
            env=safe_env(),
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    lines = proc.stdout.strip().splitlines()
    candidate = lines[0] if lines else ""
    return candidate if re.fullmatch(r"(?:fallow\s+)?[0-9]+\.[0-9]+\.[0-9]+", candidate) else None


def tool_version_is_pinned(version: str | None) -> bool:
    return version is not None and version.split()[-1] == PINNED_FALLOW_VERSION


def repo_has_js_ts_indicators(repo: Path) -> bool:
    for indicator in JS_TS_INDICATORS:
        if (repo / indicator).exists():
            return True
    checked = 0
    for path in repo.rglob("*"):
        if ".git" in path.parts or "node_modules" in path.parts:
            continue
        if path.is_file():
            checked += 1
            if path.suffix in JS_TS_EXTENSIONS:
                return True
        if checked >= 1000:
            break
    return False


def run_git(repo: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(repo),
        text=True,
        capture_output=True,
        check=False,
    )


def changed_files(repo: Path, base_ref: str | None) -> list[str]:
    candidates: list[str] = []
    if base_ref and base_ref.strip():
        candidates.append(base_ref.strip())
    else:
        candidates.extend(["origin/main", "main", "master"])

    changed: set[str] = set()
    for candidate in candidates:
        proc = run_git(repo, ["diff", "--name-only", f"{candidate}...HEAD"])
        if proc.returncode == 0:
            changed.update(line.strip() for line in proc.stdout.splitlines() if line.strip())
            break

    for args in (
        ["diff", "--name-only"],
        ["diff", "--name-only", "--cached"],
        ["ls-files", "--others", "--exclude-standard"],
    ):
        proc = run_git(repo, args)
        if proc.returncode == 0:
            changed.update(line.strip() for line in proc.stdout.splitlines() if line.strip())

    return sorted(changed)


def parse_json_output(stdout: str, stderr: str) -> tuple[Any | None, str | None]:
    for stream_name, raw in (("stdout", stdout), ("stderr", stderr)):
        text = raw.strip()
        if not text:
            continue
        try:
            return json.loads(text), stream_name
        except json.JSONDecodeError:
            continue
    return None, None


def value_from_keys(item: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in item:
            return item[key]
    return None


def extract_path(item: dict[str, Any]) -> str | None:
    value = value_from_keys(item, PATH_KEYS)
    if isinstance(value, str) and value.strip():
        return clean_path(value)
    location = item.get("location")
    if isinstance(location, dict):
        value = value_from_keys(location, PATH_KEYS)
        if isinstance(value, str) and value.strip():
            return clean_path(value)
    locations = item.get("locations")
    if isinstance(locations, list):
        for raw_location in locations:
            if isinstance(raw_location, dict):
                value = value_from_keys(raw_location, PATH_KEYS)
                if isinstance(value, str) and value.strip():
                    return clean_path(value)
    return None


def clean_path(value: str) -> str:
    cleaned = value.strip()
    if ":" in cleaned and not Path(cleaned).is_absolute():
        before_colon = cleaned.split(":", 1)[0]
        if before_colon:
            cleaned = before_colon
    return cleaned.replace("\\", "/")


def extract_line(item: dict[str, Any]) -> int | None:
    for key in ("line", "start_line", "startLine", "lineNumber"):
        value = item.get(key)
        if isinstance(value, int):
            return value
    location = item.get("location")
    if isinstance(location, dict):
        return extract_line(location)
    return None


def extract_bool(item: dict[str, Any], keys: tuple[str, ...]) -> bool | None:
    value = value_from_keys(item, keys)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1", "new", "introduced"}:
            return True
        if lowered in {"false", "no", "0", "inherited", "existing"}:
            return False
    return None


def finding_type_to_rule(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().replace("_", "-")
    return cleaned or None


def extract_symbol(item: dict[str, Any]) -> str | None:
    for key in (
        "export_name",
        "member_name",
        "name",
        "specifier",
        "package_name",
        "dependency",
        "package",
        "import",
        "target",
    ):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def message_from_finding(
    item: dict[str, Any],
    *,
    rule: str | None,
    finding_type: str | None,
) -> str | None:
    message = value_from_keys(item, MESSAGE_KEYS)
    if message is not None:
        return str(message).strip()

    symbol = extract_symbol(item)
    path = extract_path(item)
    if rule == "unused-exports" and symbol:
        return f"Unused export {symbol}"
    if rule == "unused-types" and symbol:
        return f"Unused type {symbol}"
    if rule == "unused-class-members" and symbol:
        parent = item.get("parent_name")
        if isinstance(parent, str) and parent.strip():
            return f"Unused class member {parent.strip()}.{symbol}"
        return f"Unused class member {symbol}"
    if rule == "unused-files" and path:
        return f"Unused file {path}"
    if rule == "duplicate-exports":
        return f"Duplicate export group for {symbol}" if symbol else "Duplicate export group"
    if rule == "large-functions" and symbol:
        line_count = item.get("line_count")
        if isinstance(line_count, int):
            return f"Large function {symbol} spans {line_count} lines"
        return f"Large function {symbol}"
    if rule == "targets":
        category = item.get("category")
        if isinstance(category, str) and category.strip():
            return f"Health target: {category.strip()}"
    if symbol:
        readable = (rule or finding_type or "finding").replace("_", "-")
        return f"{readable}: {symbol}"
    return None


def normalize_finding(
    item: dict[str, Any],
    *,
    source_section: str | None,
    finding_type: str | None,
) -> dict[str, Any]:
    message = value_from_keys(item, MESSAGE_KEYS)
    rule = value_from_keys(item, RULE_KEYS)
    severity = value_from_keys(item, SEVERITY_KEYS)
    category = item.get("category") or item.get("analysis") or item.get("domain")
    introduced = extract_bool(item, INTRODUCED_KEYS)
    path = extract_path(item)
    rule_text = str(rule).strip() if rule is not None else finding_type_to_rule(finding_type)
    normalized = {
        "source_section": source_section,
        "finding_type": finding_type,
        "rule": rule_text,
        "category": str(category).strip() if category is not None else source_section,
        "severity": str(severity).strip() if severity is not None else None,
        "message": str(message).strip() if message is not None else None,
        "path": path,
        "line": extract_line(item),
        "introduced": introduced,
    }
    normalized["message"] = normalized["message"] or message_from_finding(
        item,
        rule=rule_text,
        finding_type=finding_type,
    )
    symbol = extract_symbol(item)
    if symbol:
        normalized["symbol"] = symbol
    package_name = item.get("package_name")
    if isinstance(package_name, str) and package_name.strip():
        normalized["package_name"] = package_name.strip()
    return normalized


def looks_like_finding(item: dict[str, Any]) -> bool:
    keys = set(item)
    interesting = set(PATH_KEYS) | set(MESSAGE_KEYS) | set(RULE_KEYS) | set(SEVERITY_KEYS)
    if keys & interesting:
        return True
    location = item.get("location")
    return isinstance(location, dict) and bool(set(location) & set(PATH_KEYS))


def collect_legacy_raw_findings(value: Any) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FINDING_LIST_KEYS and isinstance(child, list):
                for entry in child:
                    if isinstance(entry, dict) and looks_like_finding(entry):
                        collected.append(entry)
            elif isinstance(child, (dict, list)):
                collected.extend(collect_legacy_raw_findings(child))
    elif isinstance(value, list):
        for entry in value:
            if isinstance(entry, dict):
                if looks_like_finding(entry):
                    collected.append(entry)
                else:
                    collected.extend(collect_legacy_raw_findings(entry))
            elif isinstance(entry, list):
                collected.extend(collect_legacy_raw_findings(entry))
    return collected


def is_fallow_combined_payload(value: Any) -> bool:
    return isinstance(value, dict) and any(
        isinstance(value.get(key), dict)
        for key in ("check", "dead_code", "dupes", "health", "complexity")
    )


def collect_fallow_section_records(
    section_payload: Any,
    *,
    source_section: str,
    finding_types: set[str],
) -> list[tuple[dict[str, Any], str, str]]:
    if not isinstance(section_payload, dict):
        return []

    records: list[tuple[dict[str, Any], str, str]] = []
    for finding_type in sorted(finding_types):
        entries = section_payload.get(finding_type)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            is_duplicate_export_group = (
                source_section == "check" and finding_type == "duplicate_exports"
            )
            if looks_like_finding(entry) or is_duplicate_export_group:
                records.append((entry, source_section, finding_type))
            if is_duplicate_export_group:
                locations = entry.get("locations")
                if not isinstance(locations, list):
                    continue
                for location in locations:
                    if not isinstance(location, dict) or not looks_like_finding(location):
                        continue
                    location_finding = dict(location)
                    if "export_name" not in location_finding and entry.get("export_name") is not None:
                        location_finding["export_name"] = entry.get("export_name")
                    records.append((location_finding, source_section, "duplicate_export_locations"))
    return records


def collect_fallow_finding_records(value: dict[str, Any]) -> list[tuple[dict[str, Any], str, str]]:
    records: list[tuple[dict[str, Any], str, str]] = []
    records.extend(
        collect_fallow_section_records(
            value.get("check"),
            source_section="check",
            finding_types=FALLOW_CHECK_FINDING_TYPES,
        )
    )
    records.extend(
        collect_fallow_section_records(
            value.get("dead_code"),
            source_section="dead_code",
            finding_types=FALLOW_CHECK_FINDING_TYPES,
        )
    )
    records.extend(
        collect_fallow_section_records(
            value.get("health"),
            source_section="health",
            finding_types=FALLOW_HEALTH_FINDING_TYPES,
        )
    )
    records.extend(
        collect_fallow_section_records(
            value.get("complexity"),
            source_section="complexity",
            finding_types=FALLOW_COMPLEXITY_FINDING_TYPES,
        )
    )
    return records


def collect_generic_finding_records(
    value: Any,
    *,
    source_section: str | None = None,
) -> list[tuple[dict[str, Any], str, str]]:
    records: list[tuple[dict[str, Any], str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FINDING_LIST_KEYS and isinstance(child, list):
                section = source_section or "root"
                for entry in child:
                    if isinstance(entry, dict) and looks_like_finding(entry):
                        records.append((entry, section, key))
                continue
            if isinstance(child, (dict, list)):
                child_section = source_section or key
                records.extend(collect_generic_finding_records(child, source_section=child_section))
    elif isinstance(value, list):
        for entry in value:
            records.extend(collect_generic_finding_records(entry, source_section=source_section))
    return records


def collect_raw_finding_records(value: Any) -> list[tuple[dict[str, Any], str, str]]:
    if is_fallow_combined_payload(value):
        records = collect_fallow_finding_records(value)
        if records:
            return records
    return collect_generic_finding_records(value)


def collect_unknown_fallow_finding_records(
    value: Any,
) -> list[tuple[dict[str, Any], str, str]]:
    if not is_fallow_combined_payload(value):
        return []

    records: list[tuple[dict[str, Any], str, str]] = []
    for section, child in value.items():
        if section in FALLOW_KNOWN_TOP_LEVEL_SECTIONS:
            continue
        records.extend(collect_generic_finding_records({section: child}))
    return records


def unknown_introduced_attribution_count(value: Any) -> int:
    if not isinstance(value, dict):
        return 0
    attribution = value.get("attribution")
    if not isinstance(attribution, dict):
        return 0

    count = 0
    suffix = "_introduced"
    for key, raw_count in attribution.items():
        if not key.endswith(suffix) or isinstance(raw_count, bool) or not isinstance(raw_count, int):
            continue
        domain = key[: -len(suffix)]
        if domain not in FALLOW_KNOWN_ATTRIBUTION_DOMAINS and raw_count > 0:
            count += raw_count
    return count


def finding_text(finding: dict[str, Any]) -> str:
    return json.dumps(finding, sort_keys=True, default=str).lower()


def finding_classification_text(finding: dict[str, Any]) -> str:
    """Return semantic finding fields without location-only false matches."""
    semantic = {
        key: finding.get(key)
        for key in (
            "source_section",
            "finding_type",
            "rule",
            "category",
            "severity",
            "message",
        )
    }
    return json.dumps(semantic, sort_keys=True, default=str).lower()


def severity_is_critical(finding: dict[str, Any]) -> bool:
    severity = str(finding.get("severity") or "").lower()
    message = str(finding.get("message") or "").lower()
    return severity in {"critical", "error", "high", "blocker"} or "critical" in message


def is_blocking_category(finding: dict[str, Any]) -> bool:
    text = finding_classification_text(finding)
    if "unresolved" in text and "import" in text:
        return True
    if "missing" in text and "import" in text:
        return True
    if "unlisted" in text and ("dep" in text or "dependency" in text):
        return True
    if "unused" in text and ("dep" in text or "dependency" in text):
        return True
    if "unused" in text and (
        "export" in text
        or "dead-code" in text
        or "unused-files" in text
        or "unused-types" in text
        or "unused-class-members" in text
    ):
        return True
    if "cycle" in text or "circular" in text:
        return True
    if "boundary" in text or "architecture" in text or "layer violation" in text:
        return True
    if ("complexity" in text or "crap" in text) and severity_is_critical(finding):
        return True
    return False


def is_next_route_handler_path(path: str | None) -> bool:
    normalized = (path or "").replace("\\", "/").lstrip("./")
    return normalized.startswith("src/app/") and normalized.endswith("/route.ts")


def is_suspected_framework_false_positive(finding: dict[str, Any]) -> bool:
    if not is_next_route_handler_path(finding.get("path")):
        return False
    text = finding_text(finding)
    if "unused" not in text or "export" not in text:
        return False
    symbol = finding.get("symbol")
    if isinstance(symbol, str) and symbol.upper() in NEXT_ROUTE_METHOD_EXPORTS:
        return True
    return any(f'"{method.lower()}"' in text or f" {method.lower()} " in text for method in NEXT_ROUTE_METHOD_EXPORTS)


def mark_probable_false_positive(finding: dict[str, Any], reason: str) -> dict[str, Any]:
    marked = dict(finding)
    marked["probable_false_positive"] = True
    marked["non_blocking_reason"] = reason
    return marked


def is_dependency_finding(finding: dict[str, Any]) -> bool:
    text = f"{finding.get('finding_type') or ''} {finding.get('rule') or ''}".lower()
    return "dependenc" in text or "dependencies" in text


def is_manifest_path(path: str | None) -> bool:
    normalized = (path or "").replace("\\", "/").lstrip("./")
    return normalized.endswith("package.json")


def package_name_for_finding(finding: dict[str, Any]) -> str | None:
    for key in ("package_name", "symbol"):
        value = finding.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def path_has_skipped_usage_part(path: Path) -> bool:
    skipped = {
        ".git",
        ".next",
        ".turbo",
        "build",
        "coverage",
        "dist",
        "node_modules",
    }
    return any(part in skipped for part in path.parts)


def js_module_tokens(text: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    index = 0
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if char.isspace():
            index += 1
            continue
        if char == "/" and next_char == "/":
            index += 2
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        if char == "/" and next_char == "*":
            index += 2
            while index + 1 < len(text) and not (text[index] == "*" and text[index + 1] == "/"):
                index += 1
            index = min(index + 2, len(text))
            continue
        if char in {"'", '"', "`"}:
            quote = char
            index += 1
            value: list[str] = []
            escaped = False
            while index < len(text):
                current = text[index]
                if escaped:
                    value.append(current)
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == quote:
                    index += 1
                    break
                else:
                    value.append(current)
                index += 1
            tokens.append(("string", "".join(value)))
            continue
        if char.isalpha() or char in {"_", "$"}:
            start = index
            index += 1
            while index < len(text) and (text[index].isalnum() or text[index] in {"_", "$"}):
                index += 1
            tokens.append(("ident", text[start:index]))
            continue
        tokens.append((char, char))
        index += 1
    return tokens


def module_spec_matches_package(specifier: str, package_name: str) -> bool:
    return specifier == package_name or specifier.startswith(f"{package_name}/")


def string_token_matches_package(
    tokens: list[tuple[str, str]],
    index: int,
    package_name: str,
) -> bool:
    return (
        index < len(tokens)
        and tokens[index][0] == "string"
        and module_spec_matches_package(tokens[index][1], package_name)
    )


def source_imports_package(text: str, package_name: str) -> bool:
    tokens = js_module_tokens(text)
    for index, (kind, value) in enumerate(tokens):
        if kind != "ident":
            continue
        if value == "require":
            if index + 2 < len(tokens) and tokens[index + 1][1] == "(":
                if string_token_matches_package(tokens, index + 2, package_name):
                    return True
        elif value == "import":
            if index + 2 < len(tokens) and tokens[index + 1][1] == "(":
                if string_token_matches_package(tokens, index + 2, package_name):
                    return True
            if string_token_matches_package(tokens, index + 1, package_name):
                return True
            scan = index + 1
            while scan < len(tokens) and tokens[scan][1] != ";":
                if tokens[scan] == ("ident", "from"):
                    if string_token_matches_package(tokens, scan + 1, package_name):
                        return True
                    break
                scan += 1
        elif value == "export":
            scan = index + 1
            while scan < len(tokens) and tokens[scan][1] != ";":
                if tokens[scan] == ("ident", "from"):
                    if string_token_matches_package(tokens, scan + 1, package_name):
                        return True
                    break
                scan += 1
    return False


def package_source_uses_dependency(
    repo: Path,
    *,
    manifest_path: str,
    package_name: str,
    changed: set[str],
) -> str | None:
    manifest = repo / clean_path(manifest_path)
    package_root = manifest.parent if manifest.name == "package.json" else repo
    if not package_root.is_dir():
        return None

    for path in package_root.rglob("*"):
        if not path.is_file() or path_has_skipped_usage_part(path):
            continue
        if path.suffix not in JS_TS_EXTENSIONS:
            continue
        rel = path.relative_to(repo).as_posix()
        if rel in changed:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if source_imports_package(text, package_name):
            return rel
    return None


def suspected_dependency_false_positive_usage(
    finding: dict[str, Any],
    *,
    repo: Path,
    changed: set[str],
) -> str | None:
    path = finding.get("path")
    if not isinstance(path, str) or not is_manifest_path(path):
        return None
    if clean_path(path) in changed:
        return None
    if not is_dependency_finding(finding):
        return None
    package_name = package_name_for_finding(finding)
    if not package_name:
        return None
    return package_source_uses_dependency(
        repo,
        manifest_path=path,
        package_name=package_name,
        changed=changed,
    )


def nullquad_count(findings: list[dict[str, Any]]) -> int:
    keys = ("source_section", "finding_type", "rule", "path")
    return sum(1 for finding in findings if all(finding.get(key) is None for key in keys))


def counter_payload(findings: list[dict[str, Any]], key: str) -> dict[str, int]:
    counter = Counter(
        str(finding.get(key))
        for finding in findings
        if finding.get(key) is not None and str(finding.get(key)).strip()
    )
    return dict(sorted(counter.items()))


def classification_payload(
    normalized: list[dict[str, Any]],
    *,
    legacy_candidate_count: int,
) -> dict[str, Any]:
    return {
        "finding_count": len(normalized),
        "legacy_candidate_count": legacy_candidate_count,
        "unclassified_count": max(legacy_candidate_count - len(normalized), 0),
        "nullquad_count": nullquad_count(normalized),
        "source_section_counts": counter_payload(normalized, "source_section"),
        "finding_type_counts": counter_payload(normalized, "finding_type"),
        "rule_counts": counter_payload(normalized, "rule"),
    }


def get_nested(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def count_list(value: Any) -> int | None:
    return len(value) if isinstance(value, list) else None


def as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def as_float(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def sample_paths(paths: list[str]) -> list[str]:
    return paths[:REPO_AUDIT_SAMPLE_LIMIT]


def repo_matches(repo: Path, pattern: str) -> list[str]:
    matches: list[str] = []
    for path in repo.glob(pattern):
        if ".git" in path.parts or "node_modules" in path.parts:
            continue
        if path.is_file():
            matches.append(path.relative_to(repo).as_posix())
    return sorted(matches)


def detect_framework_conventions(repo: Path) -> dict[str, dict[str, Any]]:
    specs = {
        "next_app_route_handlers": "src/app/**/route.ts",
        "next_app_pages": "src/app/**/page.tsx",
        "next_pages_router": "src/pages/**",
        "vite_config": "vite.config.*",
        "vitest_config": "vitest.config.*",
        "supabase": "supabase/**",
    }
    detected: dict[str, dict[str, Any]] = {}
    for name, pattern in specs.items():
        matches = repo_matches(repo, pattern)
        if matches:
            detected[name] = {
                "pattern": pattern,
                "count": len(matches),
                "sample_paths": sample_paths(matches),
            }
    return detected


def normalize_plugin_entries(raw: Any) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and item.strip():
                entries.append({"name": item.strip()})
            elif isinstance(item, dict):
                name = item.get("name") or item.get("id") or item.get("plugin") or item.get("framework")
                entry: dict[str, Any] = {}
                if name is not None:
                    entry["name"] = str(name).strip()
                for key in ("version", "kind", "enabled", "detected", "source"):
                    if key in item and isinstance(item[key], (str, int, float, bool)):
                        entry[key] = item[key]
                if entry:
                    entries.append(entry)
    elif isinstance(raw, dict):
        for key, value in raw.items():
            entry: dict[str, Any] = {"name": str(key)}
            if isinstance(value, dict):
                for child_key in ("version", "kind", "enabled", "detected", "source"):
                    if child_key in value and isinstance(value[child_key], (str, int, float, bool)):
                        entry[child_key] = value[child_key]
            elif isinstance(value, (str, int, float, bool)):
                entry["value"] = value
            entries.append(entry)
    return entries


def collect_fallow_detected_plugins(value: Any) -> list[dict[str, Any]]:
    plugin_keys = {
        "detected_plugins",
        "detectedPlugins",
        "enabled_plugins",
        "enabledPlugins",
        "framework_plugins",
        "frameworkPlugins",
        "plugins",
    }
    collected: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                if key in plugin_keys:
                    for entry in normalize_plugin_entries(child):
                        fingerprint = json.dumps(entry, sort_keys=True, default=str)
                        if fingerprint not in seen:
                            seen.add(fingerprint)
                            collected.append(entry)
                elif isinstance(child, (dict, list)):
                    visit(child)
        elif isinstance(node, list):
            for child in node:
                if isinstance(child, (dict, list)):
                    visit(child)

    visit(value)
    return collected[:REPO_AUDIT_SAMPLE_LIMIT]


def fallow_detected_next(detected_plugins: list[dict[str, Any]]) -> bool:
    text = json.dumps(detected_plugins, sort_keys=True, default=str).lower()
    return "next" in text or "next.js" in text or "nextjs" in text


def framework_convention_warnings(
    conventions: dict[str, dict[str, Any]],
    detected_plugins: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    route_handlers = conventions.get("next_app_route_handlers")
    if route_handlers and not fallow_detected_next(detected_plugins):
        sample = route_handlers.get("sample_paths") or []
        warnings.append(
            {
                "rule": "next-route-handlers-unmodeled-by-fallow",
                "category": "framework-convention",
                "severity": "warning",
                "message": (
                    "Next-like route handlers are present, but Fallow did not expose "
                    "Next detection; GET/POST route exports may be false positives."
                ),
                "path": sample[0] if sample else None,
                "line": None,
                "introduced": None,
                "count": route_handlers.get("count"),
                "sample_paths": sample,
                "non_blocking": True,
            }
        )
    return warnings


def local_convention_entries(conventions: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "source": "local-convention",
            "pattern": details["pattern"],
            "count": details["count"],
            "sample_paths": details["sample_paths"],
        }
        for name, details in sorted(conventions.items())
    ]


def normalized_payload_findings(payload: Any) -> list[dict[str, Any]]:
    return [
        normalize_finding(item, source_section=source_section, finding_type=finding_type)
        for item, source_section, finding_type in collect_raw_finding_records(payload)
    ]


def dead_code_sort_key(finding: dict[str, Any]) -> tuple[int, str, int]:
    priority_by_rule = {
        "unused-files": 0,
        "unused-exports": 1,
        "unused-types": 2,
        "unused-class-members": 3,
        "duplicate-exports": 4,
        "unused-dependencies": 5,
        "unused-dev-dependencies": 6,
    }
    rule = str(finding.get("rule") or "")
    path = str(finding.get("path") or "")
    line = finding.get("line")
    return (priority_by_rule.get(rule, 99), path, line if isinstance(line, int) else 0)


def top_dead_code_findings(normalized: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings = [
        item
        for item in normalized
        if not is_suspected_framework_false_positive(item)
        and (
            str(item.get("rule") or "").startswith("unused-")
            or str(item.get("category") or "") == "dead-code"
        )
    ]
    return sorted(findings, key=dead_code_sort_key)[:REPO_AUDIT_TOP_LIMIT]


def complexity_priority(item: dict[str, Any]) -> float:
    for key in ("priority", "score", "crap", "cognitive", "cyclomatic", "line_count"):
        value = as_float(item.get(key))
        if value is not None:
            return value
    evidence = item.get("evidence")
    if isinstance(evidence, dict):
        functions = evidence.get("complex_functions")
        if isinstance(functions, list):
            return float(len(functions))
    return 0.0


def top_complexity_findings(payload: Any) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for finding_type in ("targets", "findings", "hotspots", "large_functions"):
        value = get_nested(payload, ("health", finding_type))
        if not isinstance(value, list):
            continue
        for item in value:
            if not isinstance(item, dict):
                continue
            normalized = normalize_finding(
                item,
                source_section="health",
                finding_type=finding_type,
            )
            priority = complexity_priority(item)
            if priority:
                normalized["priority"] = priority
            candidates.append(normalized)
    return sorted(candidates, key=lambda item: float(item.get("priority") or 0), reverse=True)[
        :REPO_AUDIT_TOP_LIMIT
    ]


def clone_group_lines(group: dict[str, Any]) -> int:
    line_count = group.get("line_count")
    if isinstance(line_count, int):
        return line_count
    instances = group.get("instances")
    if not isinstance(instances, list):
        return 0
    spans: list[int] = []
    for item in instances:
        if not isinstance(item, dict):
            continue
        start = item.get("start_line")
        end = item.get("end_line")
        if isinstance(start, int) and isinstance(end, int) and end >= start:
            spans.append(end - start + 1)
    return max(spans) if spans else 0


def top_duplication_findings(payload: Any) -> list[dict[str, Any]]:
    groups = get_nested(payload, ("dupes", "clone_groups"))
    if not isinstance(groups, list):
        return []
    findings: list[dict[str, Any]] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        instances = group.get("instances")
        files: list[str] = []
        if isinstance(instances, list):
            for instance in instances:
                if isinstance(instance, dict):
                    file_value = instance.get("file") or instance.get("path")
                    if isinstance(file_value, str):
                        files.append(clean_path(file_value))
        lines = clone_group_lines(group)
        findings.append(
            {
                "source_section": "dupes",
                "finding_type": "clone_groups",
                "rule": "code-duplication",
                "category": "duplication",
                "severity": None,
                "message": f"Duplicated code group: {lines} lines across {len(files)} instances",
                "path": files[0] if files else None,
                "line": None,
                "introduced": None,
                "fingerprint": group.get("fingerprint"),
                "duplicated_lines": lines,
                "instance_count": len(files),
                "sample_paths": sample_paths(sorted(set(files))),
            }
        )
    return sorted(findings, key=lambda item: int(item.get("duplicated_lines") or 0), reverse=True)[
        :REPO_AUDIT_TOP_LIMIT
    ]


def suspected_false_positives(normalized: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings = []
    for finding in normalized:
        if is_suspected_framework_false_positive(finding):
            findings.append(
                mark_probable_false_positive(
                    finding,
                    "Next-like route handler exports are framework entry points.",
                )
            )
    return findings[:REPO_AUDIT_TOP_LIMIT]


def compact_repo_non_blocking_findings(normalized: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    compact.extend(suspected_false_positives(normalized))
    compact.extend(top_dead_code_findings(normalized))
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for finding in compact:
        fingerprint = json.dumps(
            {
                "rule": finding.get("rule"),
                "path": finding.get("path"),
                "line": finding.get("line"),
                "symbol": finding.get("symbol"),
                "message": finding.get("message"),
            },
            sort_keys=True,
            default=str,
        )
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        deduped.append(finding)
    return deduped[:REPO_AUDIT_TOP_LIMIT]


def build_repo_audit_report(payload: Any, repo: Path, proc: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    normalized = normalized_payload_findings(payload)
    detected_plugins = collect_fallow_detected_plugins(payload)
    conventions = detect_framework_conventions(repo)
    unavailable_sections: list[str] = []
    for section in (
        ("check", "summary"),
        ("check", "issues"),
        ("dupes", "stats"),
        ("dupes", "clone_groups"),
        ("health", "summary"),
        ("health", "targets"),
        ("health_score",),
    ):
        if get_nested(payload, section) is None:
            unavailable_sections.append(".".join(section))

    check_summary = get_nested(payload, ("check", "summary"))
    dupes_stats = get_nested(payload, ("dupes", "stats"))
    health_summary = get_nested(payload, ("health", "summary"))
    health_score = get_nested(payload, ("health_score",))
    summary: dict[str, Any] = {
        "fallow_exit_code": proc.returncode,
        "fallow_schema_version": payload.get("schema_version") if isinstance(payload, dict) else None,
        "fallow_version": payload.get("version") if isinstance(payload, dict) else None,
        "repo_audit_blocking": False,
        "normalized_finding_count": len(normalized),
        "check_total_issues": as_int(get_nested(payload, ("check", "total_issues"))),
        "check_summary": check_summary if isinstance(check_summary, dict) else None,
        "dupes_stats": dupes_stats if isinstance(dupes_stats, dict) else None,
        "health_summary": health_summary if isinstance(health_summary, dict) else None,
        "health_score": health_score,
        "health_targets_count": count_list(get_nested(payload, ("health", "targets"))),
        "check_issues_count": count_list(get_nested(payload, ("check", "issues"))),
        "dupe_clone_group_count": count_list(get_nested(payload, ("dupes", "clone_groups"))),
        "stdout_bytes": len(proc.stdout or ""),
        "stderr_bytes": len(proc.stderr or ""),
        "unavailable_sections": unavailable_sections,
    }
    return {
        "summary": summary,
        "detected_plugins": {
            "fallow": detected_plugins,
            "fallow_plugin_metadata_available": bool(detected_plugins),
            "local_framework_conventions": local_convention_entries(conventions),
        },
        "framework_convention_warnings": framework_convention_warnings(
            conventions,
            detected_plugins,
        ),
        "top_dead_code": top_dead_code_findings(normalized),
        "top_complexity": top_complexity_findings(payload),
        "top_duplication": top_duplication_findings(payload),
        "suspected_false_positives": suspected_false_positives(normalized),
    }


def read_json_file(path_text: str) -> tuple[Any | None, str | None]:
    try:
        with Path(path_text).expanduser().open("r", encoding="utf-8") as handle:
            return json.load(handle), None
    except OSError as exc:
        return None, str(exc)
    except json.JSONDecodeError as exc:
        return None, f"invalid JSON: {exc}"


def nested_metric_value(metrics: dict[str, Any], metric_path: str) -> Any:
    current: Any = metrics
    for part in metric_path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def set_nested_metric(metrics: dict[str, Any], metric_path: str, value: int | float | None) -> None:
    current = metrics
    parts = metric_path.split(".")
    for part in parts[:-1]:
        child = current.get(part)
        if not isinstance(child, dict):
            child = {}
            current[part] = child
        current = child
    current[parts[-1]] = value


def normalized_count_keys(name: str) -> tuple[str, str]:
    return name, name.replace("_", "-")


def count_from_maps(raw_summary_value: Any, names: tuple[str, ...]) -> int:
    if not isinstance(raw_summary_value, dict):
        return 0
    total = 0
    maps = (
        raw_summary_value.get("finding_type_counts"),
        raw_summary_value.get("rule_counts"),
    )
    for counts in maps:
        if not isinstance(counts, dict):
            continue
        total = 0
        for name in names:
            for key in normalized_count_keys(name):
                value = counts.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    total += value
                    break
        if total:
            return total
    return total


def count_from_summary_maps(raw_summary_value: Any, names: tuple[str, ...]) -> int:
    if not isinstance(raw_summary_value, dict):
        return 0
    summary = raw_summary_value.get("summary")
    if not isinstance(summary, dict):
        return 0
    total = 0
    for summary_key in ("check_summary", "health_summary", "dupes_stats"):
        source = summary.get(summary_key)
        if not isinstance(source, dict):
            continue
        for name in names:
            for key in normalized_count_keys(name):
                value = source.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    total += value
                    break
    return total


def count_from_findings(wrapper_payload: Any, names: tuple[str, ...]) -> int:
    if not isinstance(wrapper_payload, dict):
        return 0
    expected = {key for name in names for key in normalized_count_keys(name)}
    total = 0
    for bucket in ("blocking_findings", "non_blocking_findings"):
        findings = wrapper_payload.get(bucket)
        if not isinstance(findings, list):
            continue
        for finding in findings:
            if not isinstance(finding, dict):
                continue
            finding_type = str(finding.get("finding_type") or "")
            rule = str(finding.get("rule") or "")
            if finding_type in expected or rule in expected:
                total += 1
    return total


def count_metric(wrapper_payload: Any, *names: str) -> int:
    raw_summary_value = wrapper_payload.get("raw_summary") if isinstance(wrapper_payload, dict) else {}
    return (
        count_from_maps(raw_summary_value, names)
        or count_from_summary_maps(raw_summary_value, names)
        or count_from_findings(wrapper_payload, names)
    )


def count_top_complexity(raw_summary_value: Any, finding_type: str) -> int:
    if not isinstance(raw_summary_value, dict):
        return 0
    findings = raw_summary_value.get("top_complexity")
    if not isinstance(findings, list):
        return 0
    return sum(
        1
        for finding in findings
        if isinstance(finding, dict) and finding.get("finding_type") == finding_type
    )


def critical_complexity_count(wrapper_payload: Any) -> int:
    raw_summary_value = wrapper_payload.get("raw_summary") if isinstance(wrapper_payload, dict) else {}
    total = count_metric(wrapper_payload, "critical_findings")
    for bucket in ("blocking_findings", "non_blocking_findings"):
        findings = wrapper_payload.get(bucket) if isinstance(wrapper_payload, dict) else None
        if not isinstance(findings, list):
            continue
        for finding in findings:
            if (
                isinstance(finding, dict)
                and finding.get("source_section") == "health"
                and severity_is_critical(finding)
            ):
                total += 1
    if isinstance(raw_summary_value, dict):
        findings = raw_summary_value.get("top_complexity")
        if isinstance(findings, list):
            for finding in findings:
                if isinstance(finding, dict) and severity_is_critical(finding):
                    total += 1
    return total


def top_duplication_metric(raw_summary_value: Any, key: str, aggregate: str) -> int:
    if not isinstance(raw_summary_value, dict):
        return 0
    findings = raw_summary_value.get("top_duplication")
    if not isinstance(findings, list):
        return 0
    values = [item.get(key) for item in findings if isinstance(item, dict)]
    ints = [value for value in values if isinstance(value, int) and not isinstance(value, bool)]
    if not ints:
        return 0
    if aggregate == "sum":
        return sum(ints)
    return max(ints)


def first_int_value(source: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = as_int(source.get(key))
        if value is not None:
            return value
    return None


def unavailable_sections_count(raw_summary_value: Any) -> int:
    if not isinstance(raw_summary_value, dict):
        return 0
    summary = raw_summary_value.get("summary")
    if not isinstance(summary, dict):
        return 0
    unavailable = summary.get("unavailable_sections")
    return len(unavailable) if isinstance(unavailable, list) else 0


def extract_static_audit_metrics(wrapper_payload: Any) -> tuple[dict[str, Any], list[str]]:
    metrics: dict[str, Any] = {}
    missing: list[str] = []
    if not isinstance(wrapper_payload, dict):
        return metrics, list(METRIC_PATHS)

    existing_metrics = get_nested(wrapper_payload, ("raw_summary", "metrics"))
    if isinstance(existing_metrics, dict):
        for metric_path in METRIC_PATHS:
            value = nested_metric_value(existing_metrics, metric_path)
            set_nested_metric(metrics, metric_path, value if isinstance(value, (int, float)) else None)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                missing.append(metric_path)
        return metrics, missing

    raw_summary_value = wrapper_payload.get("raw_summary")
    summary = raw_summary_value.get("summary") if isinstance(raw_summary_value, dict) else {}
    dupes_stats = summary.get("dupes_stats") if isinstance(summary, dict) else {}

    health_score = None
    if isinstance(summary, dict):
        health_score = as_float(summary.get("health_score"))
    if health_score is None:
        health_score = as_float(wrapper_payload.get("health_score"))

    values: dict[str, int | float | None] = {
        "imports.unresolved_imports": count_metric(wrapper_payload, "unresolved_imports"),
        "dependencies.unlisted": count_metric(wrapper_payload, "unlisted_dependencies"),
        "dependencies.unused": count_metric(wrapper_payload, "unused_dependencies"),
        "dependencies.unused_dev": count_metric(wrapper_payload, "unused_dev_dependencies"),
        "dependencies.unused_optional": count_metric(wrapper_payload, "unused_optional_dependencies"),
        "dependencies.override_issues": count_metric(
            wrapper_payload,
            "unused_dependency_overrides",
            "misconfigured_dependency_overrides",
        ),
        "dead_code.unused_files": count_metric(wrapper_payload, "unused_files"),
        "dead_code.unused_exports": count_metric(wrapper_payload, "unused_exports"),
        "dead_code.unused_types": count_metric(wrapper_payload, "unused_types"),
        "dead_code.unused_enum_members": count_metric(wrapper_payload, "unused_enum_members"),
        "dead_code.unused_class_members": count_metric(wrapper_payload, "unused_class_members"),
        "cycles.circular_dependencies": count_metric(wrapper_payload, "circular_dependencies"),
        "cycles.re_export_cycles": count_metric(wrapper_payload, "re_export_cycles"),
        "architecture.boundary_violations": count_metric(wrapper_payload, "boundary_violations"),
        "catalog.unused_entries": count_metric(wrapper_payload, "unused_catalog_entries"),
        "catalog.empty_groups": count_metric(wrapper_payload, "empty_catalog_groups"),
        "catalog.unresolved_references": count_metric(wrapper_payload, "unresolved_catalog_references"),
        "complexity.health_score": health_score,
        "complexity.targets": as_int(summary.get("health_targets_count")) if isinstance(summary, dict) else None,
        "complexity.hotspots": count_metric(wrapper_payload, "hotspots")
        or count_top_complexity(raw_summary_value, "hotspots"),
        "complexity.large_functions": count_metric(wrapper_payload, "large_functions")
        or count_top_complexity(raw_summary_value, "large_functions"),
        "complexity.critical_findings": critical_complexity_count(wrapper_payload),
        "duplication.clone_groups": (
            as_int(summary.get("dupe_clone_group_count")) if isinstance(summary, dict) else None
        ),
        "duplication.duplicated_lines": (
            first_int_value(
                dupes_stats,
                "duplicated_lines",
                "total_duplicated_lines",
                "duplicate_lines",
            )
            if isinstance(dupes_stats, dict)
            else None
        ),
        "duplication.max_group_lines": top_duplication_metric(
            raw_summary_value,
            "duplicated_lines",
            "max",
        ),
        "duplication.max_instance_count": top_duplication_metric(
            raw_summary_value,
            "instance_count",
            "max",
        ),
        "framework.suspected_false_positives": (
            len(raw_summary_value.get("suspected_false_positives"))
            if isinstance(raw_summary_value, dict)
            and isinstance(raw_summary_value.get("suspected_false_positives"), list)
            else 0
        ),
        "audit.unclassified_count": (
            as_int(raw_summary_value.get("unclassified_count"))
            if isinstance(raw_summary_value, dict)
            else None
        ),
        "audit.nullquad_count": (
            as_int(raw_summary_value.get("nullquad_count")) if isinstance(raw_summary_value, dict) else None
        ),
        "audit.unavailable_sections_count": unavailable_sections_count(raw_summary_value),
    }

    for metric_path in METRIC_PATHS:
        value = values.get(metric_path)
        set_nested_metric(metrics, metric_path, value)
        if value is None:
            missing.append(metric_path)
    return metrics, missing


def flatten_metrics(metrics: dict[str, Any]) -> dict[str, int | float | None]:
    return {metric_path: nested_metric_value(metrics, metric_path) for metric_path in METRIC_PATHS}


def parse_thresholds(raw_thresholds: list[str]) -> tuple[dict[str, float], list[str]]:
    thresholds: dict[str, float] = {}
    errors: list[str] = []
    allowed = set(METRIC_PATHS)
    for raw in raw_thresholds:
        if "=" not in raw:
            errors.append(f"threshold must be METRIC=NUMBER: {raw}")
            continue
        metric, value_text = raw.split("=", 1)
        metric = metric.strip()
        if metric not in allowed:
            errors.append(f"unknown metric threshold: {metric}")
            continue
        try:
            value = float(value_text.strip())
        except ValueError:
            errors.append(f"threshold value must be numeric for {metric}: {value_text}")
            continue
        if value < 0:
            errors.append(f"threshold must be non-negative for {metric}: {value_text}")
            continue
        thresholds[metric] = value
    return thresholds, errors


def compare_metric_values(
    baseline_metrics: dict[str, Any],
    current_metrics: dict[str, Any],
    thresholds: dict[str, float],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    baseline_flat = flatten_metrics(baseline_metrics)
    current_flat = flatten_metrics(current_metrics)
    deltas: dict[str, dict[str, Any]] = {}
    regressions: list[dict[str, Any]] = []
    for metric_path in METRIC_PATHS:
        baseline_value = baseline_flat.get(metric_path)
        current_value = current_flat.get(metric_path)
        if not isinstance(baseline_value, (int, float)) or isinstance(baseline_value, bool):
            continue
        if not isinstance(current_value, (int, float)) or isinstance(current_value, bool):
            continue
        threshold = thresholds.get(metric_path, 0.0)
        delta = float(current_value) - float(baseline_value)
        direction = "lower-is-worse" if metric_path == "complexity.health_score" else "higher-is-worse"
        regressed = False
        if metric_path in DEFAULT_REGRESSION_METRICS:
            if direction == "lower-is-worse":
                regressed = (float(baseline_value) - float(current_value)) > threshold
            else:
                regressed = delta > threshold
        deltas[metric_path] = {
            "baseline": baseline_value,
            "current": current_value,
            "delta": delta,
            "threshold": threshold,
            "direction": direction,
            "regressed": regressed,
        }
        if regressed:
            regressions.append({"metric": metric_path, **deltas[metric_path]})
    return deltas, regressions


def metrics_output(
    *,
    status: str,
    result: str,
    mode: str,
    command: list[str],
    repo: Path,
    metrics: dict[str, Any] | None = None,
    missing_metrics: list[str] | None = None,
    raw_summary_value: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": "static-code-audit-metrics.v1",
        "wrapper_version": WRAPPER_VERSION,
        "name": "static-code-audit-metrics" if mode == "metrics" else "static-code-audit-metrics-delta",
        "status": status,
        "result": result,
        "mode": mode,
        "tool": "fallow",
        "repo": str(repo),
        "command": command,
        "metrics": metrics or {},
        "missing_metrics": missing_metrics or [],
        "raw_summary": raw_summary_value or {},
        "policy": policy_payload(),
    }


def run_metrics_mode(*, repo: Path, input_path: str | None, pretty: bool) -> int:
    command = ["metrics"]
    if input_path:
        command.extend(["--input", input_path])
    if not input_path:
        payload = metrics_output(
            status="error",
            result="fail",
            mode="metrics",
            command=command,
            repo=repo,
            raw_summary_value={"error": "--input is required for metrics mode", "error_kind": "usage"},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    current, error = read_json_file(input_path)
    if error:
        payload = metrics_output(
            status="error",
            result="fail",
            mode="metrics",
            command=command,
            repo=repo,
            raw_summary_value={"error": error, "error_kind": "input_json", "input": input_path},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    metrics, missing = extract_static_audit_metrics(current)
    status = "error" if missing else "pass"
    payload = metrics_output(
        status=status,
        result="fail" if missing else "pass",
        mode="metrics",
        command=command,
        repo=repo,
        metrics=metrics,
        missing_metrics=missing,
        raw_summary_value={
            "input": input_path,
            "source_schema_version": current.get("schema_version") if isinstance(current, dict) else None,
            "residual_risk": (
                "current normalized JSON lacked required metric values"
                if missing
                else "metrics extracted from normalized static-code-audit JSON"
            ),
        },
    )
    print_json(payload, pretty)
    return EXIT_GATE_FAIL if missing else EXIT_PASS_OR_SKIPPED


def run_metrics_delta_mode(
    *,
    repo: Path,
    baseline_path: str | None,
    current_path: str | None,
    raw_thresholds: list[str],
    allow_missing_baseline: bool,
    not_applicable_reason: str | None,
    pretty: bool,
) -> int:
    command = ["metrics-delta"]
    if baseline_path:
        command.extend(["--baseline", baseline_path])
    if current_path:
        command.extend(["--current", current_path])
    for threshold in raw_thresholds:
        command.extend(["--threshold", threshold])
    if allow_missing_baseline:
        command.append("--allow-missing-baseline")

    thresholds, threshold_errors = parse_thresholds(raw_thresholds)
    if threshold_errors:
        payload = metrics_output(
            status="error",
            result="fail",
            mode="metrics-delta",
            command=command,
            repo=repo,
            raw_summary_value={"error": "; ".join(threshold_errors), "error_kind": "usage"},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    if not current_path:
        payload = metrics_output(
            status="error",
            result="fail",
            mode="metrics-delta",
            command=command,
            repo=repo,
            raw_summary_value={"error": "--current is required", "error_kind": "usage"},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    current, current_error = read_json_file(current_path)
    if current_error:
        payload = metrics_output(
            status="error",
            result="fail",
            mode="metrics-delta",
            command=command,
            repo=repo,
            raw_summary_value={"error": current_error, "error_kind": "current_json", "current": current_path},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    current_metrics, missing_current = extract_static_audit_metrics(current)
    if missing_current:
        payload = metrics_output(
            status="error",
            result="fail",
            mode="metrics-delta",
            command=command,
            repo=repo,
            metrics={"current": current_metrics},
            missing_metrics=missing_current,
            raw_summary_value={
                "current": current_path,
                "error_kind": "missing_current_metrics",
                "residual_risk": "current normalized JSON is not complete enough for delta gating",
            },
        )
        print_json(payload, pretty)
        return EXIT_GATE_FAIL

    if not baseline_path:
        raw_summary_value = {
            "current": current_path,
            "baseline": None,
            "missing_baseline": True,
            "residual_risk": "no baseline metrics are available for regression comparison",
        }
        if allow_missing_baseline:
            payload = metrics_output(
                status="skipped",
                result="skipped",
                mode="metrics-delta",
                command=command,
                repo=repo,
                metrics={"current": current_metrics},
                raw_summary_value={
                    **raw_summary_value,
                    "controlled_not_applicable": True,
                    "not_applicable_reason": not_applicable_reason
                    or "baseline absent and --allow-missing-baseline was provided",
                },
            )
            print_json(payload, pretty)
            return EXIT_PASS_OR_SKIPPED
        payload = metrics_output(
            status="blocked",
            result="blocked",
            mode="metrics-delta",
            command=command,
            repo=repo,
            metrics={"current": current_metrics},
            raw_summary_value=raw_summary_value,
        )
        print_json(payload, pretty)
        return EXIT_GATE_FAIL

    baseline, baseline_error = read_json_file(baseline_path)
    if baseline_error:
        payload = metrics_output(
            status="error",
            result="fail",
            mode="metrics-delta",
            command=command,
            repo=repo,
            metrics={"current": current_metrics},
            raw_summary_value={
                "error": baseline_error,
                "error_kind": "baseline_json",
                "baseline": baseline_path,
            },
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    baseline_metrics, missing_baseline = extract_static_audit_metrics(baseline)
    if missing_baseline:
        payload = metrics_output(
            status="blocked",
            result="blocked",
            mode="metrics-delta",
            command=command,
            repo=repo,
            metrics={"baseline": baseline_metrics, "current": current_metrics},
            missing_metrics=missing_baseline,
            raw_summary_value={
                "baseline": baseline_path,
                "current": current_path,
                "missing_baseline_metrics": missing_baseline,
                "residual_risk": "baseline normalized JSON lacks required metric values",
            },
        )
        print_json(payload, pretty)
        return EXIT_GATE_FAIL

    deltas, regressions = compare_metric_values(baseline_metrics, current_metrics, thresholds)
    status = "fail" if regressions else "pass"
    payload = metrics_output(
        status=status,
        result=status,
        mode="metrics-delta",
        command=command,
        repo=repo,
        metrics={"baseline": baseline_metrics, "current": current_metrics},
        raw_summary_value={
            "baseline": baseline_path,
            "current": current_path,
            "thresholds": thresholds,
            "deltas": deltas,
            "regressions": regressions,
            "regression_count": len(regressions),
            "residual_risk": (
                "metrics delta regressions require review"
                if regressions
                else "metrics delta gate found no default regression"
            ),
        },
    )
    print_json(payload, pretty)
    return EXIT_GATE_FAIL if regressions else EXIT_PASS_OR_SKIPPED


def classify_findings(
    raw_payload: Any,
    *,
    mode: str,
    repo: Path,
    changed: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    legacy_candidates = collect_legacy_raw_findings(raw_payload)
    legacy_candidate_count = len(legacy_candidates)
    records = collect_raw_finding_records(raw_payload)
    recognized_record_ids = {id(item) for item, _, _ in records}
    normalized = [
        normalize_finding(
            item,
            source_section=source_section,
            finding_type=finding_type,
        )
        for item, source_section, finding_type in records
    ]
    classification = classification_payload(
        normalized,
        legacy_candidate_count=legacy_candidate_count,
    )
    unclassified_candidates = [
        item for item in legacy_candidates if id(item) not in recognized_record_ids
    ]
    classification["unclassified_count"] = len(unclassified_candidates)
    classification["introduced_finding_count"] = sum(
        finding.get("introduced") is True for finding in normalized
    )
    classification["introduced_unclassified_count"] = sum(
        extract_bool(item, INTRODUCED_KEYS) is True for item in unclassified_candidates
    )
    unknown_records = collect_unknown_fallow_finding_records(raw_payload)
    classification["unknown_finding_count"] = len(unknown_records)
    classification["unknown_introduced_attribution_count"] = (
        unknown_introduced_attribution_count(raw_payload)
    )
    if mode != "diff-gate":
        return [], compact_repo_non_blocking_findings(normalized), classification

    blocking: list[dict[str, Any]] = []
    non_blocking: list[dict[str, Any]] = []
    changed_set = set(changed)
    for finding in normalized:
        if is_suspected_framework_false_positive(finding):
            non_blocking.append(
                mark_probable_false_positive(
                    finding,
                    "Next-like route handler exports are framework entry points.",
                )
            )
        elif usage_path := suspected_dependency_false_positive_usage(
            finding,
            repo=repo,
            changed=changed_set,
        ):
            non_blocking.append(
                mark_probable_false_positive(
                    finding,
                    (
                        "Fallow reported an unused package dependency, but the "
                        f"package is still imported from {usage_path}."
                    ),
                )
            )
        elif finding.get("introduced") is True and is_blocking_category(finding):
            blocking.append(finding)
        else:
            non_blocking.append(finding)
    return blocking, non_blocking, classification


def has_actionable_unclassified_diff_failure(
    raw_payload: Any,
    non_blocking: list[dict[str, Any]],
    classification: dict[str, Any],
) -> bool:
    verdict = str(find_first_key(raw_payload, {"verdict", "status"}) or "").lower()
    introduced = count_introduced(raw_payload)
    if (
        int(classification.get("unknown_finding_count") or 0) > 0
        or int(classification.get("unknown_introduced_attribution_count") or 0) > 0
    ):
        return True

    actionable_unknown = [
        finding
        for finding in non_blocking
        if not finding.get("probable_false_positive")
        and finding.get("introduced") is None
        and (
            is_blocking_category(finding)
            or finding.get("source_section")
            not in {"check", "dead_code", "health", "complexity"}
        )
    ]
    if actionable_unknown:
        return True
    if introduced == 0:
        return False
    if introduced is not None and introduced > 0:
        recognized_introduced = int(classification.get("introduced_finding_count") or 0)
        if recognized_introduced > 0:
            return False
        if non_blocking and all(finding.get("introduced") is False for finding in non_blocking):
            return False
        return True
    if verdict == "fail":
        if non_blocking and all(finding.get("introduced") is False for finding in non_blocking):
            return False
        return not non_blocking
    return False


def find_first_key(value: Any, names: set[str]) -> Any:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in names:
                return child
        for child in value.values():
            found = find_first_key(child, names)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_first_key(child, names)
            if found is not None:
                return found
    return None


def count_introduced(value: Any) -> int | None:
    count_names = {"introduced_count", "introducedCount", "new_count", "newCount"}
    explicit_counts: list[int] = []
    attributed_counts: list[int] = []
    introduced_flags: list[bool] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                if key in count_names and isinstance(child, int) and not isinstance(child, bool):
                    explicit_counts.append(child)
                elif key in {"introduced", "new"} and isinstance(child, int) and not isinstance(child, bool):
                    explicit_counts.append(child)
                elif key in {"introduced", "new"} and isinstance(child, list):
                    explicit_counts.append(len(child))
                elif (
                    key.endswith("_introduced")
                    and isinstance(child, int)
                    and not isinstance(child, bool)
                ):
                    attributed_counts.append(child)
                elif key in {"introduced", "is_introduced", "isIntroduced"} and isinstance(child, bool):
                    introduced_flags.append(child)
                if isinstance(child, (dict, list)):
                    visit(child)
        elif isinstance(node, list):
            for child in node:
                if isinstance(child, (dict, list)):
                    visit(child)

    visit(value)
    candidates: list[int] = []
    if explicit_counts:
        candidates.append(max(explicit_counts))
    if attributed_counts:
        candidates.append(sum(attributed_counts))
    if introduced_flags:
        candidates.append(sum(int(flag) for flag in introduced_flags))
    if candidates:
        return max(candidates)
    return None


def raw_summary(
    payload: Any,
    *,
    mode: str,
    repo: Path,
    proc: subprocess.CompletedProcess[str],
    parsed_from: str | None,
    changed: list[str],
) -> dict[str, Any]:
    if mode == "repo-audit" and isinstance(payload, dict):
        summary = {
            "exit_code": proc.returncode,
            "parsed_from": parsed_from,
            "stderr_excerpt": tail_text(proc.stderr),
            "top_level_keys": sorted(str(key) for key in payload.keys()),
        }
        summary.update(build_repo_audit_report(payload, repo, proc))
        return summary

    summary: dict[str, Any] = {
        "exit_code": proc.returncode,
        "parsed_from": parsed_from,
        "stdout_excerpt": tail_text(proc.stdout),
        "stderr_excerpt": tail_text(proc.stderr),
        "changed_files": changed,
    }
    if isinstance(payload, dict):
        for key in ("verdict", "status", "gate", "summary", "attribution", "counts"):
            if key in payload:
                summary[key] = payload[key]
        summary["top_level_keys"] = sorted(str(key) for key in payload.keys())
        introduced = count_introduced(payload)
        if introduced is not None:
            summary["introduced_count"] = introduced
    return summary


def resolve_npm_binary(raw_npm_bin: str | None) -> str | None:
    npm_bin = raw_npm_bin or os.environ.get("NPM_BIN") or "npm"
    npm_path = Path(npm_bin).expanduser()
    if npm_path.is_absolute() or npm_path.parent != Path("."):
        resolved = npm_path.resolve(strict=False)
        return str(resolved) if is_executable_file(resolved) else None
    return shutil.which(npm_bin)


def run_bootstrap(
    *,
    repo: Path,
    bootstrap_root: Path,
    fallow_package: str,
    npm_bin_arg: str | None,
    timeout_seconds: int,
    pretty: bool,
) -> int:
    package_version = exact_fallow_package_version(fallow_package)
    if package_version is None:
        payload = base_output(
            status="error",
            mode="bootstrap",
            repo=str(repo),
            base_ref=None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={
                "error": "--fallow-package must be an exact npm spec like fallow@3.23.0",
                "error_kind": "usage",
                "fallow_package": fallow_package,
            },
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    npm_bin = resolve_npm_binary(npm_bin_arg)
    if npm_bin is None:
        payload = base_output(
            status="error",
            mode="bootstrap",
            repo=str(repo),
            base_ref=None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": "npm executable not found", "error_kind": "config"},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    node_bin = shutil.which("node")
    node_version = None
    try:
        if node_bin is not None:
            node_probe = subprocess.run(
                [node_bin, "--version"], cwd=str(repo), env=safe_npm_env(),
                text=True, capture_output=True, check=False, timeout=10,
            )
            if node_probe.returncode == 0:
                node_version = node_probe.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    node_match = re.fullmatch(r"v([0-9]+)\.[0-9]+\.[0-9]+", node_version or "")
    if node_match is None or int(node_match.group(1)) < 22:
        payload = base_output(
            status="error", mode="bootstrap", repo=str(repo), base_ref=None,
            command=[node_bin, "--version"] if node_bin else [], tool_version=None,
            blocking_findings=[], non_blocking_findings=[],
            raw_summary={
                "error": "Fallow bootstrap requires Node.js >=22 before npm install",
                "error_kind": "node_requirement", "node_version": node_version,
                "fallow_package": fallow_package,
            },
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    bootstrap_root.mkdir(parents=True, exist_ok=True)
    command = [
        npm_bin,
        "install",
        "--prefix",
        str(bootstrap_root),
        fallow_package,
        "--save-exact",
        "--no-audit",
        "--no-fund",
        "--engine-strict",
    ]
    try:
        proc = subprocess.run(
            command,
            cwd=str(bootstrap_root),
            env=safe_npm_env(),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        payload = base_output(
            status="error",
            mode="bootstrap",
            repo=str(repo),
            base_ref=None,
            command=command,
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={
                "error": f"npm bootstrap timed out after {timeout_seconds}s",
                "error_kind": "bootstrap_timeout",
                "bootstrap_root": str(bootstrap_root),
                "fallow_package": fallow_package,
                "stdout_excerpt": tail_text(exc.stdout),
                "stderr_excerpt": tail_text(exc.stderr),
            },
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE
    except OSError as exc:
        payload = base_output(
            status="error",
            mode="bootstrap",
            repo=str(repo),
            base_ref=None,
            command=command,
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={
                "error": str(exc),
                "error_kind": "bootstrap_exec",
                "bootstrap_root": str(bootstrap_root),
                "fallow_package": fallow_package,
            },
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE

    fallow_bin = bootstrap_fallow_bin(bootstrap_root)
    tool_version = get_tool_version(str(fallow_bin), repo) if fallow_bin is not None else None
    raw = {
        "bootstrap_root": str(bootstrap_root),
        "fallow_package": fallow_package,
        "fallow_package_version": package_version,
        "fallow_bin": str(fallow_bin) if fallow_bin is not None else None,
        "npm_exit_code": proc.returncode,
        "node_version": node_version,
        "stdout_excerpt": tail_text(proc.stdout),
        "stderr_excerpt": tail_text(proc.stderr),
    }

    if proc.returncode != 0 or fallow_bin is None:
        payload = base_output(
            status="error",
            mode="bootstrap",
            repo=str(repo),
            base_ref=None,
            command=command,
            tool_version=tool_version,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={**raw, "error_kind": "bootstrap_install"},
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE

    if tool_version is None or tool_version.split()[-1] != package_version:
        payload = base_output(
            status="error", mode="bootstrap", repo=str(repo), base_ref=None,
            command=command, tool_version=tool_version,
            blocking_findings=[], non_blocking_findings=[],
            raw_summary={**raw, "error_kind": "bootstrap_probe",
                         "error": "installed Fallow did not report the requested version successfully"},
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE

    payload = base_output(
        status="pass",
        mode="bootstrap",
        repo=str(repo),
        base_ref=None,
        command=command,
        tool_version=tool_version,
        blocking_findings=[],
        non_blocking_findings=[],
        raw_summary=raw,
    )
    print_json(payload, pretty)
    return EXIT_PASS_OR_SKIPPED


def run_probe(repo: Path, fallow_bin: str | None, reason: str, pretty: bool) -> int:
    if fallow_bin is None:
        payload = base_output(
            status="skipped",
            mode="probe",
            repo=str(repo),
            base_ref=None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"skip_reason": "fallow unavailable", "resolution": reason},
        )
        print_json(payload, pretty)
        return EXIT_PASS_OR_SKIPPED

    command = [fallow_bin, "--version"]
    violation = policy_violation(command)
    if violation:
        payload = base_output(
            status="error",
            mode="probe",
            repo=str(repo),
            base_ref=None,
            command=command,
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": violation, "error_kind": "policy"},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    version = get_tool_version(fallow_bin, repo)
    payload = base_output(
        status="pass" if tool_version_is_pinned(version) else "error",
        mode="probe",
        repo=str(repo),
        base_ref=None,
        command=command,
        tool_version=version,
        blocking_findings=[],
        non_blocking_findings=[],
        raw_summary={"resolution": reason, "version_available": version is not None,
                     "expected_version": PINNED_FALLOW_VERSION,
                     **({"error_kind": "tool_version", "error": "Fallow version is missing, invalid or unpinned"}
                        if not tool_version_is_pinned(version) else {})},
    )
    print_json(payload, pretty)
    return EXIT_PASS_OR_SKIPPED if tool_version_is_pinned(version) else EXIT_TOOL_UNINTERPRETABLE


def run_audit(
    *,
    mode: str,
    repo: Path,
    base_ref: str | None,
    timeout_seconds: int,
    fallow_bin: str,
    resolution: str,
    pretty: bool,
) -> int:
    command = command_for_mode(fallow_bin, mode, base_ref)
    violation = policy_violation(command)
    if violation:
        payload = base_output(
            status="error",
            mode=mode,
            repo=str(repo),
            base_ref=normalize_base_ref(base_ref) if mode == "diff-gate" else None,
            command=command,
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": violation, "error_kind": "policy", "resolution": resolution},
        )
        print_json(payload, pretty)
        return EXIT_USAGE_OR_CONFIG

    version = get_tool_version(fallow_bin, repo)
    if not tool_version_is_pinned(version):
        payload = base_output(
            status="error", mode=mode, repo=str(repo),
            base_ref=normalize_base_ref(base_ref) if mode == "diff-gate" else None,
            command=[fallow_bin, "--version"], tool_version=version,
            blocking_findings=[], non_blocking_findings=[],
            raw_summary={"resolution": resolution, "error_kind": "tool_version",
                         "expected_version": PINNED_FALLOW_VERSION,
                         "error": "Fallow version is missing, invalid or unpinned; audit was not run"},
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE
    changed = changed_files(repo, base_ref) if mode == "diff-gate" else []
    try:
        proc = subprocess.run(
            command,
            cwd=str(repo),
            env=safe_env(),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        payload = base_output(
            status="error",
            mode=mode,
            repo=str(repo),
            base_ref=normalize_base_ref(base_ref) if mode == "diff-gate" else None,
            command=command,
            tool_version=version,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={
                "error": f"Fallow timed out after {timeout_seconds}s",
                "error_kind": "tool_timeout",
                "stdout_excerpt": tail_text(exc.stdout),
                "stderr_excerpt": tail_text(exc.stderr),
                "changed_files": changed,
                "resolution": resolution,
            },
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE
    except OSError as exc:
        payload = base_output(
            status="error",
            mode=mode,
            repo=str(repo),
            base_ref=normalize_base_ref(base_ref) if mode == "diff-gate" else None,
            command=command,
            tool_version=version,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": str(exc), "error_kind": "tool_exec", "resolution": resolution},
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE

    parsed, parsed_from = parse_json_output(proc.stdout, proc.stderr)
    if parsed is None:
        payload = base_output(
            status="error",
            mode=mode,
            repo=str(repo),
            base_ref=normalize_base_ref(base_ref) if mode == "diff-gate" else None,
            command=command,
            tool_version=version,
            blocking_findings=[
                {
                    "rule": "fallow-json-uninterpretable",
                    "category": "tool-output",
                    "severity": "error",
                    "message": "Fallow ran but did not emit interpretable JSON.",
                    "path": None,
                    "line": None,
                    "introduced": None,
                }
            ],
            non_blocking_findings=[],
            raw_summary={
                "exit_code": proc.returncode,
                "error_kind": "json_parse",
                "stdout_excerpt": tail_text(proc.stdout),
                "stderr_excerpt": tail_text(proc.stderr),
                "changed_files": changed,
                "resolution": resolution,
            },
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE

    summary = raw_summary(
        parsed,
        mode=mode,
        repo=repo,
        proc=proc,
        parsed_from=parsed_from,
        changed=changed,
    )
    summary["resolution"] = resolution
    blocking, non_blocking, classification = classify_findings(
        parsed,
        mode=mode,
        repo=repo,
        changed=changed,
    )
    summary.update(classification)

    if (
        mode == "diff-gate"
        and proc.returncode == 1
        and not blocking
        and has_actionable_unclassified_diff_failure(parsed, non_blocking, classification)
    ):
        blocking.append(
            {
                "rule": "fallow-verdict-fail-unclassified",
                "category": "tool-output",
                "severity": "error",
                "message": (
                    "Fallow reported a failing diff audit, but the wrapper could not "
                    "classify a specific blocking issue object. Inspect raw_summary."
                ),
                "path": None,
                "line": None,
                "introduced": None,
            }
        )

    if proc.returncode not in (0, 1):
        payload = base_output(
            status="error",
            mode=mode,
            repo=str(repo),
            base_ref=normalize_base_ref(base_ref) if mode == "diff-gate" else None,
            command=command,
            tool_version=version,
            blocking_findings=blocking,
            non_blocking_findings=non_blocking,
            raw_summary={**summary, "error_kind": "tool_exit"},
        )
        print_json(payload, pretty)
        return EXIT_TOOL_UNINTERPRETABLE

    status = "fail" if blocking else "pass"
    payload = base_output(
        status=status,
        mode=mode,
        repo=str(repo),
        base_ref=normalize_base_ref(base_ref) if mode == "diff-gate" else None,
        command=command,
        tool_version=version,
        blocking_findings=blocking,
        non_blocking_findings=non_blocking,
        raw_summary=summary,
    )
    print_json(payload, pretty)
    return EXIT_GATE_FAIL if status == "fail" else EXIT_PASS_OR_SKIPPED


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args, unknown = parser.parse_known_args(argv)

    repo_text = args.repo
    try:
        repo = resolve_repo(repo_text)
    except ValueError as exc:
        payload = base_output(
            status="error",
            mode=args.mode,
            repo=str(Path(repo_text).expanduser()),
            base_ref=normalize_base_ref(args.base_ref) if args.mode == "diff-gate" else None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": str(exc), "error_kind": "config"},
        )
        print_json(payload, args.pretty)
        return EXIT_USAGE_OR_CONFIG

    if unknown:
        violation = policy_violation(unknown)
        message = violation or f"unsupported Fallow passthrough arguments: {' '.join(unknown)}"
        payload = base_output(
            status="error",
            mode=args.mode,
            repo=str(repo),
            base_ref=normalize_base_ref(args.base_ref) if args.mode == "diff-gate" else None,
            command=unknown,
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": message, "error_kind": "usage"},
        )
        print_json(payload, args.pretty)
        return EXIT_USAGE_OR_CONFIG

    if args.timeout_seconds <= 0:
        payload = base_output(
            status="error",
            mode=args.mode,
            repo=str(repo),
            base_ref=normalize_base_ref(args.base_ref) if args.mode == "diff-gate" else None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"error": "--timeout-seconds must be positive", "error_kind": "usage"},
        )
        print_json(payload, args.pretty)
        return EXIT_USAGE_OR_CONFIG

    if args.mode == "metrics":
        return run_metrics_mode(repo=repo, input_path=args.input, pretty=args.pretty)

    if args.mode == "metrics-delta":
        return run_metrics_delta_mode(
            repo=repo,
            baseline_path=args.baseline,
            current_path=args.current,
            raw_thresholds=args.threshold,
            allow_missing_baseline=args.allow_missing_baseline,
            not_applicable_reason=args.not_applicable_reason,
            pretty=args.pretty,
        )

    bootstrap_root = bootstrap_root_from_arg(args.bootstrap_root)

    if args.mode == "bootstrap":
        return run_bootstrap(
            repo=repo,
            bootstrap_root=bootstrap_root,
            fallow_package=args.fallow_package,
            npm_bin_arg=args.npm_bin,
            timeout_seconds=args.timeout_seconds,
            pretty=args.pretty,
        )

    fallow_bin, resolution = resolve_fallow_binary(repo, bootstrap_root)

    if args.mode == "probe":
        return run_probe(repo, fallow_bin, resolution, args.pretty)

    if not repo_has_js_ts_indicators(repo):
        payload = base_output(
            status="skipped",
            mode=args.mode,
            repo=str(repo),
            base_ref=normalize_base_ref(args.base_ref) if args.mode == "diff-gate" else None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"skip_reason": "non-JS/TS repository", "resolution": resolution},
        )
        print_json(payload, args.pretty)
        return EXIT_PASS_OR_SKIPPED

    if fallow_bin is None:
        payload = base_output(
            status="skipped",
            mode=args.mode,
            repo=str(repo),
            base_ref=normalize_base_ref(args.base_ref) if args.mode == "diff-gate" else None,
            command=[],
            tool_version=None,
            blocking_findings=[],
            non_blocking_findings=[],
            raw_summary={"skip_reason": "fallow unavailable", "resolution": resolution},
        )
        print_json(payload, args.pretty)
        return EXIT_PASS_OR_SKIPPED

    return run_audit(
        mode=args.mode,
        repo=repo,
        base_ref=args.base_ref,
        timeout_seconds=args.timeout_seconds,
        fallow_bin=fallow_bin,
        resolution=resolution,
        pretty=args.pretty,
    )


if __name__ == "__main__":
    sys.exit(main())
