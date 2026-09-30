"""Synthetic launch configurations only; no network or service mutations."""
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
CHECKER = REPO / 'scripts/check-startup-consistency.py'
SECRET = 'DO_NOT_PRINT_CREDENTIAL_SENTINEL'

class StartupConsistencyTests(unittest.TestCase):
    def setUp(self):
        (REPO / '.tooling').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='startup-unit-', dir=REPO / '.tooling')
        self.root = Path(self.temp.name)
        release = self.root / 'release'
        entry = release / 'dist/cli/index.js'
        entry.parent.mkdir(parents=True)
        entry.write_text('throw new Error("MUST_NOT_EXECUTE");\n')
        self.package = release / 'package.json'
        self.package.write_text(json.dumps({'name':'codex-with-chatgpt','version':'0.3.0-next.18'}))
        gate = release / 'scripts/wait-for-bridge-and-connect.py'
        gate.parent.mkdir()
        gate.write_text('raise RuntimeError("MUST_NOT_EXECUTE")\n')
        self.bp, self.tp = self.root / 'bridge.plist', self.root / 'tunnel.plist'
        self.b = {'ProgramArguments':['/usr/bin/node',str(entry),'serve','--workspace',str(self.root / 'project'),'--port','48765'],
                  'EnvironmentVariables':{'C2C_STATE_DIR':str(self.root / 'state'),'PRIVATE_TOKEN':SECRET}}
        self.t = {'ProgramArguments':['/usr/bin/python3',str(gate),'--state-root',str(self.root / 'state'),
                  '--workspace-id','aaaaaaaaaaaaaaaaaaaaaaaa','--workspace-root',str(self.root / 'project'),
                  '--port','48765','--version','0.3.0-next.18','--tunnel-client','/not/executed',
                  '--tunnel-id',SECRET,'--timeout-seconds','120']}
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.bp.write_bytes(plistlib.dumps(self.b))
        self.tp.write_bytes(plistlib.dumps(self.t))

    def set_flag(self, config, flag, value):
        args = config['ProgramArguments']
        args[args.index(flag) + 1] = value
        self.save()

    def check(self, args=None):
        if args is None:
            args = ['--bridge-plist',str(self.bp),'--tunnel-plist',str(self.tp)]
        result = subprocess.run([sys.executable,'-B',str(CHECKER),*args],text=True,capture_output=True,timeout=5)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertLess(len(result.stdout), 4096)
        return result.returncode, json.loads(result.stdout)

    def assert_blocked(self, code):
        rc, report = self.check()
        self.assertEqual(rc, 1)
        self.assertEqual(report['status'], 'blocked')
        self.assertIn(code, [item['code'] for item in report['findings']])

    def test_matching_is_read_only_and_discloses_unverified_identity(self):
        before = {p.relative_to(self.root):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        rc, report = self.check()
        self.assertEqual(rc, 0)
        self.assertEqual(report['status'], 'consistent_provided_fields')
        self.assertIn('workspace_id', report['unverified'])
        self.assertIn('version', report['compared'])
        after = {p.relative_to(self.root):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_current_18_vs_14_mismatch(self):
        self.set_flag(self.t, '--version', '0.3.0-next.14')
        self.assert_blocked('VERSION_MISMATCH')

    def test_wrong_workspace(self):
        self.set_flag(self.t, '--workspace-root', str(self.root / 'other'))
        self.assert_blocked('WORKSPACE_ROOT_MISMATCH')

    def test_wrong_state_root(self):
        self.set_flag(self.t, '--state-root', str(self.root / 'other-state'))
        self.assert_blocked('STATE_ROOT_MISMATCH')

    def test_invalid_ports(self):
        for value in ['0','65536','abc','-2']:
            with self.subTest(port=value):
                self.set_flag(self.t, '--port', value)
                rc, report = self.check()
                self.assertEqual(rc, 1)
                self.assertEqual(report['status'], 'blocked')

    def test_missing_required_flag(self):
        args=self.b['ProgramArguments']; i=args.index('--workspace'); del args[i:i+2]
        self.save(); self.assert_blocked('MISSING_FLAG')

    def test_duplicate_flag(self):
        self.t['ProgramArguments'] += ['--version','0.3.0-next.18']
        self.save(); self.assert_blocked('DUPLICATE_FLAG')

    def test_missing_flag_value(self):
        args=self.t['ProgramArguments']; i=args.index('--timeout-seconds'); del args[i:i+2]
        args.append('--timeout-seconds')
        self.save(); self.assert_blocked('MISSING_FLAG_VALUE')

    def test_malformed_plist(self):
        self.tp.write_text('not a plist')
        self.assert_blocked('MALFORMED_PLIST')

    def test_missing_input(self):
        self.tp.unlink(); self.assert_blocked('MISSING_OR_UNREADABLE_FILE')

    def test_duplicate_input(self):
        rc, report = self.check(['--bridge-plist',str(self.bp),'--tunnel-plist',str(self.bp)])
        self.assertEqual(rc,1); self.assertEqual(report['findings'][0]['code'],'DUPLICATE_INPUT')

    def test_duplicate_package_key(self):
        self.package.write_text('{"name":"codex-with-chatgpt","version":"0.3.0-next.18","version":"0.3.0-next.14"}')
        self.assert_blocked('DUPLICATE_KEY')

if __name__ == '__main__':
    unittest.main()
