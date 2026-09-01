import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { IgnoreRules } from "./ignore.js";
import { redactAndTruncate, redactSensitiveText } from "../security/redaction.js";
import { findBinary } from "../tunnel/detect.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const SAFE_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "protocol.allow=never",
];

const UNSAFE_GIT_CONFIGURATION_ERROR =
  "UNSAFE_GIT_CONFIGURATION: Git inspection is disabled for this repository.";

const UNSAFE_GIT_CONFIG_KEYS = [
  /^filter\..+\.(?:clean|process|smudge|required)$/i,
  /^include(?:if\..+)?\.path$/i,
  /^extensions\.partialclone$/i,
  /^remote\..+\.(?:promisor|partialclonefilter)$/i,
  /^protocol\..+\.allow$/i,
  /^credential(?:\..+)?\.helper$/i,
  /^core\.(?:askpass|sshcommand)$/i,
];

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
let cachedGitBinary: string | null | undefined;

interface ValidatedGitLayout {
  gitDir: string;
  commonGitDir: string;
  objectDir: string;
  gitDirDev: number;
  gitDirIno: number;
  commonDirDev: number;
  commonDirIno: number;
  objectDirDev: number;
  objectDirIno: number;
}

interface GitSnapshot {
  gitDir: string;
  objectDir: string;
}

const MAX_GIT_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024;
const MAX_SHARED_INDEX_FILES = 8;
// ponytail: bounded full snapshot; replace with a descriptor-bound selective snapshot if this cap blocks normal repositories.
const MAX_GIT_OBJECT_FILES = 20_000;
const MAX_GIT_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_GIT_SNAPSHOT_MS = 250;
const GIT_COPY_BUFFER_BYTES = 64 * 1024;

function gitBinary(): string | null {
  if (cachedGitBinary === undefined) cachedGitBinary = findBinary("git", { includePath: false });
  return cachedGitBinary;
}

function safeGitEnv(root: string, binary: string, snapshot?: GitSnapshot): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const safe: NodeJS.ProcessEnv = {
    ...env,
    PATH: path.dirname(binary),
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  if (snapshot) {
    safe.GIT_DIR = snapshot.gitDir;
    safe.GIT_WORK_TREE = root;
    safe.GIT_OBJECT_DIRECTORY = snapshot.objectDir;
    safe.GIT_INDEX_FILE = path.join(snapshot.gitDir, "index");
  }
  return safe;
}

/** Low-level Git spawn used only for the non-executing configuration preflight. */
function spawnGitPreflight(root: string, args: string[]): GitCommandResult {
  const binary = gitBinary();
  if (!binary) {
    return { ok: false, stdout: "", stderr: "Trusted Git binary not found.", code: null };
  }
  const result = spawnSync(
    binary,
    [
      ...SAFE_GIT_CONFIG,
      "--literal-pathspecs",
      ...args,
    ],
    {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    env: safeGitEnv(root, binary),
    }
  );
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

function readVerifiedFile(file: string, maxBytes: number): Buffer | null {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink() || !before.isFile() || before.size < 0 || before.size > maxBytes) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return null;
    const canonical = fs.realpathSync.native(file);
    const after = fs.statSync(file);
    if (
      canonical !== path.resolve(file) ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    ) {
      return null;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort for a verified read-only descriptor
      }
    }
  }
}

function readSmallTextFile(file: string): string | null {
  const buffer = readVerifiedFile(file, 4096);
  if (!buffer || buffer.length < 1) return null;
  const value = buffer.toString("utf8").trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function hasUnsafeObjectIndirection(commonGitDir: string): boolean {
  try {
    const objects = path.join(commonGitDir, "objects");
    if (fs.existsSync(objects)) {
      const canonicalObjects = fs.realpathSync.native(objects);
      const canonicalCommon = fs.realpathSync.native(commonGitDir);
      if (
        canonicalObjects !== path.join(canonicalCommon, "objects") ||
        fs.lstatSync(objects).isSymbolicLink()
      ) {
        return true;
      }
    }
    return fs.existsSync(path.join(commonGitDir, "objects", "info", "alternates"));
  } catch {
    return true;
  }
}

function layoutFor(gitDir: string, commonGitDir: string): ValidatedGitLayout | null {
  try {
    const canonicalGitDir = fs.realpathSync.native(gitDir);
    const canonicalCommon = fs.realpathSync.native(commonGitDir);
    const objectDir = fs.realpathSync.native(path.join(canonicalCommon, "objects"));
    if (objectDir !== path.join(canonicalCommon, "objects")) return null;
    const gitStat = fs.statSync(canonicalGitDir);
    const commonStat = fs.statSync(canonicalCommon);
    const objectStat = fs.statSync(objectDir);
    if (!gitStat.isDirectory() || !commonStat.isDirectory() || !objectStat.isDirectory()) return null;
    return {
      gitDir: canonicalGitDir,
      commonGitDir: canonicalCommon,
      objectDir,
      gitDirDev: gitStat.dev,
      gitDirIno: gitStat.ino,
      commonDirDev: commonStat.dev,
      commonDirIno: commonStat.ino,
      objectDirDev: objectStat.dev,
      objectDirIno: objectStat.ino,
    };
  } catch {
    return null;
  }
}

function validatedGitDirectory(root: string): ValidatedGitLayout | null {
  const marker = path.join(root, ".git");
  let markerStat: fs.Stats;
  try {
    markerStat = fs.lstatSync(marker);
  } catch {
    return null;
  }
  if (markerStat.isSymbolicLink()) return null;

  if (markerStat.isDirectory()) {
    try {
      if (fs.realpathSync.native(marker) !== path.resolve(marker)) return null;
      return hasUnsafeObjectIndirection(marker) ? null : layoutFor(marker, marker);
    } catch {
      return null;
    }
  }

  if (!markerStat.isFile() || markerStat.size > 4096) return null;
  const markerText = readSmallTextFile(marker);
  const match = markerText?.match(/^gitdir:\s*(.+)$/);
  if (!match) return null;
  try {
    const linkedGitDir = fs.realpathSync.native(path.resolve(path.dirname(marker), match[1]));
    if (!fs.statSync(linkedGitDir).isDirectory()) return null;

    // A legitimate `git worktree` control directory points back to this exact
    // .git file and names its common repository through `commondir`. Reject
    // arbitrary .git files that simply point at another checkout's metadata.
    const backPointer = readSmallTextFile(path.join(linkedGitDir, "gitdir"));
    const commonPointer = readSmallTextFile(path.join(linkedGitDir, "commondir"));
    if (!backPointer || !commonPointer) return null;
    const canonicalBackPointer = fs.realpathSync.native(path.resolve(linkedGitDir, backPointer));
    if (canonicalBackPointer !== fs.realpathSync.native(marker)) return null;
    const commonGitDir = fs.realpathSync.native(path.resolve(linkedGitDir, commonPointer));
    if (!fs.statSync(commonGitDir).isDirectory()) return null;
    if (path.dirname(path.dirname(linkedGitDir)) !== commonGitDir) return null;
    if (hasUnsafeObjectIndirection(commonGitDir)) return null;
    return layoutFor(linkedGitDir, commonGitDir);
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(file: string, dev: number, ino: number): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isDirectory() && stat.dev === dev && stat.ino === ino && fs.realpathSync.native(file) === file;
  } catch {
    return false;
  }
}

function resolveHead(layout: ValidatedGitLayout): { headText: string; oid: string | null } | null {
  const head = readSmallTextFile(path.join(layout.gitDir, "HEAD"));
  if (!head) return null;
  if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(head)) return { headText: `${head}\n`, oid: head };
  const match = head.match(/^ref:\s+(refs\/[A-Za-z0-9._/-]+)$/);
  if (!match || match[1].includes("..") || match[1].includes("//")) return null;
  const refName = match[1];
  const loose = readSmallTextFile(path.join(layout.commonGitDir, ...refName.split("/")));
  if (loose && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(loose)) {
    return { headText: `ref: ${refName}\n`, oid: loose };
  }
  const packed = readVerifiedFile(path.join(layout.commonGitDir, "packed-refs"), MAX_PACKED_REFS_BYTES);
  if (packed) {
    for (const line of packed.toString("utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const separator = line.indexOf(" ");
      if (separator < 1) continue;
      const oid = line.slice(0, separator);
      if (line.slice(separator + 1) === refName && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(oid)) {
        return { headText: `ref: ${refName}\n`, oid };
      }
    }
  }
  // An unborn branch is valid and has no object ID yet.
  return { headText: `ref: ${refName}\n`, oid: null };
}

function withinDeadline(deadline: number): boolean {
  return performance.now() <= deadline;
}

function copyVerifiedFile(source: string, destination: string, maxBytes: number, deadline = Infinity): number | null {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let sourceFd: number | null = null;
  let destinationFd: number | null = null;
  try {
    if (!withinDeadline(deadline)) return null;
    const before = fs.lstatSync(source);
    if (before.isSymbolicLink() || !before.isFile() || before.size < 0 || before.size > maxBytes) return null;
    if (!withinDeadline(deadline)) return null;
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(sourceFd);
    if (!opened.isFile() || opened.size !== before.size) return null;
    if (!withinDeadline(deadline)) return null;
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(GIT_COPY_BUFFER_BYTES, Math.max(1, opened.size)));
    let remaining = opened.size;
    while (remaining > 0) {
      if (!withinDeadline(deadline)) return null;
      const read = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (read === 0) return null;
      let written = 0;
      while (written < read) {
        if (!withinDeadline(deadline)) return null;
        written += fs.writeSync(destinationFd, buffer, written, read - written, null);
      }
      remaining -= read;
    }
    if (!withinDeadline(deadline)) return null;
    const after = fs.statSync(source);
    return (
      withinDeadline(deadline) &&
      fs.realpathSync.native(source) === path.resolve(source) &&
      after.isFile() &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      opened.dev === before.dev &&
      opened.ino === before.ino &&
      opened.size === before.size
    ) ? opened.size : null;
  } catch {
    return null;
  } finally {
    if (destinationFd !== null) {
      try {
        fs.closeSync(destinationFd);
      } catch {
        // best effort for a private snapshot descriptor
      }
    }
    if (sourceFd !== null) {
      try {
        fs.closeSync(sourceFd);
      } catch {
        // best effort for a verified source descriptor
      }
    }
  }
}

function copyVerifiedObjectStore(source: string, destination: string, deadline: number): boolean {
  let fileCount = 0;
  let totalBytes = 0;

  const copyDirectory = (from: string, to: string, relative: string): boolean => {
    try {
      if (!withinDeadline(deadline)) return false;
      const before = fs.lstatSync(from);
      if (before.isSymbolicLink() || !before.isDirectory() || fs.realpathSync.native(from) !== path.resolve(from)) {
        return false;
      }
      if (!withinDeadline(deadline)) return false;
      fs.mkdirSync(to, { mode: 0o700 });
      for (const entry of fs.readdirSync(from)) {
        if (!withinDeadline(deadline)) return false;
        const childRelative = relative ? `${relative}/${entry}` : entry;
        if (childRelative === "info/alternates") return false;
        const childFrom = path.join(from, entry);
        const childTo = path.join(to, entry);
        const child = fs.lstatSync(childFrom);
        if (child.isDirectory()) {
          if (!copyDirectory(childFrom, childTo, childRelative)) return false;
        } else {
          if (++fileCount > MAX_GIT_OBJECT_FILES) return false;
          const bytes = copyVerifiedFile(childFrom, childTo, MAX_GIT_OBJECT_BYTES - totalBytes, deadline);
          if (bytes === null) return false;
          totalBytes += bytes;
        }
      }
      if (!withinDeadline(deadline)) return false;
      const after = fs.statSync(from);
      return withinDeadline(deadline) && after.isDirectory() && after.dev === before.dev && after.ino === before.ino && fs.realpathSync.native(from) === path.resolve(from);
    } catch {
      return false;
    }
  };

  return copyDirectory(source, destination, "");
}

function createGitSnapshot(root: string): GitSnapshot | null {
  const layout = validatedGitDirectory(root);
  if (!layout) return null;
  const head = resolveHead(layout);
  if (!head) return null;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-git-snapshot-"));
  try {
    fs.chmodSync(temp, 0o700);
    fs.mkdirSync(path.join(temp, "refs"), { mode: 0o700 });
    fs.writeFileSync(path.join(temp, "HEAD"), head.headText, { mode: 0o600, flag: "wx" });
    if (head.headText.startsWith("ref: ") && head.oid) {
      const refName = head.headText.slice(5).trim();
      const destination = path.join(temp, ...refName.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, `${head.oid}\n`, { mode: 0o600, flag: "wx" });
    }
    const objectFormat = head.oid?.length === 64 ? "\n[extensions]\n\tobjectFormat = sha256\n" : "";
    fs.writeFileSync(
      path.join(temp, "config"),
      `[core]\n\trepositoryFormatVersion = ${head.oid?.length === 64 ? "1" : "0"}\n\tbare = false\n\tfileMode = true\n${objectFormat}`,
      { mode: 0o600, flag: "wx" }
    );
    const snapshotObjects = path.join(temp, "objects");
    const deadline = performance.now() + MAX_GIT_SNAPSHOT_MS;
    if (!copyVerifiedObjectStore(layout.objectDir, snapshotObjects, deadline)) throw new Error("unsafe object store");

    const sourceIndex = path.join(layout.gitDir, "index");
    if (fs.existsSync(sourceIndex) && copyVerifiedFile(sourceIndex, path.join(temp, "index"), MAX_GIT_INDEX_BYTES, deadline) === null) {
      throw new Error("unsafe index");
    }
    const shared = new Set<string>();
    for (const directory of [layout.gitDir, layout.commonGitDir]) {
      for (const name of fs.readdirSync(directory)) {
        if (/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(name)) shared.add(path.join(directory, name));
      }
    }
    if (shared.size > MAX_SHARED_INDEX_FILES) throw new Error("too many shared indexes");
    for (const source of shared) {
      if (copyVerifiedFile(source, path.join(temp, path.basename(source)), MAX_GIT_INDEX_BYTES, deadline) === null) {
        throw new Error("unsafe shared index");
      }
    }
    if (
      !sameDirectoryIdentity(layout.gitDir, layout.gitDirDev, layout.gitDirIno) ||
      !sameDirectoryIdentity(layout.commonGitDir, layout.commonDirDev, layout.commonDirIno) ||
      !sameDirectoryIdentity(layout.objectDir, layout.objectDirDev, layout.objectDirIno)
    ) {
      throw new Error("git metadata changed");
    }
    return { gitDir: temp, objectDir: snapshotObjects };
  } catch {
    fs.rmSync(temp, { recursive: true, force: true });
    return null;
  }
}

type RepositoryState = "absent" | "safe" | "unsafe_configuration";

function hasUnsafeGitConfiguration(root: string): boolean {
  // Do not follow repository-controlled include/includeIf directives while
  // inspecting configuration. Their presence is itself unsupported. Listing
  // names only also avoids copying command values or credentials into memory.
  const config = spawnGitPreflight(root, [
    "config",
    "--no-includes",
    "--name-only",
    "--null",
    "--list",
  ]);
  if (!config.ok) return true;
  const keys = config.stdout.split("\0").filter(Boolean);
  return keys.some((key) => UNSAFE_GIT_CONFIG_KEYS.some((pattern) => pattern.test(key)));
}

function repositoryState(root: string): RepositoryState {
  // Do not walk into a parent repository: the connected workspace is the
  // authorization boundary. Only validated linked-worktree control files are
  // allowed to reference metadata outside it.
  if (!validatedGitDirectory(root)) return "absent";

  // This inspection runs before any Git command that may read index or object
  // data. git-config parses names but does not invoke filters, transports,
  // credential helpers, or SSH commands. Unsupported executable/network-capable
  // configuration therefore fails closed before status or diff can reach it.
  if (hasUnsafeGitConfiguration(root)) return "unsafe_configuration";

  const check = spawnGitPreflight(root, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"]);
  if (!check.ok) return "absent";
  const lines = check.stdout.trim().split(/\r?\n/);
  if (lines[0] !== "true" || !lines[1]) return "absent";
  try {
    return fs.realpathSync.native(lines[1]) === fs.realpathSync.native(root)
      ? "safe"
      : "absent";
  } catch {
    return "absent";
  }
}

function isRepository(root: string): boolean {
  return repositoryState(root) === "safe";
}

/**
 * Run a read-only Git command only after repository configuration has passed
 * the non-executing preflight. Global/system config, hooks, pagers, optional
 * locks, and lazy object fetching remain disabled for the subprocess itself.
 */
export function runGit(root: string, args: string[]): GitCommandResult {
  const state = repositoryState(root);
  if (state !== "safe") {
    return {
      ok: false,
      stdout: "",
      stderr:
        state === "unsafe_configuration"
          ? UNSAFE_GIT_CONFIGURATION_ERROR
          : "Validated Git repository not found.",
      code: null,
    };
  }
  return withGitSnapshot(root, (run) => run(args)) ?? {
    ok: false,
    stdout: "",
    stderr: UNSAFE_GIT_CONFIGURATION_ERROR,
    code: null,
  };
}

function withGitSnapshot<T>(root: string, callback: (run: (args: string[]) => GitCommandResult) => T): T | null {
  const binary = gitBinary();
  const snapshot = createGitSnapshot(root);
  if (!binary || !snapshot) return null;
  try {
    return callback((args) => {
      const result = spawnSync(
        binary,
        [...SAFE_GIT_CONFIG, "--literal-pathspecs", `--git-dir=${snapshot.gitDir}`, `--work-tree=${root}`, ...args],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 30_000,
          env: safeGitEnv(root, binary, snapshot),
        }
      );
      return {
        ok: result.status === 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.status,
      };
    });
  } finally {
    fs.rmSync(snapshot.gitDir, { recursive: true, force: true });
  }
}

function sanitizeGitLabel(value: string): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�");
  return redactAndTruncate(clean, 4096).text;
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export function gitInfo(root: string): GitInfo {
  if (!isRepository(root)) {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Reuse the path-filtered status view so the summary does not reveal the
  // presence of secret files and does not treat AppleDouble metadata as work.
  const status = gitStatus(root);
  return {
    isRepo: true,
    branch: branch.ok ? sanitizeGitLabel(branch.stdout.trim()) : null,
    commit: commit.ok && /^[a-f0-9]{7,64}$/i.test(commit.stdout.trim()) ? commit.stdout.trim() : null,
    dirty:
      !status.isRepo ||
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0 ||
      status.conflicted.length > 0,
  };
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
  redactedPathCount: number;
  truncated: boolean;
}

function emptyStatus(): GitStatusResult {
  return {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    redactedPathCount: 0,
    truncated: false,
  };
}

const MAX_STATUS_ENTRIES = 500;

export function gitStatus(root: string): GitStatusResult {
  const out = emptyStatus();
  if (!isRepository(root)) return out;
  const result = runGit(root, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--no-renames",
    "--ignore-submodules=all",
    "-z",
    "--",
    ".",
  ]);
  if (!result.ok) return out;

  out.isRepo = true;
  const policy = new IgnoreRules(root);
  const include = (filePath: string): boolean => {
    if (!policy.isSensitive(filePath)) return true;
    out.redactedPathCount++;
    return false;
  };
  const add = <T>(target: T[], value: T): void => {
    const count = out.staged.length + out.unstaged.length + out.untracked.length + out.conflicted.length;
    if (count >= MAX_STATUS_ENTRIES) {
      out.truncated = true;
      return;
    }
    target.push(value);
  };

  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      out.branch = sanitizeGitLabel(record.slice("# branch.head ".length).trim());
    } else if (record.startsWith("# branch.upstream ")) {
      out.upstream = sanitizeGitLabel(record.slice("# branch.upstream ".length).trim());
    } else if (record.startsWith("# branch.ab ")) {
      const match = record.match(/\+(\d+) -(\d+)/);
      if (match) {
        out.ahead = Number.parseInt(match[1], 10);
        out.behind = Number.parseInt(match[2], 10);
      }
    } else if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const filePath = parts.slice(8).join(" ");
      if (!include(filePath)) continue;
      const safePath = sanitizeGitLabel(filePath).slice(0, 1000);
      if (xy[0] !== ".") add(out.staged, { path: safePath, change: xy[0] });
      if (xy[1] !== ".") add(out.unstaged, { path: safePath, change: xy[1] });
    } else if (record.startsWith("? ")) {
      const filePath = record.slice(2);
      if (include(filePath)) add(out.untracked, sanitizeGitLabel(filePath).slice(0, 1000));
    } else if (record.startsWith("u ")) {
      const filePath = record.split(" ").slice(10).join(" ");
      if (include(filePath)) add(out.conflicted, sanitizeGitLabel(filePath).slice(0, 1000));
    }
  }
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
  eligibleFileCount: number;
  redactedPathCount: number;
  redactionCount: number;
  truncatedByFileLimit: boolean;
}

const MAX_DIFF_FILES = 500;
const MAX_DIFF_PATH_BYTES = 128 * 1024;

function diffArgs(mode: DiffMode): string[] {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=all",
  ];
  if (mode === "staged") args.push("--cached");
  if (mode === "head") args.push("HEAD");
  return args;
}

function emptyDiff(mode: DiffMode): GitDiffResult {
  return {
    isRepo: false,
    mode,
    totalBytes: 0,
    offset: 0,
    returnedBytes: 0,
    hasMore: false,
    nextOffset: null,
    diff: "",
    eligibleFileCount: 0,
    redactedPathCount: 0,
    redactionCount: 0,
    truncatedByFileLimit: false,
  };
}

export function gitDiff(root: string, opts: GitDiffOptions = {}, relPath?: string): GitDiffResult {
  const mode = opts.mode ?? "unstaged";
  const state = repositoryState(root);
  if (state === "unsafe_configuration") throw new Error(UNSAFE_GIT_CONFIGURATION_ERROR);
  if (state !== "safe") return emptyDiff(mode);

  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const policy = new IgnoreRules(root);

  const diff = withGitSnapshot(root, (run) => {
    const names = run([
      ...diffArgs(mode),
      "--name-only",
      "-z",
      "--",
      relPath || ".",
    ]);
    if (!names.ok) {
      throw new Error(`Unable to enumerate Git diff paths (exit ${names.code ?? "unknown"}).`);
    }
    const allPaths = names.stdout.split("\0").filter(Boolean);
    const allowedPaths = allPaths.filter((filePath) => !policy.isSensitive(filePath));
    const selectedPaths: string[] = [];
    let selectedPathBytes = 0;
    for (const filePath of allowedPaths) {
      const cost = Buffer.byteLength(filePath, "utf8") + 1;
      if (selectedPaths.length >= MAX_DIFF_FILES || selectedPathBytes + cost > MAX_DIFF_PATH_BYTES) break;
      selectedPaths.push(filePath);
      selectedPathBytes += cost;
    }
    const redactedPathCount = allPaths.length - allowedPaths.length;
    const truncatedByFileLimit = allowedPaths.length > selectedPaths.length;

    if (selectedPaths.length === 0) {
      return {
        ...emptyDiff(mode),
        isRepo: true,
        offset,
        eligibleFileCount: allowedPaths.length,
        redactedPathCount,
        truncatedByFileLimit,
      };
    }

    const result = run([...diffArgs(mode), "--", ...selectedPaths]);
    if (!result.ok) {
      throw new Error(`Unable to produce Git diff (exit ${result.code ?? "unknown"}).`);
    }
    const redacted = redactSensitiveText(result.stdout);
    const full = Buffer.from(redacted.text, "utf8");
    const slice = full.subarray(offset, offset + maxBytes);
    let text = slice.toString("utf8");
    let sliceLen = slice.length;
    if (offset + sliceLen < full.length) {
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline > 0) {
        text = text.slice(0, lastNewline + 1);
        sliceLen = Buffer.byteLength(text, "utf8");
      }
    }
    const hasMore = offset + sliceLen < full.length;
    return {
      isRepo: true,
      mode,
      totalBytes: full.length,
      offset,
      returnedBytes: sliceLen,
      hasMore,
      nextOffset: hasMore ? offset + sliceLen : null,
      diff: text,
      eligibleFileCount: allowedPaths.length,
      redactedPathCount,
      redactionCount: redacted.redactionCount,
      truncatedByFileLimit,
    };
  });
  if (!diff) throw new Error(UNSAFE_GIT_CONFIGURATION_ERROR);
  return diff;
}
