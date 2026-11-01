import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('verify_candidate', ROOT / 'scripts/verify-cross-chat-candidate.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in runner.INPUTS:
            target = self.root / name
            if '.' in name:
                target.write_text('{}')
            else:
                target.mkdir()
        (self.root / runner.RUNNER).write_text('# synthetic runner')
        (self.root / 'tests/new-test.ts').write_text('new modified test')

    def test_hashes_include_runner_and_new_tests(self):
        hashes = runner.snapshot(self.root)
        self.assertIn(runner.RUNNER, hashes)
        self.assertIn('tests/new-test.ts', hashes)
        self.assertEqual(hashes, runner.snapshot(self.root))

    def test_symlink_rejected(self):
        (self.root / 'src/link').symlink_to(self.root / 'package.json')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            runner.snapshot(self.root)

    def test_size_and_count_bounds(self):
        for key in ('file_bytes', 'total_bytes', 'files'):
            with patch.dict(runner.LIMITS, {key: 1}):
                with self.assertRaises(ValueError):
                    runner.snapshot(self.root)

    def test_stale_change_addition_deletion(self):
        with patch.object(runner, 'identity', return_value={'head': 'synthetic'}):
            original = runner.candidate(self.root)
            runner.recheck(self.root, original)
            target = self.root / 'src/new.ts'
            target.write_text('new')
            with self.assertRaisesRegex(ValueError, 'stale'):
                runner.recheck(self.root, original)
            target.unlink()
            target = self.root / 'package.json'
            target.write_text('changed')
            with self.assertRaisesRegex(ValueError, 'stale'):
                runner.recheck(self.root, original)
            target.unlink()
            with self.assertRaises(FileNotFoundError):
                runner.recheck(self.root, original)

    def test_wrong_identity(self):
        with patch.object(runner.subprocess, 'check_output', side_effect=[b'wrong', runner.HEAD.encode()]):
            with self.assertRaisesRegex(ValueError, 'branch/HEAD'):
                runner.identity(self.root)

    def test_preserve_refuses_overwrite(self):
        target = self.root / 'manifest.json'
        with patch.object(runner.os, 'getuid', return_value=os.getuid()):
            runner.preserve(target, b'original')
            with self.assertRaises(ValueError):
                runner.preserve(target, b'changed')
        self.assertEqual(target.read_bytes(), b'original')

    def test_timeout_only_own_group_reaped(self):
        proc = Mock(pid=12345, returncode=-9)
        proc.poll.return_value = None
        popen, kill = Mock(return_value=proc), Mock()
        select = Mock()
        select.__enter__ = Mock(return_value=select)
        select.__exit__ = Mock(return_value=False)
        result = runner.execute(['synthetic'], self.root, {}, self.root / 'timeout.log',
                                popen=popen, clock=Mock(side_effect=[0, 91]),
                                selector_factory=Mock(return_value=select), killpg=kill)
        self.assertEqual(result['stop_reason'], 'timeout')
        kill.assert_called_once_with(12345, runner.signal.SIGKILL)
        proc.wait.assert_called_once_with(timeout=5)
        self.assertTrue(popen.call_args.kwargs['start_new_session'])
        self.assertTrue((self.root / 'timeout.log').exists())

    def test_output_limit(self):
        proc = Mock(pid=12345, returncode=-9)
        proc.poll.return_value = None
        select = Mock()
        select.__enter__ = Mock(return_value=select)
        select.__exit__ = Mock(return_value=False)
        select.select.return_value = [True]
        with patch.dict(runner.LIMITS, output_bytes=4), patch.object(runner.os, 'read', return_value=b'abcdef'):
            result = runner.execute(['synthetic'], self.root, {}, self.root / 'limit.log',
                                    popen=Mock(return_value=proc), clock=lambda: 0,
                                    selector_factory=lambda: select, killpg=Mock())
        self.assertEqual(result['stop_reason'], 'output_limit')
        self.assertEqual((self.root / 'limit.log').stat().st_size, 4)

    def test_metadata_churn_hidden_sources_and_exclusions(self):
        with patch.object(runner, 'identity', return_value={}):
            original = runner.candidate(self.root)
            self.assertEqual(original['exclusions'], runner.EXCLUSIONS)
            for name in ('._source.ts', '.DS_Store'):
                (self.root / 'src' / name).write_text('metadata')
            cache = self.root / 'scripts/__pycache__'
            cache.mkdir()
            (cache / 'runner.pyc').write_bytes(b'cache')
            runner.recheck(self.root, original)
            (self.root / 'src/.DS_Store').write_text('changed metadata')
            runner.recheck(self.root, original)
            (self.root / 'src/.actual-source.ts').write_text('actual hidden source')
            with self.assertRaisesRegex(ValueError, 'stale'):
                runner.recheck(self.root, original)

    def test_excluded_symlinks_still_refused(self):
        (self.root / 'src/._metadata').symlink_to(self.root / 'package.json')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            runner.snapshot(self.root)

    def execute_fixture(self, proc, clock, ready=True):
        select = Mock()
        select.__enter__ = Mock(return_value=select)
        select.__exit__ = Mock(return_value=False)
        select.select.return_value = [True] if ready else []
        kill = Mock()
        with patch.object(runner.os, 'read', return_value=b''):
            result = runner.execute(['synthetic'], self.root, {}, self.root / 'execution.log',
                                    popen=Mock(return_value=proc), clock=clock,
                                    selector_factory=lambda: select, killpg=kill)
        return result, kill

    def test_normal_success_never_kills(self):
        proc = Mock(pid=12345, returncode=0)
        proc.poll.return_value = 0
        result, kill = self.execute_fixture(proc, lambda: 0)
        kill.assert_not_called()
        self.assertIsNone(result['cleanup_failure'])
        self.assertIsNone(result['stop_reason'])
        proc.wait.assert_called_once_with(timeout=5)

    def test_exited_leader_open_pipe_never_killed(self):
        proc = Mock(pid=12345, returncode=0)
        proc.poll.return_value = 0
        result, kill = self.execute_fixture(proc, lambda: 0, ready=False)
        kill.assert_not_called()
        self.assertIn('indeterminate', result['cleanup_failure'])
        self.assertEqual(result['stop_reason'], 'leader_exited_with_open_pipe')

    def test_timeout_with_exited_leader_never_killed(self):
        proc = Mock(pid=12345, returncode=0)
        proc.poll.return_value = 0
        result, kill = self.execute_fixture(proc, Mock(side_effect=[0, 91]))
        kill.assert_not_called()
        self.assertIn('indeterminate', result['cleanup_failure'])

    def test_wait_failure_reported(self):
        proc = Mock(pid=12345, returncode=None)
        proc.poll.return_value = None
        proc.wait.side_effect = runner.subprocess.TimeoutExpired('synthetic', 5)
        result, kill = self.execute_fixture(proc, Mock(side_effect=[0, 91]))
        self.assertIn('wait failed', result['cleanup_failure'])
        kill.assert_called_once_with(12345, runner.signal.SIGKILL)
        proc.wait.assert_called_once_with(timeout=5)

    def run_fixture(self, item, checks):
        base = self.root / 'evidence'
        base.mkdir()
        scratch = self.root / 'mock-owner-scratch'
        scratch.mkdir(mode=0o700)
        for fixed in runner.COMMANDS:
            target = self.root / fixed[1]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('synthetic')
        with patch.object(runner, 'ROOT', self.root), patch.object(runner, 'BASE', base), \
             patch.object(runner, 'owner_scratch', return_value=scratch), \
             patch.object(runner, 'scratch_preflight'), \
             patch.object(runner.shutil, 'which', return_value='/synthetic/node'), \
             patch.object(runner, 'recheck', side_effect=checks), \
             patch.object(runner, 'execute', return_value=item) as execute, \
             patch.object(runner, 'main', side_effect=lambda: runner.run({})):
            # Mocked main exercises CLI error propagation without invoking --run.
            code = runner.cli()
        result = json.loads(next(base.glob('run-*/result.json')).read_text())
        env = execute.call_args.args[2]
        self.assertTrue(env['PATH'].endswith(':/usr/bin:/bin:/usr/sbin:/sbin'))
        self.assertNotIn('OPENAI_API_KEY', env)
        for key in ('HOME', 'CODEX_HOME', 'C2C_STATE_DIR', 'C2C_TEST_TMP_ROOT', 'TMPDIR'):
            self.assertTrue(Path(env[key]).is_relative_to(scratch))
        return code, result, execute.call_count

    def test_redaction_and_safe_failed_diagnostics(self):
        secrets = ['c2c_admin_synthetic123', 'sk-proj-synthetic0123456789',
                   'syntheticbearer0123456789', 'syntheticcookie', 'syntheticpassword', 'synthetickeybody']
        text = ('FAIL tests/task-journal.test.ts > UNSAFE_STATE_DIRECTORY\n'
                'AssertionError: adminToken: "' + secrets[0] + '"\n'
                'Error: ' + secrets[1] + '\nError: Bearer ' + secrets[2] + '\n'
                'Error: Cookie: session=' + secrets[3] + '\n'
                'Error: password="' + secrets[4] + '"\n'
                '-----BEGIN PRIVATE KEY-----\n' + secrets[5] + '\n-----END PRIVATE KEY-----\n'
                'Tests 24 failed | 454 passed (478)\n')
        masked = runner.redact(text)
        report = runner.diagnostics(text, True)
        self.assertEqual(report['status'], 'ready')
        self.assertTrue(report['failures'])
        self.assertIn('task-journal.test.ts', masked)
        self.assertIn('UNSAFE_STATE_DIRECTORY', masked)
        for secret in secrets:
            self.assertNotIn(secret, masked + json.dumps(report))
        item = dict(exit_code=1, stop_reason=None, cleanup_failure=None, diagnostics=report)
        code, result, _ = self.run_fixture(item, None)
        exported = json.loads((self.root / result['diagnostics_path']).read_text())
        self.assertEqual(code, 1)
        self.assertTrue(exported['commands'][0]['failures'])
        for secret in secrets:
            self.assertNotIn(secret, json.dumps(exported))

    def test_diagnostics_overflow_and_masking_failure_closed(self):
        self.assertEqual(runner.diagnostics('FAIL x', True, True)['status'], 'not-ready')
        bounded = runner.diagnostics('FAIL ' + 'x' * 2049, True)
        self.assertEqual(bounded['status'], 'partial')
        self.assertEqual(len(bounded['failures'][0]['message']), 2048)
        self.assertEqual(bounded['truncated_fields'], 2)
        with patch.object(runner, 'redact', side_effect=ValueError('synthetic')):
            self.assertEqual(runner.diagnostics('secret', True)['failures'], [])

    def test_actual_scale_failure_prefix_preserved(self):
        token = 'c2c_admin_synthetic_scale_secret'
        lines = []
        for index in range(24):
            lines.extend([f'FAIL tests/task-journal.test.ts > case{index}',
                          'AssertionError: adminToken="' + token + '"'])
            if index < 23:
                lines.append('UNSAFE_STATE_DIRECTORY: synthetic fixture')
        self.assertEqual(len(lines), 71)
        lines.extend(['Test Files 6 failed', 'Tests 24 failed | 454 passed (478)'])
        report = runner.diagnostics('\n'.join(lines), True)
        self.assertEqual(report['status'], 'partial')
        self.assertEqual(len(report['failures']), 32)
        self.assertEqual(report['omitted_entries'], 39)
        self.assertEqual(report['omitted_count_lines'], 0)
        self.assertEqual(report['counts'], lines[-2:])
        self.assertEqual(report['failures'][0]['heading'], lines[0])
        self.assertIn('UNSAFE_STATE_DIRECTORY', json.dumps(report))
        self.assertNotIn(token, json.dumps(report))
        code, result, _ = self.run_fixture(dict(exit_code=1, stop_reason=None,
                                                cleanup_failure=None, diagnostics=report), None)
        self.assertEqual((code, result['status']), (1, 'failed'))
        exported = json.loads((self.root / result['diagnostics_path']).read_text())
        self.assertEqual(exported['commands'][0]['omitted_entries'], 39)
        self.assertNotIn(token, json.dumps(exported))

    def test_extra_counts_keep_safe_prefix(self):
        report = runner.diagnostics('Tests 1 failed\nTest Files 1 failed\nTests 2 failed', True)
        self.assertEqual(report['status'], 'partial')
        self.assertEqual(len(report['counts']), 2)
        self.assertEqual(report['omitted_count_lines'], 1)

    def test_scratch_source_separation(self):
        scratch = self.root / 'inside'
        scratch.mkdir()
        with self.assertRaisesRegex(ValueError, 'outside source'):
            runner.scratch_preflight(scratch, self.root)

    def test_unsupported_scratch_filesystem(self):
        scratch = self.root / 'scratch'
        scratch.mkdir(mode=0o700)
        with patch.object(Path, 'chmod', side_effect=OSError('unsupported')):
            with self.assertRaisesRegex(ValueError, 'chmod/hardlinks required'):
                runner.scratch_preflight(scratch, self.root / 'source')

    def test_unsupported_hardlink_preflight(self):
        scratch = self.root / 'scratch'
        scratch.mkdir(mode=0o700)
        with patch.object(Path, 'chmod'), patch.object(runner.stat, 'S_IMODE', side_effect=[0o750, 0o700, 0o644, 0o600, 0o700, 0o600]), \
             patch.object(runner.os, 'link', side_effect=OSError('ENOTSUP')):
            with self.assertRaisesRegex(ValueError, 'chmod/hardlinks required'):
                runner.scratch_preflight(scratch, self.root / 'source')

    def test_global_log_protection_unchanged(self):
        self.assertIn('"*.log"', (ROOT / 'src/workspace/ignore.ts').read_text())

    def test_command_failure_is_failed_nonzero_and_preserved(self):
        code, result, count = self.run_fixture(dict(exit_code=1, stop_reason=None, cleanup_failure=None), None)
        self.assertEqual((code, result['status'], count), (1, 'failed', 1))
        self.assertEqual(len(result['commands']), 1)

    def test_cleanup_failure_is_failed_nonzero_and_preserved(self):
        code, result, count = self.run_fixture(dict(exit_code=0, stop_reason=None, cleanup_failure='wait failed'), None)
        self.assertEqual((code, result['status'], count), (1, 'failed', 1))

    def test_final_source_mismatch_is_failed_nonzero(self):
        checks = [None] * 9 + [ValueError('stale')]
        code, result, count = self.run_fixture(dict(exit_code=0, stop_reason=None, cleanup_failure=None), checks)
        self.assertEqual((code, result['status'], count), (1, 'failed', 4))
        self.assertEqual(result['source_after'], 'STALE_OR_UNREADABLE')

    def test_after_command_mismatch_stops(self):
        code, result, count = self.run_fixture(dict(exit_code=0, stop_reason=None, cleanup_failure=None),
                                               [None, None, ValueError('stale'), None])
        self.assertEqual((code, result['status'], count), (1, 'failed', 1))


if __name__ == '__main__':
    unittest.main()
