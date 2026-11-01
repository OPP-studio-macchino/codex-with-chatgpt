import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { IgnoreRules } from "./ignore.js";
import { redactAndTruncate, redactSensitiveText } from "../security/redaction.js";
import { findBinary } from "../tunnel/detect.js";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { readStableFile, sameFile } from "../security/stable-file.js";
import type { Workspace } from "./manager.js";
import type { TaskReconciler } from "../execution/task-reconciler.js";
import { z } from "zod/v3";

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
  sourceLayout: ValidatedGitLayout;
  headOid: string | null;
  deadline: number;
}

const MAX_GIT_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024;
const MAX_GIT_INFO_EXCLUDE_BYTES = 1024 * 1024;
const MAX_SHARED_INDEX_FILES = 8;
// Shared ceilings for selective reads and the eager fallback for other queries.
const MAX_GIT_OBJECT_FILES = 20_000;
const MAX_GIT_OBJECT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_GIT_SNAPSHOT_MS = 250;
const MAX_CONFIGURED_GIT_SNAPSHOT_MS = 10_000;

/** Internal worker-only context. hrtime is process-wide monotonic across threads. */
export interface ReconciliationReadBudget { readonly deadlineNs: bigint; readonly snapshotRoot?: string }
export function remainingReconciliationReadMs(budget: ReconciliationReadBudget): number {
  if (!budget || typeof budget.deadlineNs !== "bigint") throw new GitReadError("GIT_SNAPSHOT_FAILED", "scope", "unverified", 1000);
  const remaining = Number(budget.deadlineNs - process.hrtime.bigint()) / 1e6;
  if (!Number.isFinite(remaining) || remaining > 20_000) throw new GitReadError("GIT_SNAPSHOT_FAILED", "scope", "unverified", 1000);
  if (remaining < 1) throw new GitReadError("GIT_SNAPSHOT_FAILED", "scoped_objects", "budget_exhausted", 1000);
  return remaining;
}

function readTimeout(deadline: number | undefined): number {
  if (deadline === undefined) return 30_000;
  const remaining = Math.floor(deadline - performance.now());
  if (!Number.isFinite(remaining) || remaining < 1) throw new GitReadError("GIT_SNAPSHOT_FAILED", "scoped_objects", "budget_exhausted");
  return Math.min(30_000, remaining);
}

function gitSnapshotTimeBudgetMs(): number {
  const raw = process.env.C2C_GIT_SNAPSHOT_MS;
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_GIT_SNAPSHOT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= DEFAULT_MAX_GIT_SNAPSHOT_MS &&
    value <= MAX_CONFIGURED_GIT_SNAPSHOT_MS
    ? value
    : DEFAULT_MAX_GIT_SNAPSHOT_MS;
}
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
function spawnGitPreflight(root: string, args: string[], deadline?: number): GitCommandResult {
  readTimeout(deadline);
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
    timeout: readTimeout(deadline),
    killSignal: "SIGKILL",
    env: safeGitEnv(root, binary),
    }
  );
  readTimeout(deadline);
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

/** Digest of the validated repository layout and bounded control files; never exposes their paths. */
export function gitRepositoryIdentity(root: string): string {
  const layout = validatedGitDirectory(root);
  if (!layout) throw new GitReadError("GIT_READ_FAILED", "layout", "unverified");
  const hash = createHash("sha256").update(JSON.stringify(layout));
  const marker = path.join(root, ".git");
  const controls = [path.join(layout.commonGitDir, "config"), path.join(layout.gitDir, "config.worktree")];
  if (fs.lstatSync(marker).isFile()) controls.push(marker, path.join(layout.gitDir, "gitdir"), path.join(layout.gitDir, "commondir"));
  for (const file of controls) {
    try {
      fs.lstatSync(file);
      const bytes = readVerifiedFile(file, 64 * 1024);
      if (!bytes) throw new GitReadError("GIT_READ_FAILED", "control_file", "unverified");
      hash.update(file).update(bytes);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") hash.update(file).update("absent");
      else throw new GitReadError("GIT_READ_FAILED", "control_file", "unverified");
    }
  }
  if (JSON.stringify(validatedGitDirectory(root)) !== JSON.stringify(layout)) throw new GitReadError("GIT_READ_FAILED", "identity", "unverified");
  return hash.digest("hex");
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
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size < 0 || before.size > maxBytes) return null;
    if (!withinDeadline(deadline)) return null;
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(sourceFd);
    if (!opened.isFile() || !sameFile(opened, before)) return null;
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
      sameFile(before, after) && sameFile(opened, fs.fstatSync(sourceFd)) &&
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
        // macOS/network filesystems can add AppleDouble sidecars beside real
        // Git objects. They are not valid object-store entries. Exclude them
        // only from the private read-only snapshot; never mutate the repo.
        if (entry.startsWith("._")) continue;
        const childRelative = relative ? `${relative}/${entry}` : entry;
        if (childRelative === "info/alternates") return false;
        const childFrom = path.join(from, entry);
        const childTo = path.join(to, entry);
        const child = fs.lstatSync(childFrom);
        if (child.isDirectory()) {
          if (!copyDirectory(childFrom, childTo, childRelative)) return false;
        } else {
          if (++fileCount > MAX_GIT_OBJECT_FILES) throw new GitReadError("GIT_SNAPSHOT_FAILED", "objects", "file_limit");
          if (child.isFile() && child.size > MAX_GIT_OBJECT_BYTES - totalBytes) throw new GitReadError("GIT_SNAPSHOT_FAILED", "objects", "byte_limit");
          const bytes = copyVerifiedFile(childFrom, childTo, MAX_GIT_OBJECT_BYTES - totalBytes, deadline);
          if (bytes === null) return false;
          totalBytes += bytes;
        }
      }
      if (!withinDeadline(deadline)) return false;
      const after = fs.statSync(from);
      return withinDeadline(deadline) && after.isDirectory() && after.dev === before.dev && after.ino === before.ino && fs.realpathSync.native(from) === path.resolve(from);
    } catch (error) {
      if (error instanceof GitReadError) throw error;
      return false;
    }
  };

  return copyDirectory(source, destination, "");
}

export class GitReadError extends Error {
  constructor(public readonly code: "GIT_SNAPSHOT_FAILED" | "UNSAFE_GIT_CONFIGURATION" | "GIT_READ_FAILED", public readonly stage: string, public readonly reason: string, public snapshotMs = gitSnapshotTimeBudgetMs()) {
    super(`${code}: ${stage}: ${reason}`);
    this.name = "GitReadError";
  }
  details() {
    return { stage: this.stage, reason: this.reason,
      limits: { snapshot_ms: this.snapshotMs, object_files: MAX_GIT_OBJECT_FILES,
        object_bytes: MAX_GIT_OBJECT_BYTES, index_bytes: MAX_GIT_INDEX_BYTES,
        pack_indexes: 128, pack_index_bytes: 16 * 1024 * 1024, aggregate_pack_index_bytes: 32 * 1024 * 1024, aggregate_pack_index_oids: 400_000 },
      retry: { automatic: false, action: this.reason === "budget_exhausted" ? "RETRY_SCOPED_FILE_READ_AFTER_WORKSPACE_SETTLES" : "INSPECT_REPOSITORY_METADATA_READ_ONLY",
        preserves_worktree: true, never_reset_clean_stash: true } };
  }
}

function createGitSnapshot(root: string, selective = false, acquisitionDeadline?: number, snapshotRoot?: string): GitSnapshot {
  readTimeout(acquisitionDeadline);
  const layout = validatedGitDirectory(root);
  if (!layout) throw new GitReadError("GIT_SNAPSHOT_FAILED", "layout", "unverified");
  const head = resolveHead(layout);
  readTimeout(acquisitionDeadline);
  if (!head) throw new GitReadError("GIT_SNAPSHOT_FAILED", "head", "unverified");
  let temp: string | undefined;
  let stage = "temporary_storage";
  let deadline: number | undefined = acquisitionDeadline;
  try {
    temp = fs.mkdtempSync(path.join(snapshotRoot ?? os.tmpdir(), "c2c-git-snapshot-"));
    readTimeout(acquisitionDeadline);
    fs.chmodSync(temp, 0o700);
    readTimeout(acquisitionDeadline);
    fs.mkdirSync(path.join(temp, "refs"), { mode: 0o700 });
    readTimeout(acquisitionDeadline);
    fs.writeFileSync(path.join(temp, "HEAD"), head.headText, { mode: 0o600, flag: "wx" });
    readTimeout(acquisitionDeadline);
    if (head.headText.startsWith("ref: ") && head.oid) {
      const refName = head.headText.slice(5).trim();
      const destination = path.join(temp, ...refName.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      readTimeout(acquisitionDeadline);
      fs.writeFileSync(destination, `${head.oid}\n`, { mode: 0o600, flag: "wx" });
      readTimeout(acquisitionDeadline);
    }
    const objectFormat = head.oid?.length === 64 ? "\n[extensions]\n\tobjectFormat = sha256\n" : "";
    fs.writeFileSync(
      path.join(temp, "config"),
      `[core]\n\trepositoryFormatVersion = ${head.oid?.length === 64 ? "1" : "0"}\n\tbare = false\n\tfileMode = true\n${objectFormat}`,
      { mode: 0o600, flag: "wx" }
    );
    deadline ??= performance.now() + gitSnapshotTimeBudgetMs();
    readTimeout(acquisitionDeadline);
    stage = "exclude";
    const sourceExclude = path.join(layout.commonGitDir, "info", "exclude");
    if (fs.existsSync(sourceExclude)) {
      fs.mkdirSync(path.join(temp, "info"), { mode: 0o700 });
      if (copyVerifiedFile(sourceExclude, path.join(temp, "info", "exclude"), MAX_GIT_INFO_EXCLUDE_BYTES, deadline) === null) {
        throw new Error("unsafe info exclude");
      }
    }

    const snapshotObjects = path.join(temp, "objects");
    stage = "objects";
    if (selective) fs.mkdirSync(snapshotObjects, { mode: 0o700 });
    else if (!copyVerifiedObjectStore(layout.objectDir, snapshotObjects, deadline)) throw new Error("unsafe object store");

    const sourceIndex = path.join(layout.gitDir, "index");
    stage = "index";
    if (fs.existsSync(sourceIndex) && copyVerifiedFile(sourceIndex, path.join(temp, "index"), MAX_GIT_INDEX_BYTES, deadline) === null) {
      throw new Error("unsafe index");
    }
    const shared = new Set<string>();
    stage = "shared_index";
    for (const directory of new Set([layout.gitDir, layout.commonGitDir])) {
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
    stage = "identity";
    if (
      !sameDirectoryIdentity(layout.gitDir, layout.gitDirDev, layout.gitDirIno) ||
      !sameDirectoryIdentity(layout.commonGitDir, layout.commonDirDev, layout.commonDirIno) ||
      !sameDirectoryIdentity(layout.objectDir, layout.objectDirDev, layout.objectDirIno)
    ) {
      throw new Error("git metadata changed");
    }
    return { gitDir: temp, objectDir: snapshotObjects, sourceLayout: layout, headOid: head.oid, deadline };
  } catch (error) {
    if (temp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Preserve safe primary diagnostic. */ } }
    if (error instanceof GitReadError) throw error;
    throw new GitReadError("GIT_SNAPSHOT_FAILED", stage, deadline !== undefined && !withinDeadline(deadline) ? "budget_exhausted" : "unverified");
  }
}


type SelectiveRead = { path: string; mode: DiffMode } | "current" | "head" | "index";

/** Selective reads never traverse parent commits or unrelated loose objects.
 * Packed objects require a verified private copy of their containing pack only.
 * No alternates, original-object-directory access, network, hooks or lazy fetch.
 */
function hydrateScopedObjects(root: string, binary: string, snapshot: GitSnapshot, scope: SelectiveRead): void {
  function fail(stage: string, reason = "unverified"): never { throw new GitReadError("GIT_SNAPSHOT_FAILED", stage, reason); }
  const check = () => { if (!withinDeadline(snapshot.deadline)) fail("scoped_objects", "budget_exhausted"); };
  if (typeof scope !== "string" && (path.isAbsolute(scope.path) || scope.path.split(/[\\/]/).some(p => !p || p === "." || p === "..") ||
      /[\p{Cc}\p{Cf}]/u.test(scope.path) || Buffer.byteLength(scope.path) > 4096)) fail("scope", "invalid_path");
  const hashBytes = snapshot.headOid?.length === 64 ? 32 : 20;
  const oidPattern = new RegExp("^[a-f0-9]{" + hashBytes * 2 + "}$");
  let copiedBytes = 0, copiedFiles = 0;
  const copy = (source: string, dest: string) => {
    check();
    if (++copiedFiles > MAX_GIT_OBJECT_FILES) fail("scoped_objects", "file_limit");
    const bytes = copyVerifiedFile(source, dest, MAX_GIT_OBJECT_BYTES - copiedBytes, snapshot.deadline);
    if (bytes === null) fail("scoped_objects", withinDeadline(snapshot.deadline) ? "unverified_or_byte_limit" : "budget_exhausted");
    copiedBytes += bytes;
  };
  const run = (args: string[], input?: Buffer | string): Buffer => {
    check();
    const p = spawnSync(binary, [...SAFE_GIT_CONFIG, "--literal-pathspecs", "--git-dir=" + snapshot.gitDir,
      "--work-tree=" + root, ...args], { cwd: root, env: safeGitEnv(root, binary, snapshot),
      input, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL", timeout: Math.max(1, Math.min(30_000, Math.ceil(snapshot.deadline - performance.now()))) });
    check();
    if (p.status !== 0 || p.error) fail("scoped_objects", "command_failed");
    return p.stdout;
  };
  let indexBytes = 0, scannedOids = 0;
  const copiedPacks = new Set<string>(), imported = new Set<string>();
  const pendingIndexBlobs = new Set<string>(), packedOutputs = new Map<string, Buffer>();
  const readPackedObject = (oid: string): Buffer => {
    const cached = packedOutputs.get(oid);
    if (cached) { packedOutputs.delete(oid); return cached; }
    if (!pendingIndexBlobs.has(oid) || pendingIndexBlobs.size < 2) return run(["cat-file", "--batch"], oid + "\n");
    // Only already-copied private packs, and only OIDs required by this index.
    // Bound one prefetch below the existing 16 MiB subprocess output ceiling.
    const requested = [oid, ...pendingIndexBlobs].filter((value, i) => i === 0 || value !== oid);
    const lines = run(["cat-file", "--batch-check"], requested.join("\n") + "\n").toString("ascii").split("\n");
    if (lines.pop() !== "" || lines.length !== requested.length) fail("scoped_objects", "invalid_object");
    const selected: { oid: string; size: number }[] = [];
    let bytes = 0, missing = false;
    for (let i = 0; i < requested.length; i++) {
      check();
      const fields = lines[i]!.split(" ");
      if (fields[0] !== requested[i]) fail("scoped_objects", "invalid_object");
      if (fields.length === 2 && fields[1] === "missing") { if (i === 0) missing = true; continue; }
      const size = Number(fields[2]);
      if (fields.length !== 3 || fields[1] !== "blob" || !/^(0|[1-9]\d*)$/.test(fields[2] ?? "") ||
          !Number.isSafeInteger(size) || size > 8 * 1024 * 1024) fail("scoped_objects", "invalid_object");
      const length = Buffer.byteLength(lines[i]!) + size + 2;
      if (selected.length && bytes + length > 8 * 1024 * 1024) continue;
      selected.push({ oid: fields[0]!, size }); bytes += length;
    }
    if (missing) return Buffer.from(oid + " missing\n");
    packedOutputs.clear();
    const output = run(["cat-file", "--batch"], selected.map(item => item.oid).join("\n") + "\n");
    let offset = 0;
    for (const item of selected) {
      check();
      const header = Buffer.from(`${item.oid} blob ${item.size}\n`), end = offset + header.length + item.size;
      if (!output.subarray(offset, offset + header.length).equals(header) || output[end] !== 10)
        fail("scoped_objects", "invalid_object");
      packedOutputs.set(item.oid, output.subarray(offset, end + 1)); offset = end + 1;
    }
    if (offset !== output.length) fail("scoped_objects", "invalid_object");
    const result = packedOutputs.get(oid)!; packedOutputs.delete(oid);
    return result;
  };
  // Bound metadata enumeration, and reject aliases even for acceleration
  // files omitted from the private snapshot. AppleDouble is never a pack index.
  const packDir = path.join(snapshot.sourceLayout.objectDir, "pack");
  let packStat: fs.Stats | undefined;
  try { packStat = fs.lstatSync(packDir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (packStat && (!packStat.isDirectory() || packStat.isSymbolicLink() || fs.realpathSync.native(packDir) !== packDir)) fail("scoped_pack", "unsafe_directory");
  const packNames: string[] = [];
  const directory = packStat ? fs.opendirSync(packDir) : undefined;
  try {
    let entry: fs.Dirent | null, count = 0;
    while (directory && (entry = directory.readSync())) {
      check();
      if (++count > 1024) fail("scoped_pack", "directory_entry_limit");
      if (entry.name.startsWith("._")) continue;
      if (/^pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(idx|pack|rev)$/.test(entry.name) || entry.name === "multi-pack-index") {
        const stat = fs.lstatSync(path.join(packDir, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("scoped_pack", "unsafe_file");
        if (entry.name.endsWith(".idx")) packNames.push(entry.name);
      }
    }
  } finally { directory?.closeSync(); }
  if (packNames.length > 128) fail("scoped_pack", "index_count_limit");
  packNames.sort();
  const graph = path.join(snapshot.sourceLayout.objectDir, "info/commit-graph");
  try {
    const stat = fs.lstatSync(graph);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(graph) !== graph) fail("scoped_pack", "unsafe_file");
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const importObject = (oid: string) => {
    if (!oidPattern.test(oid)) fail("scoped_objects", "invalid_oid");
    if (imported.has(oid)) return;
    if (imported.size >= MAX_GIT_OBJECT_FILES) fail("scoped_objects", "file_limit");
    check();
    const fanout = path.join(snapshot.sourceLayout.objectDir, oid.slice(0, 2));
    const source = path.join(fanout, oid.slice(2));
    let exists = true;
    try { fs.lstatSync(source); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") exists = false; else fail("scoped_objects"); }
    if (exists) {
      const s = fs.lstatSync(fanout);
      if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(fanout) !== fanout) fail("scoped_objects", "unsafe_fanout");
      const destination = path.join(snapshot.objectDir, oid.slice(0, 2));
      fs.mkdirSync(destination, { mode: 0o700, recursive: true });
      copy(source, path.join(destination, oid.slice(2)));
      if (!sameDirectoryIdentity(fanout, s.dev, s.ino)) fail("scoped_objects", "identity_changed");
    } else {
      // A copied pack already supplies its other objects. No source index cache
      // or all-history OID set is retained in the bridge heap.
      if (copiedPacks.size) {
        const output = readPackedObject(oid);
        if (!output.equals(Buffer.from(oid + " missing\n"))) {
          // Reuse this bounded private-pack read for the mandatory type/size/hash
          // verification below instead of launching a second cat-file process.
          imported.add(oid); return output;
        }
      }
      let pack: { name: string; data: Buffer } | undefined;
      for (const name of packNames) {
        check();
        const { data } = readStableFile(path.join(packDir, name), 16 * 1024 * 1024);
        indexBytes += data.length;
        if (indexBytes > 32 * 1024 * 1024) fail("scoped_pack", "aggregate_index_byte_limit");
        const listing = run(["show-index", "--object-format=" + (hashBytes === 32 ? "sha256" : "sha1")], data).toString("utf8");
        let found = false;
        for (const line of listing.trim().split("\n").filter(Boolean)) {
          if (++scannedOids > 400_000) fail("scoped_pack", "aggregate_index_oid_limit");
          const fields = line.trim().split(/\s+/);
          if (!/^\d+$/.test(fields[0]!) || !oidPattern.test(fields[1]!)) fail("scoped_pack", "index_unverified");
          if (fields[1] === oid) found = true;
        }
        if (found) { pack = { name, data }; break; }
      }
      if (!pack) fail("scoped_objects", "object_missing");
      if (!copiedPacks.has(pack!.name)) {
        const target = path.join(snapshot.objectDir, "pack");
        fs.mkdirSync(target, { mode: 0o700, recursive: true });
        copy(path.join(packDir, pack!.name), path.join(target, pack!.name));
        if (!fs.readFileSync(path.join(target, pack!.name)).equals(pack!.data)) fail("scoped_pack", "identity_changed");
        const dataName = pack!.name.replace(/\.idx$/, ".pack");
        copy(path.join(packDir, dataName), path.join(target, dataName));
        run(["verify-pack", "--", path.join(target, pack!.name)]);
        copiedPacks.add(pack!.name);
      }
      if (!packStat || !sameDirectoryIdentity(packDir, packStat.dev, packStat.ino)) fail("scoped_pack", "identity_changed");
      imported.add(oid); return readPackedObject(oid);
    }
    imported.add(oid);
  };
  const verifiedBlobs = new Set<string>();
  let decodedBytes = 0;
  const object = (oid: string, expected: "commit" | "tree" | "blob") => {
    if (expected === "blob" && verifiedBlobs.has(oid)) return Buffer.alloc(0);
    const packedOutput = importObject(oid);
    check();
    let header: string[], content: Buffer;
    const loose = path.join(snapshot.objectDir, oid.slice(0, 2), oid.slice(2));
    if (fs.existsSync(loose)) {
      // Decode only the verified private copy. Bound compressed input and inflated
      // output independently; no per-loose-object Git startup or source-store read.
      let raw: Buffer;
      try {
        const compressed = readVerifiedFile(loose, 16 * 1024 * 1024);
        if (!compressed) fail("scoped_objects", "invalid_object");
        check();
        raw = inflateSync(compressed, { maxOutputLength: 8 * 1024 * 1024 + 128 });
      }
      catch { check(); fail("scoped_objects", "invalid_object"); }
      check();
      const nul = raw.indexOf(0);
      if (nul < 0 || nul > 128) fail("scoped_objects", "invalid_object");
      header = [oid, ...raw.subarray(0, nul).toString("utf8").split(" ")];
      content = raw.subarray(nul + 1);
    } else {
      const output = packedOutput ?? run(["cat-file", "--batch"], oid + "\n"), lineEnd = output.indexOf(10);
      if (lineEnd < 0 || output.at(-1) !== 10) fail("scoped_objects", "invalid_object");
      header = output.subarray(0, lineEnd).toString("ascii").split(" ");
      content = output.subarray(lineEnd + 1, -1);
    }
    const size = Number(header[2]);
    if (header.length !== 3 || header[0] !== oid || header[1] !== expected || !/^(0|[1-9]\d*)$/.test(header[2] ?? "") ||
        !Number.isSafeInteger(size) || size > 8 * 1024 * 1024 || content.length !== size)
      fail("scoped_objects", "invalid_object");
    decodedBytes += size;
    if (decodedBytes > MAX_GIT_OBJECT_BYTES) fail("scoped_objects", "byte_limit");
    if (createHash(hashBytes === 32 ? "sha256" : "sha1").update(expected + " " + size + "\0").update(content).digest("hex") !== oid)
      fail("scoped_objects", "object_hash_mismatch");
    check();
    if (expected === "blob") verifiedBlobs.add(oid);
    return content;
  };
  const index = scope === "head" ? "" : run(["ls-files", "--stage", "-z", ...(typeof scope === "string" ? [] : ["--", scope.path])]).toString("utf8");
  let entries = 0;
  function* treeEntries(oid: string) {
    const bytes = object(oid, "tree"), names = new Set<string>();
    let offset = 0;
    while (offset < bytes.length) {
      check();
      if (++entries > MAX_GIT_OBJECT_FILES) fail("scoped_objects", "file_limit");
      const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1);
      if (space < offset || nul <= space + 1 || nul + 1 + hashBytes > bytes.length) fail("scoped_objects", "invalid_tree");
      const mode = bytes.subarray(offset, space).toString("ascii");
      const name = bytes.subarray(space + 1, nul), key = name.toString("hex");
      if (name.includes(47) || name.equals(Buffer.from(".")) || name.equals(Buffer.from("..")) || names.has(key)) fail("scoped_objects", "invalid_tree");
      names.add(key);
      offset = nul + 1 + hashBytes;
      yield { mode, name, oid: bytes.subarray(nul + 1, offset).toString("hex") };
    }
  }
  for (const row of index.split("\0").filter(Boolean)) {
    check();
    if (++entries > MAX_GIT_OBJECT_FILES) fail("scoped_objects", "file_limit");
    const m = /^([0-7]{6}) ([a-f0-9]+) ([0-3])\t(.+)$/s.exec(row);
    if (!m || (typeof scope !== "string" && m[4] !== scope.path)) fail("scope", "single_file_required");
    if (m[1] === "160000") { if (typeof scope === "string") continue; fail("scope", "submodule_unsupported"); }
    if (!["100644", "100755", "120000"].includes(m[1]!)) fail("scope", "index_mode_unsupported");
    if (!/^0+$/.test(m[2]!)) pendingIndexBlobs.add(m[2]!);
  }
  for (const oid of pendingIndexBlobs) {
    object(oid, "blob");
    pendingIndexBlobs.delete(oid);
    packedOutputs.delete(oid);
  }
  entries = 0;
  if (scope === "head") {
    if (snapshot.headOid) object(snapshot.headOid, "commit");
  } else if ((scope === "current" || (typeof scope !== "string" && scope.mode !== "unstaged")) && snapshot.headOid) {
    const commit = object(snapshot.headOid, "commit");
    const tree = /^tree ([a-f0-9]+)\n/.exec(commit.toString("utf8"))?.[1];
    if (!tree || !oidPattern.test(tree)) fail("scoped_objects", "invalid_commit");
    let treeId = tree!;
    if (scope === "current") {
      const pending = [treeId], visited = new Set<string>();
      while (pending.length) {
        check();
        const oid = pending.pop()!;
        if (visited.has(oid)) continue;
        visited.add(oid);
        for (const { mode, oid: child } of treeEntries(oid)) {
          if (mode === "40000") pending.push(child);
          else if (["100644", "100755", "120000"].includes(mode)) object(child, "blob");
          else if (mode !== "160000") fail("scoped_objects", "invalid_tree");
        }
      }
    } else if (typeof scope !== "string") {
      const components = scope.path.split("/");
      for (let depth = 0; depth < components.length; depth++) {
        let chosen: { mode: string; oid: string } | undefined;
        for (const entry of treeEntries(treeId)) {
          const name = new TextDecoder("utf-8", { fatal: true }).decode(entry.name);
          if (name === components[depth]) chosen = entry;
        }
        if (!chosen) break; // Added path, absent from HEAD.
        if (depth + 1 < components.length) {
          if (chosen.mode !== "40000") fail("scope", "invalid_parent");
          treeId = chosen.oid;
        } else {
          if (!["100644", "100755", "120000"].includes(chosen.mode)) fail("scope", "single_file_required");
          object(chosen.oid, "blob");
        }
      }
    }
  }
  check();
  if ((packStat && !sameDirectoryIdentity(packDir, packStat.dev, packStat.ino)) ||
      !sameDirectoryIdentity(snapshot.sourceLayout.objectDir, snapshot.sourceLayout.objectDirDev, snapshot.sourceLayout.objectDirIno))
    fail("scoped_objects", "identity_changed");
}

type RepositoryState = "absent" | "safe" | "unsafe_configuration";

function hasUnsafeGitConfiguration(root: string, deadline?: number): boolean {
  // Do not follow repository-controlled include/includeIf directives while
  // inspecting configuration. Their presence is itself unsupported. Listing
  // names only also avoids copying command values or credentials into memory.
  const config = spawnGitPreflight(root, [
    "config",
    "--no-includes",
    "--name-only",
    "--null",
    "--list",
  ], deadline);
  if (!config.ok) return true;
  const keys = config.stdout.split("\0").filter(Boolean);
  return keys.some((key) => UNSAFE_GIT_CONFIG_KEYS.some((pattern) => pattern.test(key)));
}

function repositoryState(root: string, strict = false, deadline?: number): RepositoryState {
  readTimeout(deadline);
  const unverified = (stage: string): RepositoryState => {
    if (strict) throw new GitReadError("GIT_READ_FAILED", stage, "unverified");
    return "absent";
  };
  // Do not walk into a parent repository: the connected workspace is the
  // authorization boundary. Only validated linked-worktree control files are
  // allowed to reference metadata outside it.
  try { fs.lstatSync(path.join(root, ".git")); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : unverified("layout"); }
  if (!validatedGitDirectory(root)) return unverified("layout");
  readTimeout(deadline);

  // This inspection runs before any Git command that may read index or object
  // data. git-config parses names but does not invoke filters, transports,
  // credential helpers, or SSH commands. Unsupported executable/network-capable
  // configuration therefore fails closed before status or diff can reach it.
  if (hasUnsafeGitConfiguration(root, deadline)) return "unsafe_configuration";

  const check = spawnGitPreflight(root, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], deadline);
  if (!check.ok) return unverified("preflight");
  const lines = check.stdout.trim().split(/\r?\n/);
  if (lines[0] !== "true" || !lines[1] || lines.length !== 2) return unverified("preflight");
  try {
    return fs.realpathSync.native(lines[1]) === fs.realpathSync.native(root)
      ? "safe"
      : unverified("identity");
  } catch {
    return unverified("identity");
  }
}

function isRepository(root: string): boolean {
  return repositoryState(root) === "safe";
}

const RECONCILIATION_GIT_READS = {
  head: ["rev-parse", "HEAD"], branch: ["rev-parse", "--abbrev-ref", "HEAD"],
  index: ["ls-files", "--stage", "-z"],
  status: ["-c", "core.filemode=false", "status", "--porcelain=v2", "--no-renames", "--ignore-submodules=all", "--untracked-files=all", "-z", "--", "."],
};

/** Share initial reads only; fingerprinting must independently recheck after dirty-file reads. */
export function readReconciliationGitState(root: string, budget?: ReconciliationReadBudget) {
  const deadline = budget ? performance.now() + Math.min(1000, remainingReconciliationReadMs(budget)) : undefined;
  try {
    const state = repositoryState(root, true, deadline);
    if (state !== "safe") throw new GitReadError(state === "unsafe_configuration" ? "UNSAFE_GIT_CONFIGURATION" : "GIT_READ_FAILED", "configuration", "unverified");
    return withGitSnapshot(root, run => {
      const read = (args: string[]) => {
        const result = run(args);
        if (!result.ok || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new GitReadError("GIT_READ_FAILED", "scope", "command_failed");
        return result.stdout;
      };
      return { head: read(RECONCILIATION_GIT_READS.head).trim(), branch: read(RECONCILIATION_GIT_READS.branch).trim(),
        status: read(RECONCILIATION_GIT_READS.status), index: read(RECONCILIATION_GIT_READS.index) };
    }, "current", deadline, budget)!;
  } catch (error) {
    if (budget && error instanceof GitReadError) error.snapshotMs = 1000;
    throw error;
  }
}

/**
 * Run a read-only Git command only after repository configuration has passed
 * the non-executing preflight. Global/system config, hooks, pagers, optional
 * locks, and lazy object fetching remain disabled for the subprocess itself.
 */
export function runGit(root: string, args: string[], budget?: ReconciliationReadBudget): GitCommandResult {
  // Only the explicit worker context opts in; direct callers keep their policy.
  const acquisitionDeadline = budget !== undefined ? performance.now() + Math.min(1000, remainingReconciliationReadMs(budget)) : undefined;
  try {
  const state = repositoryState(root, false, acquisitionDeadline);
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
  // Only exact known current-state queries opt in; arbitrary/history queries
  // retain the bounded eager fallback. Never infer revision or path arguments.
  const current = Object.values(RECONCILIATION_GIT_READS).some(command => JSON.stringify(command) === JSON.stringify(args));
  const scope = current ? args[0] === "rev-parse" ? "head" : args[0] === "ls-files" ? "index" : "current" : undefined;
  const result = withGitSnapshot(root, (run) => run(args), scope, acquisitionDeadline, budget) ?? {
    ok: false,
    stdout: "",
    stderr: UNSAFE_GIT_CONFIGURATION_ERROR,
    code: null,
  };
  if (budget) remainingReconciliationReadMs(budget);
  return result;
  } catch (error) {
    if (budget && error instanceof GitReadError) error.snapshotMs = 1000;
    throw error;
  }
}

function withGitSnapshot<T>(root: string, callback: (run: (args: string[]) => GitCommandResult) => T,
  scope?: SelectiveRead, acquisitionDeadline?: number, budget?: ReconciliationReadBudget): T | null {
  const binary = gitBinary();
  if (!binary) throw new GitReadError("GIT_SNAPSHOT_FAILED", "binary", "unavailable");
  const snapshot = createGitSnapshot(root, scope !== undefined, acquisitionDeadline, budget?.snapshotRoot);
  try {
    if (scope) {
      try { hydrateScopedObjects(root, binary, snapshot, scope); }
      catch (error) { if (error instanceof GitReadError) throw error;
        throw new GitReadError("GIT_SNAPSHOT_FAILED", "scoped_objects", "unverified"); }
    }
    readTimeout(acquisitionDeadline);
    return callback((args) => {
      const timeout = budget ? Math.max(1, Math.floor(Math.min(30_000, remainingReconciliationReadMs(budget)))) : 30_000;
      const result = spawnSync(
        binary,
        [...SAFE_GIT_CONFIG, "--literal-pathspecs", `--git-dir=${snapshot.gitDir}`, `--work-tree=${root}`, ...args],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout,
          killSignal: "SIGKILL",
          env: safeGitEnv(root, binary, snapshot),
        }
      );
      if (budget) remainingReconciliationReadMs(budget);
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
  contentDirty: boolean | null;
  modeOnly: string[];
  isRepo: boolean;
  branch: string | null;
  head: string | null;
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
    contentDirty: null,
    modeOnly: [],
    isRepo: false,
    branch: null,
    head: null,
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

/** Both commands must use the caller's one hardened snapshot. */
export function readStatusPair(run: (args: string[]) => GitCommandResult) {
  const args = ["status", "--porcelain=v2", "--branch", "--no-renames", "--untracked-files=all", "--ignore-submodules=all", "-z", "--", "."];
  return { raw: run(args), content: run(["-c", "core.filemode=false", ...args]) };
}

/** Advisory only: never used to reduce raw dirty/reconciliation evidence. */
export function classifyStatusPair(raw: GitCommandResult, content: GitCommandResult,
  sensitive: (file: string) => boolean): { contentDirty: boolean | null; modeOnly: string[] } {
  const unknown = { contentDirty: null, modeOnly: [] };
  if (!raw.ok || !content.ok) return unknown;
  const parse = (text: string) => {
    if (text && !text.endsWith("\0")) return null;
    const entries = new Map<string, string>();
    const seen = new Set<string>();
    let hidden = false;
    for (const record of text.split("\0")) {
      if (!record || record.startsWith("# branch.")) continue;
      const ordinary = /^1 [ .MADRCUT?!]{2} [N.SCMU.]{4} [0-7]{6} [0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ (.+)$/s.exec(record);
      const file = ordinary ? ordinary[1] : record.startsWith("? ") ? record.slice(2)
        : /^u /.test(record) && record.split(" ").length >= 11 ? record.split(" ").slice(10).join(" ") : null;
      if (!file || seen.has(file)) return null;
      seen.add(file);
      if (seen.size > MAX_STATUS_ENTRIES) return null;
      if (sensitive(file)) { hidden = true; continue; }
      if (sanitizeGitLabel(file) !== file || file.length > 1000) return null;
      entries.set(file, record);
    }
    return { entries, hidden };
  };
  const first = parse(raw.stdout), second = parse(content.stdout);
  if (!first || !second) return unknown;
  const modeOnly: string[] = [];
  for (const [file, record] of first.entries) {
    if (second.entries.has(file)) continue;
    const parts = record.split(" ");
    if (parts[0] !== "1" || parts[1] !== ".M" || parts[2] !== "N..." ||
        parts[3] !== parts[4] || parts[6] !== parts[7] ||
        !["100644 100755", "100755 100644"].includes(`${parts[4]} ${parts[5]}`)) return unknown;
    modeOnly.push(file);
  }
  return { contentDirty: second.entries.size > 0 ? true : first.hidden || second.hidden ? null : false, modeOnly };
}

export function gitStatus(root: string, budget?: ReconciliationReadBudget): GitStatusResult {
  const deadline = budget ? performance.now() + Math.min(1000, remainingReconciliationReadMs(budget)) : undefined;
  const out = emptyStatus();
  const state = repositoryState(root, true, deadline);
  if (state === "unsafe_configuration") throw new GitReadError("UNSAFE_GIT_CONFIGURATION", "configuration", "unverified");
  if (state === "absent") return out;
  const pair = withGitSnapshot(root, readStatusPair, "current", deadline, budget);
  if (!pair) throw new GitReadError("GIT_READ_FAILED", "status", "unavailable");
  const result = pair.raw;
  if (!result.ok) throw new GitReadError("GIT_READ_FAILED", "status", "command_failed");

  out.isRepo = true;
  const layout = validatedGitDirectory(root);
  const resolvedHead = layout ? resolveHead(layout) : null;
  out.head =
    resolvedHead?.oid && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(resolvedHead.oid)
      ? resolvedHead.oid
      : null;
  const policy = new IgnoreRules(root);


  let rawEntries = 0;
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
    if (budget) remainingReconciliationReadMs(budget);
    if (!record) continue;
    // Keep enumeration bounded independently of the visible presentation cap.
    if (!record.startsWith("# ") && ++rawEntries > MAX_GIT_OBJECT_FILES) {
      out.truncated = true;
      break;
    }
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
  if (!out.truncated) {
    Object.assign(out, classifyStatusPair(pair.raw, pair.content, file => policy.isSensitive(file)));
  }
  if (budget) remainingReconciliationReadMs(budget);
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

export function gitDiff(root: string, opts: GitDiffOptions = {}, relPath?: string, budget?: ReconciliationReadBudget): GitDiffResult {
  const deadline = budget ? performance.now() + Math.min(1000, remainingReconciliationReadMs(budget)) : undefined;
  const mode = opts.mode ?? "unstaged";
  const state = repositoryState(root, true, deadline);
  if (state === "unsafe_configuration") throw new GitReadError("UNSAFE_GIT_CONFIGURATION", "configuration", "unverified");
  if (state !== "safe") return emptyDiff(mode);

  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const policy = new IgnoreRules(root);
  // Retain the existing bounded directory query semantics. The fast path applies
  // to an exact file, including a deleted file; it never silently broadens a path.
  let fileScope = relPath;
  if (relPath) {
    try { if (fs.lstatSync(path.join(root, relPath)).isDirectory()) fileScope = undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new GitReadError("GIT_READ_FAILED", "scope", "unverified"); }
  }

  const diff = withGitSnapshot(root, (run) => {
    const names = run([
      ...diffArgs(mode),
      "--name-only",
      "-z",
      "--",
      relPath || ".",
    ]);
    if (!names.ok) {
      throw new GitReadError("GIT_READ_FAILED", "diff_paths", "command_failed");
    }
    const allPaths = names.stdout.split("\0").filter(Boolean);
    const allowedPaths = allPaths.filter((filePath) => !policy.isSensitive(filePath));
    const selectedPaths: string[] = [];
    let selectedPathBytes = 0;
    for (const filePath of allowedPaths) {
      if (budget) remainingReconciliationReadMs(budget);
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
      throw new GitReadError("GIT_READ_FAILED", "diff", "command_failed");
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
  }, fileScope ? { path: fileScope, mode } : "current", deadline, budget);
  if (!diff) throw new GitReadError("GIT_READ_FAILED", "diff", "unavailable");
  if (budget) remainingReconciliationReadMs(budget);
  return diff;
}

const publishTextSafe = (value: string) => !/[\p{Cc}\p{Cf}$`\\;&|<>]/u.test(value) &&
  !/(?:password|passwd|secret|token|api[_ -]?key|cookie)\s*[:=]/i.test(value) &&
  redactSensitiveText(value).redactionCount === 0;
export const gitPublishFields = {
  workspace_id: z.string().regex(/^[a-f0-9]{24}$/),
  paths: z.array(z.string().min(1).max(512)).min(1).max(32),
  commit_message: z.string().min(1).max(200).refine(s => Buffer.byteLength(s) <= 800 && publishTextSafe(s) && s.trim() === s),
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/),
};
const publishSchema = z.object(gitPublishFields).strict();
export type GitPublishFields = z.infer<typeof publishSchema>;
export class GitPublishError extends Error {
  constructor(public readonly code: string) { super(code.replaceAll("_", " ")); }
}
function publishFail(code: string): never { throw new GitPublishError(code); }
const publishHash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const PUBLISH_CONFIG = [
  ...SAFE_GIT_CONFIG, "-c", "core.attributesFile=/dev/null", "-c", "core.editor=/usr/bin/false",
  "-c", "sequence.editor=/usr/bin/false", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "credential.helper=",
  "-c", "core.bare=false", "-c", "core.filemode=true", "-c", "core.splitIndex=false",
];
// Fixed system installations only, never PATH, caller argv or repository config.
const MAC_GIT_CORE = ["/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core",
  "/Library/Developer/CommandLineTools/usr/libexec/git-core"];

function inspectPublish(workspace: Pick<Workspace, "id" | "root">, value: GitPublishFields, recovery = false) {
  try {
    const fields = publishSchema.parse(value);
    if (fields.workspace_id !== workspace.id) publishFail("GIT_PUBLISH_WORKSPACE_MISMATCH");
    const root = workspace.root;
    if (fs.realpathSync.native(root) !== root) publishFail("GIT_PUBLISH_UNSAFE_ROOT");
    const policy = new IgnoreRules(root);
    if (new Set(fields.paths).size !== fields.paths.length || fields.paths.some(file =>
      !publishTextSafe(file) || file.startsWith("-") || !/^[A-Za-z0-9_./ -]+$/.test(file) ||
      file.split("/").some(c => !c || c === "." || c === ".." || c.toLowerCase() === ".git") || policy.isSensitive(file))) {
      publishFail("GIT_PUBLISH_UNSAFE_PATH");
    }
    if (fields.branch.split("/").some(c => !c || c.startsWith(".") || c.endsWith(".") || c.endsWith(".lock")) || fields.branch.includes("..")) publishFail("GIT_PUBLISH_UNSAFE_BRANCH");
    const layout = validatedGitDirectory(root);
    if (!layout) publishFail("GIT_PUBLISH_UNSAFE_REPOSITORY");
    for (const name of ["objects/info/http-alternates", "info/grafts", "shallow", "refs/replace", "config.worktree"]) {
      if (fs.existsSync(path.join(layout.commonGitDir, name))) publishFail("GIT_PUBLISH_UNSAFE_REPOSITORY");
    }
    if (fs.existsSync(path.join(layout.gitDir, "index.lock")) || fs.readdirSync(layout.gitDir).some(n => n.startsWith("sharedindex."))) publishFail("GIT_PUBLISH_INDEX_UNAVAILABLE");
    const hash = createHash("sha256").update("c2c-git-publish-v1").update(JSON.stringify(fields));
    const observed = new Map<string, { digest: string; stat: fs.Stats } | null>();
    let total = 0;
    const snapshot = (file: string, optional = false): Buffer => {
      try {
        const { data, stat } = readStableFile(file, 8 * 1024 * 1024);
        total += data.length;
        if (total > 64 * 1024 * 1024) publishFail("GIT_PUBLISH_TOO_LARGE");
        const digest = publishHash(data);
        observed.set(file, { digest, stat });
        hash.update(file).update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.uid, stat.nlink])).update(digest);
        return data;
      } catch (e) {
        if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") { observed.set(file, null); hash.update(file + ":absent"); return Buffer.alloc(0); }
        throw e;
      }
    };
    const directories = new Map<string, fs.Stats>();
    for (const dir of [root, layout.gitDir, layout.commonGitDir, layout.objectDir]) {
      const stat = fs.lstatSync(dir);
      directories.set(dir, stat);
      hash.update(dir).update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid]));
    }
    snapshot("/usr/bin/git");
    let binary = "/usr/bin/git", execPath: string | undefined, helper: string | undefined;
    if (process.platform === "darwin") {
      const discovered = spawnSync("/usr/bin/git", ["--exec-path"], { cwd: root, encoding: "utf8", timeout: 30_000,
        env: safeGitEnv(root, "/usr/bin/git"), maxBuffer: 4096 });
      execPath = discovered.status === 0 ? discovered.stdout.trim() : "";
      if (!MAC_GIT_CORE.includes(execPath)) publishFail("GIT_PUBLISH_UNTRUSTED_EXECUTABLE");
      binary = path.resolve(execPath, "../../bin/git");
      helper = path.join(execPath, "git-credential-osxkeychain");
      // Apple's HTTPS alias is a system symlink; bind both alias and target.
      const transport = path.join(execPath, "git-remote-https");
      const alias = fs.lstatSync(transport);
      const resolved = fs.realpathSync.native(transport);
      if (resolved !== path.join(execPath, "git-remote-http") || alias.uid !== 0) publishFail("GIT_PUBLISH_UNTRUSTED_EXECUTABLE");
      hash.update(JSON.stringify([alias.dev, alias.ino, alias.mode, fs.readlinkSync(transport)]));
      snapshot(resolved); snapshot(helper); snapshot(binary);
    }
    for (const file of ["/usr/bin/git", binary, ...(helper ? [helper, path.join(execPath!, "git-remote-http")] : [])]) {
      const stat = observed.get(file)!.stat;
      if (stat.uid !== 0 || (stat.mode & 0o022) || !(stat.mode & 0o111)) publishFail("GIT_PUBLISH_UNTRUSTED_EXECUTABLE");
    }
    const env = { ...safeGitEnv(root, binary), GIT_OPTIONAL_LOCKS: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_EDITOR: "/usr/bin/false", GIT_SEQUENCE_EDITOR: "/usr/bin/false", GIT_ASKPASS: "/usr/bin/false",
      ...(execPath ? { GIT_EXEC_PATH: execPath } : {}) };
    const run = (args: string[], input?: Buffer | string, push = false): string => {
      const result = spawnSync(binary, ["--no-pager", "--literal-pathspecs", ...PUBLISH_CONFIG,
        ...(push ? ["-c", "protocol.https.allow=always", "-c", `credential.helper=${helper}`, "-c", "credential.useHttpPath=false"] : []),
        `--git-dir=${layout.gitDir}`, `--work-tree=${root}`, ...args],
      { cwd: root, encoding: "utf8", env, input, timeout: push ? 60_000 : 30_000, maxBuffer: 16 * 1024 * 1024 });
      // Neither stderr nor the bound URL/credential values leave this boundary.
      if (result.status !== 0) publishFail(push ? "GIT_PUBLISH_PUSH_FAILED_NEW_APPROVAL_REQUIRED" : "GIT_PUBLISH_COMMAND_FAILED");
      return result.stdout;
    };
    snapshot(path.join(layout.commonGitDir, "config"));
    snapshot(path.join(layout.gitDir, "config.worktree"), true);
    snapshot(path.join(root, ".c2cignore"), true);
    // Includes, filters, URL rewriting, helpers, SSH, push options and extension
    // commands are refused before any index/object operation.
    const keys = run(["config", "--no-includes", "--local", "--name-only", "--null", "--list"]).split("\0").filter(Boolean);
    if (keys.some(key => !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|user\.(?:name|email)|remote\.[A-Za-z0-9_-]+\.(?:url|fetch)|branch\.[A-Za-z0-9_./-]+\.(?:remote|merge))$/i.test(key))) publishFail("GIT_PUBLISH_UNSAFE_CONFIG");
    const urls = run(["config", "--no-includes", "--local", "--null", "--get-all", `remote.${fields.remote}.url`]).split("\0").filter(Boolean);
    if (urls.length !== 1) publishFail("GIT_PUBLISH_UNSAFE_REMOTE");
    const url = new URL(urls[0]);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) ||
      !/^\/[A-Za-z0-9_./~-]+$/.test(url.pathname) || urls[0] !== url.href) publishFail("GIT_PUBLISH_UNSAFE_REMOTE");
    hash.update(urls[0]);
    // Git updates remote-tracking refs after push using this mapping. Refuse
    // mappings that could rewrite any local branch or another remote's refs.
    const fetches = run(["config", "--no-includes", "--local", "--null", "--get-all", `remote.${fields.remote}.fetch`]).split("\0").filter(Boolean);
    if (fetches.length !== 1 || fetches[0] !== `+refs/heads/*:refs/remotes/${fields.remote}/*`) publishFail("GIT_PUBLISH_UNSAFE_REMOTE");
    const headFile = path.join(layout.gitDir, "HEAD");
    const headText = snapshot(headFile).toString("utf8").trim();
    if (headText !== `ref: refs/heads/${fields.branch}`) publishFail("GIT_PUBLISH_BRANCH_MISMATCH");
    snapshot(path.join(layout.commonGitDir, "refs/heads", fields.branch), true);
    snapshot(path.join(layout.commonGitDir, "packed-refs"), true);
    if (recovery) snapshot(path.join(layout.commonGitDir, "refs/remotes", fields.remote, fields.branch), true);
    const indexFile = path.join(layout.gitDir, "index");
    snapshot(indexFile);
    const head = run(["rev-parse", "--verify", "HEAD"]).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) publishFail("GIT_PUBLISH_HEAD_UNAVAILABLE");
    hash.update(head);
    const staged = run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD", "--"]).split("\0").filter(Boolean);
    if (staged.some(file => !fields.paths.includes(file))) publishFail("GIT_PUBLISH_UNRELATED_STAGED_PATH");
    if (run(["ls-files", "--unmerged", "-z"])) publishFail("GIT_PUBLISH_UNMERGED_INDEX");
    const blobs = new Map<string, string>();
    for (const file of fields.paths) {
      const absolute = path.join(root, file);
      const data = snapshot(absolute);
      blobs.set(file, createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"));
      for (let dir = path.dirname(absolute);; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, ".gitattributes"))) publishFail("GIT_PUBLISH_ATTRIBUTES_UNSUPPORTED");
        snapshot(path.join(dir, ".gitattributes"), true);
        if (dir === root) break;
      }
    }
    if (fs.existsSync(path.join(layout.commonGitDir, "info/attributes"))) publishFail("GIT_PUBLISH_ATTRIBUTES_UNSUPPORTED");
    snapshot(path.join(layout.commonGitDir, "info/attributes"), true);
    const unchanged = (skip: Set<string> = new Set()) => {
      for (const [file, before] of observed) {
        if (skip.has(file)) continue;
        if (!before) { if (fs.existsSync(file)) publishFail("GIT_PUBLISH_STATE_CHANGED"); continue; }
        const now = readStableFile(file, 8 * 1024 * 1024);
        if (!sameFile(before.stat, now.stat) || before.digest !== publishHash(now.data)) publishFail("GIT_PUBLISH_STATE_CHANGED");
      }
      for (const [dir, before] of directories) {
        const now = fs.lstatSync(dir);
        if (now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino || now.mode !== before.mode || now.uid !== before.uid) publishFail("GIT_PUBLISH_STATE_CHANGED");
      }
    };
    unchanged();
    return { fields, fingerprint: hash.digest("hex"), head, run, blobs, unchanged, indexFile, headFile, layout, url: urls[0], helper };
  } catch (e) {
    if (e instanceof GitPublishError) throw e;
    publishFail("GIT_PUBLISH_UNSAFE_STATE");
  }
}

function inspectPush(workspace: Pick<Workspace, "id" | "root">, fields: GitPublishFields) {
  const plan = inspectPublish(workspace, fields, true);
  const { run, head: commit, blobs } = plan;
  const ancestry = run(["rev-list", "--parents", "-n", "1", commit]).trim().split(" ");
  if (ancestry.length !== 2 || ancestry[0] !== commit || !/^[a-f0-9]{40}$/.test(ancestry[1])) publishFail("GIT_PUSH_PARENT_MISMATCH");
  const parent = ancestry[1];
  const raw = run(["cat-file", "commit", commit]);
  const message = raw.slice(raw.indexOf("\n\n") + 2);
  if (raw.indexOf("\n\n") < 0 || message !== fields.commit_message + "\n") publishFail("GIT_PUSH_MESSAGE_MISMATCH");
  const names = run(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", parent, commit]).split("\0").filter(Boolean);
  if (names.length !== fields.paths.length || new Set(names).size !== names.length || names.some(n => !fields.paths.includes(n))) publishFail("GIT_PUSH_PATH_MISMATCH");
  const entries = run(["ls-tree", "-z", commit, "--", ...fields.paths]).split("\0").filter(Boolean);
  const verified = new Set<string>();
  if (entries.length !== fields.paths.length || entries.some(entry => {
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match || verified.has(match[2]) || blobs.get(match[2]) !== match[1]) return true;
    verified.add(match[2]); return false;
  })) publishFail("GIT_PUSH_BLOB_MISMATCH");
  if (run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", commit, "--"])) publishFail("GIT_PUSH_STAGED_CHANGES");
  const trackingRef = `refs/remotes/${fields.remote}/${fields.branch}`;
  const tracking = run(["rev-parse", "--verify", trackingRef]).trim();
  if (tracking !== parent) publishFail("GIT_PUSH_TRACKING_PARENT_MISMATCH");
  plan.unchanged();
  return { ...plan, commit, parent, trackingRef,
    fingerprint: publishHash(JSON.stringify({ version: "c2c-git-push-recovery-v1", base: plan.fingerprint,
      commit, parent, trackingRef, tracking, message, names, entries })) };
}
function pushInstruction(fields: GitPublishFields, fingerprint: string, commit: string, parent: string) {
  return `C2C Git push recovery v1: push verified current local commit by non-force HTTPS only. ${JSON.stringify({ ...fields, fingerprint, commit, parent })}`;
}
export function gitPushPlan(workspace: Pick<Workspace, "id" | "root">, fields: GitPublishFields) {
  const plan = inspectPush(workspace, fields);
  return { ...plan.fields, fingerprint: plan.fingerprint, commit: plan.commit, parent: plan.parent,
    instruction: pushInstruction(plan.fields, plan.fingerprint, plan.commit, plan.parent) };
}
export async function gitPushCheckpoint(workspace: Workspace, reconciler: TaskReconciler,
  fields: GitPublishFields, fingerprint: string, taskId: string, next: number) {
  let plan = inspectPush(workspace, fields);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || plan.fingerprint !== fingerprint) publishFail("GIT_PUSH_PLAN_CHANGED");
  const verify = () => {
    plan = inspectPush(workspace, fields);
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || plan.fingerprint !== fingerprint) publishFail("GIT_PUSH_PLAN_CHANGED");
  };
  return reconciler.executeCheckpointAction(workspace, taskId, next,
    pushInstruction(plan.fields, fingerprint, plan.commit, plan.parent), verify, actionId => {
      verify();
      if (!plan.helper) publishFail("GIT_PUBLISH_MACOS_TRANSPORT_REQUIRED");
      plan.unchanged();
      plan.run(["push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", "--",
        fields.remote, `${plan.commit}:refs/heads/${fields.branch}`], undefined, true);
      if (plan.run(["rev-parse", "--verify", plan.trackingRef]).trim() !== plan.commit) publishFail("GIT_PUBLISH_TRACKING_MISMATCH_NEW_APPROVAL_REQUIRED");
      return { action_id: actionId, workspace_id: workspace.id, commit: plan.commit, parent: plan.parent,
        remote: fields.remote, branch: fields.branch, pushed: true, remote_tracking_verified: true, checkpoint_consumed: true };
    });
}

function publishInstruction(fields: GitPublishFields, fingerprint: string, head: string): string {
  return `C2C Git publish v1: stage exact paths; force selected index modes 100644; commit exact index; non-force HTTPS push. ${JSON.stringify({ ...fields, fingerprint, head })}`;
}

export function gitPublishPlan(workspace: Pick<Workspace, "id" | "root">, fields: GitPublishFields) {
  const plan = inspectPublish(workspace, fields);
  return { ...plan.fields, fingerprint: plan.fingerprint, head: plan.head,
    instruction: publishInstruction(plan.fields, plan.fingerprint, plan.head) };
}

export async function gitPublishCheckpoint(workspace: Workspace, reconciler: TaskReconciler,
  fields: GitPublishFields, fingerprint: string, taskId: string, next: number) {
  let plan = inspectPublish(workspace, fields);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || plan.fingerprint !== fingerprint) publishFail("GIT_PUBLISH_PLAN_CHANGED");
  const instruction = publishInstruction(plan.fields, fingerprint, plan.head);
  return reconciler.executeCheckpointAction(workspace, taskId, next, instruction, () => {
    plan = inspectPublish(workspace, fields);
    if (plan.fingerprint !== fingerprint) publishFail("GIT_PUBLISH_PLAN_CHANGED");
  }, actionId => {
    const { run, blobs, head, unchanged, indexFile, layout } = plan;
    const exact = (names: string[]) => names.length === fields.paths.length && new Set(names).size === names.length && names.every(n => fields.paths.includes(n));
    run(["add", "--", ...fields.paths]);
    run(["update-index", "--chmod=-x", "--", ...fields.paths]);
    unchanged(new Set([indexFile]));
    const names = run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", head, "--"]).split("\0").filter(Boolean);
    if (!exact(names)) publishFail("GIT_PUBLISH_STAGE_MISMATCH");
    const entries = run(["ls-files", "--stage", "-z", "--", ...fields.paths]).split("\0").filter(Boolean);
    if (entries.length !== fields.paths.length || entries.some(entry => {
      const match = /^100644 ([a-f0-9]{40}) 0\t(.+)$/.exec(entry);
      return !match || blobs.get(match[2]) !== match[1];
    })) publishFail("GIT_PUBLISH_STAGE_MISMATCH");
    const tree = run(["write-tree"]).trim();
    if (!/^[a-f0-9]{40}$/.test(tree)) publishFail("GIT_PUBLISH_STAGE_MISMATCH");
    if (!exact(run(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", head, tree]).split("\0").filter(Boolean))) publishFail("GIT_PUBLISH_STAGE_MISMATCH");
    const treeEntries = run(["ls-tree", "-z", tree, "--", ...fields.paths]).split("\0").filter(Boolean);
    if (treeEntries.length !== fields.paths.length || treeEntries.some(entry => {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      return !match || blobs.get(match[2]) !== match[1];
    })) publishFail("GIT_PUBLISH_STAGE_MISMATCH");
    // commit-tree binds the verified immutable tree, even if another writer
    // changes the index. update-ref compares HEAD and never overwrites a move.
    const commit = run(["commit-tree", tree, "-p", head, "-m", fields.commit_message]).trim();
    if (!/^[a-f0-9]{40}$/.test(commit) || !exact(run(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", head, commit]).split("\0").filter(Boolean))) publishFail("GIT_PUBLISH_COMMIT_MISMATCH");
    const committed = run(["ls-tree", "-z", commit, "--", ...fields.paths]).split("\0").filter(Boolean);
    if (committed.length !== fields.paths.length || committed.some(entry => {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      return !match || blobs.get(match[2]) !== match[1];
    })) publishFail("GIT_PUBLISH_COMMIT_MISMATCH");
    unchanged(new Set([indexFile]));
    run(["update-ref", "-m", "C2C approved Git publish", "HEAD", commit, head]);
    unchanged(new Set([indexFile, plan.headFile, path.join(layout.commonGitDir, "refs/heads", fields.branch)]));
    if (run(["rev-parse", "--verify", "HEAD"]).trim() !== commit) publishFail("GIT_PUBLISH_STATE_CHANGED");
    if (!plan.helper) publishFail("GIT_PUBLISH_MACOS_TRANSPORT_REQUIRED");
    run(["push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", "--", fields.remote, `${commit}:refs/heads/${fields.branch}`], undefined, true);
    const tracking = run(["rev-parse", "--verify", `refs/remotes/${fields.remote}/${fields.branch}`]).trim();
    if (tracking !== commit) publishFail("GIT_PUBLISH_TRACKING_MISMATCH_NEW_APPROVAL_REQUIRED");
    return { action_id: actionId, workspace_id: workspace.id, previous_head: head, commit,
      remote: fields.remote, branch: fields.branch,
      staged_files: [...fields.paths], staged_modes: fields.paths.map(file => ({ path: file, mode: "100644" as const })),
      committed_files: [...fields.paths], committed_modes: fields.paths.map(file => ({ path: file, mode: "100644" as const })),
      pushed: true, remote_tracking_verified: true, checkpoint_consumed: true };
  });
}
