import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { LOCAL_GIT_PREFIX, validateLocalApproval, localApprovalSchemaDiagnostic, localApprovalScopeReason, localApprovalPresentation } from "../src/codex/local-approval.js";
import { cleanup, makeTmpDir } from "./helpers.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanup(root); });
function fixture() {
  const root = makeTmpDir("local-approval"); roots.push(root);
  fs.mkdirSync(path.join(root, ".git/refs/heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  fs.writeFileSync(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git/refs/heads/main"), "a".repeat(40) + "\n");
  fs.writeFileSync(path.join(root, ".git/index"), "fixture index");
  fs.writeFileSync(path.join(root, "a.txt"), "fixture content");
  return { kind: "command", threadId: "thread", turnId: "turn", itemId: "item", environmentId: "local",
    command: LOCAL_GIT_PREFIX + " commit --only -m 'message' -- a.txt", cwd: root,
    additionalPermissions: { network: { enabled: false }, fileSystem: { read: null, write: [root + "/.git"] } } };
}

function commandFixture() {
  const git = fixture();
  return {
    root: git.cwd,
    request: {
      kind: "command",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      startedAtMs: 1,
      environmentId: "local",
      command: "/usr/bin/python3 -c \"print(12345)\"",
      cwd: git.cwd,
      additionalPermissions: null,
      availableDecisions: ["accept", "cancel"],
    } as any,
  };
}

it("accepts current Codex wire shape with no extra permissions as one exact workspace command", () => {
  const f = commandFixture();
  expect(localApprovalSchemaDiagnostic(f.request)).toEqual({ valid: true, issues: [], omitted: false });
  const scope = validateLocalApproval(f.request, f.root);
  expect(scope).toMatchObject({ type: "workspace_command", root: f.root, command: f.request.command, readPaths: [], writePaths: [] });
  expect(localApprovalScopeReason(f.request)).toBe("EXACT_COMMAND_SCOPE_UNVERIFIED");
});

it("accepts the captured Codex 0.159.2 exact temporary-write request and presents accept-once only", () => {
  const f = commandFixture();
  const target = "/private/tmp/c2c-command-approval-test-marker";
  f.request.command = "/bin/zsh -lc '/usr/bin/touch " + target + "'";
  f.request.commandActions = [{ type: "unknown", command: f.request.command }];
  f.request.proposedExecpolicyAmendment = ["/bin/zsh", "-lc", "/usr/bin/touch " + target];
  f.request.additionalPermissions = {
    network: null,
    fileSystem: {
      read: null,
      write: [target],
      entries: [{ path: { type: "path", path: target }, access: "write" }],
    },
  };
  const scope = validateLocalApproval(f.request, f.root);
  expect(scope).toMatchObject({ type: "workspace_command", writePaths: [target], readPaths: [] });
  const presentation = localApprovalPresentation(scope!, "command-e2e", "a".repeat(32));
  expect(presentation.mode).toBe("approve-command");
  expect(presentation.message).toContain(f.request.command);
  expect(presentation.message).toContain(target);
  expect(presentation.message).toContain("一回限り");
  expect(presentation.message).toContain("session/persistent許可は発行しません");
  expect(presentation.message).toContain("ネットワーク追加: なし");
});

it.each([
  "network",
  "network-context",
  "network-amendment",
  "outside-write",
  "root-write",
  "git-write",
  "glob",
  "special",
  "deny",
  "depth",
  "session-only",
  "amendment-only",
  "write-stdin",
])("rejects unsafe generic command permission shape: %s", mode => {
  const f = commandFixture();
  const temp = "/private/tmp/c2c-command-safe";
  f.request.additionalPermissions = { network: null, fileSystem: { read: null, write: [temp] } };
  if (mode === "network") f.request.additionalPermissions.network = { enabled: true };
  if (mode === "network-context") f.request.networkApprovalContext = { host: "example.com", protocol: "https" };
  if (mode === "network-amendment") f.request.proposedNetworkPolicyAmendments = [{ host: "example.com" }];
  if (mode === "outside-write") f.request.additionalPermissions.fileSystem.write = ["/etc/c2c-command-forbidden"];
  if (mode === "root-write") f.request.additionalPermissions.fileSystem.write = [f.root];
  if (mode === "git-write") f.request.additionalPermissions.fileSystem.write = [path.join(f.root, ".git", "index")];
  if (mode === "glob") f.request.additionalPermissions.fileSystem.entries = [{ path: { type: "glob_pattern", pattern: temp + "/*" }, access: "write" }];
  if (mode === "special") f.request.additionalPermissions.fileSystem.entries = [{ path: { type: "special", value: { kind: "tmpdir" } }, access: "write" }];
  if (mode === "deny") f.request.additionalPermissions.fileSystem.entries = [{ path: { type: "path", path: temp }, access: "deny" }];
  if (mode === "depth") f.request.additionalPermissions.fileSystem.globScanMaxDepth = 1;
  if (mode === "session-only") f.request.availableDecisions = ["acceptForSession"];
  if (mode === "amendment-only") f.request.availableDecisions = [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["python"] } }];
  if (mode === "write-stdin") f.request.kind = "writeStdin";
  expect(validateLocalApproval(f.request, f.root)).toBeNull();
});

it.each([
  "git status",
  "/usr/bin/git status",
  "/bin/zsh -lc 'git status'",
])("never routes Git-like command through generic command approval: %s", command => {
  const f = commandFixture();
  f.request.command = command;
  expect(validateLocalApproval(f.request, f.root)).toBeNull();
  expect(localApprovalScopeReason(f.request)).toBe("HERMETIC_GIT_COMMAND_REQUIRED");
});

it("retains the exact full 37-argument proposal for the recorded sh command", () => {
  const p: any = fixture();
  fs.writeFileSync(path.join(p.cwd, "acceptance.txt"), "fixture");
  const proposal = LOCAL_GIT_PREFIX.split(" ").concat(["commit", "--only", "-m", "C2C native approval E2E", "--", "acceptance.txt"]);
  p.command = `/bin/sh -c "${LOCAL_GIT_PREFIX} commit --only -m 'C2C native approval E2E' -- acceptance.txt"`;
  p.proposedExecpolicyAmendment = proposal; p.availableDecisions = ["accept", "cancel"];
  p.additionalPermissions.fileSystem.entries = [{ path: { type: "path", path: p.cwd + "/.git" }, access: "write" }];
  expect(proposal).toHaveLength(37);
  expect(createHash("sha256").update(p.command).digest("hex")).toBe("1645e907642ae6975096d4d7b342421aae0115516c9cef82db76ac330251dd8c");
  const raw = JSON.stringify(p), scope = validateLocalApproval(p, p.cwd)!;
  expect(scope).toMatchObject({ type: "git_commit", files: ["acceptance.txt"] });
  expect(JSON.stringify(p)).toBe(raw);
  expect(validateLocalApproval(p, p.cwd)!.fingerprint).toBe(scope.fingerprint);
});

it.each([[], ["git", "commit"], ["x".repeat(1024), "x".repeat(1024), "x".repeat(1024), "x".repeat(1024)]].map(proposal => [proposal]))("keeps bounded proposal %j inert and fingerprinted", proposedExecpolicyAmendment => {
  const p: any = fixture();
  const before = validateLocalApproval(p, p.cwd)!;
  Object.assign(p, { proposedExecpolicyAmendment, availableDecisions: ["accept", "cancel", { acceptWithExecpolicyAmendment: { execpolicy_amendment: proposedExecpolicyAmendment } }] });
  expect(localApprovalSchemaDiagnostic(p).valid).toBe(true);
  expect(validateLocalApproval(p, p.cwd)).toMatchObject({ type: "git_commit" });
  expect(validateLocalApproval(p, p.cwd)!.fingerprint).not.toBe(before.fingerprint);
});

it.each(["scalar", "object", "non-string", "count", "string", "utf8-string", "total", "absent-accept", "null-decisions", "session-only", "amendment-only", "network-amendment", "network-context", "actual-command", "overlay"])("rejects proposal route mutation: %s", mode => {
  const p: any = fixture();
  p.proposedExecpolicyAmendment = ["git", "commit"]; p.availableDecisions = ["accept", "cancel"];
  if (mode === "scalar") p.proposedExecpolicyAmendment = "git";
  if (mode === "object") p.proposedExecpolicyAmendment = { command: "git" };
  if (mode === "non-string") p.proposedExecpolicyAmendment = [1];
  if (mode === "count") p.proposedExecpolicyAmendment = Array(129).fill("");
  if (mode === "string") p.proposedExecpolicyAmendment = ["x".repeat(1025)];
  if (mode === "utf8-string") p.proposedExecpolicyAmendment = ["あ".repeat(342)];
  if (mode === "total") p.proposedExecpolicyAmendment = Array(5).fill("x".repeat(1024));
  if (mode === "absent-accept") delete p.availableDecisions;
  if (mode === "null-decisions") p.availableDecisions = null;
  if (mode === "session-only") p.availableDecisions = ["acceptForSession"];
  if (mode === "amendment-only") p.availableDecisions = [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git"] } }];
  if (mode === "network-amendment") p.proposedNetworkPolicyAmendments = [];
  if (mode === "network-context") p.networkApprovalContext = {};
  if (mode === "actual-command") p.command += " && id";
  if (mode === "overlay") p.additionalPermissions.fileSystem.write = [p.cwd];
  expect(validateLocalApproval(p, p.cwd)).toBeNull();
});

it("accepts equivalent literal entries without discarding their raw fingerprint identity", () => {
  const p: any = fixture();
  p.command = `/bin/sh -c "${p.command}"`;
  const legacy = validateLocalApproval(p, p.cwd)!;
  p.additionalPermissions.fileSystem.entries = [{ path: { type: "path", path: p.cwd + "/.git" }, access: "write" }];
  expect(localApprovalSchemaDiagnostic(p).valid).toBe(true);
  const scope = validateLocalApproval(p, p.cwd)!;
  expect(scope).toMatchObject({ type: "git_commit", files: ["a.txt"] });
  expect(scope.fingerprint).not.toBe(legacy.fingerprint);
});

it.each(["null", "empty", "multiple", "read", "deny", "glob", "special", "mismatch", "relative", "traversal", "trailing", "broad", "depth", "extension", "path-extension", "entry-extension", "legacy-read", "legacy-multiple"])("rejects filesystem entries mutation: %s", mode => {
  const p: any = fixture(), f = p.additionalPermissions.fileSystem;
  const entry: any = { path: { type: "path", path: p.cwd + "/.git" }, access: "write" };
  f.entries = [entry];
  if (mode === "null") f.entries = null;
  if (mode === "empty") f.entries = [];
  if (mode === "multiple") f.entries.push(entry);
  if (mode === "read" || mode === "deny") entry.access = mode;
  if (mode === "glob") entry.path = { type: "glob_pattern", pattern: p.cwd + "/*" };
  if (mode === "special") entry.path = { type: "special", value: "root" };
  if (mode === "mismatch") entry.path.path = p.cwd;
  if (mode === "relative") entry.path.path = f.write[0] = ".git";
  if (mode === "traversal") entry.path.path = f.write[0] = p.cwd + "/x/../.git";
  if (mode === "trailing") entry.path.path = f.write[0] = p.cwd + "/.git/";
  if (mode === "broad") entry.path.path = f.write[0] = p.cwd;
  if (mode === "depth") f.globScanMaxDepth = 0;
  if (mode === "extension") f.extension = true;
  if (mode === "path-extension") entry.path.extension = true;
  if (mode === "entry-extension") entry.extension = true;
  if (mode === "legacy-read") f.read = [];
  if (mode === "legacy-multiple") f.write.push(p.cwd);
  expect(validateLocalApproval(p, p.cwd)).toBeNull();
});

it("emits only bounded schema codes and allowlisted paths, never values or unknown keys", () => {
  const p: any = fixture();
  p.additionalPermissions.fileSystem.entries = [{ path: { type: "glob_pattern", pattern: "credential-value" }, access: "deny", "credential-key": "credential-value" }];
  p["credential-key"] = "credential-value";
  const d = localApprovalSchemaDiagnostic(p), text = JSON.stringify(d);
  expect(d.valid).toBe(false);
  expect(d.issues.length).toBeLessThanOrEqual(4);
  expect(text).not.toMatch(/credential|pattern|message/);
  expect(d.issues.every(issue => Object.keys(issue).sort().join(",") === "code,path")).toBe(true);
  expect(Buffer.byteLength(text)).toBeLessThan(2048);
  expect(typeof d.omitted).toBe("boolean");
  expect(localApprovalSchemaDiagnostic(fixture())).toEqual({ valid: true, issues: [], omitted: false });
});

it("admits only fixed direct Git with inline .git permission; index changes invalidate its fingerprint", () => {
  const p = fixture();
  const first = validateLocalApproval(p, p.cwd);
  expect(first).toMatchObject({ type: "git_commit", files: ["a.txt"] });
  fs.writeFileSync(path.join(p.cwd, ".git/index"), "unrelated staged change");
  expect(validateLocalApproval(p, p.cwd)?.fingerprint).not.toBe(first?.fingerprint);
  expect(validateLocalApproval({ ...p, command: LOCAL_GIT_PREFIX + " add -- a.txt" }, p.cwd)).toMatchObject({ type: "git_stage" });
});

it.each(["plain-index", "push", "substitution", "wrapper", "network", "broad-fs", "no-inline", "remote", "stdin", "proposal-without-accept", "traversal", "filter", "attributes", "redirected-root", "secret"])("rejects %s", mode => {
  const p: any = fixture();
  if (mode === "plain-index") p.command = LOCAL_GIT_PREFIX + " commit -m 'message'";
  if (mode === "push") p.command += " && /usr/bin/git push";
  if (mode === "substitution") p.command += " $(id)";
  if (mode === "wrapper") p.command = "/bin/zsh -lc '" + p.command + "'";
  if (mode === "network") p.additionalPermissions.network.enabled = true;
  if (mode === "broad-fs") p.additionalPermissions.fileSystem.write = ["/fixture"];
  if (mode === "no-inline") p.additionalPermissions = null;
  if (mode === "remote") p.environmentId = "remote";
  if (mode === "stdin") p.kind = "writeStdin";
  if (mode === "proposal-without-accept") p.proposedExecpolicyAmendment = ["git"];
  if (mode === "traversal") p.command += " ../elsewhere";
  if (mode === "filter") fs.appendFileSync(path.join(p.cwd, ".git/config"), "[filter \"unsafe\"]\nclean = forbidden\n");
  if (mode === "attributes") fs.writeFileSync(path.join(p.cwd, ".gitattributes"), "* filter=unsafe");
  if (mode === "redirected-root") fs.appendFileSync(path.join(p.cwd, ".git/config"), "[core]\nworktree = /other\n");
  if (mode === "secret") p.command = LOCAL_GIT_PREFIX + " add -- credentials";
  expect(validateLocalApproval(p, p.cwd)).toBeNull();
});

it("ignores a large unrelated object store and accepts Japanese messages and nullable wire metadata", () => {
  const p: any = fixture();
  fs.mkdirSync(path.join(p.cwd, ".git/objects"));
  const fd = fs.openSync(path.join(p.cwd, ".git/objects/unrelated"), "w");
  fs.ftruncateSync(fd, 40 * 1024 * 1024); fs.closeSync(fd);
  p.command = LOCAL_GIT_PREFIX + " commit --only -m '修正を保存する' -- a.txt";
  p.availableDecisions = null;
  for (const network of [null, undefined, { enabled: false }, { enabled: null }]) {
    p.additionalPermissions.network = network;
    expect(validateLocalApproval(p, p.cwd)).not.toBeNull();
  }
  p.environmentId = null;
  expect(validateLocalApproval(p, p.cwd)).not.toBeNull();
});

it("rejects includes before any Git execution or global configuration reads", () => {
  const p = fixture();
  fs.appendFileSync(path.join(p.cwd, ".git/config"), "[include]\npath = /must-not-read\n");
  expect(validateLocalApproval(p, p.cwd)).toBeNull();
});

it("invalidates a file changed during the descriptor read", () => {
  const p = fixture(), original = fs.readSync;
  let changed = false;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
    const value = (original as any)(...args);
    if (!changed) { changed = true; fs.appendFileSync(path.join(p.cwd, ".git/config"), "\n# changed"); }
    return value;
  }) as any);
  expect(validateLocalApproval(p, p.cwd)).toBeNull();
});

it("replays the recorded zsh envelope but admits only the exact sh route and preserves raw identity", () => {
  const p = fixture();
  fs.writeFileSync(path.join(p.cwd, "acceptance.txt"), "fixture");
  const inner = LOCAL_GIT_PREFIX + " commit --only -m 'C2C native approval E2E' -- acceptance.txt";
  const recorded = `/bin/zsh -c "${inner}"`;
  expect(Buffer.byteLength(inner)).toBe(516);
  expect(Buffer.byteLength(recorded)).toBe(530);
  expect(createHash("sha256").update(recorded).digest("hex")).toBe("eadfefe2ab5e81f56e3074d7941ace048d7bce6d14493ff95cfcdc789a5d9b9b");
  expect(validateLocalApproval({ ...p, command: recorded }, p.cwd)).toBeNull();
  const direct = validateLocalApproval({ ...p, command: inner }, p.cwd);
  const shell = validateLocalApproval({ ...p, command: `/bin/sh -c "${inner}"` }, p.cwd);
  expect(shell).toMatchObject({ type: "git_commit", files: ["acceptance.txt"] });
  expect(shell!.fingerprint).not.toBe(direct!.fingerprint);
  expect(validateLocalApproval({ ...p, command: `/bin/sh -c "${inner}"`, itemId: "changed" }, p.cwd)!.fingerprint).not.toBe(shell!.fingerprint);
  expect(validateLocalApproval({ ...p, command: `/bin/sh -c "${LOCAL_GIT_PREFIX} add -- a.txt"` }, p.cwd)).toMatchObject({ type: "git_stage" });
});

it.each(["zsh", "bash", "login", "interactive", "extra-argv", "nested", "substitution", "operator", "multiline", "expansion", "backtick", "backslash", "double-quote", "single-quoted-envelope", "extra-space", "trailing-space", "network", "broad-fs"])("refuses shell route mutation: %s", mode => {
  const p: any = fixture();
  const inner = p.command;
  p.command = `/bin/sh -c "${inner}"`;
  if (mode === "zsh") p.command = `/bin/zsh -c "${inner}"`;
  if (mode === "bash") p.command = `/bin/bash -c "${inner}"`;
  if (mode === "login") p.command = `/bin/sh -lc "${inner}"`;
  if (mode === "interactive") p.command = `/bin/sh -i -c "${inner}"`;
  if (mode === "extra-argv") p.command += " extra";
  if (mode === "nested") p.command = `/bin/sh -c "/bin/sh -c '${inner}'"`;
  if (mode === "substitution") p.command = `/bin/sh -c "${inner} $(id)"`;
  if (mode === "operator") p.command = `/bin/sh -c "${inner}; id"`;
  if (mode === "multiline") p.command = `/bin/sh -c "${inner}\nid"`;
  if (mode === "expansion") p.command = `/bin/sh -c "${inner} $HOME"`;
  if (mode === "backtick") p.command = `/bin/sh -c "${inner} \`id\`"`;
  if (mode === "backslash") p.command = `/bin/sh -c "${inner} \\x"`;
  if (mode === "double-quote") p.command = `/bin/sh -c "${inner.replace("message", 'a"b')}"`;
  if (mode === "single-quoted-envelope") p.command = `/bin/sh -c '${inner}'`;
  if (mode === "extra-space") p.command = `/bin/sh  -c "${inner}"`;
  if (mode === "trailing-space") p.command += " ";
  if (mode === "network") p.additionalPermissions.network.enabled = true;
  if (mode === "broad-fs") p.additionalPermissions.fileSystem.write = [p.cwd];
  expect(validateLocalApproval(p, p.cwd)).toBeNull();
});

it("rejects changed shell identity and includes descriptor-read shell content in the fingerprint", () => {
  const p = fixture(); p.command = `/bin/sh -c "${p.command}"`;
  const first = validateLocalApproval(p, p.cwd)!;
  expect(first).not.toBeNull();
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: any, ...args: any[]) => {
    const value = (lstat as any)(file, ...args);
    return file === "/bin/sh" ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { uid: 501 }) : value;
  }) as any);
  expect(validateLocalApproval(p, p.cwd)).toBeNull();
  vi.restoreAllMocks();
  const open = fs.openSync, read = fs.readSync; let shellFd = -1;
  vi.spyOn(fs, "openSync").mockImplementation(((file: any, ...args: any[]) => {
    const fd = (open as any)(file, ...args); if (file === "/bin/sh") shellFd = fd; return fd;
  }) as any);
  vi.spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
    const n = (read as any)(...args); if (args[0] === shellFd && n > 0) args[1][args[2]] ^= 1; return n;
  }) as any);
  expect(validateLocalApproval(p, p.cwd)!.fingerprint).not.toBe(first.fingerprint);
});
