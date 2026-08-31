import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { IgnoreRules } from "./ignore.js";
import { getStateDir, getWorkspaceIdentityKey } from "../config/paths.js";
import { redactAndTruncate, StreamingSecretRedactor } from "../security/redaction.js";

export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSAFE_PATH_MUTATION"
  | "UNSAFE_STATE_DIRECTORY"
  | "UNSUPPORTED_REGEX";

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);

export interface ReadFileResult {
  path: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
  redactionCount: number;
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface VerifiedDirectory {
  abs: string;
  rel: string;
  entries: fs.Dirent[];
}

export interface ProjectConfig {
  name?: string;
  maxIterations?: number;
}

export interface ProjectInfo {
  projectType: string;
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  scriptNames: string[];
}

export interface SearchLine {
  lineNumber: number;
  text: string;
  redactionCount: number;
}

const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

function readVerifiedRootFileSync(root: string, relative: string, maxBytes: number): Buffer | null {
  const file = path.join(root, relative);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) return null;
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
      !canonical.startsWith(root + path.sep) ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino
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
        // best-effort close of a read-only descriptor
      }
    }
  }
}

function loadProjectConfig(root: string): ProjectConfig {
  const buffer = readVerifiedRootFileSync(root, ".c2c.json", 64 * 1024);
  let raw: Record<string, unknown> | null = null;
  try {
    raw = buffer ? (JSON.parse(buffer.toString("utf8")) as Record<string, unknown>) : null;
  } catch {
    raw = null;
  }
  if (!raw) return {};
  const config: ProjectConfig = {};
  if (typeof raw.name === "string") {
    const name = raw.name
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (name) config.name = redactAndTruncate(name, 100).text;
  }
  if (
    typeof raw.maxIterations === "number" &&
    Number.isInteger(raw.maxIterations) &&
    raw.maxIterations >= 1 &&
    raw.maxIterations <= 100
  ) {
    config.maxIterations = raw.maxIterations;
  }
  return config;
}

export class Workspace {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly ignoreRules: IgnoreRules;
  readonly projectConfig: ProjectConfig;

  constructor(rootInput: string) {
    const resolved = path.resolve(rootInput);
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootInput}`);
    }
    this.root = real;
    const stateDir = this.canonicalize(path.resolve(getStateDir()));
    if (this.contains(stateDir)) {
      throw new WorkspaceError(
        "UNSAFE_STATE_DIRECTORY",
        "C2C state directory must be outside the connected workspace."
      );
    }
    this.id = createHmac("sha256", getWorkspaceIdentityKey())
      .update(normCase(real))
      .digest("hex")
      .slice(0, 24);
    this.ignoreRules = new IgnoreRules(real);
    this.projectConfig = loadProjectConfig(real);
    this.name = this.projectConfig.name ?? path.basename(real);
  }

  private contains(candidate: string): boolean {
    const r = normCase(this.root);
    const c = normCase(candidate);
    return c === r || c.startsWith(r + path.sep);
  }

  /**
   * Canonicalize a path by realpath-ing its deepest existing ancestor.
   * Defends against symlink escapes even for not-yet-existing leaf segments.
   */
  private canonicalize(abs: string): string {
    let current = abs;
    const suffix: string[] = [];
    for (;;) {
      try {
        const real = fs.realpathSync.native(current);
        return suffix.length > 0 ? path.join(real, ...suffix) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return abs;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Resolve an untrusted path to a canonical absolute path inside the workspace.
   * Throws PATH_OUTSIDE_WORKSPACE or ACCESS_DENIED_SENSITIVE_FILE.
   */
  resolve(requested: string, opts: { allowSensitive?: boolean } = {}): { abs: string; rel: string } {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    let p = requested.trim();
    if (p === "" || p === "/") p = ".";
    // Normalize separators so Windows-style input behaves identically everywhere.
    p = p.replace(/\\/g, "/");
    // Strip a "workspace:/" alias prefix if the model echoes it back.
    p = p.replace(/^workspace:\/*/i, "");
    if (p === "") p = ".";

    const abs = path.resolve(this.root, p);
    const canonical = this.canonicalize(abs);
    if (!this.contains(canonical)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path resolves outside the connected workspace: ${requested}`
      );
    }
    const rel = path.relative(this.root, canonical).split(path.sep).join("/");
    if (rel.startsWith("..")) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside the connected workspace: ${requested}`);
    }
    if (!opts.allowSensitive && rel !== "" && this.ignoreRules.isSensitive(rel)) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        `ACCESS_DENIED_SENSITIVE_FILE: '${rel}' matches the sensitive-file policy and cannot be read.`
      );
    }
    return { abs: canonical, rel };
  }

  private unsafeMutation(rel: string): WorkspaceError {
    return new WorkspaceError(
      "UNSAFE_PATH_MUTATION",
      `UNSAFE_PATH_MUTATION: '${rel || "."}' changed while it was being accessed.`
    );
  }

  private async openVerifiedRegularFile(
    requested: string
  ): Promise<{ handle: fs.promises.FileHandle; stat: fs.Stats; abs: string; rel: string }> {
    const resolved = this.resolve(requested);
    const flags =
      fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(resolved.abs, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") throw this.unsafeMutation(resolved.rel);
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${resolved.rel}`);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${resolved.rel}`);
      }
      let canonicalAfter: string;
      let pathStat: fs.Stats;
      try {
        canonicalAfter = await fs.promises.realpath(resolved.abs);
        pathStat = await fs.promises.stat(resolved.abs);
      } catch {
        throw this.unsafeMutation(resolved.rel);
      }
      if (
        normCase(canonicalAfter) !== normCase(resolved.abs) ||
        !this.contains(canonicalAfter) ||
        pathStat.dev !== stat.dev ||
        pathStat.ino !== stat.ino
      ) {
        throw this.unsafeMutation(resolved.rel);
      }
      const actualRel = path.relative(this.root, canonicalAfter).split(path.sep).join("/");
      if (actualRel !== resolved.rel || this.ignoreRules.isSensitive(actualRel)) {
        throw this.unsafeMutation(resolved.rel);
      }
      return { handle, stat, abs: canonicalAfter, rel: actualRel };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async scanTextHandle(
    handle: fs.promises.FileHandle,
    maxBytes: number,
    visitor: (line: string, lineNumber: number) => boolean | void
  ): Promise<{ totalLines: number; totalBytes: number; completed: boolean }> {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let position = 0;
    let totalLines = 0;
    let completed = true;
    const emit = (raw: string): boolean => {
      totalLines++;
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (visitor(line, totalLines) === false) {
        completed = false;
        return false;
      }
      return true;
    };

    for (;;) {
      const remaining = maxBytes + 1 - position;
      if (remaining <= 0) {
        throw new WorkspaceError("FILE_TOO_LARGE", `File exceeds the ${maxBytes}-byte source limit.`);
      }
      const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      position += bytesRead;
      if (position > maxBytes) {
        throw new WorkspaceError("FILE_TOO_LARGE", `File exceeds the ${maxBytes}-byte source limit.`);
      }
      if (bytes.includes(0)) throw new WorkspaceError("BINARY_FILE", "Binary file content is not returned.");
      pending += decoder.write(bytes);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!emit(line)) return { totalLines, totalBytes: position, completed };
      }
    }
    pending += decoder.end();
    if (pending.length > 0 && !emit(pending)) return { totalLines, totalBytes: position, completed };
    return { totalLines, totalBytes: position, completed };
  }

  async readDirectoryEntries(requested: string): Promise<VerifiedDirectory> {
    const before = this.resolve(requested);
    let beforeStat: fs.Stats;
    let dir: fs.Dir;
    try {
      beforeStat = await fs.promises.lstat(before.abs);
      if (!beforeStat.isDirectory() || beforeStat.isSymbolicLink()) {
        throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${before.rel}`);
      }
      dir = await fs.promises.opendir(before.abs);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${before.rel || "."}`);
    }
    const entries: fs.Dirent[] = [];
    try {
      for (;;) {
        const entry = await dir.read();
        if (!entry) break;
        entries.push(entry);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    let after: { abs: string; rel: string };
    let afterStat: fs.Stats;
    try {
      after = this.resolve(requested);
      afterStat = await fs.promises.lstat(after.abs);
    } catch {
      throw this.unsafeMutation(before.rel);
    }
    if (
      normCase(after.abs) !== normCase(before.abs) ||
      !afterStat.isDirectory() ||
      afterStat.isSymbolicLink() ||
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino
    ) {
      throw this.unsafeMutation(before.rel);
    }
    return { ...after, entries };
  }

  async forEachSearchLine(
    requested: string,
    visitor: (line: SearchLine) => boolean | void,
    maxBytes = 2 * 1024 * 1024
  ): Promise<boolean> {
    let opened: Awaited<ReturnType<Workspace["openVerifiedRegularFile"]>>;
    try {
      opened = await this.openVerifiedRegularFile(requested);
    } catch {
      return false;
    }
    try {
      if (opened.stat.size > maxBytes) return false;
      const redactor = new StreamingSecretRedactor();
      await this.scanTextHandle(opened.handle, maxBytes, (line, lineNumber) => {
        const redacted = redactor.redactLine(line);
        return visitor({ lineNumber, text: redacted.text, redactionCount: redacted.redactionCount });
      });
      return true;
    } catch (error) {
      if (error instanceof WorkspaceError && (error.code === "BINARY_FILE" || error.code === "FILE_TOO_LARGE")) {
        return false;
      }
      throw error;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  async readFile(
    requested: string,
    opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number } = {}
  ): Promise<ReadFileResult> {
    const opened = await this.openVerifiedRegularFile(requested);
    const { stat, rel } = opened;
    try {
      if (stat.size > HARD_MAX_SOURCE_BYTES) {
        throw new WorkspaceError(
          "FILE_TOO_LARGE",
          `File exceeds the ${HARD_MAX_SOURCE_BYTES}-byte source limit: ${rel}`
        );
      }
      const startLine = Math.max(1, Math.floor(opts.startLine ?? 1));
      const maxLines = Math.min(HARD_MAX_LINES, Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES)));
      const endLimit = opts.endLine
        ? Math.min(Math.floor(opts.endLine), startLine + HARD_MAX_LINES - 1)
        : startLine + maxLines - 1;
      const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)));

      const selectedLines: string[] = [];
      let collectedBytes = 0;
      let byteTruncated = false;
      let actualEnd = startLine - 1;
      let redactionCount = 0;
      const redactor = new StreamingSecretRedactor();
      const scan = await this.scanTextHandle(opened.handle, HARD_MAX_SOURCE_BYTES, (line, lineNumber) => {
        const redacted = redactor.redactLine(line);
        if (lineNumber >= startLine && lineNumber <= endLimit && !byteTruncated) {
          const cost = Buffer.byteLength(redacted.text, "utf8") + (selectedLines.length > 0 ? 1 : 0);
          if (collectedBytes + cost > maxBytes) {
            if (selectedLines.length === 0) {
              throw new WorkspaceError(
                "FILE_TOO_LARGE",
                `Line ${lineNumber} exceeds the ${maxBytes}-byte response limit: ${rel}`
              );
            }
            byteTruncated = true;
          } else {
            selectedLines.push(redacted.text);
            redactionCount += redacted.redactionCount;
            collectedBytes += cost;
            actualEnd = lineNumber;
          }
        }
      });

      const totalLines = scan.totalLines;
      const remaining = Math.max(0, totalLines - actualEnd);
      return {
        path: rel,
        sizeBytes: scan.totalBytes,
        totalLines,
        startLine: Math.min(startLine, Math.max(totalLines, 1)),
        endLine: actualEnd,
        truncated: remaining > 0,
        remainingLines: remaining,
        nextStartLine: remaining > 0 ? actualEnd + 1 : null,
        content: selectedLines.join("\n"),
        redactionCount,
      };
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  async listDirectory(
    requested: string,
    opts: { depth?: number; limit?: number; offset?: number } = {}
  ): Promise<ListDirectoryResult> {
    const initial = await this.readDirectoryEntries(requested);
    const { abs, rel } = initial;
    const depth = Math.min(4, Math.max(1, Math.floor(opts.depth ?? 1)));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
    const offset = Math.min(10_000, Math.max(0, Math.floor(opts.offset ?? 0)));

    const all: DirEntry[] = [];
    const walk = async (dirAbs: string, dirRel: string, level: number): Promise<void> => {
      let verified: VerifiedDirectory;
      try {
        verified = dirAbs === abs && dirRel === rel ? initial : await this.readDirectoryEntries(dirRel);
      } catch {
        return;
      }
      const entries = verified.entries;
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (this.ignoreRules.isHidden(childRel) || this.ignoreRules.isHidden(childRel + "/")) continue;
        if (entry.isDirectory()) {
          try {
            const child = await this.readDirectoryEntries(childRel);
            all.push({ path: childRel + "/", type: "dir" });
            if (level < depth) await walk(child.abs, childRel, level + 1);
          } catch {
            continue;
          }
        } else if (entry.isFile()) {
          let opened: Awaited<ReturnType<Workspace["openVerifiedRegularFile"]>>;
          try {
            opened = await this.openVerifiedRegularFile(childRel);
          } catch {
            continue;
          }
          try {
            all.push({ path: childRel, type: "file", sizeBytes: opened.stat.size });
          } finally {
            await opened.handle.close().catch(() => undefined);
          }
        }
        if (all.length >= Math.min(12_000, offset + limit + 2000)) return;
      }
    };
    await walk(abs, rel, 1);

    const page = all.slice(offset, offset + limit);
    return {
      path: rel || ".",
      entries: page,
      total: all.length,
      offset,
      limit,
      hasMore: offset + page.length < all.length,
    };
  }

  /** Lightweight project detection for workspace_info. */
  private async hasVerifiedFile(requested: string): Promise<boolean> {
    let opened: Awaited<ReturnType<Workspace["openVerifiedRegularFile"]>>;
    try {
      opened = await this.openVerifiedRegularFile(requested);
    } catch {
      return false;
    }
    await opened.handle.close().catch(() => undefined);
    return true;
  }

  private async readVerifiedJson<T>(requested: string, maxBytes = 2 * 1024 * 1024): Promise<T | null> {
    let opened: Awaited<ReturnType<Workspace["openVerifiedRegularFile"]>>;
    try {
      opened = await this.openVerifiedRegularFile(requested);
    } catch {
      return null;
    }
    try {
      if (opened.stat.size > maxBytes) return null;
      let text = "";
      const scan = await this.scanTextHandle(opened.handle, maxBytes, (line, lineNumber) => {
        text += `${lineNumber > 1 ? "\n" : ""}${line}`;
      });
      if (!scan.completed) return null;
      return JSON.parse(text) as T;
    } catch {
      return null;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  async detectProject(): Promise<ProjectInfo> {
    const has = async (f: string): Promise<boolean> => {
      try {
        return await this.hasVerifiedFile(f);
      } catch {
        return false;
      }
    };
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    let projectType = "unknown";
    let packageManager: string | null = null;
    let scriptNames: string[] = [];

    const pkg = await this.readVerifiedJson<{
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>("package.json");
    if (pkg) {
      projectType = "node";
      languages.add("JavaScript");
      scriptNames = Object.keys(
        pkg?.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts) ? pkg.scripts : {}
      )
        .slice(0, 200)
        .map((name) => redactAndTruncate(name, 200).text)
        .sort();
      const dependencies =
        pkg?.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies)
          ? pkg.dependencies
          : {};
      const devDependencies =
        pkg?.devDependencies && typeof pkg.devDependencies === "object" && !Array.isArray(pkg.devDependencies)
          ? pkg.devDependencies
          : {};
      const known: Record<string, string> = {
        next: "Next.js",
        react: "React",
        vue: "Vue",
        svelte: "Svelte",
        express: "Express",
        fastify: "Fastify",
        "@nestjs/core": "NestJS",
        electron: "Electron",
        vitest: "Vitest",
        jest: "Jest",
      };
      for (const [dep, label] of Object.entries(known)) {
        if (Object.hasOwn(dependencies, dep) || Object.hasOwn(devDependencies, dep)) frameworks.add(label);
      }
      if (await has("pnpm-lock.yaml")) packageManager = "pnpm";
      else if (await has("yarn.lock")) packageManager = "yarn";
      else if ((await has("bun.lockb")) || (await has("bun.lock"))) packageManager = "bun";
      else if (await has("package-lock.json")) packageManager = "npm";
    }
    if (await has("tsconfig.json")) languages.add("TypeScript");
    if ((await has("pyproject.toml")) || (await has("requirements.txt")) || (await has("setup.py"))) {
      languages.add("Python");
      if (projectType === "unknown") projectType = "python";
    }
    if (await has("Cargo.toml")) {
      languages.add("Rust");
      if (projectType === "unknown") projectType = "rust";
    }
    if (await has("go.mod")) {
      languages.add("Go");
      if (projectType === "unknown") projectType = "go";
    }
    if (await has("Package.swift")) {
      languages.add("Swift");
      if (projectType === "unknown") projectType = "swift";
    }
    return {
      projectType,
      languages: [...languages],
      frameworks: [...frameworks],
      packageManager,
      scriptNames,
    };
  }
}
