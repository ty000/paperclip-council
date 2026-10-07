"""Provider-free Git probe in an explicitly selected Codex home and sandbox.

Never starts a thread/turn, copies credentials, repairs a home, or writes the real
index. Preparing a fresh clone is a separate, exclusive local policy creation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time
import uuid


class Blocked(ValueError):
    pass


def environment() -> dict[str, str]:
    # Do not propagate caller Git redirects, provider tokens, or shell startup.
    return {key: value for key, value in os.environ.items()
            if key in {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"}}


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null",
                             "-c", "core.fsmonitor=false", *args], cwd=repo,
                            env={**environment(), "GIT_OPTIONAL_LOCKS": "0"},
                            capture_output=True, timeout=10, check=False)
    if result.returncode:
        raise Blocked("git_read_failed")
    return result.stdout.decode("utf-8", errors="strict").strip()


def workspace(repo: Path, expected_head: str | None = None) -> tuple[Path, Path]:
    if not repo.is_absolute() or repo.is_symlink() or repo.resolve() != repo:
        raise Blocked("canonical_absolute_workspace_required")
    if Path(git(repo, "rev-parse", "--show-toplevel")) != repo:
        raise Blocked("repository_root_required")
    git_dir = Path(git(repo, "rev-parse", "--absolute-git-dir"))
    # The first tranche only grants this clone's .git, never a sibling worktree.
    if git_dir != repo / ".git" or git_dir.is_symlink() or not git_dir.is_dir():
        raise Blocked("standalone_clone_required")
    if (repo / ".codex").is_symlink():
        raise Blocked("symlink_project_config")
    if expected_head and git(repo, "rev-parse", "HEAD") != expected_head:
        raise Blocked("head_mismatch")
    return repo, git_dir


def digest_file(path: Path) -> str | None:
    if path.is_symlink():
        raise Blocked("symlink_state_file")
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(repo: Path) -> dict:
    return {"head": git(repo, "rev-parse", "HEAD"),
            "indexSha256": digest_file(repo / ".git" / "index"),
            "status": git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
            "projectConfigSha256": digest_file(repo / ".codex" / "config.toml")}


def prepare_policy(repo: Path, expected_head: str | None = None) -> dict:
    repo, git_dir = workspace(repo, expected_head)
    folder = repo / ".codex"
    if folder.is_symlink():
        raise Blocked("symlink_project_config")
    folder.mkdir(exist_ok=True)
    config = folder / "config.toml"
    # No merge/replacement of a foreign or previously prepared configuration.
    if config.exists() or config.is_symlink():
        raise Blocked("project_config_exists_use_probe")
    content = ("# Council workspace preflight: this clone's Git metadata only.\n"
               "[sandbox_workspace_write]\n"
               f"writable_roots = [{json.dumps(str(git_dir))}]\n")
    with config.open("x", encoding="utf-8") as handle:
        handle.write(content)
    return {"schemaVersion": "council-workspace-policy.v1", "status": "prepared",
            "repository": str(repo), "head": git(repo, "rev-parse", "HEAD"),
            "policyPath": str(config), "policySha256": digest_file(config),
            "providerTurns": 0, "launchReadinessObserved": False}


class Rpc:
    """Small bounded stdio client; its method allowlist excludes model execution."""
    METHODS = {"initialize", "config/read", "command/exec"}

    def __init__(self, command: str, repo: Path, home: Path, path: str):
        self.process = subprocess.Popen(
            [command, "app-server", "--stdio", "-c", 'sandbox_mode="workspace-write"',
             "-c", "sandbox_workspace_write.network_access=false"], cwd=repo,
            env={**environment(), "CODEX_HOME": str(home), "PATH": path},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.counter = 0
        self.deadline = time.monotonic() + 35

    def request(self, method: str, params: dict) -> dict:
        if method not in self.METHODS:
            raise Blocked("rpc_method_forbidden")
        self.counter += 1
        message = {"id": self.counter, "method": method, "params": params}
        try:
            self.process.stdin.write(json.dumps(message).encode() + b"\n")
            self.process.stdin.flush()
        except (OSError, BrokenPipeError):
            raise Blocked("codex_transport_unavailable") from None
        deadline = min(time.monotonic() + 15, self.deadline)
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                response = json.loads(line)
                if response.get("id") == self.counter:
                    if "error" in response or not isinstance(response.get("result"), dict):
                        raise Blocked("codex_rpc_failed")
                    return response["result"]
            if not self.selector.select(max(0, deadline - time.monotonic())):
                break
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                raise Blocked("codex_transport_closed")
            self.buffer += data
            if len(self.buffer) > 4 * 1024 * 1024:
                raise Blocked("codex_response_too_large")
        raise Blocked("codex_rpc_timeout")

    def close(self) -> None:
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=3)
        except ProcessLookupError:
            pass
        self.selector.close()
        for stream in (self.process.stdin, self.process.stdout):
            stream.close()


def probe(repo: Path, home: Path, command: str = "codex", helper: Path | None = None,
          expected_head: str | None = None) -> dict:
    repo, git_dir = workspace(repo, expected_head)
    if not home.is_absolute() or home.resolve() != home or not home.is_dir():
        raise Blocked("explicit_existing_codex_home_required")
    before = snapshot(repo)
    home_hash = digest_file(home / "config.toml")
    report = {"schemaVersion": "council-workspace-preflight.v1", "status": "blocked",
              "repository": str(repo), "codexHome": str(home), "head": before["head"],
              "providerTurns": 0, "nativeAgentExecutionObserved": False,
              "githubAccessObserved": False, "checks": {},
              "limitations": ["No native agent, thread, turn, model availability or GitHub access was exercised",
                              "The registered home must match the effective native adapter home",
                              "A standalone clone and fixed ordinary CLI sandbox are required"]}
    # Codex 0.160 command/exec needs its official Linux multicall helper on PATH.
    # A supplied binary is linked in an owned temporary directory, never installed
    # globally or used to disable the sandbox. Absence is a failed probe.
    with tempfile.TemporaryDirectory(prefix="council-preflight-helper-") as temporary:
        path = environment().get("PATH", "")
        if helper:
            if not helper.is_absolute() or not helper.is_file() or not os.access(helper, os.X_OK):
                raise Blocked("sandbox_helper_unavailable")
            (Path(temporary) / "codex-linux-sandbox").symlink_to(helper)
            path = temporary + os.pathsep + path
        rpc = None
        index = git_dir / ("council-preflight-index-" + str(uuid.uuid4()))
        # Claim only our probe path; Git itself must create/write the lock inside
        # command/exec. Neither the real index nor a user lock is ever removed.
        with index.open("xb"):
            pass
        try:
            rpc = Rpc(command, repo, home, path)
            initialized = rpc.request("initialize", {"clientInfo": {"name": "council-workspace-preflight", "version": "1"},
                                                    "capabilities": {"experimentalApi": True}})
            report["cliUserAgent"] = initialized.get("userAgent")
            config = rpc.request("config/read", {"cwd": str(repo), "includeLayers": True})
            effective = config.get("config", {})
            sandbox = effective.get("sandbox_workspace_write") or {}
            roots = sandbox.get("writable_roots", [])
            policy_ok = (effective.get("sandbox_mode") == "workspace-write"
                         and sandbox.get("network_access") is False
                         and not effective.get("default_permissions") and not effective.get("permissions")
                         and isinstance(roots, list) and all(root == str(git_dir) for root in roots))
            report["checks"]["boundedSandbox"] = policy_ok
            report["permissions"] = {"sandboxMode": effective.get("sandbox_mode"),
                                     "writableRoots": roots, "networkAccess": sandbox.get("network_access")}
            report["projectLayers"] = [{"name": layer.get("name"), "version": layer.get("version"),
                                        "disabledReason": layer.get("disabledReason")}
                                       for layer in config.get("layers") or []
                                       if (layer.get("name") or {}).get("type") == "project"]
            if not policy_ok:
                report["reason"] = "sandbox_policy_out_of_scope"
                return report
            result = rpc.request("command/exec", {"command": ["git", "-c", "core.hooksPath=/dev/null",
                                  "-c", "core.fsmonitor=false", "read-tree", "HEAD"],
                "cwd": str(repo), "env": {"GIT_INDEX_FILE": str(index), "PATH": path,
                    "GIT_DIR": None, "GIT_WORK_TREE": None, "GIT_COMMON_DIR": None,
                    "GIT_OBJECT_DIRECTORY": None, "GIT_ALTERNATE_OBJECT_DIRECTORIES": None,
                    "GIT_CONFIG_COUNT": None, "GIT_CONFIG_PARAMETERS": None,
                    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"},
                "timeoutMs": 10000, "outputBytesCap": 1024})
            report["checks"]["gitTemporaryIndexWrite"] = result.get("exitCode") == 0
            report["probeExitCode"] = result.get("exitCode")
            if result.get("exitCode") != 0:
                report["reason"] = "sandbox_git_write_failed"
        finally:
            if rpc:
                rpc.close()
            # Owned UUID paths only; a failed sandbox may prevent native cleanup.
            index.unlink(missing_ok=True)
            index.with_name(index.name + ".lock").unlink(missing_ok=True)
            report["checks"]["workspacePreserved"] = snapshot(repo) == before
            report["checks"]["homeConfigPreserved"] = digest_file(home / "config.toml") == home_hash
    if all(report["checks"].values()) and report["checks"].get("gitTemporaryIndexWrite"):
        report["status"] = "pass"
    elif not report.get("reason"):
        report["reason"] = "workspace_or_home_changed"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "probe"])
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--expected-head")
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--codex-command", default="codex")
    parser.add_argument("--sandbox-helper", type=Path)
    args = parser.parse_args()
    def interrupted(_signal, _frame):
        raise InterruptedError("probe_interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        if args.mode == "prepare":
            result = prepare_policy(args.repo, args.expected_head)
        else:
            if not args.codex_home:
                raise Blocked("explicit_existing_codex_home_required")
            result = probe(args.repo, args.codex_home, args.codex_command,
                           args.sandbox_helper, args.expected_head)
    except (Blocked, OSError, subprocess.TimeoutExpired, UnicodeError, json.JSONDecodeError) as error:
        result = {"schemaVersion": "council-workspace-preflight.v1", "status": "blocked",
                  "reason": str(error) if isinstance(error, Blocked) else type(error).__name__, "providerTurns": 0}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] in {"pass", "prepared"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
