import { ExtensionStore, extensionHash } from "./extensions.js";
import { approvalDiagnosticSchema, type ApprovalDiagnostic } from "../codex/approval-diagnostic.js";
import { readStableFile } from "../security/stable-file.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { getStateDir } from "../config/paths.js";
import { redactAndTruncate } from "../security/redaction.js";
import { isBuiltinSensitivePath } from "../workspace/ignore.js";

/**
 * Lightweight execution records written by the Codex harness (`c2c record`)
 * or the Codex App Server boundary after a terminal turn. ChatGPT reads them
 * through the `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  approval_diagnostic?: ApprovalDiagnostic;
  approval_diagnostic_available?: boolean;
  taskId: string;
  iteration: number;
  changedFiles: string[] | number | null;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked";
  runId?: string;
  timestamp: string;
  notes?: string;
}

function sanitizeChangedFiles(value: unknown): string[] | number | null {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const files = value.slice(0, 50).map((entry) => {
      const candidate = String(entry).replace(/\\/g, "/");
      if (isBuiltinSensitivePath(candidate)) return "[REDACTED SENSITIVE PATH]";
      return redactAndTruncate(candidate, 512).text;
    });
    if (value.length > files.length) files.push(`[TRUNCATED ${value.length - files.length} MORE PATHS]`);
    return files;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100_000, Math.max(0, Math.floor(value)));
  }
  return null;
}

function sanitizeRecord(value: unknown): ExecutionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.taskId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(record.taskId)) return null;
  if (
    typeof record.iteration !== "number" ||
    !Number.isSafeInteger(record.iteration) ||
    record.iteration < 0
  ) {
    return null;
  }
  if (record.exitStatus !== "ok" && record.exitStatus !== "failed" && record.exitStatus !== "blocked") {
    return null;
  }
  if (
    typeof record.timestamp !== "string" ||
    record.timestamp.length > 64 ||
    !Number.isFinite(Date.parse(record.timestamp))
  ) {
    return null;
  }
  const diagnostic = approvalDiagnosticSchema.safeParse(record.approval_diagnostic);
  return {
    ...(diagnostic.success ? { approval_diagnostic: diagnostic.data } : {}),
    approval_diagnostic_available: diagnostic.success,
    taskId: record.taskId,
    iteration: record.iteration,
    changedFiles: sanitizeChangedFiles(record.changedFiles),
    tests: typeof record.tests === "string" ? redactAndTruncate(record.tests, 500).text : null,
    exitStatus: record.exitStatus,
    timestamp: record.timestamp,
    runId:
      typeof record.runId === "string" && /^[a-f0-9]{32}$/.test(record.runId)
        ? record.runId
        : undefined,
    notes: typeof record.notes === "string" ? redactAndTruncate(record.notes, 500).text : undefined,
  };
}

const legacyRowSchema = z.object({ taskId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), iteration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    changedFiles: z.union([z.array(z.string().max(512)).max(51), z.number().int().min(0).max(100000), z.null()]),
    tests: z.string().max(500).nullable(), exitStatus: z.enum(["ok", "failed", "blocked"]),
    runId: z.string().regex(/^[a-f0-9]{32}$/).optional(), timestamp: z.string().max(64).refine(s => Number.isFinite(Date.parse(s))),
    notes: z.string().max(500).optional() }).strict();

function canonicalRecord(record: ExecutionRecord): ExecutionRecord {
  const { approval_diagnostic, approval_diagnostic_available, ...canonical } = record;
  return canonical;
}
function readRecordsForWrite(file: string): string | null {
  try {
    const { data, stat } = readStableFile(path.resolve(file), 4 * 1024 * 1024);
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("LEGACY_SNAPSHOT_INVALID");
    return data.toString("utf8");
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

function recordsFile(workspaceId: string): string {
  if (
    workspaceId === "." ||
    workspaceId === ".." ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId)
  ) {
    throw new Error("Invalid workspace id for execution records.");
  }
  const dir = path.join(getStateDir(), "executions");
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  new ExtensionStore(workspaceId, "records", file).withMainLock(file, () => appendExecutionRecordUnlocked(workspaceId, record));
}
function appendExecutionRecordUnlocked(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(record.taskId)) {
    throw new Error("Invalid execution task id.");
  }
  if (!Number.isSafeInteger(record.iteration) || record.iteration < 0) {
    throw new Error("Invalid execution iteration.");
  }
  if (!["ok", "failed", "blocked"].includes(record.exitStatus)) {
    throw new Error("Invalid execution status.");
  }
  if (record.runId !== undefined && !/^[a-f0-9]{32}$/.test(record.runId)) {
    throw new Error("Invalid execution run id.");
  }
  if (record.timestamp.length > 64 || !Number.isFinite(Date.parse(record.timestamp))) {
    throw new Error("Invalid execution timestamp.");
  }
  const safeRecord = sanitizeRecord(record);
  if (!safeRecord) throw new Error("Invalid execution record.");
  const store = new ExtensionStore(workspaceId, "records", file);
  store.assertWritable();
  const existing = readExecutionRecords(workspaceId, 99).map(canonicalRecord);
  const canonical = canonicalRecord(safeRecord);
  // Refuse WIP rows rather than silently stripping evidence in an ordinary append.
  const raw = readRecordsForWrite(file);
  if (raw !== null) raw.trimEnd().split("\n").forEach(line => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("LEGACY_SNAPSHOT_INVALID"); }
    if (!legacyRowSchema.safeParse(value).success) throw new Error("EXECUTION_RECORD_EXTENSION_MIGRATION_REQUIRED");
  });
  const prepared = safeRecord.approval_diagnostic ? [store.prepare({ kind: "execution_diagnostic", task_id: canonical.taskId,
    run_id: canonical.runId, iteration: canonical.iteration, record_sha256: extensionHash(JSON.stringify(canonical)), diagnostic: safeRecord.approval_diagnostic })] : [];
  store.replaceMain(file, raw, [...existing, canonical].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  store.commit(prepared);
}

/** Idempotent projection into the legacy bounded history; journal is authoritative. */
export function appendExecutionRecordOnce(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  new ExtensionStore(workspaceId, "records", file).withMainLock(file, () => {
    if (record.runId && readExecutionRecords(workspaceId, 100).some(existing =>
      existing.runId === record.runId && existing.taskId === record.taskId && existing.iteration === record.iteration
    )) return;
    appendExecutionRecordUnlocked(workspaceId, record);
  });
}

/** Explicit evidence-preserving offline migration; never called by normal reads/writes. */
export function migrateExecutionRecordExtensions(workspaceId: string): { status: "not_required" | "migrated"; archive?: string } {
  const file = recordsFile(workspaceId);
  return new ExtensionStore(workspaceId, "records", file).withMainLock(file, () => migrateExecutionRecordExtensionsUnlocked(workspaceId));
}
function migrateExecutionRecordExtensionsUnlocked(workspaceId: string): { status: "not_required" | "migrated"; archive?: string } {
  const file = recordsFile(workspaceId), raw = readRecordsForWrite(file);
  if (raw === null) return { status: "not_required" };
  const lines = raw.trimEnd().split("\n");
  if (!lines.length || lines.length > 100) throw new Error("LEGACY_SNAPSHOT_INVALID");
  const wipRow = legacyRowSchema.extend({ approval_diagnostic: approvalDiagnosticSchema.optional(), approval_diagnostic_available: z.boolean().optional() }).strict();
  const rows = lines.map(line => {
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error("LEGACY_SNAPSHOT_INVALID"); }
    if (!wipRow.safeParse(row).success) throw new Error("LEGACY_SNAPSHOT_INVALID");
    return row as ExecutionRecord;
  });
  if (rows.every(row => legacyRowSchema.safeParse(row).success)) return { status: "not_required" };
  const store = new ExtensionStore(workspaceId, "records", file);
  const archive = store.archive(raw), prepared: string[] = [];
  const canonical = rows.map(row => canonicalRecord(row));
  rows.forEach((row, i) => {
    if (row.approval_diagnostic) prepared.push(store.prepare({ kind: "execution_diagnostic", task_id: row.taskId,
      run_id: row.runId, iteration: row.iteration, record_sha256: extensionHash(JSON.stringify(canonical[i])), diagnostic: row.approval_diagnostic }));
  });
  store.replaceMain(file, raw, canonical.map(row => JSON.stringify(row)).join("\n") + "\n");
  store.commit(prepared);
  return { status: "migrated", archive };
}

export function executionExtensionStatus(workspaceId: string): object {
  const store = new ExtensionStore(workspaceId, "records", recordsFile(workspaceId));
  return { available: store.available, evidence: store.entries().map(e => ({ ...e,
    classification: e.committed ? "committed_evidence" : "prepared_uncommitted", approval_granted: false, resumable: false })) };
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  const store = new ExtensionStore(workspaceId, "records", file);
  if (!fs.existsSync(file)) return [];
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch {
    return [];
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    return [];
  }
  const maxRead = 4 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxRead);
  const buffer = Buffer.alloc(stat.size - start);
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let raw = buffer.toString("utf8");
  if (start > 0) raw = raw.slice(Math.max(0, raw.indexOf("\n") + 1));
  const boundedLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 10));
  const lines = raw.trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (const line of lines.slice(-boundedLimit)) {
    try {
      const source = JSON.parse(line);
      const record = sanitizeRecord(source);
      if (record) {
        for (const entry of store.entries()) {
          const p = entry.payload;
          if (entry.committed && p.kind === "execution_diagnostic" && p.task_id === record.taskId && p.run_id === record.runId &&
              p.iteration === record.iteration && p.record_sha256 === extensionHash(JSON.stringify(source))) {
            record.approval_diagnostic = p.diagnostic; record.approval_diagnostic_available = true;
          }
        }
        records.push(record);
      }
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}

/** Admission-only snapshot. Unlike diagnostics, partial or malformed history is never usable. */
export function readLegacySnapshot(workspaceId: string, taskId: string): { records: ExecutionRecord[]; sha256: string } {
  const reject = (): never => { throw new Error("LEGACY_SNAPSHOT_INVALID"); };
  if (!/^[a-f0-9]{24}$/.test(workspaceId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(taskId)) reject();
  const file = recordsFile(workspaceId);
  const privateEntry = (s: fs.Stats) => process.platform === "win32" ||
    ((s.mode & 0o077) === 0 && (typeof process.getuid !== "function" || s.uid === process.getuid()));
  const parents = new Map<string, fs.Stats>();
  for (let p = path.dirname(file);; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || ((p === path.dirname(file) || p === getStateDir()) && !privateEntry(s))) reject();
    parents.set(p, s);
    if (path.dirname(p) === p) break;
  }
  const before = fs.lstatSync(file);
  const valid = (s: fs.Stats) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && privateEntry(s) && s.size > 0 && s.size <= 4 * 1024 * 1024;
  const same = (a: fs.Stats, b: fs.Stats) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  if (!valid(before)) reject();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let raw: Buffer;
  try {
    const opened = fs.fstatSync(fd);
    if (!valid(opened) || !same(before, opened)) reject();
    raw = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < raw.length) {
      const n = fs.readSync(fd, raw, length, raw.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (length !== opened.size || !valid(after) || !valid(named) || !same(opened, after) || !same(opened, named)) reject();
    raw = raw.subarray(0, length);
    for (const [p, original] of parents) {
      const current = fs.lstatSync(p);
      if (current.isSymbolicLink() || current.ino !== original.ino || current.dev !== original.dev || current.mode !== original.mode || current.uid !== original.uid) reject();
    }
  } finally { fs.closeSync(fd); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (!lines.length || lines.length > 100) reject();
  const all = lines.map(line => legacyRowSchema.parse(JSON.parse(line)));
  const selected = all.filter(r => r.taskId === taskId);
  if (!selected.length) reject();
  const turns = new Map<number, ExecutionRecord>();
  const ids = new Map<string, number>();
  for (const r of selected) {
    if (r.iteration < 1) reject();
    const previous = turns.get(r.iteration);
    if (r.runId && ((previous?.runId && previous.runId !== r.runId) ||
        (ids.has(r.runId) && ids.get(r.runId) !== r.iteration) ||
        all.some(other => other.taskId !== taskId && other.runId === r.runId))) reject();
    if (r.runId) ids.set(r.runId, r.iteration);
    // Explicit test rows are evidence, not additional executions. Never synthesize an ID.
    if (!previous || (!previous.runId && r.runId)) turns.set(r.iteration, r);
  }
  const records = [...turns.values()].sort((a, b) => a.iteration - b.iteration);
  return { records, sha256: createHash("sha256").update(raw).digest("hex") };
}
