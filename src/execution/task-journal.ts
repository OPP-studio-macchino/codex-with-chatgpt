import { ExtensionStore, notificationSchema, recoverySchema, type Extension } from "./extensions.js";
import { quarantine, type ProcessEvidence, type DiagnosticContext } from "./reconciliation-processes.js";
import type { ElicitationEvent } from "../codex/mcp-elicitation.js";
import { approvalDiagnosticSchema } from "../codex/approval-diagnostic.js";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v3";
import { getStateDir } from "../config/paths.js";
import { readStableFile } from "../security/stable-file.js";
import { redactAndTruncate } from "../security/redaction.js";
import type { CodexRunResult } from "../codex/app-server.js";
import { executionModeSchema, type ExecutionMode } from "../codex/execution-mode.js";
import { readExecutionRecords, readLegacySnapshot } from "./records.js";
import { deliveryDelay, noticeCategory, notificationId, readNoticeDelivery, writeNoticeDelivery } from "../notifications/delivery-store.js";

const MAX_BYTES = 4 * 1024 * 1024;
const workspace = z.string().regex(/^[a-f0-9]{24}$/);
const task = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const iteration = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const bounded = (bytes: number): z.ZodType<string> => z.string().refine((s) => Buffer.byteLength(s) <= bytes);
const timestamp = z.string().datetime();
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/);
const reconciliationSchema = z.object({
  resolution: z.literal("allow_new_task_only"), source_record_sha256: sha256,
  evidence_sha256: sha256, owner_approved_at: timestamp, reconciled_at: timestamp,
}).strict();
const runSchema = z.object({
  task_id: task, workspace_id: workspace, iteration, run_id: identifier,
  state: z.enum(["running", "completed", "blocked", "failed"]),
  runtime_id: identifier, instruction_excerpt: bounded(2048), instruction_truncated: z.boolean(),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/), summary: bounded(8192).optional(),
  reason: bounded(2048).optional(), started_at: timestamp, updated_at: timestamp,
  reconciliation: reconciliationSchema.optional(),
}).strict();
const wipRunSchema = runSchema.extend({ notifications: z.array(notificationSchema).max(34).optional(), approval_diagnostic: approvalDiagnosticSchema.optional() }).strict();
type SavedRun = z.infer<typeof runSchema>;
type WipRun = z.infer<typeof wipRunSchema> & { execution_mode?: ExecutionMode };
const missingRunSchema = z.object({ iteration, run_id: identifier }).strict();
const checkpointTargetSchema = z.object({
  workspace_id: workspace, task_id: task, next_iteration: iteration,
  source: z.enum(["journal", "legacy_execution_records"]), source_sha256: sha256,
  known_records: z.array(z.object({ iteration, run_id: identifier.nullable() }).strict()).min(1).max(4000),
  reported_missing_run: missingRunSchema.extend({ provenance: z.literal("user_reported_unknown") }).strict().optional(),
  request_sha256: sha256, instruction_excerpt: bounded(2048), instruction_truncated: z.boolean(),
}).strict();
export type CheckpointTarget = z.infer<typeof checkpointTargetSchema>;
const checkpointSchema = checkpointTargetSchema.extend({
  checkpoint_id: identifier, runtime_id: identifier, evidence_sha256: sha256,
  owner_approved_at: timestamp, expires_at: timestamp,
  status: z.enum(["approved", "consumed", "revoked"]), consumed_run_id: identifier.optional(), consumed_action_id: identifier.optional(),
}).strict().refine(c => Date.parse(c.expires_at) - Date.parse(c.owner_approved_at) === 60_000 &&
  (c.status === "consumed") === (c.consumed_run_id !== undefined || c.consumed_action_id !== undefined) &&
  !(c.consumed_run_id && c.consumed_action_id));
type Checkpoint = z.infer<typeof checkpointSchema>;
type WorkspaceRecovery = z.infer<typeof recoverySchema>;
const snapshotSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), runs: z.array(runSchema).max(4000), checkpoints: z.array(checkpointSchema).max(1000).optional() }).strict();
const wipSnapshotSchema = snapshotSchema.extend({ runs: z.array(wipRunSchema).max(4000), recoveries: z.array(recoverySchema).max(128).optional() }).strict();
const lockSchema = z.object({ pid: z.number().int().positive().max(2147483647), nonce: identifier }).strict();

export interface ReconciliationTarget {
  workspace_id: string;
  task_id: string;
  run_id: string;
  source_record_sha256: string;
}
const reconciliationTargetSchema = z.object({
  workspace_id: workspace, task_id: task, run_id: identifier, source_record_sha256: sha256,
}).strict();

export class TaskJournalError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: object) { super(message); this.name = "TaskJournalError"; }
}
function fail(code: string): never { throw new TaskJournalError(code, code.replaceAll("_", " ")); }
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("TASK_JOURNAL_INVALID");
  return parsed.data;
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function hash(instruction: string): string {
  if (typeof instruction !== "string") fail("TASK_JOURNAL_INVALID");
  return createHash("sha256").update(instruction).digest("hex");
}
function safeText(text: string, bytes: number): string {
  if (typeof text !== "string") fail("TASK_JOURNAL_INVALID");
  return redactAndTruncate(text, bytes).text;
}

// These termination paths cannot prove whether partial effects or an orphan remain.
function uncertain(run: SavedRun): boolean {
  return run.state === "running" || (run.state === "blocked" && run.reason === "user_input_required") || (run.state === "failed" && [
    "bridge_stopped", "turn_timeout", "turn_start_failed", "child_exit", "child_error",
    "protocol_write_failed", "malformed_protocol", "oversized_protocol_line",
  ].includes(run.reason ?? ""));
}

function recordsAreConsistent(runs: SavedRun[]): boolean {
  const tasks = new Map<string, string>();
  const ids = new Set<string>();
  const turns = new Set<string>();
  for (const run of runs) {
    if (run.reconciliation) {
      const { reconciliation, ...source } = run;
      const age = Date.parse(reconciliation.reconciled_at) - Date.parse(reconciliation.owner_approved_at);
      if (!uncertain(run) || reconciliation.source_record_sha256 !== hash(JSON.stringify(source)) || !Number.isFinite(age) || age < 0 || age > 60_000) return false;
    }
    if ((tasks.has(run.task_id) && tasks.get(run.task_id) !== run.workspace_id) || ids.has(run.run_id) || turns.has(`${run.task_id}/${run.iteration}`) || run.updated_at < run.started_at) return false;
    tasks.set(run.task_id, run.workspace_id); ids.add(run.run_id); turns.add(`${run.task_id}/${run.iteration}`);
  }
  return tasks.size <= 1000 && runs.length <= 4000;
}

function checkpointsAreConsistent(runs: SavedRun[], checkpoints: Checkpoint[], workspaceId: string): boolean {
  if (new Set(checkpoints.map(c => c.checkpoint_id)).size !== checkpoints.length) return false;
  const consumedIds = checkpoints.flatMap(c => c.consumed_run_id ? [c.consumed_run_id] : c.consumed_action_id ? [c.consumed_action_id] : []);
  if (new Set(consumedIds).size !== consumedIds.length) return false;
  for (const c of checkpoints) {
    if (c.workspace_id !== workspaceId) return false;
    const runIds = c.known_records.flatMap(r => r.run_id ? [r.run_id] : []);
    if (new Set(c.known_records.map(r => r.iteration)).size !== c.known_records.length || new Set(runIds).size !== runIds.length) return false;
    const high = Math.max(...c.known_records.map(r => r.iteration));
    const missing = c.reported_missing_run;
    if (c.next_iteration !== high + (missing ? 2 : 1) || (missing && (missing.iteration !== high + 1 || c.known_records.some(r => r.run_id === missing.run_id)))) return false;
    if (c.consumed_action_id) return false; // The journal has no action-result record to prove this consumption.
    if (c.consumed_run_id && !runs.some(r => r.run_id === c.consumed_run_id && r.workspace_id === c.workspace_id &&
        r.runtime_id === c.runtime_id && r.task_id === c.task_id && r.iteration === c.next_iteration && r.request_sha256 === c.request_sha256 &&
        Date.parse(r.started_at) >= Date.parse(c.owner_approved_at) && Date.parse(r.started_at) < Date.parse(c.expires_at) &&
        !runIds.includes(r.run_id) && c.reported_missing_run?.run_id !== r.run_id)) return false;
  }
  return true;
}

/** Read-only fail-closed admission check for removing a workspace registration. */
export function workspaceUnregistrationSafety(workspaceId: string): "clear" | "blocking" | "unknown" {
  if (!workspace.safeParse(workspaceId).success) return "unknown";
  const file = path.join(getStateDir(), "task-journal", `${workspaceId}.json`);
  try {
    const { data, stat } = readStableFile(path.resolve(file), MAX_BYTES);
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()))) return "unknown";
    const parsed = wipSnapshotSchema.safeParse(JSON.parse(data.toString("utf8")));
    if (!parsed.success || !recordsAreConsistent(parsed.data.runs) || parsed.data.runs.some(run => run.workspace_id !== workspaceId) ||
        !checkpointsAreConsistent(parsed.data.runs, parsed.data.checkpoints ?? [], workspaceId)) return "unknown";
    // An approved checkpoint is an unconsumed owner authorization.  It stays
    // unsafe even after its TTL: expiry prevents use, but cannot prove that no
    // action was started while it was valid.  Consumed and revoked records are
    // terminal, and schema validation above makes malformed records unknown.
    if (parsed.data.checkpoints?.some(checkpoint => checkpoint.status === "approved")) return "blocking";
    if (parsed.data.recoveries?.some(recovery => recovery.state === "blocked")) return "unknown";
    return parsed.data.runs.some(run => uncertain(run) && !run.reconciliation) ? "blocking" : "clear";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "clear" : "unknown";
  }
}


/** Read-only upgrade preflight. Never reinterpret mixed anchor-era records as empty history. */
export function inspectTaskJournalLayout(stateDir: string = getStateDir()): {
  status: "empty" | "target_keyed"; journals: number; runs: number;
} {
  const dir = path.join(path.resolve(stateDir), "task-journal");
  const reject = (code: string, message: string): never => { throw new TaskJournalError(code, message); };
  try {
    // Validate existing ancestors, without creating or chmod-ing any directory.
    for (let p = dir;; p = path.dirname(p)) {
      try {
        const st = fs.lstatSync(p);
        if (!st.isDirectory() || st.isSymbolicLink()) reject("TASK_JOURNAL_LAYOUT_UNREADABLE", "Journal storage path is unsafe; existing records were not changed.");
        if (p === dir && process.platform !== "win32" && ((st.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" && st.uid !== process.getuid()))) {
          reject("TASK_JOURNAL_LAYOUT_UNREADABLE", "Journal storage must be owner-only; no records were changed.");
        }
      } catch (e) { if (code(e) !== "ENOENT") throw e; }
      if (path.dirname(p) === p) break;
    }
    let entries: string[];
    try { entries = fs.readdirSync(dir); }
    catch (e) { if (code(e) === "ENOENT") return { status: "empty", journals: 0, runs: 0 }; throw e; }
    if (entries.length > 256) reject("TASK_JOURNAL_LAYOUT_LIMIT", "Journal layout scan exceeded its bound; preserve records for offline review.");
    const names = entries.filter(n => n.endsWith(".json") && !n.startsWith("._")).sort();
    let totalBytes = 0, totalRuns = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) reject("TASK_JOURNAL_LAYOUT_INVALID", "Unexpected journal filename; preserve existing records for offline review.");
      const file = path.join(dir, name), before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink()) reject("TASK_JOURNAL_LAYOUT_UNREADABLE", "Journal must be a regular, non-symlink file.");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let raw: string;
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES || st.ino !== before.ino || st.dev !== before.dev ||
            (process.platform !== "win32" && ((st.mode & 0o077) !== 0 ||
              (typeof process.getuid === "function" && st.uid !== process.getuid())))) {
          reject("TASK_JOURNAL_LAYOUT_UNREADABLE", "Journal cannot be safely inspected; no records were changed.");
        }
        totalBytes += st.size;
        if (totalBytes > 64 * 1024 * 1024) reject("TASK_JOURNAL_LAYOUT_LIMIT", "Journal layout scan exceeded its byte bound; preserve records for offline review.");
        const buffer = Buffer.alloc(st.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
          if (!n) break;
          length += n;
        }
        const after = fs.lstatSync(file), openedAfter = fs.fstatSync(fd);
        if (length !== st.size || after.isSymbolicLink() || after.ino !== st.ino || after.dev !== st.dev ||
            openedAfter.size !== st.size || openedAfter.mtimeMs !== st.mtimeMs || openedAfter.ctimeMs !== st.ctimeMs) {
          reject("TASK_JOURNAL_LAYOUT_CHANGED", "Journal changed during inspection; retry only after coordinating the running services.");
        }
        raw = buffer.subarray(0, length).toString("utf8");
      } finally { fs.closeSync(fd); }
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch { reject("TASK_JOURNAL_LAYOUT_INVALID", "Journal JSON is invalid; it was not treated as empty history."); }
      const parsed = wipSnapshotSchema.safeParse(value);
      if (!parsed.success) reject("TASK_JOURNAL_LAYOUT_INVALID", "Journal schema is invalid; preserve records for offline review.");
      const snapshot = parsed.data!;
      const targetId = name.slice(0, -5);
      if (snapshot.runs.some(r => r.workspace_id !== targetId) || snapshot.checkpoints?.some(c => c.workspace_id !== targetId)) {
        reject("TASK_JOURNAL_MIGRATION_REQUIRED", "Legacy anchor-keyed journal detected. Preserve the state directory and migrate records offline before starting this version; no history was deleted or automatically replayed.");
      }
      totalRuns += snapshot.runs.length;
    }
    const current = fs.readdirSync(dir).filter(n => n.endsWith(".json") && !n.startsWith("._")).sort();
    if (JSON.stringify(current) !== JSON.stringify(names)) reject("TASK_JOURNAL_LAYOUT_CHANGED", "Journal set changed during inspection; coordinate service shutdown before retrying.");
    return { status: names.length ? "target_keyed" : "empty", journals: names.length, runs: totalRuns };
  } catch (e) {
    if (e instanceof TaskJournalError) throw e;
    return reject("TASK_JOURNAL_LAYOUT_UNREADABLE", "Journal layout could not be verified; no stored history was changed.");
  }
}

/** Bounded history: 1000 task tombstones, 4000 runs, 4 MiB; never evicted. */
export class TaskJournal {
  readonly runtimeId: string = randomBytes(16).toString("hex");
  private readonly dir: string;
  private readonly file: string;
  private readonly lock: string;
  private readonly nonce: string = randomBytes(16).toString("hex");
  private lockIdentity?: fs.Stats;
  private runs: SavedRun[] = [];
  private checkpoints: Checkpoint[] = [];
  private wipSnapshot?: z.infer<typeof wipSnapshotSchema>;
  private readonly extensions: ExtensionStore;
  private diskSnapshot: string | null = null;
  private healthy = true;
  private closed = false;

  constructor(private readonly targetWorkspaceId: string) {
    validate(workspace, targetWorkspaceId);
    this.dir = path.join(getStateDir(), "task-journal");
    this.file = path.join(this.dir, `${targetWorkspaceId}.json`);
    this.lock = path.join(this.dir, `${targetWorkspaceId}.lock`);
    this.extensions = new ExtensionStore(targetWorkspaceId, "journal", this.file);
    try {
      this.checkParents();
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.checkParents();
      fs.chmodSync(this.dir, 0o700);
      this.acquire();
      const raw = this.read(this.file, MAX_BYTES);
      this.diskSnapshot = raw;
      if (raw !== null) {
        const snapshot = JSON.parse(raw);
        validate(wipSnapshotSchema, snapshot);
        if (!snapshotSchema.safeParse(snapshot).success) this.wipSnapshot = snapshot;
        // Preserve source record property order for JSON.stringify-based evidence hashes.
        this.runs = snapshot.runs;
        this.checkpoints = snapshot.checkpoints ?? [];
        if (snapshot.recoveries?.some((r: WorkspaceRecovery) => r.workspace_id !== targetWorkspaceId)) fail("TASK_WORKSPACE_MISMATCH");
        if (new Set(snapshot.recoveries?.map((r: WorkspaceRecovery) => r.recovery_id)).size !== (snapshot.recoveries?.length ?? 0)) fail("TASK_JOURNAL_INVALID");
        if (this.runs.some(r => r.workspace_id !== targetWorkspaceId) || this.checkpoints.some(c => c.workspace_id !== targetWorkspaceId)) fail("TASK_WORKSPACE_MISMATCH");
        this.validateCheckpoints(this.runs, this.checkpoints);
        this.validateRecords(this.runs);
      }
    } catch (error) {
      this.close();
      if (error instanceof TaskJournalError) throw error;
      fail("TASK_JOURNAL_UNAVAILABLE");
    }
  }

  private checkParents(): void {
    let parent = this.dir;
    for (;;) {
      try {
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("TASK_JOURNAL_UNAVAILABLE");
        if (parent === this.dir && process.platform !== "win32" &&
            ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) {
          fail("TASK_JOURNAL_UNAVAILABLE");
        }
      }
      catch (error) { if (code(error) !== "ENOENT") throw error; }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  private read(file: string, max: number): string | null {
    this.checkParents();
    let fd: number;
    try {
      const entry = fs.lstatSync(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > max) fail("TASK_JOURNAL_UNAVAILABLE");
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    }
    catch (error) { if (code(error) === "ENOENT") return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > max || stat.nlink !== 1) fail("TASK_JOURNAL_UNAVAILABLE");
      if (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) {
        fail("TASK_JOURNAL_UNAVAILABLE");
      }
      // Fixed-size read also bounds concurrent growth of an untrusted file.
      const buffer = Buffer.alloc(max + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > max) fail("TASK_JOURNAL_UNAVAILABLE");
      return buffer.subarray(0, length).toString("utf8");
    } finally { fs.closeSync(fd); }
  }

  private acquire(): void {
    try {
      const existing = this.read(this.lock, 1024);
      if (existing !== null) {
        const identity = fs.lstatSync(this.lock);
        const owner = validate(lockSchema, JSON.parse(existing));
        try { process.kill(owner.pid, 0); fail("TASK_JOURNAL_BUSY"); }
        catch (error) { if (code(error) !== "ESRCH") fail("TASK_JOURNAL_BUSY"); }
        const current = fs.lstatSync(this.lock);
        if (current.ino !== identity.ino || current.dev !== identity.dev || this.read(this.lock, 1024) !== existing) fail("TASK_JOURNAL_BUSY");
        fs.unlinkSync(this.lock);
      }
      const fd = fs.openSync(this.lock, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.nonce }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.lockIdentity = fs.lstatSync(this.lock);
      fs.chmodSync(this.lock, 0o600);
      this.syncDirectory();
    } catch { fail("TASK_JOURNAL_BUSY"); }
  }

  private syncDirectory(): void {
    const fd = fs.openSync(this.dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); }
    catch (error) { if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(code(error) ?? "")) throw error; }
    finally { fs.closeSync(fd); }
  }

  private ready(): void {
    if (!this.healthy || this.closed) fail("TASK_JOURNAL_UNAVAILABLE");
  }

  private validateRecords(runs: SavedRun[]): void {
    const tasks = new Map<string, string>();
    const ids = new Set<string>();
    const turns = new Set<string>();
    for (const run of runs) {
      if (run.reconciliation) {
        const { reconciliation, ...source } = run;
        const age = Date.parse(reconciliation.reconciled_at) - Date.parse(reconciliation.owner_approved_at);
        if (!uncertain(run) || reconciliation.source_record_sha256 !== hash(JSON.stringify(source)) ||
            !Number.isFinite(age) || age < 0 || age > 60_000) fail("TASK_JOURNAL_INVALID");
      }
      if ((tasks.has(run.task_id) && tasks.get(run.task_id) !== run.workspace_id) || ids.has(run.run_id) || turns.has(`${run.task_id}/${run.iteration}`) || run.updated_at < run.started_at) fail("TASK_JOURNAL_INVALID");
      tasks.set(run.task_id, run.workspace_id); ids.add(run.run_id); turns.add(`${run.task_id}/${run.iteration}`);
    }
    if (tasks.size > 1000 || runs.length > 4000) fail("TASK_JOURNAL_CAPACITY");
  }

  private validateCheckpoints(runs: SavedRun[], checkpoints: Checkpoint[]): void {
    validate(z.array(checkpointSchema).max(1000), checkpoints);
    if (new Set(checkpoints.map(c => c.checkpoint_id)).size !== checkpoints.length) fail("TASK_JOURNAL_INVALID");
    const consumedIds = checkpoints.flatMap(c => c.consumed_run_id ? [c.consumed_run_id] : c.consumed_action_id ? [c.consumed_action_id] : []);
    if (new Set(consumedIds).size !== consumedIds.length) fail("TASK_JOURNAL_INVALID");
    for (const c of checkpoints) {
      if (c.workspace_id !== this.targetWorkspaceId) fail("TASK_WORKSPACE_MISMATCH");
      const runIds = c.known_records.flatMap(r => r.run_id ? [r.run_id] : []);
      if (new Set(c.known_records.map(r => r.iteration)).size !== c.known_records.length || new Set(runIds).size !== runIds.length) fail("TASK_JOURNAL_INVALID");
      const high = Math.max(...c.known_records.map(r => r.iteration));
      const missing = c.reported_missing_run;
      if (c.next_iteration !== high + (missing ? 2 : 1) || (missing && (missing.iteration !== high + 1 || c.known_records.some(r => r.run_id === missing.run_id)))) fail("TASK_JOURNAL_INVALID");
      if (c.consumed_run_id && !runs.some(r => r.run_id === c.consumed_run_id && r.workspace_id === c.workspace_id &&
          r.runtime_id === c.runtime_id && r.task_id === c.task_id && r.iteration === c.next_iteration && r.request_sha256 === c.request_sha256 &&
          Date.parse(r.started_at) >= Date.parse(c.owner_approved_at) && Date.parse(r.started_at) < Date.parse(c.expires_at) &&
          !runIds.includes(r.run_id) && c.reported_missing_run?.run_id !== r.run_id)) fail("TASK_JOURNAL_INVALID");
    }
  }

  private save(input: WipRun[], checkpoints = this.checkpoints, recoveries: WorkspaceRecovery[] = []): void {
    if (this.wipSnapshot) fail("TASK_JOURNAL_EXTENSION_MIGRATION_REQUIRED");
    const runs = input.map(({ approval_diagnostic, notifications, execution_mode, ...run }) => run);
    const prepared: string[] = [];
    this.extensions.assertWritable();
    this.ready();
    this.validateRecords(runs);
    this.validateCheckpoints(runs, checkpoints);
    validate(z.array(recoverySchema).max(128), recoveries);
    if (recoveries.some(r => r.workspace_id !== this.targetWorkspaceId) || new Set(recoveries.map(r => r.recovery_id)).size !== recoveries.length) fail("TASK_JOURNAL_INVALID");
    // Version 2 deliberately prevents old writers from opening post-limit history.
    // Keep ordinary <=12 histories byte-compatible with the legacy reader.
    const version = runs.some(r => r.iteration > 12) || checkpoints.some(c => c.next_iteration > 12) ? 2 : 1;
    validate(snapshotSchema, { version, runs, checkpoints });
    const content = JSON.stringify({ version, runs, ...(checkpoints.length ? { checkpoints } : {}) });
    if (Buffer.byteLength(content) > MAX_BYTES) fail("TASK_JOURNAL_CAPACITY");
    const temp = `${this.file}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      this.checkParents();
      if (!this.ownsLock()) throw new Error("Lost lock");
      if (this.read(this.file, MAX_BYTES) !== this.diskSnapshot) throw new Error("Journal changed outside this writer");
      for (let i = 0; i < input.length; i++) {
        const binding = this.binding(runs[i]);
        if (input[i].execution_mode !== undefined) prepared.push(this.extensions.prepare({ kind: "execution_mode", binding,
          execution_mode: input[i].execution_mode! }));
        const diagnostic = input[i].approval_diagnostic;
        if (diagnostic) prepared.push(this.extensions.prepare({ kind: "diagnostic", binding, diagnostic }));
        for (const reservation of input[i].notifications ?? []) prepared.push(this.extensions.prepare({ kind: "notification", binding, reservation }));
      }
      for (const recovery of recoveries) {
        const targets = recovery.records.map(t => runs.find(r => r.task_id === t.task_id && r.run_id === t.run_id)!);
        if (targets.some((r, i) => !r || this.binding(r).source_sha256 !== recovery.records[i].source_record_sha256)) fail("TASK_RECONCILIATION_INVALID");
        prepared.push(this.extensions.prepare({ kind: "recovery", recovery, bindings: targets.map(r => this.binding(r)),
          reconciled_sha256: recovery.state === "recovered" ? targets.map(r => hash(JSON.stringify(r))) : [] }));
      }
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, this.file);
      this.syncDirectory();
      this.runs = runs;
      this.checkpoints = checkpoints;
      this.extensions.commit(prepared);
      this.diskSnapshot = content;
    } catch { this.healthy = false; fail("TASK_JOURNAL_UNAVAILABLE"); }
    finally { try { fs.unlinkSync(temp); } catch { /* Already renamed or unavailable. */ } }
  }

  private bound(workspaceId: string, taskId: string): SavedRun[] {
    this.ready(); validate(workspace, workspaceId); validate(task, taskId);
    if (workspaceId !== this.targetWorkspaceId) fail("TASK_WORKSPACE_MISMATCH");
    const runs = this.runs.filter((r) => r.task_id === taskId);
    if (runs.some((r) => r.workspace_id !== workspaceId)) fail("TASK_WORKSPACE_MISMATCH");
    return runs;
  }

  private binding(run: SavedRun) {
    const { reconciliation, ...source } = run;
    return { workspace_id: run.workspace_id, task_id: run.task_id, run_id: run.run_id, iteration: run.iteration, runtime_id: run.runtime_id,
      request_sha256: run.request_sha256, source_sha256: hash(JSON.stringify(source)) };
  }

  private extensionCommitted(entry: { payload: Extension; committed: boolean }): boolean {
    if (!entry.committed) return false;
    const p = entry.payload;
    if (p.kind === "execution_diagnostic") return false;
    const bindings = p.kind === "recovery" ? p.bindings : [p.binding];
    if (bindings.some(b => {
      const r = this.runs.find(r => r.run_id === b.run_id && r.task_id === b.task_id);
      if (!r) return true;
      const actual = this.binding(r);
      // Reservations bind immutable run identity and survive its later terminal
      // update. Their original source hash remains evidence, never authority.
      if (p.kind === "notification" || p.kind === "notification_dispatch" || p.kind === "elicitation" || p.kind === "execution_mode") {
        const { source_sha256: _actual, ...identity } = actual;
        const { source_sha256: _bound, ...expected } = b;
        return !isDeepStrictEqual(identity, expected);
      }
      return !isDeepStrictEqual(actual, b);
    })) return false;
    if (p.kind !== "recovery") return true;
    if (p.bindings.length !== p.recovery.records.length || p.bindings.some((b, i) =>
      b.task_id !== p.recovery.records[i].task_id || b.run_id !== p.recovery.records[i].run_id ||
      b.source_sha256 !== p.recovery.records[i].source_record_sha256)) return false;
    if (p.recovery.state !== "recovered") return p.reconciled_sha256.length === 0;
    return p.reconciled_sha256.length === p.bindings.length && p.bindings.every((b, i) => this.runs.some(r =>
      r.run_id === b.run_id && r.reconciliation?.source_record_sha256 === b.source_sha256 &&
      r.reconciliation.evidence_sha256 === p.recovery.evidence_sha256 &&
      r.reconciliation.reconciled_at === p.recovery.updated_at && hash(JSON.stringify(r)) === p.reconciled_sha256[i]));
  }

  private runExtensions(run: SavedRun) {
    const old = this.wipSnapshot?.runs.find(r => r.run_id === run.run_id);
    let approval_diagnostic = old?.approval_diagnostic;
    const notifications = [...(old?.notifications ?? [])];
    for (const e of this.extensions.entries()) {
      if ((e.payload.kind !== "diagnostic" && e.payload.kind !== "notification") || e.payload.binding.run_id !== run.run_id) continue;
      if (!this.extensionCommitted(e)) continue;
      if (e.payload.kind === "diagnostic" && e.payload.binding.run_id === run.run_id) approval_diagnostic = e.payload.diagnostic;
      if (e.payload.kind === "notification" && e.payload.binding.run_id === run.run_id) notifications.push(e.payload.reservation);
    }
    return { approval_diagnostic, notifications };
  }

  extensionStatus(): object {
    this.ready();
    return { available: this.extensions.available, migration_required: this.wipSnapshot !== undefined,
      evidence: this.extensions.entries().map(e => ({ id: e.id, kind: e.payload.kind,
        classification: this.extensionCommitted(e) ? "committed_evidence" : "prepared_uncommitted",
        // Bounded strict redacted evidence only; no pending transport or grant.
        payload: e.payload, resumable: false, approval_granted: false, delivery_proven: false, goal_completed: false })) };
  }

  recordElicitation(workspaceId: string, run: CodexRunResult, event: ElicitationEvent): void {
    const saved = this.bound(workspaceId, run.task_id).find(r => r.run_id === run.run_id && r.iteration === run.iteration);
    if (!saved || saved.runtime_id !== this.runtimeId || saved.state !== "running") fail("TASK_RECOVERY_REQUIRED");
    if (!this.ownsLock() || this.read(this.file, MAX_BYTES) !== this.diskSnapshot) fail("TASK_JOURNAL_UNAVAILABLE");
    const id = this.extensions.prepare({ kind: "elicitation", binding: this.binding(saved), ...event, observed_at: new Date().toISOString() });
    this.extensions.commit([id]);
  }

  private elicitationHistory(run: SavedRun) {
    return this.extensions.entries().filter(e => e.payload.kind === "elicitation" && e.payload.binding.run_id === run.run_id &&
      e.payload.binding.task_id === run.task_id && this.extensionCommitted(e)).map(e => {
      const p = e.payload as Extract<Extension, { kind: "elicitation" }>;
      return { evidence: p.evidence, phase: p.phase, observed_at: p.observed_at, ...(p.action ? { action: p.action } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
        resumable: false as const, delivery_proven: false as const, goal_verified: false as const };
    });
  }

  /** Explicit offline operation. Callers must supply a disposable fixture or separately authorized state. */
  migrateExtensions(): { status: "not_required" | "migrated"; archive?: string } {
    this.ready();
    if (!this.wipSnapshot) return { status: "not_required" };
    const snapshot = this.wipSnapshot;
    if (snapshot.runs.some(r => r.reconciliation && (r.approval_diagnostic !== undefined || r.notifications !== undefined))) {
      fail("TASK_JOURNAL_HASH_BOUND_EXTENSION_MIGRATION_REQUIRED");
    }
    if (!this.ownsLock() || this.read(this.file, MAX_BYTES) !== this.diskSnapshot) fail("TASK_JOURNAL_UNAVAILABLE");
    const canonical = snapshot.runs.map(({ approval_diagnostic, notifications, ...run }) => run);
    this.validateRecords(canonical); this.validateCheckpoints(canonical, this.checkpoints);
    if (snapshot.recoveries?.some(recovery => recovery.records.some(t => {
      const run = canonical.find(r => r.run_id === t.run_id && r.task_id === t.task_id);
      return !run || this.binding(run).source_sha256 !== t.source_record_sha256;
    }))) fail("TASK_JOURNAL_RECOVERY_EXTENSION_MIGRATION_REQUIRED");
    const archive = this.extensions.archive(this.diskSnapshot!);
    // save prepares all extracted evidence before the canonical main replacement.
    this.wipSnapshot = undefined;
    try { this.save(snapshot.runs, this.checkpoints, snapshot.recoveries ?? []); }
    catch (e) { this.wipSnapshot = snapshot; throw e; }
    return { status: "migrated", archive };
  }

  private result(run: SavedRun): CodexRunResult {
    const mode = this.recordedExecutionMode(run);
    const diagnostic = this.runExtensions(run).approval_diagnostic;
    const history = this.elicitationHistory(run);
    const diagnosticReason = run.reason === "protocol_write_failed" ? [...history].reverse().find(e => e.phase === "channel_closed")?.reason : undefined;
    return { task_id: run.task_id, iteration: run.iteration, run_id: run.run_id, state: run.state,
      ...(mode === undefined ? {} : { execution_mode: mode }),
      ...(run.reason === "read_only_approval_denied" ? { resumable: false } : {}),
      ...(history.length ? { elicitation_history: history } : {}),
      ...(diagnostic ? { approval_diagnostic: diagnostic, approval_diagnostic_available: true } : {}),
      ...(run.state === "blocked" && run.reason === "approval_required" ? { resumable: false, approval_diagnostic_available: diagnostic !== undefined } : {}),
      ...(this.checkpoints.some(c => c.consumed_run_id === run.run_id) ? { checkpoint_continuation: true as const, original_context_restored: false as const } : {}),
      ...(run.summary === undefined ? {} : { summary: safeText(run.summary, 8192) }),
      ...(run.reason === undefined ? {} : { reason: safeText(diagnosticReason ?? run.reason, 2048), ...(diagnosticReason ? { legacy_terminal_reason: run.reason } : {}) }) };
  }

  workspaceBlockers(workspaceId: string): ReconciliationTarget[] {
    this.ready(); validate(workspace, workspaceId);
    if (workspaceId !== this.targetWorkspaceId) fail("TASK_WORKSPACE_MISMATCH");
    const runs = this.runs.filter(r => r.runtime_id !== this.runtimeId && uncertain(r) && !r.reconciliation);
    if (runs.length > 50) fail("RECONCILIATION_CAPACITY");
    return runs.map(r => this.reconciliationTarget(workspaceId, r.task_id, r.run_id));
  }

  workspaceRecoveryStatus(workspaceId: string, recoveryId?: string): object {
    const blockers = this.workspaceBlockers(workspaceId);
    if (recoveryId) validate(identifier, recoveryId);
    const entry = this.extensions.entries().find(e => e.payload.kind === "recovery" && e.payload.recovery.recovery_id === recoveryId);
    const historical = this.wipSnapshot?.recoveries?.find(r => r.recovery_id === recoveryId);
    const record = entry?.payload.kind === "recovery" ? entry.payload.recovery : historical;
    let committed = entry ? this.extensionCommitted(entry) : false;
    if (!entry && historical) {
      const runs = historical.records.map(t => this.runs.find(r => r.run_id === t.run_id && r.task_id === t.task_id));
      if (runs.every((r): r is SavedRun => r !== undefined)) committed = this.extensionCommitted({ committed: true,
        payload: { kind: "recovery", recovery: historical, bindings: runs.map(r => this.binding(r)),
          reconciled_sha256: historical.state === "recovered" ? runs.map(r => hash(JSON.stringify(r))) : [] } });
    }
    const recovery = record ? (committed ? record : { recovery_id: recoveryId, state: "prepared_uncommitted" }) : undefined;
    if (recoveryId && !recovery) fail("RECONCILIATION_NOT_FOUND");
    return { ...(recovery ?? { state: blockers.length ? "required" : "not_required" }), workspace_id: workspaceId,
      blockers, original_outcome_known: false, original_task_replayed: false,
      quarantine: quarantine(committed ? record?.processes : undefined, committed && record?.state === "recovered" && blockers.length === 0),
      next_action: blockers.length ? "workspace_recovery_start" : "START_NEW_TASK_AFTER_REVIEW" };
  }

  reconciliationProcessContext(workspaceId: string, taskId: string, runId: string): DiagnosticContext["historical"] {
    const run = this.bound(workspaceId, taskId).find(r => r.run_id === runId);
    if (!run) fail("TASK_RECONCILIATION_INVALID");
    // No PID/start/session receipt exists in the canonical journal. These IDs/times are
    // diagnostic context only; updated_at is a logical terminal boundary, not OS exit proof.
    return { workspace_id: workspaceId, run_id: runId, runtime_id: run.runtime_id,
      started_at: run.started_at, ...(run.state !== "running" ? { ended_at: run.updated_at } : {}) };
  }

  recordWorkspaceRecovery(workspaceId: string, id: string, targets: ReconciliationTarget[], state: WorkspaceRecovery["state"],
    code?: WorkspaceRecovery["code"], evidence?: string, approvedAt?: string, processes?: ProcessEvidence): void {
    this.ready();
    if (workspaceId !== this.targetWorkspaceId || this.extensions.entries().some(e => e.payload.kind === "recovery" && e.payload.recovery.recovery_id === id) || this.wipSnapshot?.recoveries?.some(r => r.recovery_id === id)) fail("TASK_RECONCILIATION_INVALID");
    if (this.extensions.entries().filter(e => e.payload.kind === "recovery").length >= 128) fail("TASK_JOURNAL_CAPACITY");
    if (new Set(targets.map(t => t.run_id)).size !== targets.length || targets.some(t => {
      validate(reconciliationTargetSchema, t);
      const run = this.runs.find(r => r.task_id === t.task_id && r.run_id === t.run_id);
      return t.workspace_id !== workspaceId || !run || this.binding(run).source_sha256 !== t.source_record_sha256;
    })) fail("TASK_RECONCILIATION_INVALID");
    const record = validate(recoverySchema, { recovery_id: id, workspace_id: workspaceId, state, code,
      evidence_sha256: evidence, updated_at: new Date().toISOString(), processes,
      records: targets.map(({ task_id, run_id, source_record_sha256 }) => ({ task_id, run_id, source_record_sha256 })) });
    let runs = this.runs;
    if (state === "recovered") {
      if (processes && processes.quiescence !== "QUIESCENT") fail("TASK_RECONCILIATION_INVALID");
      if (JSON.stringify(this.workspaceBlockers(workspaceId)) !== JSON.stringify(targets)) fail("TASK_RECONCILIATION_INVALID");
      validate(sha256, evidence); validate(timestamp, approvedAt);
      const age = Date.now() - Date.parse(approvedAt!);
      if (!Number.isFinite(age) || age < 0 || age > 60_000) fail("TASK_RECONCILIATION_INVALID");
      runs = runs.map(r => {
        const t = targets.find(t => t.run_id === r.run_id);
        return t ? { ...r, reconciliation: { resolution: "allow_new_task_only" as const, source_record_sha256: t.source_record_sha256,
          evidence_sha256: evidence!, owner_approved_at: approvedAt!, reconciled_at: record.updated_at } } : r;
      });
    }
    this.save(runs, this.checkpoints, [record]);
  }

  private recordedExecutionMode(run: SavedRun, strict = false): ExecutionMode | undefined {
    if (!this.extensions.available) {
      if (strict) fail("TASK_EXTENSION_UNAVAILABLE");
      return undefined;
    }
    const entries = this.extensions.entries().filter(e => e.payload.kind === "execution_mode" && e.payload.binding.run_id === run.run_id);
    if (entries.length > 1 || entries.some(e => !this.extensionCommitted(e))) {
      if (strict) fail("TASK_EXECUTION_MODE_UNVERIFIED");
      return undefined;
    }
    const payload = entries[0]?.payload;
    return payload?.kind === "execution_mode" ? payload.execution_mode : undefined;
  }

  /** Historical absence is an unknown mode with a reader ceiling, never writer authority. */
  checkExecutionMode(workspaceId: string, taskId: string, requestedMode?: ExecutionMode): ExecutionMode {
    const mode = requestedMode === undefined ? "read_only" : validate(executionModeSchema, requestedMode);
    const runs = this.bound(workspaceId, taskId);
    if (runs.some(run => (this.recordedExecutionMode(run, true) ?? "read_only") !== mode) ||
        (!runs.length && mode === "workspace_write" && readExecutionRecords(workspaceId, 100).some(r => r.taskId === taskId))) {
      fail("EXECUTION_MODE_MISMATCH");
    }
    return mode;
  }

  checkStart(workspaceId: string, taskId: string, turn: number, instruction: string, executionMode?: ExecutionMode): CodexRunResult | null {
    this.checkExecutionMode(workspaceId, taskId, executionMode);
    const runs = this.bound(workspaceId, taskId);
    validate(iteration, turn);
    const digest = hash(instruction);
    const fence = this.checkpointFence(taskId);
    const saved = runs.find((r) => r.iteration === turn);
    if (saved) {
      if (saved.request_sha256 !== digest) fail("TASK_REQUEST_MISMATCH");
      if (runs.some((r) => r.iteration >= fence && r.reconciliation) || (uncertain(saved) && saved.runtime_id !== this.runtimeId)) fail("TASK_RECOVERY_REQUIRED");
      return this.result(saved);
    }
    const current = runs.filter(r => r.iteration >= fence);
    if (current.some((r) => r.runtime_id !== this.runtimeId)) fail("TASK_RECOVERY_REQUIRED");
    if (!runs.length && readExecutionRecords(workspaceId, 100).some(r => r.taskId === taskId)) fail("TASK_RECOVERY_REQUIRED");
    if (this.runs.some((r) => r.workspace_id === workspaceId && r.runtime_id !== this.runtimeId && uncertain(r) && !r.reconciliation && !(r.task_id === taskId && r.iteration < fence))) throw new TaskJournalError("WORKSPACE_RECOVERY_REQUIRED", "WORKSPACE RECOVERY REQUIRED", this.workspaceRecoveryStatus(workspaceId));
    if (current.some((r) => r.state === "running")) fail("TASK_ALREADY_RUNNING");
    if (runs.length && turn !== Math.max(...runs.map(r => r.iteration)) + 1) fail("INVALID_ITERATION");
    return null;
  }

  private checkpointFence(taskId: string): number {
    return this.checkpoints.filter(c => c.task_id === taskId && c.consumed_run_id && c.status === "consumed" && c.runtime_id === this.runtimeId)
      .reduce((n, c) => Math.max(n, c.next_iteration), 0);
  }

  /** Trusted controller only. Reads observed history, never imports historical instructions. */
  checkpointTarget(workspaceId: string, taskId: string, next: number, instruction: string,
    missing?: { iteration: number; run_id: string }): CheckpointTarget {
    const runs = this.bound(workspaceId, taskId);
    validate(iteration, next);
    if (!instruction || Buffer.byteLength(instruction) > 16 * 1024) fail("TASK_JOURNAL_INVALID");
    if (missing) validate(missingRunSchema, missing);
    if (!this.ownsLock() || this.read(this.file, MAX_BYTES) !== this.diskSnapshot) fail("TASK_JOURNAL_UNAVAILABLE");
    if (this.runs.some(r => r.workspace_id === workspaceId && r.task_id !== taskId && uncertain(r) && !r.reconciliation)) fail("WORKSPACE_RECOVERY_REQUIRED");
    if (runs.some(r => r.runtime_id === this.runtimeId && (r.state === "running" || uncertain(r)))) fail("TASK_RECOVERY_REQUIRED");
    const snapshot = runs.length ? undefined : readLegacySnapshot(workspaceId, taskId);
    const legacy = snapshot?.records ?? [];
    const identities = runs.length ? runs.map(r => ({ iteration: r.iteration, run_id: r.run_id })) :
      legacy.map(r => ({ iteration: r.iteration, run_id: r.runId ?? null }));
    if (!identities.length) fail("TASK_NOT_FOUND");
    const high = Math.max(...identities.map(r => r.iteration));
    if (next !== high + (missing ? 2 : 1) || (missing && (missing.iteration !== high + 1 ||
        identities.some(r => r.run_id === missing.run_id) || this.runs.some(r => r.run_id === missing.run_id)))) fail("INVALID_ITERATION");
    const excerpt = redactAndTruncate(instruction, 2048);
    return validate(checkpointTargetSchema, { workspace_id: workspaceId, task_id: taskId, next_iteration: next,
      source: runs.length ? "journal" : "legacy_execution_records", source_sha256: snapshot?.sha256 ?? hash(JSON.stringify(runs)),
      known_records: identities, ...(missing ? { reported_missing_run: { ...missing, provenance: "user_reported_unknown" } } : {}),
      request_sha256: hash(instruction), instruction_excerpt: excerpt.text, instruction_truncated: excerpt.truncated });
  }

  private recheckCheckpoint(target: CheckpointTarget, instruction: string): void {
    validate(checkpointTargetSchema, target);
    const m = target.reported_missing_run;
    const current = this.checkpointTarget(target.workspace_id, target.task_id, target.next_iteration, instruction,
      m ? { iteration: m.iteration, run_id: m.run_id } : undefined);
    if (JSON.stringify(current) !== JSON.stringify(target)) fail("CHECKPOINT_SOURCE_CHANGED");
  }

  approveCheckpoint(target: CheckpointTarget, instruction: string, evidence: string, approvedAt: string, id: string): void {
    this.recheckCheckpoint(target, instruction);
    const age = Date.now() - Date.parse(approvedAt);
    if (!Number.isFinite(age) || age < 0 || age > 60_000) fail("OWNER_APPROVAL_EXPIRED");
    if (this.checkpoints.some(c => c.checkpoint_id === id || (c.task_id === target.task_id && c.status === "approved" && c.runtime_id === this.runtimeId && Date.parse(c.expires_at) > Date.now()))) fail("CHECKPOINT_EXISTS");
    const checkpoint = validate(checkpointSchema, { ...target, checkpoint_id: id, runtime_id: this.runtimeId,
      evidence_sha256: evidence, owner_approved_at: approvedAt, expires_at: new Date(Date.parse(approvedAt) + 60_000).toISOString(), status: "approved" });
    this.save(this.runs, [...this.checkpoints, checkpoint]);
  }

  approvedCheckpoint(workspaceId: string, taskId: string, next: number, instruction: string): Checkpoint {
    this.bound(workspaceId, taskId);
    const c = [...this.checkpoints].reverse().find(c => c.task_id === taskId && c.next_iteration === next && c.status === "approved");
    if (!c || c.runtime_id !== this.runtimeId || Date.now() >= Date.parse(c.expires_at)) fail("CHECKPOINT_UNAVAILABLE");
    if (c.request_sha256 !== hash(instruction)) fail("TASK_REQUEST_MISMATCH");
    const { checkpoint_id, runtime_id, evidence_sha256, owner_approved_at, expires_at, status, consumed_run_id, consumed_action_id, ...target } = c;
    this.recheckCheckpoint(target, instruction);
    return structuredClone(c);
  }

  beginCheckpoint(workspaceId: string, run: CodexRunResult, instruction: string, checkpointId: string, evidence: string): void {
    const executionMode = this.checkExecutionMode(workspaceId, run.task_id, run.execution_mode);
    const c = this.approvedCheckpoint(workspaceId, run.task_id, run.iteration, instruction);
    if (c.checkpoint_id !== checkpointId || c.evidence_sha256 !== evidence || run.state !== "running" || this.runs.some(r => r.run_id === run.run_id)) fail("CHECKPOINT_INVALID");
    const now = new Date().toISOString();
    const saved = validate(runSchema, { task_id: run.task_id, workspace_id: workspaceId, iteration: run.iteration,
      run_id: run.run_id, state: "running", runtime_id: this.runtimeId, instruction_excerpt: c.instruction_excerpt,
      instruction_truncated: c.instruction_truncated, request_sha256: c.request_sha256, started_at: now, updated_at: now });
    this.save([...this.runs, { ...saved, execution_mode: executionMode }], this.checkpoints.map(entry => entry.checkpoint_id === checkpointId ?
      { ...entry, status: "consumed", consumed_run_id: run.run_id } : entry));
  }

  consumeCheckpointAction(workspaceId: string, taskId: string, next: number, instruction: string,
    checkpointId: string, evidence: string, actionId: string): void {
    validate(identifier, actionId);
    const c = this.approvedCheckpoint(workspaceId, taskId, next, instruction);
    if (c.checkpoint_id !== checkpointId || c.evidence_sha256 !== evidence) fail("CHECKPOINT_INVALID");
    this.save(this.runs, this.checkpoints.map(entry => entry.checkpoint_id === checkpointId ?
      { ...entry, status: "consumed", consumed_action_id: actionId } : entry));
  }

  revokeCheckpoints(): void {
    if (this.checkpoints.some(c => c.status === "approved")) this.save(this.runs, this.checkpoints.map(c => c.status === "approved" ? { ...c, status: "revoked" } : c));
  }

  hasCheckpoint(workspaceId: string, taskId: string, next: number): boolean {
    const runs = this.bound(workspaceId, taskId);
    return !runs.some(r => r.iteration === next) && this.checkpoints.some(c => c.task_id === taskId && c.next_iteration === next && c.status === "approved");
  }

  checkpointStatus(workspaceId: string, taskId: string): object[] {
    this.bound(workspaceId, taskId);
    return this.checkpoints.filter(c => c.task_id === taskId).map(c => ({ checkpoint_id: c.checkpoint_id,
      next_iteration: c.next_iteration, status: c.status === "approved" && (c.runtime_id !== this.runtimeId || Date.now() >= Date.parse(c.expires_at)) ? "expired" : c.status,
      reported_missing_run: c.reported_missing_run, original_context_restored: false, outcome_known: false }));
  }

  begin(workspaceId: string, run: CodexRunResult, instruction: string): void {
    validate(identifier, run.run_id);
    const executionMode = validate(executionModeSchema.default("read_only"), run.execution_mode);
    if (this.checkStart(workspaceId, run.task_id, run.iteration, instruction, executionMode) || this.runs.some((r) => r.run_id === run.run_id)) fail("TASK_RUN_EXISTS");
    if (run.state !== "running" || run.summary !== undefined || run.reason !== undefined) fail("TASK_JOURNAL_INVALID");
    const excerpt = redactAndTruncate(instruction, 2048);
    const now = new Date().toISOString();
    this.save([...this.runs, { task_id: run.task_id, workspace_id: workspaceId, iteration: run.iteration,
      execution_mode: executionMode,
      run_id: run.run_id, state: "running", runtime_id: this.runtimeId, instruction_excerpt: excerpt.text,
      instruction_truncated: excerpt.truncated, request_sha256: hash(instruction), started_at: now, updated_at: now }]);
  }

  private notificationReservation(run: CodexRunResult, eventId: string) {
    if (run.state === "running" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(eventId) || /[\r\n]/.test(eventId)) fail("TASK_JOURNAL_INVALID");
    return { event_id: eventId, state: run.state, reason: noticeCategory(run.state, run.reason),
      created_at: new Date().toISOString(), kind: run.state === "completed" ? "completion" as const : "owner_attention" as const };
  }

  recordNotification(workspaceId: string, run: CodexRunResult, eventId: string): boolean {
    const saved = this.bound(workspaceId, run.task_id).find(r => r.run_id === run.run_id && r.iteration === run.iteration);
    if (!saved) fail("RUN_NOT_FOUND");
    // Existing reservations survive runtime changes; they never restore a live channel.
    const events = this.runExtensions(saved).notifications;
    const existing = events.find(e => e.event_id === eventId);
    if (existing) {
      if (existing.state !== run.state || noticeCategory(existing.state, existing.reason) !== noticeCategory(run.state, run.reason)) fail("TASK_RESULT_MISMATCH");
      return false;
    }
    if (events.length >= 34) fail("TASK_JOURNAL_CAPACITY");
    if (this.extensions.entries().some(e => e.payload.kind === "notification" && e.payload.binding.run_id === saved.run_id && e.payload.reservation.event_id === eventId)) fail("TASK_EXTENSION_PENDING");
    if (saved.runtime_id !== this.runtimeId) fail("TASK_RECOVERY_REQUIRED");
    this.save(this.runs.map(r => r === saved ? { ...saved, notifications: [this.notificationReservation(run, eventId)] } : r));
    return true;
  }

  private notificationEntry(run: SavedRun, eventId: string) {
    this.extensions.assertWritable();
    if (!this.ownsLock() || this.read(this.file, MAX_BYTES) !== this.diskSnapshot) fail("TASK_JOURNAL_UNAVAILABLE");
    const entry = this.extensions.entries().find(e => e.payload.kind === "notification" &&
      e.payload.binding.run_id === run.run_id && e.payload.reservation.event_id === eventId && this.extensionCommitted(e));
    if (!entry || entry.payload.kind !== "notification") fail("TASK_EXTENSION_PENDING");
    return { id: entry.id,
      notification_id: notificationId(run.workspace_id, run.run_id, eventId) };
  }

  private notificationObservations(run: SavedRun, eventId: string) {
    return this.extensions.entries().flatMap(e => e.payload.kind === "notification_dispatch" &&
      e.payload.binding.run_id === run.run_id && e.payload.dispatch.event_id === eventId && this.extensionCommitted(e)
      ? [e.payload.dispatch] : []);
  }

  recordNotificationDispatch(workspaceId: string, run: CodexRunResult, eventId: string,
    observation: Extract<Extension, { kind: "notification_dispatch" }>["dispatch"]["observation"]): boolean | number {
    const saved = this.bound(workspaceId, run.task_id).find(r => r.run_id === run.run_id && r.iteration === run.iteration);
    if (!saved) fail("RUN_NOT_FOUND");
    const event = this.notificationEntry(saved, eventId);
    const prior = this.notificationObservations(saved, eventId);
    if (prior.some(e => e.observation.outcome === "notice_acknowledged")) return false;
    const delivery = readNoticeDelivery(event.notification_id, event.id);
    const now = new Date().toISOString();
    const intent = observation.outcome === "dispatch_intent";
    if (intent) {
      if (delivery && Date.parse(delivery.observed_at) <= Date.now() && Date.parse(delivery.next_attempt_at) > Date.now()) return false;
    } else if (!delivery || delivery.observation.outcome !== "dispatch_intent") fail("TASK_EXTENSION_PENDING");
    // Only the first intent and explicit receipt belong in the append-only ledger.
    // Reuse prepared evidence after a commit failure; retries cannot fill the ledger.
    if (observation.outcome === "notice_acknowledged" || intent && !prior.some(e => e.observation.outcome === "dispatch_intent")) {
      const prepared = this.extensions.entries().find(e => e.payload.kind === "notification_dispatch" &&
        e.payload.binding.run_id === saved.run_id && e.payload.dispatch.event_id === eventId &&
        e.payload.dispatch.observation.outcome === observation.outcome && this.extensionCommitted({ ...e, committed: true }));
      const id = prepared?.id ?? this.extensions.prepare({ kind: "notification_dispatch", binding: this.binding(saved),
        dispatch: { event_id: eventId, observation, observed_at: now } });
      this.extensions.commit([id]);
    }
    const attempts = intent ? Math.min(1_000_000, (delivery?.attempts ?? 0) + 1) : delivery!.attempts;
    writeNoticeDelivery({ version: 1, notification_id: event.notification_id, reservation_sha256: event.id,
      attempts, next_attempt_at: new Date(Date.parse(now) + deliveryDelay(attempts)).toISOString(), observed_at: now, observation });
    if (intent) return attempts;
    return true;
  }

  /** Repair only an explicitly prepared terminal event whose canonical terminal write landed.
   * Historical terminal runs without an event are deliberately not backfilled.
   * This commits notice evidence only, never execution/reconciliation/approval evidence.
   */
  recoverNotificationEvents(): void {
    this.ready(); this.extensions.assertWritable();
    if (!this.ownsLock() || this.read(this.file, MAX_BYTES) !== this.diskSnapshot) fail("TASK_JOURNAL_UNAVAILABLE");
    const ids = this.extensions.entries().filter(e => !e.committed && e.payload.kind === "notification" &&
      e.payload.reservation.event_id === "terminal" && this.runs.some(r => r.state !== "running" &&
        e.payload.kind === "notification" && r.state === e.payload.reservation.state &&
        this.binding(r).source_sha256 === e.payload.binding.source_sha256 &&
        this.extensionCommitted({ ...e, committed: true }))).map(e => e.id);
    this.extensions.commit(ids);
  }

  pendingNotifications(): Array<{ run: CodexRunResult; eventId: string }> {
    this.ready(); this.extensions.assertWritable();
    return this.runs.flatMap(saved => this.runExtensions(saved).notifications.flatMap(reservation => {
      if (this.notificationObservations(saved, reservation.event_id).some(e => e.observation.outcome === "notice_acknowledged")) return [];
      // Reconstruct only the bounded notice, never live pending inputs or approval payloads.
      return [{ run: { task_id: saved.task_id, iteration: saved.iteration, run_id: saved.run_id,
        state: reservation.state, reason: noticeCategory(reservation.state, reservation.reason) }, eventId: reservation.event_id }];
    }));
  }

  private notificationEvidence(run: SavedRun) {
    return this.runExtensions(run).notifications.map(reservation => {
      const notification_id = notificationId(run.workspace_id, run.run_id, reservation.event_id);
      const observations = this.notificationObservations(run, reservation.event_id);
      const acknowledged = observations.some(e => e.observation.outcome === "notice_acknowledged");
      let delivery = null, delivery_evidence_available = true;
      try {
        const entry = this.notificationEntry(run, reservation.event_id);
        delivery = readNoticeDelivery(notification_id, entry.id);
      } catch { delivery_evidence_available = false; }
      if (delivery && !acknowledged && (delivery.observation.outcome !== "dispatch_intent" || observations.length === 0)) observations.push({ event_id: reservation.event_id,
        observed_at: delivery.observed_at, observation: delivery.observation });
      return { ...reservation, global_event_id: notification_id, notification_id,
        workspace_id: run.workspace_id, task_id: run.task_id, run_id: run.run_id, iteration: run.iteration,
        execution_mode: this.recordedExecutionMode(run) ?? "unknown", category: noticeCategory(reservation.state, reservation.reason),
        reservation: "committed", dispatch: observations.some(e => e.observation.outcome !== "dispatch_intent") ? "local_outcome_recorded"
          : observations.length ? "intent_recorded_outcome_unknown" : "not_observed",
        observations, delivery, delivery_evidence_available, os_presentation: "unknown", user_receipt: acknowledged ? "notice_acknowledged" : "unknown",
        presentation_policy: "persistent_until_acknowledgement", notice_acknowledgement: acknowledged ? "acknowledged" : "pending",
        acknowledgement_grants_authority: false, automatic_host_reentry: false,
        automatic_retry: false, automatic_delivery_retry: !acknowledged, goal_verified: false,
        handoff: { tool: "task_resume_context", arguments: { workspace_id: run.workspace_id, task_id: run.task_id },
          run_id: run.run_id, revalidate_live_channel: true, grants_authority: false,
          status_read: { tool: "codex_turn_approval_status", arguments: { workspace_id: run.workspace_id, task_id: run.task_id, run_id: run.run_id },
            requires_registered_authorized_tool: true } } };
    });
  }

  complete(workspaceId: string, run: CodexRunResult): void {
    if (run.execution_mode !== undefined) this.checkExecutionMode(workspaceId, run.task_id, run.execution_mode);
    const runs = this.bound(workspaceId, run.task_id);
    validate(identifier, run.run_id); validate(iteration, run.iteration);
    if (!runs.length) fail("TASK_NOT_FOUND");
    const saved = runs.find((r) => r.run_id === run.run_id && r.iteration === run.iteration);
    if (!saved) fail("RUN_NOT_FOUND");
    if (!["completed", "blocked", "failed"].includes(run.state)) fail("TASK_JOURNAL_INVALID");
    // Pending input is a live presentation, not a terminal outcome. Keep the
    // write-ahead record; never persist questions or a runtime-only reply token.
    if (run.state === "blocked" && (run.reason === "user_input_required" || run.reason === "mcp_elicitation_required" && run.resumable === true)) {
      if (saved.runtime_id !== this.runtimeId) fail("TASK_RECOVERY_REQUIRED");
      if (saved.state !== "running" || run.resumable !== true) fail("TASK_JOURNAL_INVALID");
      return;
    }
    const terminal: CodexRunResult = {
      ...(run.approval_diagnostic === undefined ? {} : { approval_diagnostic: validate(approvalDiagnosticSchema, run.approval_diagnostic) }), task_id: run.task_id, iteration: run.iteration, run_id: run.run_id, state: run.state,
      ...(run.summary === undefined ? {} : { summary: safeText(run.summary, 8192) }),
      // New transport-failure names must not look like known outcomes to r32.
      ...(run.reason === undefined ? {} : { reason: safeText(run.elicitation_evidence && run.state === "failed" ? "protocol_write_failed" : run.reason, 2048) }) };
    if (saved.state !== "running") {
      const { execution_mode, checkpoint_continuation, original_context_restored, resumable, approval_diagnostic_available, elicitation_history, legacy_terminal_reason, ...savedTerminal } = this.result(saved);
      if (legacy_terminal_reason) savedTerminal.reason = legacy_terminal_reason;
      if (!isDeepStrictEqual(savedTerminal, terminal)) fail("TASK_RESULT_MISMATCH");
      return;
    }
    if (saved.runtime_id !== this.runtimeId) fail("TASK_RECOVERY_REQUIRED");
    try {
      const events = this.runExtensions(saved).notifications;
      const existing = events.find(e => e.event_id === "terminal");
      if (existing && (existing.state !== run.state || noticeCategory(existing.state, existing.reason) !== noticeCategory(run.state, run.reason))) fail("TASK_RESULT_MISMATCH");
      if (!existing && events.length >= 34) fail("TASK_JOURNAL_CAPACITY");
      this.save(this.runs.map((r) => r === saved ? { ...saved, ...terminal, updated_at: new Date().toISOString(),
        notifications: existing ? [] : [this.notificationReservation(run, "terminal")] } : r));
    } catch {
      this.healthy = false;
      fail("TASK_JOURNAL_UNAVAILABLE");
    }
  }

  recoveredRun(workspaceId: string, taskId: string, runId: string): CodexRunResult | null {
    const runs = this.bound(workspaceId, taskId); validate(identifier, runId);
    if (!runs.length) fail("TASK_NOT_FOUND");
    const saved = runs.find((r) => r.run_id === runId);
    if (!saved) fail("RUN_NOT_FOUND");
    if (runs.some((r) => r.iteration >= this.checkpointFence(taskId) && r.reconciliation) || (saved.runtime_id !== this.runtimeId && uncertain(saved))) fail("TASK_RECOVERY_REQUIRED");
    if (saved.state !== "running") return this.result(saved);
    if (saved.runtime_id !== this.runtimeId) fail("TASK_RECOVERY_REQUIRED");
    return null;
  }

  reconciliationTarget(workspaceId: string, taskId: string, runId: string): ReconciliationTarget {
    const runs = this.bound(workspaceId, taskId);
    validate(identifier, runId);
    try {
      if (!this.ownsLock() || this.read(this.file, MAX_BYTES) !== this.diskSnapshot) throw new Error("Journal changed");
    } catch { this.healthy = false; fail("TASK_JOURNAL_UNAVAILABLE"); }
    if (!runs.length) fail("TASK_NOT_FOUND");
    const saved = runs.find((r) => r.run_id === runId);
    if (!saved) fail("RUN_NOT_FOUND");
    if (saved.runtime_id === this.runtimeId || !uncertain(saved) || saved.reconciliation) fail("TASK_RECONCILIATION_INVALID");
    if (this.runs.some((r) => r.workspace_id === workspaceId && r.runtime_id === this.runtimeId && r.state === "running")) fail("WORKSPACE_BUSY");
    return { workspace_id: workspaceId, task_id: taskId, run_id: runId, source_record_sha256: hash(JSON.stringify(saved)) };
  }

  /** Internal trusted local controller API; never an MCP/model approval flag. */
  reconcileConfirmed(target: ReconciliationTarget, evidenceSha256: string, ownerApprovedAt: string): void {
    validate(reconciliationTargetSchema, target);
    const current = this.reconciliationTarget(target.workspace_id, target.task_id, target.run_id);
    if (current.source_record_sha256 !== target.source_record_sha256) fail("TASK_RECONCILIATION_INVALID");
    validate(sha256, evidenceSha256); validate(timestamp, ownerApprovedAt);
    const now = Date.now();
    const age = now - Date.parse(ownerApprovedAt);
    if (!Number.isFinite(age) || age < 0 || age > 60_000) fail("TASK_RECONCILIATION_INVALID");
    const reconciliation = { resolution: "allow_new_task_only" as const,
      source_record_sha256: current.source_record_sha256, evidence_sha256: evidenceSha256,
      owner_approved_at: ownerApprovedAt, reconciled_at: new Date(now).toISOString() };
    // r32 supports reconciliation; its hash binds canonical main bytes only.
    try {
      this.save(this.runs.map((r) => r.run_id === current.run_id ? { ...r, reconciliation } : r));
    } catch { this.healthy = false; fail("TASK_JOURNAL_UNAVAILABLE"); }
  }

  /** Terminal transport outcome is separate from workspace safety and goal verification. */
  observedTaskOutcome(workspaceId: string, taskId: string, runId?: string) {
    this.ready(); validate(workspace, workspaceId);
    const runs = this.bound(workspaceId, taskId);
    const run = runId === undefined ? runs.at(-1) : runs.find(r => r.run_id === runId);
    if (!run) return { known: false as const, state: "unknown", run_id: null, reason: null };
    const interrupted = run.runtime_id !== this.runtimeId && uncertain(run);
    return { known: !interrupted && run.state !== "running", state: interrupted ? "interrupted" : run.state,
      run_id: run.run_id, reason: run.reason ?? null };
  }

  status(workspaceId: string, taskId?: string, limit = 10): object {
    this.ready(); validate(workspace, workspaceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("TASK_JOURNAL_INVALID");
    const selected = taskId === undefined ? this.runs : this.bound(workspaceId, taskId);
    if (taskId !== undefined && selected.length === 0) fail("TASK_NOT_FOUND");
    const latest = new Map<string, SavedRun>();
    for (const run of selected) if (run.workspace_id === workspaceId) latest.set(run.task_id, run);
    return { workspace_id: workspaceId, extension_storage: { available: this.extensions.available,
      migration_required: this.wipSnapshot !== undefined,
      prepared_uncommitted: this.extensions.entries().filter(e => !this.extensionCommitted(e)).length },
      tasks: [...latest.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.started_at.localeCompare(a.started_at)).slice(0, limit).map((run) => {
      const previous = run.runtime_id !== this.runtimeId;
      const interrupted = previous && uncertain(run);
      const { state: _state, ...result } = this.result(run);
      return { ...result, workspace_id: run.workspace_id, checkpoints: this.checkpointStatus(workspaceId, run.task_id),
        notifications: this.notificationEvidence(run),
        notification_evidence_available: this.extensions.available,
        notification_prepared_evidence: this.extensions.entries().flatMap(e => {
          const p = e.payload;
          return (p.kind === "notification" || p.kind === "notification_dispatch") && p.binding.run_id === run.run_id &&
            !e.committed && this.extensionCommitted({ ...e, committed: true })
            ? [{ id: e.id, kind: p.kind, classification: "prepared_uncommitted", evidence: p.kind === "notification" ? p.reservation : p.dispatch,
                resumable: false, delivery_proven: false, automatic_retry: false }] : [];
        }),
        execution_state: interrupted ? "interrupted" : run.state, outcome_known: !interrupted && run.state !== "running",
        instruction_excerpt: safeText(run.instruction_excerpt, 2048), instruction_truncated: run.instruction_truncated,
        request_sha256: run.request_sha256, started_at: run.started_at, updated_at: run.updated_at,
        from_previous_runtime: previous, requires_reconciliation: interrupted && !run.reconciliation,
        ...(run.reconciliation ? { reconciliation: { ...run.reconciliation } } : {}),
        ...(previous ? { can_resume_original_context: false } : {}), tests: null, review: "not_recorded", goal_status: "unverified",
        next_action: run.reconciliation ? "START_NEW_TASK_AFTER_REVIEW" : interrupted ? "RECONCILE_INTERRUPTED_RUN" : run.state === "running" ? "WAIT_FOR_RUN" : previous ? "INSPECT_SAVED_RESULT" : "INSPECT_RESULT" };
    }) };
  }

  private ownsLock(): boolean {
    if (!this.lockIdentity) return false;
    const stat = fs.lstatSync(this.lock);
    return !stat.isSymbolicLink() && stat.ino === this.lockIdentity.ino && stat.dev === this.lockIdentity.dev && this.read(this.lock, 1024) === JSON.stringify({ pid: process.pid, nonce: this.nonce });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.checkParents(); if (this.ownsLock()) { fs.unlinkSync(this.lock); this.syncDirectory(); } }
    catch { /* Never remove an unverified lock. */ }
  }
}
