#!/usr/bin/env python3
"""Prepare/verify a manifest-bound launch pair, without applying or starting it."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('startup_check', Path(__file__).with_name('check-startup-consistency.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def fail(code):
    raise check.Invalid(code)


def safe_path(value):
    p = Path(check.absolute(value))
    if p.is_symlink() or any(parent.is_symlink() for parent in p.parents):
        fail('SYMLINK_PATH')
    return p


def json_file(p):
    try:
        return json.loads(check.read_file(p), object_pairs_hook=check.unique_json)
    except check.Invalid:
        raise
    except (ValueError, UnicodeError):
        fail('MALFORMED_JSON')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(data):
    return (json.dumps(data, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode()


def release_manifest(root):
    root = safe_path(str(root))
    package = json_file(root / 'package.json')
    if not isinstance(package, dict) or package.get('name') != 'codex-with-chatgpt':
        fail('INVALID_PACKAGE')
    version = check.version(package.get('version'))
    for rel in ('src/version.ts', 'dist/version.js'):
        raw = check.read_file(safe_path(str(root / rel))).decode('utf8')
        values = re.findall(r'export\s+const\s+VERSION\s*=\s*[\'"]([^\'"]+)[\'"]\s*;', raw)
        if values != [version]:
            fail('RELEASE_VERSION_MISMATCH')
    mandatory = ['package.json', 'src/version.ts', 'dist/version.js',
                 'dist/cli/index.js', 'scripts/wait-for-bridge-and-connect.py']
    candidates = {Path(rel) for rel in mandatory}
    for base, pattern in [('src','*.ts'), ('dist','*.js'), ('scripts','*.py')]:
        candidates.update(p.relative_to(root) for p in (root / base).rglob(pattern))
    for rel in ['pnpm-lock.yaml','bin/c2c.js','assets/completion-sound.wav']:
        if (root / rel).exists():
            candidates.add(Path(rel))
    if not 5 <= len(candidates) <= 512:
        fail('RELEASE_FILE_LIMIT')
    files = {}
    for rel in sorted(candidates):
        if rel.is_absolute() or '..' in rel.parts:
            fail('RELEASE_PATH_INVALID')
        p = safe_path(str(root / rel))
        files[str(rel)] = digest(check.read_file(p))
    material = {'version':version, 'files':files}
    return {'formatVersion':1, 'releaseRoot':str(root), 'version':version,
            'releaseId':digest(encoded(material)), 'files':files}


def replace_flag(argv, flag, value):
    hits = [i for i,a in enumerate(argv) if a.partition('=')[0] == flag]
    if len(hits) != 1:
        fail('MISSING_OR_DUPLICATE_FLAG')
    i = hits[0]
    if '=' in argv[i]:
        argv[i] = flag + '=' + value
    else:
        argv[i + 1] = value


def templates(bridge_path, tunnel_path):
    bp, tp = safe_path(str(bridge_path)), safe_path(str(tunnel_path))
    if os.path.samefile(bp, tp):
        fail('DUPLICATE_INPUT')
    b, t = check.bridge(bp), check.tunnel(tp)
    for key in ('workspace_root','state_root','port'):
        if key not in b or key not in t:
            fail('INPUT_BINDING_INCOMPLETE')
        if b[key] != t[key]:
            fail('INPUT_' + key.upper() + '_MISMATCH')
    raw_b, raw_t = check.read_file(bp), check.read_file(tp)
    bdoc, tdoc = plistlib.loads(raw_b), plistlib.loads(raw_t)
    argv = bdoc['ProgramArguments']
    index = 1 if Path(argv[0]).name == 'node' else 0
    args = check.flags(argv[index + 2:], {'--workspace','--port','--external-base-url',
                       '--trusted-tunnel-token-file','--codex-execution','--codex-binary'},
                       ('--workspace','--port','--trusted-tunnel-token-file','--codex-execution'),
                       ('--codex-execution',))
    expected = str(Path(b['state_root']) / 'tunnel-auth' / (t['workspace_id'] + '.token'))
    if args['--trusted-tunnel-token-file'] != expected:
        fail('TOKEN_REFERENCE_BINDING_MISMATCH')
    for doc in [bdoc, tdoc]:
        if not isinstance(doc.get('Label'), str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',doc['Label']):
            fail('INVALID_SERVICE_LABEL')
    if bdoc['Label'] == tdoc['Label']:
        fail('DUPLICATE_SERVICE_LABEL')
    return bdoc, tdoc, raw_b, raw_t


def pair_from_manifest(manifest, bridge_doc, tunnel_doc):
    # Documents came from validated local templates. Only release references change.
    b = plistlib.loads(plistlib.dumps(bridge_doc))
    t = plistlib.loads(plistlib.dumps(tunnel_doc))
    root = Path(manifest['releaseRoot'])
    bi = 1 if Path(b['ProgramArguments'][0]).name == 'node' else 0
    old_entry = b['ProgramArguments'][bi]
    entry_rel = 'dist/cli/index.js' if old_entry.endswith('/dist/cli/index.js') else 'bin/c2c.js'
    if entry_rel not in manifest['files']:
        fail('RELEASE_ENTRY_MISSING')
    new_entry = str(root / entry_rel)
    b['ProgramArguments'][bi] = new_entry
    if bi == 0 and b.get('Program') == old_entry:
        b['Program'] = new_entry
    ti = 1 if Path(t['ProgramArguments'][0]).name in ('python','python3') else 0
    old_gate = t['ProgramArguments'][ti]
    new_gate = str(root / 'scripts/wait-for-bridge-and-connect.py')
    t['ProgramArguments'][ti] = new_gate
    if ti == 0 and t.get('Program') == old_gate:
        t['Program'] = new_gate
    replace_flag(t['ProgramArguments'], '--version', manifest['version'])
    env = b.get('EnvironmentVariables', {})
    sound = env.get('C2C_COMPLETION_SOUND_PATH')
    if sound:
        # Audio is owner-provided, not redistributed. Validate only the existing
        # reference and retain it; do not open, copy or play the recording.
        check.absolute(sound)
    return b, t


def write_private(p, raw):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        meta = os.fstat(out.fileno())
        if os.name != 'nt' and ((meta.st_mode & 0o077) or meta.st_uid != os.getuid()):
            fail('OUTPUT_NOT_OWNER_PRIVATE')
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())


def verify(bundle_dir):
    out = safe_path(str(bundle_dir))
    manifest = json_file(out / 'release-manifest.json')
    if not isinstance(manifest,dict) or not isinstance(manifest.get('releaseRoot'),str):
        fail('INVALID_MANIFEST')
    if manifest != release_manifest(manifest['releaseRoot']):
        fail('RELEASE_MANIFEST_MISMATCH')
    bundle = json_file(out / 'bundle.json')
    if not isinstance(bundle,dict) or bundle.get('formatVersion') != 1 or bundle.get('releaseId') != manifest['releaseId'] or bundle.get('liveApplied') is not False:
        fail('INVALID_BUNDLE')
    paths = ['bridge.plist','tunnel.plist','before/bridge.plist','before/tunnel.plist','release-manifest.json']
    hashes = {rel:digest(check.read_file(safe_path(str(out / rel)))) for rel in paths}
    if bundle.get('hashes') != hashes:
        fail('BUNDLE_HASH_MISMATCH')
    b,t,_,_ = templates(out/'before/bridge.plist', out/'before/tunnel.plist')
    expected_b,expected_t = pair_from_manifest(manifest,b,t)
    if (plistlib.loads(check.read_file(out/'bridge.plist')) != expected_b or
            plistlib.loads(check.read_file(out/'tunnel.plist')) != expected_t):
        fail('GENERATED_PAIR_MISMATCH')
    bv,tv = check.bridge(out/'bridge.plist'),check.tunnel(out/'tunnel.plist')
    if any(bv.get(k) != tv.get(k) for k in ['version','workspace_root','state_root','port']):
        fail('GENERATED_BINDING_MISMATCH')
    if bv['version'] != manifest['version']:
        fail('GENERATED_VERSION_MISMATCH')
    return {'status':'verified_not_applied','version':manifest['version'],
            'releaseId':manifest['releaseId'],'liveApplied':False,
            'next_action':'REVIEW_DIFF_AND_COORDINATE_OWNER_APPROVED_CUTOVER'}


def prepare(root, bridge_path, tunnel_path, output):
    out = safe_path(str(output))
    if any(part in ('LaunchAgents','LaunchDaemons') for part in out.parts):
        fail('LIVE_OUTPUT_FORBIDDEN')
    if out.exists():
        fail('OUTPUT_EXISTS')
    if not out.parent.is_dir():
        fail('OUTPUT_PARENT_MISSING')
    manifest = release_manifest(root)
    b,t,raw_b,raw_t = templates(bridge_path,tunnel_path)
    generated_b,generated_t = pair_from_manifest(manifest,b,t)
    os.mkdir(out,0o700)
    os.mkdir(out/'before',0o700)
    items = {'bridge.plist':plistlib.dumps(generated_b), 'tunnel.plist':plistlib.dumps(generated_t),
             'before/bridge.plist':raw_b,'before/tunnel.plist':raw_t,
             'release-manifest.json':encoded(manifest)}
    for rel,raw in items.items():
        write_private(out/rel,raw)
    write_private(out/'bundle.json',encoded({'formatVersion':1,'releaseId':manifest['releaseId'],
                  'liveApplied':False,'hashes':{rel:digest(raw) for rel,raw in items.items()}}))
    # A bundle is never considered usable until verify succeeds. No live operations.
    return verify(out)


def main(argv):
    try:
        if '--verify-bundle' in argv or any(a.startswith('--verify-bundle=') for a in argv):
            args=check.flags(argv,{'--verify-bundle'},('--verify-bundle',))
            result=verify(args['--verify-bundle'])
        else:
            names=('--release-root','--bridge-plist','--tunnel-plist','--output-dir')
            args=check.flags(argv,set(names),names)
            result=prepare(*(args[n] for n in names))
        print(json.dumps(result))
        return 0
    except check.Invalid as error:
        code=str(error)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        code='INVALID_OR_UNREADABLE_INPUT'
    print(json.dumps({'status':'blocked','code':code,'liveApplied':False,
                      'next_action':'REVIEW_INPUTS_WITHOUT_CHANGING_RUNNING_SERVICES'}))
    return 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
