#!/usr/bin/env python3
"""Bounded login gate: authenticate the local C2C Bridge before managed Tunnel connect."""
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time


class StartupTimeout(Exception):
    pass


def startup_timeout(signum, frame):
    raise StartupTimeout()


def blocked(code):
    print(f"c2c tunnel startup blocked: {code}", file=sys.stderr)
    raise SystemExit(2)


def private_file(path, max_bytes):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        blocked("UNSAFE_FILE")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            meta = os.fstat(stream.fileno())
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid():
                blocked("UNSAFE_FILE")
            if stat.S_IMODE(meta.st_mode) != 0o600 or not (0 < meta.st_size <= max_bytes):
                blocked("UNSAFE_FILE")
            raw = stream.read(max_bytes + 1)
    except SystemExit:
        raise
    except OSError:
        blocked("MISSING_FILE")
    if len(raw) > max_bytes:
        blocked("UNSAFE_FILE")
    return raw


def request_json(port, method, target, token=None):
    headers = {"Authorization": "Bearer " + token} if token else {}
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        conn.request(method, target, headers=headers)
        response = conn.getresponse()
        raw = response.read(65537)
    except (OSError, http.client.HTTPException):
        return None
    finally:
        conn.close()
    if response.status != 200 or len(raw) > 65536:
        return None
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def bridge_ready(args):
    runtime = Path(args.state_root) / "runtime" / f"{args.workspace_id}.json"
    try:
        data = json.loads(private_file(runtime, 65536))
    except (SystemExit, UnicodeDecodeError, json.JSONDecodeError):
        return False
    expected = {
        "service": "c2c-bridge",
        "version": args.version,
        "workspaceId": args.workspace_id,
        "workspaceRoot": args.workspace_root,
        "port": args.port,
        "trustedTunnelAuth": True,
        "codexExecution": True,
    }
    if not isinstance(data, dict):
        return False
    if any(type(data.get(key)) is not type(value) or data.get(key) != value
           for key, value in expected.items()):
        return False
    if type(data.get("pid")) is not int or data["pid"] <= 0:
        return False
    if not isinstance(data.get("startedAt"), str) or not data["startedAt"]:
        return False
    admin = data.get("adminToken")
    if not isinstance(admin, str) or re.fullmatch(r"c2c_admin_[A-Za-z0-9_-]{32}", admin) is None:
        return False
    health = request_json(args.port, "GET", "/health")
    if health != {"service": "c2c-bridge", "status": "ok"}:
        return False
    info = request_json(args.port, "GET", "/admin/info", admin)
    if not isinstance(info, dict):
        return False
    for key, value in expected.items():
        if type(info.get(key)) is not type(value) or info.get(key) != value:
            return False
    for key in ("pid", "startedAt"):
        if type(info.get(key)) is not type(data[key]) or info.get(key) != data[key]:
            return False
    return True


def tunnel_identity(status, alias, tunnel_id, profile_dir):
    if not isinstance(status, dict) or status.get("alias") != alias:
        return False
    if status.get("profile_name", alias) != alias or status.get("profile_dir", str(profile_dir)) != str(profile_dir):
        return False
    ids = []
    if "tunnel_id" in status:
        ids.append(status["tunnel_id"])
    for container, key in (("tunnel", "id"), ("remote", "id"), ("process", "tunnel_id")):
        value = status.get(container)
        if isinstance(value, dict) and key in value:
            ids.append(value[key])
    return bool(ids) and all(value == tunnel_id for value in ids)


def run_json(argv, env, allow_failure=False):
    try:
        result = subprocess.run(argv, env=env, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        if allow_failure:
            return None
        blocked("MANAGED_TUNNEL_COMMAND_FAILED")
    if result.returncode != 0:
        if allow_failure:
            return None
        blocked("MANAGED_TUNNEL_COMMAND_FAILED")
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        blocked("INVALID_MANAGED_TUNNEL_STATUS")
    if not isinstance(value, dict):
        blocked("INVALID_MANAGED_TUNNEL_STATUS")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--workspace-id", required=True)
    parser.add_argument("--workspace-root", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tunnel-client", required=True)
    parser.add_argument("--tunnel-id", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=30)
    args = parser.parse_args()

    if not re.fullmatch(r"[a-f0-9]{24}", args.workspace_id):
        blocked("INVALID_WORKSPACE_ID")
    if not re.fullmatch(r"tunnel_[a-f0-9]{32}", args.tunnel_id):
        blocked("INVALID_TUNNEL_ID")
    root = Path(args.state_root)
    if not root.is_absolute() or root.resolve() != root or Path(args.workspace_root).resolve() != Path(args.workspace_root):
        blocked("INVALID_PATH")
    if not 1 <= args.port <= 65535 or not 5 <= args.timeout_seconds <= 120:
        blocked("INVALID_BOUND")

    # A wall-clock timer also bounds slow HTTP bodies and the complete CLI sequence.
    previous = signal.signal(signal.SIGALRM, startup_timeout)
    signal.setitimer(signal.ITIMER_REAL, args.timeout_seconds)
    try:
        connect_when_ready(args)
    except StartupTimeout:
        blocked("STARTUP_TIMEOUT")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def connect_when_ready(args):
    root = Path(args.state_root)
    alias = "c2c-" + args.workspace_id
    profile_dir = root / "managed-tunnel-profiles" / alias
    token = root / "tunnel-auth" / f"{args.workspace_id}.token"
    runtime_key = root / "tunnel-runtime-key" / f"{args.workspace_id}.key"
    private_file(token, 256)
    private_file(runtime_key, 65536)

    deadline = time.monotonic() + args.timeout_seconds
    while time.monotonic() < deadline:
        if bridge_ready(args):
            break
        time.sleep(0.25)
    else:
        blocked("BRIDGE_NOT_READY")

    env = {key: os.environ[key] for key in ("HOME", "PATH", "TMPDIR") if key in os.environ}
    header = "X-C2C-Tunnel-Token: file:" + str(token)
    env["MCP_EXTRA_HEADERS"] = header
    env["MCP_DISCOVERY_EXTRA_HEADERS"] = header


    listing = run_json([args.tunnel_client, "runtimes", "list", "--json"], env)
    aliases = listing.get("aliases")
    if not isinstance(aliases, list):
        blocked("INVALID_MANAGED_TUNNEL_STATUS")
    matches = [item for item in aliases if isinstance(item, dict) and item.get("alias") == alias]
    if len(matches) > 1:
        blocked("DUPLICATE_MANAGED_RUNTIME")
    for item in aliases:
        if (not isinstance(item, dict) or not isinstance(item.get("alias"), str)
                or not item["alias"] or not isinstance(item.get("workspace_ids", []), list)):
            blocked("INVALID_MANAGED_TUNNEL_STATUS")
        if item["alias"] != alias and (
                args.workspace_id in item.get("workspace_ids", [])
                or item.get("mcp_server_url") == f"http://127.0.0.1:{args.port}/mcp"):
            blocked("DUPLICATE_MANAGED_RUNTIME")

    if matches:
        status = run_json([args.tunnel_client, "runtimes", "status", alias, "--json"], env)
        if not tunnel_identity(status, alias, args.tunnel_id, profile_dir):
            blocked("UNKNOWN_PROCESS_CONFLICT")
        runtime = status.get("runtime_status", status)
        if not isinstance(runtime, dict) or type(runtime.get("process_running")) is not bool:
            blocked("UNKNOWN_PROCESS_CONFLICT")
        if runtime.get("process_running") is True:
            if all(runtime.get(key) is True for key in ("process_running", "healthy", "ready")):
                return
            run_json([args.tunnel_client, "runtimes", "stop", alias, "--json"], env)

    connect = [
        args.tunnel_client, "runtimes", "connect",
        "--alias", alias,
        "--profile", alias,
        "--profile-dir", str(profile_dir),
        "--tunnel-id", args.tunnel_id,
        "--runtime-api-key", "file:" + str(runtime_key),
        "--mcp-server-url", f"http://127.0.0.1:{args.port}/mcp",
        "--json",
    ]
    run_json(connect, env)

    while time.monotonic() < deadline:
        status = run_json([args.tunnel_client, "runtimes", "status", alias, "--json"], env, allow_failure=True)
        if status and tunnel_identity(status, alias, args.tunnel_id, profile_dir):
            runtime = status.get("runtime_status", status)
            if isinstance(runtime, dict) and all(runtime.get(key) is True for key in ("process_running", "healthy", "ready")):
                return
        time.sleep(0.25)

    blocked("MANAGED_TUNNEL_NOT_READY")


if __name__ == "__main__":
    main()
