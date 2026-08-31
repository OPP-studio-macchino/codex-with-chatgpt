import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

function gitBinary(): string | null {
  if (cachedGitBinary === undefined) cachedGitBinary = findBinary("git", { includePath: false });
  return cachedGitBinary;
}

function safeGitEnv(root: string, binary: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
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
}

/** Low-level Git spawn used only for the non-executing configuration preflight. */
function spawnGit(root: string, args: string[]): GitCommandResult {
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

function readSmallTextFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 4096) return null;
    const value = fs.readFileSync(file, "utf8").trim();
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
    return value;
  } catch {
    return null;
  }
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

function validatedGitDirectory(root: string): string | null {
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
      return hasUnsafeObjectIndirection(marker) ? null : marker;
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
    return linkedGitDir;
  } catch {
    return null;
  }
}

type RepositoryState = "absent" | "safe" | "unsafe_configuration";

function hasUnsafeGitConfiguration(root: string): boolean {
  // Do not follow repository-controlled include/includeIf directives while
  // inspecting configuration. Their presence is itself unsupported. Listing
  // names only also avoids copying command values or credentials into memory.
  const config = spawnGit(root, [
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

  const check = spawnGit(root, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"]);
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
  return spawnGit(root, args);
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

  const names = runGit(root, [
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

  const result = runGit(root, [...diffArgs(mode), "--", ...selectedPaths]);
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
}
