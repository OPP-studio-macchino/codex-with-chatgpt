#!/usr/bin/env python3
"""Owner-run verification, not a sandbox or deployment approval."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time

ROOT = Path('/Volumes/ORICO/O.P.P Studio/codex-with-chatgpt-refactor-20260930')
BRANCH = 'feat/product-ux-no-mention-20260930'
HEAD = 'cbd9be1194ddb4f971f5f31e4ae03485d1bf1344'
RUNNER = 'scripts/verify-cross-chat-candidate.py'
INPUTS = ('src', 'tests', 'scripts', 'skill', 'package.json', 'pnpm-lock.yaml',
          'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts')
LIMITS = dict(seconds=90, cleanup_seconds=5, output_bytes=2 * 1024 * 1024, workers=2,
              files=10000, file_bytes=8 * 1024 * 1024, total_bytes=64 * 1024 * 1024)
BASE = ROOT / '.local/cross-chat-verification'
EXCLUSIONS = ['AppleDouble basenames ._*', '.DS_Store', '__pycache__ directories']
COMMANDS = (('node', 'node_modules/typescript/bin/tsc', '--noEmit'),
            ('node', 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--minWorkers=1'),
            ('node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'),
            ('node', 'scripts/validate-skill.mjs'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def safe(path, directory=False):
    info = path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('unsafe file type: ' + str(path))
    return info


def snapshot(root):
    hashes, total, entries = {}, 0, 0

    def visit(path, excluded=False):
        nonlocal total, entries
        entries += 1
        if entries > LIMITS['files']:
            raise ValueError('input count limit')
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('input symlink')
        excluded = excluded or path.name.startswith('._') or path.name == '.DS_Store'
        excluded = excluded or (path.name == '__pycache__' and stat.S_ISDIR(info.st_mode))
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir()):
                visit(child, excluded)
        else:
            safe(path)
            if excluded:
                return
            if info.st_size > LIMITS['file_bytes']:
                raise ValueError('file size limit')
            total += info.st_size
            if total > LIMITS['total_bytes']:
                raise ValueError('total size limit')
            with path.open('rb') as stream:
                data = stream.read(LIMITS['file_bytes'] + 1)
            if len(data) != info.st_size:
                raise ValueError('input changed while reading')
            hashes[str(path.relative_to(root))] = digest(data)
    for name in INPUTS:
        visit(root / name)
    return hashes


def identity(root):
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(root / '.local'),
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'}
    def git(*args):
        return subprocess.check_output(['/usr/bin/git', '-c', 'core.filemode=false', '-C', str(root), *args],
                                       env=env, timeout=10, stderr=subprocess.DEVNULL).decode().strip()
    branch, head = git('branch', '--show-current'), git('rev-parse', 'HEAD')
    if (branch, head) != (BRANCH, HEAD):
        raise ValueError('branch/HEAD mismatch')
    if git('check-ignore', '.local/cross-chat-verification/probe') != '.local/cross-chat-verification/probe':
        raise ValueError('evidence directory is not excluded')
    return {'root': str(root), 'branch': branch, 'head': head}


def candidate(root):
    return {'identity': identity(root), 'hashes': snapshot(root), 'limits': LIMITS,
            'exclusions': EXCLUSIONS,
            'commands': [list(c) for c in COMMANDS], 'NOT_APPLIED': True,
            'real_codex_e2e': 'NOT_RUN'}


def recheck(root, manifest):
    if candidate(root) != manifest:
        raise ValueError('stale manifest/source identity')


def private_dir(path):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o700)
    info = safe(path, True)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('directory must already be owner-private: ' + str(path))


def preserve(path, data):
    if path.exists() or path.is_symlink():
        info = safe(path)
        if info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size != len(data) or path.read_bytes() != data:
            raise ValueError('refusing existing differing/unsafe evidence: ' + str(path))
        return
    with path.open('xb') as stream:
        stream.write(data)


def redact(text):
    """Bounded stdlib equivalent of C2C credential rules, with assignment coverage.

    No Node helper/process is needed before the fixed verification commands.
    This is credential masking, not proof that arbitrary PII is absent.
    """
    if len(text.encode()) > LIMITS['output_bytes']:
        raise ValueError('diagnostics input overflow')
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----.*?(?:-----END \1-----|\Z)',
                  '[REDACTED PRIVATE KEY]', text, flags=re.S)
    patterns = (
        r'\bc2c_(?:at|rt|ac|admin|tunnel)_[A-Za-z0-9_-]+',
        r'\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+',
        r'\bsk-(?:proj-)?[A-Za-z0-9_-]+',
        r'\b(?:github_pat_|gh[opusr]_|glpat-|xox[baprs]-|npm_|pypi-|hf_|xai-)[A-Za-z0-9_-]+',
        r'\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})',
        r'\bBearer\s+[A-Za-z0-9._~+/=-]+',
        r'https?://[^\s/:@]+:[^\s/@]+@',
    )
    for pattern in patterns:
        text = re.sub(pattern, '[REDACTED]', text, flags=re.I)
    # Mask the whole assignment tail, including quoted diff values and cookies.
    keys = r'(?:[A-Z_]*(?:API_KEY|SECRET_KEY|SECRET_ACCESS_KEY|TOKEN)|adminToken|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key|cookie|set-cookie|DATABASE_URL)'
    text = re.sub(r'\b' + keys + r'''["'`]?\s*[:=][^\r\n]*''', '[REDACTED ASSIGNMENT]', text, flags=re.I)
    return text


def diagnostics(text, failed, overflow=False):
    report = {'kind': 'DERIVED', 'status': 'ready', 'counts': [], 'failures': [],
              'omitted_entries': 0, 'omitted_count_lines': 0, 'truncated_fields': 0}
    try:
        if overflow:
            raise ValueError('capture overflow')
        text = redact(text)
        for line in text.splitlines():
            line = line.strip()
            if re.match(r'^\s*(Tests|Test Files)\s+', line):
                if len(report['counts']) < 2:
                    report['counts'].append(line[:256])
                    report['truncated_fields'] += int(len(line) > 256)
                else:
                    report['omitted_count_lines'] += 1
            if re.search(r'\bFAIL\b|(?:Assertion|Type|Range)?Error:|UNSAFE_[A-Z_]+|ENOTSUP|expected .*|timed out', line):
                if len(report['failures']) >= 32:
                    report['omitted_entries'] += 1
                    continue
                report['failures'].append({'heading': line[:256], 'message': line[:2048]})
                report['truncated_fields'] += int(len(line) > 256) + int(len(line) > 2048)
        if report['omitted_entries'] or report['omitted_count_lines'] or report['truncated_fields']:
            report['status'] = 'partial'
        if failed and not report['failures']:
            report['failures'] = [{'heading': 'Command failed', 'message': 'No recognized failure heading; inspect private evidence locally.'}]
    except Exception:
        report = {'kind': 'DERIVED', 'status': 'not-ready', 'counts': [], 'failures': [],
                  'omitted_entries': None, 'omitted_count_lines': None, 'truncated_fields': 0}
    return report


def scratch_preflight(scratch, root):
    if scratch.resolve().is_relative_to(root.resolve()) or root.resolve().is_relative_to(scratch.resolve()):
        raise ValueError('synthetic scratch must be outside source checkout')
    private_dir(scratch)
    probe = scratch / 'filesystem-probe'
    probe.mkdir(mode=0o700)
    source = probe / 'file'
    source.write_bytes(b'fixture')
    try:
        for target, modes in ((probe, (0o750, 0o700)), (source, (0o644, 0o600, 0o700, 0o600))):
            for mode in modes:
                target.chmod(mode)
                if stat.S_IMODE(target.stat().st_mode) != mode:
                    raise ValueError('chmod semantics unsupported')
        link = probe / 'hardlink'
        os.link(source, link)
        if not source.samefile(link) or source.stat().st_nlink < 2:
            raise ValueError('hardlink semantics unsupported')
    except (OSError, ValueError) as exc:
        raise ValueError('scratch filesystem preflight failed: chmod/hardlinks required') from exc


def owner_scratch():
    # Called only from the explicit owner --run path; retained for audit.
    return Path(tempfile.mkdtemp(prefix='c2c-verification-', dir='/private/tmp'))


def execute(command, cwd, env, log, popen=subprocess.Popen, clock=time.monotonic,
            selector_factory=selectors.DefaultSelector, killpg=os.killpg):
    """Bound combined output and kill only our newly created process group."""
    proc = popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    reason = None
    cleanup = None
    start = clock()
    try:
        with selector_factory() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while True:
                if clock() - start >= LIMITS['seconds']:
                    reason = 'timeout'
                    break
                if selector.select(0.1):
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        if proc.poll() is not None:
                            break
                        continue
                    remaining = LIMITS['output_bytes'] - len(output)
                    output.extend(chunk[:remaining])
                    if len(chunk) >= remaining:
                        reason = 'output_limit'
                        break
                elif proc.poll() is not None:
                    reason = 'leader_exited_with_open_pipe'
                    break
    except Exception as exc:
        reason = 'execution_error: ' + type(exc).__name__
    finally:
        # poll(None) leaves our child unreaped, reserving its PID even if it
        # exits immediately afterward. Never signal a group after reaping.
        try:
            if reason:
                if proc.poll() is None:
                    killpg(proc.pid, signal.SIGKILL)
                else:
                    cleanup = 'indeterminate: leader already exited; group not signalled'
        except Exception as exc:
            cleanup = 'group cleanup failed: ' + type(exc).__name__
        try:
            proc.wait(timeout=LIMITS['cleanup_seconds'])
        except Exception as exc:
            cleanup = 'wait failed: ' + type(exc).__name__
        proc.stdout.close()
        text = output.decode('utf-8', errors='replace')
        report = diagnostics(text, bool(reason or cleanup or proc.returncode), reason == 'output_limit')
        try:
            masked = redact(text) if reason != 'output_limit' else '[NOT READY: capture overflow]'
        except Exception:
            masked = '[NOT READY: masking failed]'
        preserve(log, masked.encode()[:LIMITS['output_bytes']])
    return {'command': list(command), 'exit_code': proc.returncode, 'stop_reason': reason,
            'cleanup_failure': cleanup,
            'test_counts': report['counts'], 'diagnostics': report,
            'output_bytes': len(output), 'limits': LIMITS}


def run(manifest):
    recheck(ROOT, manifest)
    node = shutil.which('node')
    if not node:
        raise ValueError('installed Node missing')
    for command in COMMANDS:
        if not (ROOT / command[1]).is_file():
            raise ValueError('installed dependency/script missing')
    folder = Path(tempfile.mkdtemp(prefix='run-', dir=BASE))
    result = {'NOT_APPLIED': True, 'real_codex_e2e': 'NOT_RUN', 'source': manifest,
              'manifest_sha256': digest(encoded(manifest)), 'commands': [], 'status': 'failed'}
    try:
        scratch = owner_scratch()
        result['scratch'] = str(scratch)
        result['scratch_retained'] = True
        scratch_preflight(scratch, ROOT)
    except Exception as exc:
        result['error'] = 'scratch preflight failed: ' + type(exc).__name__
        preserve(folder / 'result.json', encoded(result))
        raise ValueError('scratch preflight failed: private external scratch with chmod/hardlinks required') from exc
    for name in ('home', 'codex-home', 'tmp', 'state', 'bin'):
        private_dir(scratch / name)
    (scratch / 'bin/node').symlink_to(Path(node).resolve())
    for tool in ('python3', 'git'):
        installed = shutil.which(tool)
        if installed:
            (scratch / 'bin' / tool).symlink_to(Path(installed).resolve())
    env = {'PATH': str(scratch / 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(scratch / 'home'),
           'CODEX_HOME': str(scratch / 'codex-home'), 'TMPDIR': str(scratch / 'tmp'),
           'TMP': str(scratch / 'tmp'), 'TEMP': str(scratch / 'tmp'),
           'C2C_STATE_DIR': str(scratch / 'state'), 'C2C_TEST_TMP_ROOT': str(scratch / 'tmp'),
           'PYTHONDONTWRITEBYTECODE': '1', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null',
           'XDG_CONFIG_HOME': str(scratch / 'state'), 'XDG_STATE_HOME': str(scratch / 'state'),
           'XDG_CACHE_HOME': str(scratch / 'state'), 'CI': '1', 'NO_COLOR': '1', 'LANG': 'C'}
    try:
        for index, fixed in enumerate(COMMANDS):
            recheck(ROOT, manifest)
            command = [str(scratch / 'bin/node'), *fixed[1:]]
            item = execute(command, ROOT, env, folder / (str(index + 1) + '.log'))
            result['commands'].append(item)
            print('command', index + 1, 'exit', item['exit_code'], item['stop_reason'] or '', flush=True)
            recheck(ROOT, manifest)
            if item['exit_code'] != 0 or item['stop_reason'] or item['cleanup_failure'] or item.get('diagnostics', {}).get('status') == 'not-ready':
                raise ValueError('command failed; no retry')
        result['status'] = 'passed'
    except Exception as exc:
        result['status'] = 'failed'
        result['error'] = str(exc)
    finally:
        try:
            recheck(ROOT, manifest)
            result['source_after'] = 'matched'
        except Exception:
            result['source_after'] = 'STALE_OR_UNREADABLE'
            result['status'] = 'failed'
            result['error'] = 'after-source mismatch or unreadable source'
        report_path = folder / 'diagnostics.json'
        report = {'schema_version': 1, 'kind': 'DERIVED', 'commands': [
            {'command': list(COMMANDS[i]), 'exit_code': item['exit_code'],
             **item.get('diagnostics', {'status': 'not-ready', 'counts': [], 'failures': []})}
            for i, item in enumerate(result['commands'])]}
        preserve(report_path, encoded(report))
        result['diagnostics_path'] = str(report_path.relative_to(ROOT))
        preserve(folder / 'result.json', encoded(result))
        print('evidence:', folder)
    if result['status'] != 'passed':
        raise ValueError(result['error'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--run', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if ROOT.resolve() != ROOT or Path(__file__).resolve() != ROOT / RUNNER:
        raise ValueError('fixed checkout/runner mismatch')
    print('OWNER: let all other work in this checkout finish first. Not a sandbox or deployment approval.')
    identity(ROOT)
    private_dir(ROOT / '.local')
    private_dir(BASE)
    manifest_path = BASE / 'manifest.json'
    current = candidate(ROOT)
    data = encoded(current)
    summary = encoded({'manifest': str(manifest_path), 'manifest_sha256': digest(data),
                       'runner_sha256': current['hashes'][RUNNER]})
    if args.prepare:
        preserve(manifest_path, data)
        preserve(BASE / 'summary.json', summary)
        print('prepared', len(current['hashes']), 'files; manifest SHA256', digest(data))
    else:
        if not manifest_path.exists() or not (BASE / 'summary.json').exists():
            raise ValueError('prepare required')
        preserve(manifest_path, data)
        preserve(BASE / 'summary.json', summary)
        run(current)


def cli():
    try:
        main()
        return 0
    except Exception as error:
        print('REFUSED:', error)
        return 1


if __name__ == '__main__':
    raise SystemExit(cli())
