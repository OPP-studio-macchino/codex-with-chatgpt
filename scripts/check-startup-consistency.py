#!/usr/bin/env python3
"""Read-only comparison of explicit launch plists; never runs their programs."""
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import sys


class Invalid(Exception):
    pass


class UniqueDict(dict):
    def __setitem__(self, key, value):
        if key in self:
            raise Invalid("DUPLICATE_KEY")
        super().__setitem__(key, value)


def unique_json(pairs):
    result = UniqueDict()
    for key, value in pairs:
        result[key] = value
    return result


def read_file(path):
    # Nonblocking open prevents a named pipe from hanging this diagnostic.
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            meta = os.fstat(stream.fileno())
            if not stat.S_ISREG(meta.st_mode) or not 0 < meta.st_size <= 1024 * 1024:
                raise Invalid("INVALID_FILE")
            data = stream.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                raise Invalid("INVALID_FILE")
            return data
    except OSError:
        raise Invalid("MISSING_OR_UNREADABLE_FILE") from None


def flags(argv, allowed, required=(), booleans=()):
    result = {}
    i = 0
    while i < len(argv):
        flag, sep, value = argv[i].partition("=")
        if flag not in allowed:
            raise Invalid("UNSUPPORTED_ARGUMENT")
        if flag in result:
            raise Invalid("DUPLICATE_FLAG")
        if flag in booleans:
            if sep:
                raise Invalid("INVALID_FLAG")
            result[flag] = True
        else:
            if not sep:
                i += 1
                if i >= len(argv) or argv[i].startswith("-"):
                    raise Invalid("MISSING_FLAG_VALUE")
                value = argv[i]
            if not value or len(value) > 4096 or any(ord(c) < 32 for c in value):
                raise Invalid("INVALID_FLAG_VALUE")
            result[flag] = value
        i += 1
    if any(flag not in result for flag in required):
        raise Invalid("MISSING_FLAG")
    return result


def load_plist(path):
    try:
        data = plistlib.loads(read_file(path), dict_type=UniqueDict)
    except Invalid:
        raise
    except Exception:
        raise Invalid("MALFORMED_PLIST") from None
    if not isinstance(data, dict):
        raise Invalid("MALFORMED_PLIST")
    argv = data.get("ProgramArguments")
    env = data.get("EnvironmentVariables", {})
    if (not isinstance(argv, list) or not 2 <= len(argv) <= 128
            or any(not isinstance(arg, str) or not arg or len(arg) > 4096 for arg in argv)
            or not isinstance(env, dict)
            or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items())):
        raise Invalid("MALFORMED_PLIST")
    if "Program" in data and data["Program"] != argv[0]:
        raise Invalid("AMBIGUOUS_PROGRAM")
    return argv, env


def absolute(value):
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
        raise Invalid("INVALID_PATH")
    if str(Path(value)) != value or ".." in Path(value).parts:
        raise Invalid("INVALID_PATH")
    return value


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", value):
        raise Invalid("INVALID_VERSION")
    return value


def identity(values):
    for key in ("workspace_root", "state_root"):
        if key in values:
            absolute(values[key])
    if "workspace_id" in values and not re.fullmatch(r"[a-f0-9]{24}", values["workspace_id"]):
        raise Invalid("INVALID_WORKSPACE_ID")
    if "port" in values:
        value = values["port"]
        if not re.fullmatch(r"[0-9]{1,5}", value) or not 1 <= int(value) <= 65535:
            raise Invalid("INVALID_PORT")
        values["port"] = int(value)
    return values


def bridge(path):
    argv, env = load_plist(path)
    # Only direct installed JS entry points, optionally preceded by node.
    index = 1 if Path(argv[0]).name == "node" else 0
    entry = Path(absolute(argv[index]))
    if entry.parts[-2:] == ("bin", "c2c.js"):
        release = entry.parent.parent
    elif entry.parts[-3:] == ("dist", "cli", "index.js"):
        release = entry.parent.parent.parent
    else:
        raise Invalid("UNSUPPORTED_BRIDGE_COMMAND")
    if argv[index + 1:index + 2] != ["serve"]:
        raise Invalid("UNSUPPORTED_BRIDGE_COMMAND")
    opts = flags(argv[index + 2:], {
        "--workspace", "--port", "--external-base-url", "--trusted-tunnel-token-file",
        "--codex-execution", "--codex-binary",
    }, ("--workspace",), ("--codex-execution",))
    try:
        package = json.loads(read_file(release / "package.json"), object_pairs_hook=unique_json)
    except Invalid:
        raise
    except Exception:
        raise Invalid("MALFORMED_PACKAGE") from None
    if not isinstance(package, dict) or package.get("name") != "codex-with-chatgpt":
        raise Invalid("INVALID_PACKAGE")
    values = {"version": version(package.get("version")), "workspace_root": opts["--workspace"]}
    if "--port" in opts:
        values["port"] = opts["--port"]
    if "C2C_STATE_DIR" in env:
        values["state_root"] = env["C2C_STATE_DIR"]
    # Workspace id is keyed at runtime; do not read the identity key to derive it.
    return identity(values)


def tunnel(path):
    argv, _ = load_plist(path)
    index = 1 if Path(argv[0]).name in ("python3", "python") else 0
    if Path(absolute(argv[index])).name != "wait-for-bridge-and-connect.py":
        raise Invalid("UNSUPPORTED_TUNNEL_COMMAND")
    required = ("--version", "--workspace-id", "--workspace-root", "--port", "--state-root")
    opts = flags(argv[index + 1:], {*required, "--tunnel-client", "--tunnel-id", "--timeout-seconds"}, required)
    return identity({key[2:].replace("-", "_"): version(opts[key]) if key == "--version" else opts[key]
                     for key in required})


def main(argv):
    findings = []
    compared = []
    unverified = []
    try:
        opts = flags(argv, {"--bridge-plist", "--tunnel-plist"}, ("--bridge-plist", "--tunnel-plist"))
        bridge_path, tunnel_path = (absolute(opts[key]) for key in ("--bridge-plist", "--tunnel-plist"))
        if os.path.samefile(bridge_path, tunnel_path):
            raise Invalid("DUPLICATE_INPUT")
        values = {}
        for source, path, parse in (("bridge", bridge_path, bridge), ("tunnel", tunnel_path, tunnel)):
            try:
                values[source] = parse(path)
            except Invalid as error:
                findings.append({"source": source, "code": str(error)})
        if len(values) == 2:
            for key in ("version", "workspace_id", "workspace_root", "port", "state_root"):
                if key not in values["bridge"] or key not in values["tunnel"]:
                    unverified.append(key)
                elif values["bridge"][key] != values["tunnel"][key]:
                    findings.append({"source": "comparison", "code": key.upper() + "_MISMATCH"})
                else:
                    compared.append(key)
    except Invalid as error:
        findings.append({"source": "inputs", "code": str(error)})
    except OSError:
        findings.append({"source": "inputs", "code": "MISSING_OR_UNREADABLE_FILE"})
    status = "blocked" if findings else "consistent_provided_fields"
    print(json.dumps({"status": status, "findings": findings, "compared": compared,
                      "unverified": unverified,
                      "next_action": "OWNER_REVIEW_INPUTS_NO_LIVE_CHANGE" if findings else
                      "VERIFY_UNPROVIDED_FIELDS_AND_RUNTIME_BEFORE_OWNER_APPROVED_ROLLOUT"}))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
