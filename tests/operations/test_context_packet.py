from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "operations" / "context_packet.py"
SPEC = importlib.util.spec_from_file_location("context_packet", SCRIPT)
assert SPEC and SPEC.loader
context_packet = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(context_packet)


def checkpoint() -> dict:
    return {
        "objective": "Review candidate without claiming permission",
        "current_gate": "candidate review",
        "mandate": {"current": "Read and review only", "superseded_instructions": ["Older write permission was revoked"]},
        "stop_conditions": ["Stop before any provider action"],
        "hard_constraints": ["Never deploy", "Keep candidate identity exact"],
        "budgets": ["One review pass"],
        "known_facts": [f"fact-{index}-" + "x" * 300 for index in range(80)],
        "decisions": ["Reviewer owns the verdict"],
        "unknowns": ["Whether the native wake remains available"],
        "open_risks": ["Candidate may differ from the reviewed base"],
        "owners": ["Council reviewer: thread-123"],
        "evidence_collected": [f"evidence-{index}-" + "y" * 300 for index in range(80)],
        "files_touched": [f"path/to/file-{index}.txt" for index in range(80)],
        "next_action": "Verify candidate and base before review",
        "next_checkpoint": "After review evidence is collected",
        "volatile_state": ["Re-check repository, permissions, and agent state"],
        "checkpoint": {"created_at": "2026-10-05T10:00:00Z", "source": "test"},
    }


def subject() -> dict:
    return {
        "repoPath": "/work/repository",
        "baseSha": "a" * 40,
        "candidateSha": "b" * 40,
        "missionId": "mission-S4",
    }


class ContextPacketTests(unittest.TestCase):
    def build(self, state: dict | None = None, limit: int = 5_000):
        state = state or checkpoint()
        raw = json.dumps(state).encode()
        return context_packet.build_packet(state, subject(), Path("/tmp/state.json"), hashlib.sha256(raw).hexdigest(), limit)

    def test_essential_fields_and_identity_survive_huge_optional_history(self):
        packet, encoded = self.build()
        self.assertLessEqual(len(encoded), 5_000)
        self.assertEqual(packet["subject"]["status"], "supplied_unverified")
        for key, value in subject().items():
            self.assertEqual(packet["subject"][key], value)
        mission = packet["mission"]
        self.assertEqual(mission["mandate"]["current"], "Read and review only")
        self.assertEqual(mission["mandate"]["supersededInstructions"], ["Older write permission was revoked"])
        self.assertEqual(mission["hardConstraints"], checkpoint()["hard_constraints"])
        self.assertEqual(mission["openRisks"], checkpoint()["open_risks"])
        self.assertEqual(mission["volatileFactsToVerify"], checkpoint()["volatile_state"])

    def test_mandate_extensions_are_preserved_as_essential_sourced_data(self):
        state = checkpoint()
        extensions = {
            "emergency_stop": "never publish",
            "sourceExtensions": {"nestedCollision": "remains source data"},
            "review_policy": {"required": True, "roles": ["security", "quality"]},
        }
        state["mandate"].update(extensions)
        packet, _ = self.build(state)
        self.assertEqual(packet["mission"]["mandate"]["sourceExtensions"], extensions)

        # Optional history cannot be traded away to hide an oversized mandate clause.
        for field in ("known_facts", "evidence_collected", "files_touched"):
            state[field] = []
        state["mandate"]["emergency_stop"] = "never publish " + "z" * 3_000
        with self.assertRaisesRegex(context_packet.PacketError, "essential safety/identity"):
            self.build(state, limit=2_000)

    def test_optional_omission_accounting_is_complete(self):
        packet, _ = self.build()
        mapping = {"knownFacts": "known_facts", "evidenceCollected": "evidence_collected", "filesTouched": "files_touched"}
        for output_name, source_name in mapping.items():
            record = packet["omissions"][output_name]
            self.assertEqual(record["total"], len(checkpoint()[source_name]))
            self.assertEqual(record["included"] + record["omitted"], record["total"])
            self.assertEqual(record["included"], len(packet["optional"][output_name]))
            self.assertEqual(record["truncated"], 0)
            covered = sum(end - start + 1 for start, end in record["includedRanges"] + record["omittedRanges"])
            self.assertEqual(covered, record["total"])
        self.assertGreater(sum(item["omitted"] for item in packet["omissions"].values()), 0)

    def test_too_small_budget_fails_instead_of_dropping_essential_data(self):
        with self.assertRaisesRegex(context_packet.PacketError, "essential safety/identity"):
            self.build(limit=1_200)

    def test_missing_critical_field_and_invalid_subject_fail(self):
        state = checkpoint()
        del state["open_risks"]
        with self.assertRaisesRegex(context_packet.PacketError, "open_risks"):
            self.build(state)
        bad_subject = subject()
        bad_subject["candidateSha"] = "main"
        with self.assertRaisesRegex(context_packet.PacketError, "candidateSha"):
            context_packet.build_packet(checkpoint(), bad_subject, Path("/tmp/state.json"), "0" * 64, 5_000)
        bad_subject["candidateSha"] = "c" * 41
        with self.assertRaisesRegex(context_packet.PacketError, "40 or 64"):
            context_packet.build_packet(checkpoint(), bad_subject, Path("/tmp/state.json"), "0" * 64, 5_000)

    def test_bounded_reader_rejects_oversized_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "oversized.json"
            path.write_text(json.dumps({"value": "x" * 100}), encoding="utf-8")
            with self.assertRaisesRegex(context_packet.PacketError, "exceeds 32 bytes"):
                context_packet._read_json(path, 32, "state")

    def test_secret_and_raw_prompt_fields_fail(self):
        for key, value in (("api_key", "redacted"), ("raw_prompt", "entire prompt")):
            state = checkpoint()
            state[key] = value
            with self.assertRaises(context_packet.PacketError):
                self.build(state)

    def test_timestamp_only_change_keeps_semantic_digest(self):
        first, _ = self.build()
        later = checkpoint()
        later["checkpoint"]["created_at"] = "2026-10-05T11:00:00Z"
        second, _ = self.build(later)
        self.assertEqual(first["semanticSha256"], second["semanticSha256"])

    def test_cli_writes_new_packet_without_modifying_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path, subject_path, output = root / "state.json", root / "subject.json", root / "packet.json"
            state_path.write_text(json.dumps(checkpoint()), encoding="utf-8")
            subject_path.write_text(json.dumps(subject()), encoding="utf-8")
            before = state_path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--state", str(state_path), "--subject", str(subject_path),
                 "--max-bytes", "5000", "--output", str(output)],
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout)
            self.assertEqual(summary["status"], "written")
            self.assertLessEqual(summary["bytes"], 5_000)
            self.assertEqual(state_path.read_bytes(), before)
            packet = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(packet["source"]["sha256"], hashlib.sha256(before).hexdigest())
            again = subprocess.run(
                [sys.executable, str(SCRIPT), "--state", str(state_path), "--subject", str(subject_path),
                 "--max-bytes", "5000", "--output", str(output)],
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(again.returncode, 2)
            self.assertIn("refusing to overwrite", again.stderr)

    def test_cli_rejects_dangling_output_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path, subject_path = root / "state.json", root / "subject.json"
            output, target = root / "packet.json", root / "uncreated-target.json"
            state_path.write_text(json.dumps(checkpoint()), encoding="utf-8")
            subject_path.write_text(json.dumps(subject()), encoding="utf-8")
            output.symlink_to(target)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--state", str(state_path), "--subject", str(subject_path),
                 "--max-bytes", "5000", "--output", str(output)],
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("symbolic link", result.stderr)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
