from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "ci" / "static_audit_gate.py"


class StaticAuditGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "package.json").write_text('{"private":true}\n', encoding="utf-8")
        subprocess.run(
            ["git", "init", "--quiet", "--initial-branch=main"],
            cwd=self.repo,
            check=True,
        )
        subprocess.run(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
             "add", "package.json"],
            cwd=self.repo,
            check=True,
        )
        subprocess.run(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
             "commit", "--quiet", "-m", "base"],
            cwd=self.repo,
            check=True,
        )
        self.fallow = self.root / "fallow"
        self.fallow.write_text(
            """#!/usr/bin/env python3
import os
import sys
if "--version" in sys.argv:
    print("fallow 3.23.0")
    raise SystemExit(0)
sys.stdout.write(os.environ.get("FAKE_FALLOW_OUTPUT", ""))
raise SystemExit(int(os.environ.get("FAKE_FALLOW_EXIT", "0")))
""",
            encoding="utf-8",
        )
        self.fallow.chmod(self.fallow.stat().st_mode | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def audit(self, payload: object | str, *, exit_code: int = 1) -> tuple[subprocess.CompletedProcess[str], dict]:
        output = payload if isinstance(payload, str) else json.dumps(payload)
        env = {
            **os.environ,
            "FALLOW_BIN": str(self.fallow),
            "FAKE_FALLOW_OUTPUT": output,
            "FAKE_FALLOW_EXIT": str(exit_code),
        }
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "diff-gate", "--repo", str(self.repo),
             "--base-ref", "HEAD"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            check=False,
        )
        return completed, json.loads(completed.stdout)

    @staticmethod
    def payload(*findings: dict, dead_code: dict | None = None, extra: dict | None = None) -> dict:
        value = {
            "verdict": "fail",
            "version": "3.23.0",
            "attribution": {
                "complexity_introduced": sum(item.get("introduced") is True for item in findings),
                "complexity_inherited": sum(item.get("introduced") is False for item in findings),
            },
            "complexity": {"findings": list(findings)},
            "dead_code": dead_code or {},
        }
        if extra:
            value.update(extra)
        return value

    def test_introduced_high_complexity_blocks_with_inherited_dead_code(self) -> None:
        payload = self.payload(
            {
                "path": "tests/linear-intake-revalidation.spec.ts",
                "name": "execute",
                "line": 32,
                "severity": "high",
                "crap": 97.0,
                "introduced": True,
                "actions": [{"description": "refactor", "path": "boundary/action"}],
            },
            dead_code={
                "unused_exports": [
                    {"path": "src/worker.ts", "name": "default", "introduced": False}
                ]
            },
        )
        completed, result = self.audit(payload)
        self.assertEqual(completed.returncode, 1, result)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(len(result["blocking_findings"]), 1)
        finding = result["blocking_findings"][0]
        self.assertEqual(finding["source_section"], "complexity")
        self.assertEqual(finding["finding_type"], "findings")
        self.assertEqual(finding["severity"], "high")
        self.assertIs(finding["introduced"], True)
        self.assertEqual(result["raw_summary"]["finding_count"], 2)

    def test_introduced_critical_complexity_blocks(self) -> None:
        completed, result = self.audit(self.payload({
            "path": "src/new.ts", "name": "criticalWork", "severity": "critical",
            "introduced": True,
        }))
        self.assertEqual(completed.returncode, 1, result)
        self.assertEqual(result["blocking_findings"][0]["severity"], "critical")

    def test_moderate_complexity_path_named_boundary_is_non_blocking(self) -> None:
        completed, result = self.audit(self.payload({
            "path": "tests/linear-intake-n1-boundary.spec.ts", "name": "fixture",
            "severity": "moderate", "introduced": True,
        }))
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["blocking_findings"], [])
        self.assertEqual(result["non_blocking_findings"][0]["source_section"], "complexity")

    def test_inherited_high_complexity_is_non_blocking(self) -> None:
        payload = self.payload({
            "path": "src/old.ts", "name": "legacy", "severity": "high",
            "introduced": False,
        })
        payload["attribution"]["duplication_introduced"] = 2
        payload["attribution"]["styling_introduced"] = 1
        payload["duplication"] = {
            "clone_groups": [{
                "introduced": True,
                "instances": [{"path": "src/old.ts"}, {"path": "src/copy.ts"}],
                "remediation": {"description": "extract shared code"},
            }]
        }
        completed, result = self.audit(payload)
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["status"], "pass")
        self.assertIs(result["non_blocking_findings"][0]["introduced"], False)

    def test_unclassified_introduced_failure_is_not_masked_by_inherited_debt(self) -> None:
        payload = self.payload(
            dead_code={
                "unused_exports": [
                    {"path": "src/old.ts", "name": "legacy", "introduced": False}
                ]
            },
            extra={
                "unknown_analysis": {
                    "findings": [
                        {"path": "src/new.ts", "severity": "error", "introduced": True}
                    ]
                }
            },
        )
        completed, result = self.audit(payload)
        self.assertEqual(completed.returncode, 1, result)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["blocking_findings"][0]["rule"], "fallow-verdict-fail-unclassified")
        self.assertEqual(result["raw_summary"]["introduced_unclassified_count"], 1)

    def test_unclassified_failure_without_attribution_blocks(self) -> None:
        payload = self.payload(
            dead_code={
                "unused_exports": [
                    {"path": "src/old.ts", "name": "legacy", "introduced": False}
                ]
            },
            extra={
                "unknown_analysis": {
                    "findings": [{"path": "src/unknown.ts", "severity": "warning"}]
                }
            },
        )
        completed, result = self.audit(payload)
        self.assertEqual(completed.returncode, 1, result)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["blocking_findings"][0]["rule"], "fallow-verdict-fail-unclassified")
        self.assertEqual(result["raw_summary"]["unknown_finding_count"], 1)

    def test_unknown_introduced_attribution_is_not_masked_by_inherited_debt(self) -> None:
        payload = self.payload(
            dead_code={
                "unused_exports": [
                    {"path": "src/old.ts", "name": "legacy", "introduced": False}
                ]
            },
        )
        payload["attribution"]["unknown_introduced"] = 1
        completed, result = self.audit(payload)
        self.assertEqual(completed.returncode, 1, result)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["blocking_findings"][0]["rule"], "fallow-verdict-fail-unclassified")
        self.assertEqual(result["raw_summary"]["unknown_introduced_attribution_count"], 1)

    def test_recognized_moderate_failure_can_pass(self) -> None:
        completed, result = self.audit(self.payload({
            "path": "src/new.ts", "name": "moderateWork", "severity": "moderate",
            "introduced": True,
        }))
        self.assertEqual(completed.returncode, 0, result)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["raw_summary"]["introduced_unclassified_count"], 0)

    def test_malformed_fallow_json_is_an_error(self) -> None:
        completed, result = self.audit("{not-json")
        self.assertEqual(completed.returncode, 3, result)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["blocking_findings"][0]["rule"], "fallow-json-uninterpretable")


if __name__ == "__main__":
    unittest.main()
