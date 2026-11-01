import copy
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("receipt", ROOT / "scripts/owner-test-evidence.py")
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class ReceiptTests(unittest.TestCase):
    def fixture(self):
        binding = dict(workspace_id="a" * 24, workspace_root="/workspace", state_dir="/state")
        manifest = dict(identity=dict(root="/workspace"), hashes={"src/a.ts": "b" * 64})
        diagnostic = dict(status="ready", omitted_entries=0, omitted_count_lines=0, truncated_fields=0)
        rows = [dict(command=["/scratch/bin/node", *c[1:]], exit_code=0, stop_reason=None, cleanup_failure=None,
                     diagnostics=diagnostic.copy(), test_counts=["Test Files 1 passed (1)", "Tests 12 passed (12)"] if i == 1 else [])
                for i, c in enumerate(receipt.COMMANDS)]
        result = dict(source=manifest, manifest_sha256="c" * 64, scratch="/scratch", commands=rows,
                      status="passed", source_after="matched")
        return binding, manifest, result

    def derive(self, data):
        return receipt.derive(*data, "c" * 64)

    def test_pass_is_derived_from_exact_four_commands(self):
        output = self.derive(self.fixture())
        self.assertEqual(output["result"]["status"], "passed")
        self.assertEqual(output["result"]["commands"][1]["counts"]["total"], 12)
        self.assertEqual(output["result_sha256"], receipt.digest(output["result"]))
        self.assertEqual(output["result"]["commands"][1]["test_files"]["total"], 1)

    def test_missing_or_contradictory_file_counts_never_pass(self):
        for lines in (["Tests 12 passed (12)"], ["Tests 12 passed (12)", "Test Files 2 passed (1)"],
                      ["Tests 12 passed (12)", "Test Files 13 passed (13)"]):
            data = self.fixture(); data[2]["commands"][1]["test_counts"] = lines
            self.assertNotEqual(self.derive(data)["result"]["status"], "passed")

    def test_no_forged_pass_from_absent_or_truncated_counts(self):
        for mutate in (lambda r: r["commands"][1].update(test_counts=[]),
                       lambda r: r["commands"][1]["diagnostics"].update(status="partial"),
                       lambda r: r.update(commands=r["commands"][:1])):
            data = self.fixture(); mutate(data[2])
            self.assertEqual(self.derive(data)["result"]["status"], "partial")

    def test_failed_partial_run_keeps_observed_counts_only(self):
        data = self.fixture(); r = data[2]
        r["commands"] = r["commands"][:2]
        r["commands"][1].update(exit_code=1, test_counts=["Tests 2 failed | 10 passed (12)"])
        output = self.derive(data)["result"]
        self.assertEqual(output["status"], "failed")
        self.assertEqual(output["commands"][1]["counts"]["failed"], 2)

    def test_changed_source_cannot_pass(self):
        data = self.fixture(); data[2]["source_after"] = "STALE_OR_UNREADABLE"
        self.assertEqual(self.derive(data)["result"]["status"], "failed")

    def test_command_and_binding_mismatch_refused(self):
        for mutate in (lambda d: d[2]["commands"][0].update(command=["arbitrary"]),
                       lambda d: d[0].update(workspace_root="/different"),
                       lambda d: d[2].update(manifest_sha256="d" * 64)):
            data = self.fixture(); mutate(data)
            with self.assertRaises(ValueError): self.derive(data)

    def test_malformed_counts_not_invented(self):
        for line in ("Tests all passed", "Tests 12 passed (13)", "Tests 12 passed | 12 passed (24)"):
            data = self.fixture(); data[2]["commands"][1]["test_counts"] = [line]
            self.assertIsNone(self.derive(data)["result"]["commands"][1]["counts"])

    def test_atomic_conflict_preserves_external_change(self):
        base = Path(os.environ.get("C2C_TEST_TMP_ROOT", ROOT / ".local/c2c-local-approval-audit-evidence/fixtures"))
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            file = Path(directory) / "receipt.json"
            fd = os.open(file, os.O_CREAT | os.O_WRONLY, 0o600); os.write(fd, b"old"); os.close(fd)
            original = tempfile.mkstemp
            def conflict(*args, **kwargs):
                file.write_bytes(b"external update")
                return original(*args, **kwargs)
            with patch.object(receipt.tempfile, "mkstemp", side_effect=conflict):
                with self.assertRaisesRegex(ValueError, "conflict"): receipt.atomic_publish(file, b"new")
            self.assertEqual(file.read_bytes(), b"external update")

    def test_writer_lock_conflict_never_overwrites(self):
        with patch.object(receipt.os, "open", side_effect=FileExistsError), patch.object(receipt.os, "replace") as replace:
            with self.assertRaises(FileExistsError): receipt.atomic_publish(Path("/state/receipt.json"), b"new")
            replace.assert_not_called()

    def test_replaced_lock_is_retained(self):
        owned = type("S", (), {"st_dev": 1, "st_ino": 1})()
        other = type("S", (), {"st_dev": 1, "st_ino": 2})()
        with patch.object(receipt.os, "open", return_value=42), patch.object(receipt.os, "fstat", return_value=owned), \
             patch.object(Path, "exists", return_value=False), patch.object(Path, "is_symlink", return_value=False), \
             patch.object(receipt.tempfile, "mkstemp", side_effect=RuntimeError("stop")), \
             patch.object(Path, "lstat", return_value=other), patch.object(receipt.os, "close"), patch.object(receipt.os, "unlink") as unlink:
            with self.assertRaises(RuntimeError): receipt.atomic_publish(Path("/state/test.json"), b"new")
            unlink.assert_not_called()

    def test_postrename_fsync_failure_reports_uncertain_durability(self):
        base = Path(os.environ.get("C2C_TEST_TMP_ROOT", ROOT / ".local/c2c-local-approval-audit-evidence/fixtures"))
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            file = Path(directory) / "receipt.json"
            original = os.fsync
            def fail_directory(fd):
                if receipt.stat.S_ISDIR(os.fstat(fd).st_mode): raise OSError("fixture directory fsync failure")
                original(fd)
            with patch.object(receipt.os, "fsync", side_effect=fail_directory):
                with self.assertRaisesRegex(RuntimeError, "receipt replaced"):
                    receipt.atomic_publish(file, b"new")
            self.assertEqual(file.read_bytes(), b"new")


if __name__ == "__main__":
    unittest.main()
