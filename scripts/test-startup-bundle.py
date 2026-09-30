"""Fixture-only generation/verification tests; never starts real services."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('startup_fixtures',Path(__file__).with_name('test-startup-consistency.py'))
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
GEN=Path(__file__).with_name('prepare-startup-bundle.py')

class ReleaseBundleTests(unittest.TestCase):
    def setUp(self):
        base.StartupConsistencyTests.setUp(self)
        self.release=self.package.parent
        (self.release/'src').mkdir()
        (self.release/'src/version.ts').write_text('export const VERSION = "0.3.0-next.18";\n')
        (self.release/'dist/version.js').write_text('export const VERSION = "0.3.0-next.18";\n')
        self.b['Label']='tech.test.bridge'
        self.t['Label']='tech.test.tunnel'
        self.b['ProgramArguments']+=['--trusted-tunnel-token-file',str(self.root/'state/tunnel-auth/aaaaaaaaaaaaaaaaaaaaaaaa.token'),'--codex-execution']
        a=self.t['ProgramArguments'];a[a.index('--version')+1]='0.3.0-next.14'
        self.save()
        self.output=self.root/'prepared'

    tearDown=base.StartupConsistencyTests.tearDown
    save=base.StartupConsistencyTests.save

    def run_generator(self,verify=False,extra=None):
        args=['--verify-bundle',str(self.output)] if verify else [
            '--release-root',str(self.release),'--bridge-plist',str(self.bp),
            '--tunnel-plist',str(self.tp),'--output-dir',str(self.output)]
        result=subprocess.run([sys.executable,'-B',str(GEN),*args,*(extra or [])],text=True,capture_output=True,timeout=5)
        self.assertNotIn(base.SECRET,result.stdout+result.stderr)
        self.assertLess(len(result.stdout),4096)
        return result.returncode,json.loads(result.stdout)

    def expect_blocked(self,code,verify=False):
        rc,obj=self.run_generator(verify)
        self.assertEqual((rc,obj['status'],obj['code']),(1,'blocked',code))
        self.assertIs(obj['liveApplied'],False)

    def test_common_manifest_generates_matching_pair_and_preserves_originals(self):
        before=(self.bp.read_bytes(),self.tp.read_bytes())
        rc,obj=self.run_generator()
        self.assertEqual(rc,0);self.assertEqual(obj['status'],'verified_not_applied')
        self.assertEqual((self.bp.read_bytes(),self.tp.read_bytes()),before)
        self.assertEqual((self.output/'before/bridge.plist').read_bytes(),before[0])
        self.assertEqual((self.output/'before/tunnel.plist').read_bytes(),before[1])
        m=json.loads((self.output/'release-manifest.json').read_text())
        b=plistlib.loads((self.output/'bridge.plist').read_bytes())
        t=plistlib.loads((self.output/'tunnel.plist').read_bytes())
        self.assertEqual(b['EnvironmentVariables'],self.b['EnvironmentVariables'])
        self.assertEqual(t['ProgramArguments'][t['ProgramArguments'].index('--version')+1],m['version'])
        self.assertEqual(t['ProgramArguments'][1],str(self.release/'scripts/wait-for-bridge-and-connect.py'))
        self.assertEqual(self.run_generator(True)[0],0)
        if os.name!='nt':
            self.assertEqual(self.output.stat().st_mode&0o777,0o700)
            for p in self.output.rglob('*'):
                # Some external volumes report an extra owner execute bit.
                if p.is_file():self.assertEqual(p.stat().st_mode&0o077,0)

    def test_modified_launch_file_rejected(self):
        self.assertEqual(self.run_generator()[0],0)
        p=self.output/'tunnel.plist';doc=plistlib.loads(p.read_bytes());a=doc['ProgramArguments'];a[a.index('--version')+1]='0.3.0-next.14';p.write_bytes(plistlib.dumps(doc))
        self.expect_blocked('BUNDLE_HASH_MISMATCH',True)

    def test_modified_release_after_preparation_rejected(self):
        self.assertEqual(self.run_generator()[0],0)
        (self.release/'dist/cli/index.js').write_text('CHANGED_BUILD')
        self.expect_blocked('RELEASE_MANIFEST_MISMATCH',True)

    def test_package_source_build_must_agree(self):
        (self.release/'dist/version.js').write_text('export const VERSION = "0.3.0-next.14";\n')
        self.expect_blocked('RELEASE_VERSION_MISMATCH')
        self.assertFalse(self.output.exists())

    def test_cannot_change_workspace_binding_to_fix_version(self):
        a=self.t['ProgramArguments'];a[a.index('--workspace-root')+1]=str(self.root/'wrong');self.save()
        self.expect_blocked('INPUT_WORKSPACE_ROOT_MISMATCH')

    def test_token_reference_must_match_id_and_state(self):
        a=self.b['ProgramArguments'];a[a.index('--trusted-tunnel-token-file')+1]=str(self.root/'wrong.token');self.save()
        self.expect_blocked('TOKEN_REFERENCE_BINDING_MISMATCH')

    def test_output_cannot_overwrite_existing_directory(self):
        self.output.mkdir();p=self.output/'keep.txt';p.write_text('KEEP')
        self.expect_blocked('OUTPUT_EXISTS');self.assertEqual(p.read_text(),'KEEP')

    def test_never_writes_live_launchagent_directory(self):
        self.output=self.root/'Library/LaunchAgents/c2c'
        self.expect_blocked('LIVE_OUTPUT_FORBIDDEN');self.assertFalse((self.root/'Library').exists())

    def test_symlink_release_rejected(self):
        alias=self.root/'linked-release';alias.symlink_to(self.release,target_is_directory=True);self.release=alias
        self.expect_blocked('SYMLINK_PATH')

    def test_missing_version_proof_rejected(self):
        (self.release/'src/version.ts').unlink()
        self.expect_blocked('MISSING_OR_UNREADABLE_FILE')

    def test_duplicate_flags_rejected_without_output(self):
        rc,obj=self.run_generator(extra=['--release-root',str(self.release)])
        self.assertEqual((rc,obj['code']),(1,'DUPLICATE_FLAG'));self.assertFalse(self.output.exists())

    def test_manifest_tampering_rejected(self):
        self.assertEqual(self.run_generator()[0],0)
        p=self.output/'release-manifest.json';doc=json.loads(p.read_text());doc['releaseId']='0'*64;p.write_text(json.dumps(doc))
        self.expect_blocked('RELEASE_MANIFEST_MISMATCH',True)


    def test_personal_audio_reference_is_preserved_without_bundling_or_opening_it(self):
        sound=str(self.root/'owner-audio/not-distributed.wav')
        self.b['EnvironmentVariables']['C2C_COMPLETION_SOUND_PATH']=sound
        self.save()
        self.assertEqual(self.run_generator()[0],0)
        generated=plistlib.loads((self.output/'bridge.plist').read_bytes())
        self.assertEqual(generated['EnvironmentVariables']['C2C_COMPLETION_SOUND_PATH'],sound)
        self.assertFalse(Path(sound).exists())
        self.assertEqual(self.run_generator(True)[0],0)

    def test_relative_personal_audio_reference_is_rejected(self):
        self.b['EnvironmentVariables']['C2C_COMPLETION_SOUND_PATH']='relative/private.wav'
        self.save()
        rc,report=self.run_generator()
        self.assertEqual(rc,1)
        self.assertEqual(report['status'],'blocked')
        self.assertFalse(self.output.exists())

if __name__=='__main__':unittest.main()
