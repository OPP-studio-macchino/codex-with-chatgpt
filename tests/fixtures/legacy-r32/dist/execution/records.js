import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getStateDir, writeSecureText } from "../config/paths.js";
import { redactAndTruncate } from "../security/redaction.js";
import { isBuiltinSensitivePath } from "../workspace/ignore.js";
function sanitizeChangedFiles(value) {
    if (value === null)
        return null;
    if (Array.isArray(value)) {
        const files = value.slice(0, 50).map((entry) => {
            const candidate = String(entry).replace(/\\/g, "/");
            if (isBuiltinSensitivePath(candidate))
                return "[REDACTED SENSITIVE PATH]";
            return redactAndTruncate(candidate, 512).text;
        });
        if (value.length > files.length)
            files.push(`[TRUNCATED ${value.length - files.length} MORE PATHS]`);
        return files;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.min(100_000, Math.max(0, Math.floor(value)));
    }
    return null;
}
function sanitizeRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = value;
    if (typeof record.taskId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(record.taskId))
        return null;
    if (typeof record.iteration !== "number" ||
        !Number.isInteger(record.iteration) ||
        record.iteration < 0 ||
        record.iteration > 10_000) {
        return null;
    }
    if (record.exitStatus !== "ok" && record.exitStatus !== "failed" && record.exitStatus !== "blocked") {
        return null;
    }
    if (typeof record.timestamp !== "string" ||
        record.timestamp.length > 64 ||
        !Number.isFinite(Date.parse(record.timestamp))) {
        return null;
    }
    return {
        taskId: record.taskId,
        iteration: record.iteration,
        changedFiles: sanitizeChangedFiles(record.changedFiles),
        tests: typeof record.tests === "string" ? redactAndTruncate(record.tests, 500).text : null,
        exitStatus: record.exitStatus,
        timestamp: record.timestamp,
        runId: typeof record.runId === "string" && /^[a-f0-9]{32}$/.test(record.runId)
            ? record.runId
            : undefined,
        notes: typeof record.notes === "string" ? redactAndTruncate(record.notes, 500).text : undefined,
    };
}
function recordsFile(workspaceId) {
    if (workspaceId === "." ||
        workspaceId === ".." ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId)) {
        throw new Error("Invalid workspace id for execution records.");
    }
    const dir = path.join(getStateDir(), "executions");
    return path.join(dir, `${workspaceId}.jsonl`);
}
export function appendExecutionRecord(workspaceId, record) {
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
    if (record.runId !== undefined && !/^[a-f0-9]{32}$/.test(record.runId)) {
        throw new Error("Invalid execution run id.");
    }
    if (record.timestamp.length > 64 || !Number.isFinite(Date.parse(record.timestamp))) {
        throw new Error("Invalid execution timestamp.");
    }
    const safeRecord = sanitizeRecord(record);
    if (!safeRecord)
        throw new Error("Invalid execution record.");
    const existing = readExecutionRecords(workspaceId, 99);
    writeSecureText(file, [...existing, safeRecord].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}
/** Idempotent projection into the legacy bounded history; journal is authoritative. */
export function appendExecutionRecordOnce(workspaceId, record) {
    if (record.runId && readExecutionRecords(workspaceId, 100).some(existing => existing.runId === record.runId && existing.taskId === record.taskId && existing.iteration === record.iteration))
        return;
    appendExecutionRecord(workspaceId, record);
}
export function readExecutionRecords(workspaceId, limit = 10) {
    const file = recordsFile(workspaceId);
    if (!fs.existsSync(file))
        return [];
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    }
    catch {
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
    }
    finally {
        fs.closeSync(fd);
    }
    let raw = buffer.toString("utf8");
    if (start > 0)
        raw = raw.slice(Math.max(0, raw.indexOf("\n") + 1));
    const boundedLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 10));
    const lines = raw.trim().split("\n").filter(Boolean);
    const records = [];
    for (const line of lines.slice(-boundedLimit)) {
        try {
            const record = sanitizeRecord(JSON.parse(line));
            if (record)
                records.push(record);
        }
        catch {
            // skip corrupt lines
        }
    }
    return records;
}
export function latestExecutionRecord(workspaceId) {
    const records = readExecutionRecords(workspaceId, 1);
    return records[records.length - 1] ?? null;
}
/** Admission-only snapshot. Unlike diagnostics, partial or malformed history is never usable. */
export function readLegacySnapshot(workspaceId, taskId) {
    const reject = () => { throw new Error("LEGACY_SNAPSHOT_INVALID"); };
    if (!/^[a-f0-9]{24}$/.test(workspaceId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(taskId))
        reject();
    const file = recordsFile(workspaceId);
    const privateEntry = (s) => process.platform === "win32" ||
        ((s.mode & 0o077) === 0 && (typeof process.getuid !== "function" || s.uid === process.getuid()));
    const parents = new Map();
    for (let p = path.dirname(file);; p = path.dirname(p)) {
        const s = fs.lstatSync(p);
        if (!s.isDirectory() || s.isSymbolicLink() || ((p === path.dirname(file) || p === getStateDir()) && !privateEntry(s)))
            reject();
        parents.set(p, s);
        if (path.dirname(p) === p)
            break;
    }
    const before = fs.lstatSync(file);
    const valid = (s) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && privateEntry(s) && s.size > 0 && s.size <= 4 * 1024 * 1024;
    const same = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (!valid(before))
        reject();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let raw;
    try {
        const opened = fs.fstatSync(fd);
        if (!valid(opened) || !same(before, opened))
            reject();
        raw = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < raw.length) {
            const n = fs.readSync(fd, raw, length, raw.length - length, null);
            if (!n)
                break;
            length += n;
        }
        const after = fs.fstatSync(fd), named = fs.lstatSync(file);
        if (length !== opened.size || !valid(after) || !valid(named) || !same(opened, after) || !same(opened, named))
            reject();
        raw = raw.subarray(0, length);
        for (const [p, original] of parents) {
            const current = fs.lstatSync(p);
            if (current.isSymbolicLink() || current.ino !== original.ino || current.dev !== original.dev || current.mode !== original.mode || current.uid !== original.uid)
                reject();
        }
    }
    finally {
        fs.closeSync(fd);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    if (!lines.length || lines.length > 100)
        reject();
    const row = z.object({ taskId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), iteration: z.number().int().min(0).max(10000),
        changedFiles: z.union([z.array(z.string().max(512)).max(51), z.number().int().min(0).max(100000), z.null()]),
        tests: z.string().max(500).nullable(), exitStatus: z.enum(["ok", "failed", "blocked"]),
        runId: z.string().regex(/^[a-f0-9]{32}$/).optional(), timestamp: z.string().max(64).refine(s => Number.isFinite(Date.parse(s))),
        notes: z.string().max(500).optional() }).strict();
    const all = lines.map(line => row.parse(JSON.parse(line)));
    const selected = all.filter(r => r.taskId === taskId);
    if (!selected.length)
        reject();
    const turns = new Map();
    const ids = new Map();
    for (const r of selected) {
        if (r.iteration < 1 || r.iteration > 12)
            reject();
        const previous = turns.get(r.iteration);
        if (r.runId && ((previous?.runId && previous.runId !== r.runId) ||
            (ids.has(r.runId) && ids.get(r.runId) !== r.iteration) ||
            all.some(other => other.taskId !== taskId && other.runId === r.runId)))
            reject();
        if (r.runId)
            ids.set(r.runId, r.iteration);
        // Explicit test rows are evidence, not additional executions. Never synthesize an ID.
        if (!previous || (!previous.runId && r.runId))
            turns.set(r.iteration, r);
    }
    const records = [...turns.values()].sort((a, b) => a.iteration - b.iteration);
    return { records, sha256: createHash("sha256").update(raw).digest("hex") };
}
//# sourceMappingURL=records.js.map