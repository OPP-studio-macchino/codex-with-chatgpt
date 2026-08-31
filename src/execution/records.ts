import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, writeSecureText } from "../config/paths.js";
import { redactAndTruncate } from "../security/redaction.js";
import { isBuiltinSensitivePath } from "../workspace/ignore.js";

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked";
  timestamp: string;
  notes?: string;
}

function sanitizeChangedFiles(value: unknown): string[] | number {
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
  return 0;
}

function sanitizeRecord(value: unknown): ExecutionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.taskId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(record.taskId)) return null;
  if (
    typeof record.iteration !== "number" ||
    !Number.isInteger(record.iteration) ||
    record.iteration < 0 ||
    record.iteration > 10_000
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
  return {
    taskId: record.taskId,
    iteration: record.iteration,
    changedFiles: sanitizeChangedFiles(record.changedFiles),
    tests: typeof record.tests === "string" ? redactAndTruncate(record.tests, 500).text : null,
    exitStatus: record.exitStatus,
    timestamp: record.timestamp,
    notes: typeof record.notes === "string" ? redactAndTruncate(record.notes, 500).text : undefined,
  };
}

function recordsFile(workspaceId: string): string {
  if (
    workspaceId === "." ||
    workspaceId === ".." ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId)
  ) {
    throw new Error("Invalid workspace id for execution records.");
  }
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(record.taskId)) {
    throw new Error("Invalid execution task id.");
  }
  if (!Number.isInteger(record.iteration) || record.iteration < 0 || record.iteration > 10_000) {
    throw new Error("Invalid execution iteration.");
  }
  if (!["ok", "failed", "blocked"].includes(record.exitStatus)) {
    throw new Error("Invalid execution status.");
  }
  if (record.timestamp.length > 64 || !Number.isFinite(Date.parse(record.timestamp))) {
    throw new Error("Invalid execution timestamp.");
  }
  const safeRecord = sanitizeRecord(record);
  if (!safeRecord) throw new Error("Invalid execution record.");
  const existing = readExecutionRecords(workspaceId, 99);
  writeSecureText(file, [...existing, safeRecord].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
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
      const record = sanitizeRecord(JSON.parse(line));
      if (record) records.push(record);
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
