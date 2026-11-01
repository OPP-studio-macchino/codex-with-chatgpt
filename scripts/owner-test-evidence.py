"""Internal fixed-runner receipt writer. No CLI, upload, or caller-nominated path."""
import hashlib
import json
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

COMMANDS = (("node", "node_modules/typescript/bin/tsc", "--noEmit"),
            ("node", "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2", "--minWorkers=1"),
            ("node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"),
            ("node", "scripts/validate-skill.mjs"))


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def counts(item, label="Tests"):
    diagnostic = item.get("diagnostics", {})
    if diagnostic.get("status") != "ready" or any(diagnostic.get(k) != 0 for k in
            ("omitted_entries", "omitted_count_lines", "truncated_fields")):
        return None
    lines = [s for s in item.get("test_counts", []) if isinstance(s, str) and re.match(r"^" + re.escape(label) + r"\s", s)]
    if len(lines) != 1 or len(lines[0]) > 256:
        return None
    m = re.fullmatch(re.escape(label) + r"\s+(.+?)\s+\((\d+)\)", lines[0])
    if not m:
        return None
    result = dict(passed=0, failed=0, skipped=0, total=int(m[2]))
    seen = set()
    for part in m[1].split("|"):
        match = re.fullmatch(r"\s*(\d+) (passed|failed|skipped)\s*", part)
        if not match or match[2] in seen:
            return None
        seen.add(match[2])
        result[match[2]] = int(match[1])
    if result["total"] != sum(result[k] for k in ("passed", "failed", "skipped")) or result["total"] > 1000000:
        return None
    return result


def derive(binding, manifest, result, pinned_manifest):
    if set(binding) != {"workspace_id", "workspace_root", "state_dir"} or not re.fullmatch(r"[a-f0-9]{24}", binding["workspace_id"]):
        raise ValueError("binding")
    root = Path(binding["workspace_root"])
    if manifest["identity"]["root"] != str(root) or result.get("source") != manifest or result.get("manifest_sha256") != pinned_manifest:
        raise ValueError("source binding")
    rows = result.get("commands", [])
    if not isinstance(rows, list) or len(rows) > 4:
        raise ValueError("command count")
    typed = []
    for i, row in enumerate(rows):
        expected = [str(Path(result["scratch"]) / "bin/node"), *COMMANDS[i][1:]]
        if row.get("command") != expected:
            raise ValueError("fixed command mismatch")
        exit_code = row.get("exit_code")
        if exit_code is not None and (type(exit_code) is not int or not -255 <= exit_code <= 255):
            raise ValueError("exit code")
        complete = not row.get("stop_reason") and not row.get("cleanup_failure") and row.get("diagnostics", {}).get("status") == "ready"
        typed.append(dict(command=list(COMMANDS[i]), exit_code=exit_code, complete=complete,
                          counts=counts(row) if i == 1 else None, test_files=counts(row, "Test Files") if i == 1 else None))
    source_after = "matched" if result.get("source_after") == "matched" else "changed" if result.get("source_after") else "unknown"
    passed = (result.get("status") == "passed" and source_after == "matched" and len(typed) == 4 and
              all(r["exit_code"] == 0 and r["complete"] for r in typed) and typed[1]["counts"] is not None and
              typed[1]["counts"]["failed"] == 0 and typed[1]["counts"]["total"] > 0 and
              typed[1]["test_files"] is not None and typed[1]["test_files"]["failed"] == 0 and
              0 < typed[1]["test_files"]["total"] <= typed[1]["counts"]["total"])
    failed = result.get("status") == "failed" or source_after == "changed" or any(r["exit_code"] not in (0, None) or (r["counts"] and r["counts"]["failed"]) for r in typed)
    summary = dict(status="passed" if passed else "failed" if failed else "partial", source_after=source_after, commands=typed)
    sources = manifest["hashes"]
    if not 0 < len(sources) <= 10000 or any(not re.fullmatch(r"[a-f0-9]{64}", h) for h in sources.values()):
        raise ValueError("manifest")
    return dict(schema_version=1, source="fixed-owner-runner", workspace_id=binding["workspace_id"], workspace_root=str(root),
                recorded_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), runner_manifest_sha256=pinned_manifest,
                raw_result_sha256=hashlib.sha256((json.dumps(result, sort_keys=True, indent=2) + "\n").encode()).hexdigest(),
                manifest_sha256=digest(sources), result_sha256=digest(summary), manifest=sources, result=summary)


def private_chain(directory, state):
    for p in (directory, *directory.parents):
        s = p.lstat()
        if not stat.S_ISDIR(s.st_mode) or p.resolve() != p or s.st_uid not in (0, os.getuid()) or s.st_mode & 0o022:
            raise ValueError("unsafe ancestor")
        if p in (directory, state) and (s.st_uid != os.getuid() or s.st_mode & 0o077):
            raise ValueError("nonprivate state")


def atomic_publish(file, data):
    # Exclusive writer lock; a concurrent run cannot overwrite a receipt.
    lock = file.with_suffix(".lock")
    lock_fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    owned_lock = os.fstat(lock_fd)
    temp = None
    try:
        before = None
        if file.exists() or file.is_symlink():
            s = file.lstat()
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid() or s.st_mode & 0o077:
                raise ValueError("unsafe receipt")
            before = (s.st_dev, s.st_ino, s.st_mtime_ns, s.st_ctime_ns, s.st_size)
        fd, temp = tempfile.mkstemp(prefix=".receipt-", dir=file.parent)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        now = file.lstat() if file.exists() or file.is_symlink() else None
        if (None if now is None else (now.st_dev, now.st_ino, now.st_mtime_ns, now.st_ctime_ns, now.st_size)) != before:
            raise ValueError("receipt conflict")
        os.replace(temp, file)
        temp = None
        directory_fd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        except OSError as exc:
            raise RuntimeError("receipt replaced; directory durability unconfirmed") from exc
        finally:
            os.close(directory_fd)
    finally:
        if temp is not None:
            os.unlink(temp)
        try:
            current_lock = lock.lstat()
            if (current_lock.st_dev, current_lock.st_ino) == (owned_lock.st_dev, owned_lock.st_ino):
                os.unlink(lock)
        except FileNotFoundError:
            pass
        finally:
            os.close(lock_fd)


def publish(binding, manifest, result, pinned_manifest):
    receipt = derive(binding, manifest, result, pinned_manifest)
    root, state = Path(binding["workspace_root"]), Path(binding["state_dir"])
    if not state.is_absolute() or state.resolve() != state or state.is_relative_to(root) or root.resolve() != root:
        raise ValueError("untrusted receipt location")
    directory = state / "owner-test-evidence"
    # State is installed/bound once; never discover it from subprocess output or environment.
    private_chain(state, state)
    directory.mkdir(mode=0o700, exist_ok=True)
    private_chain(directory, state)
    data = encoded(receipt)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("receipt bound")
    atomic_publish(directory / (binding["workspace_id"] + ".json"), data)
    return receipt
