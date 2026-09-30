import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { redactAndTruncate } from "../security/redaction.js";
import type { CodexRunResult } from "../codex/app-server.js";

const MAX_BYTES = 4 * 1024 * 1024;
const workspace = z.string().regex(/^[a-f0-9]{24}$/);
const task = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const iteration = z.number().int().min(1).max(12);
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
type SavedRun = z.infer<typeof runSchema>;
const snapshotSchema = z.object({ version: z.literal(1), runs: z.array(runSchema).max(4000) }).strict();
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
  constructor(public readonly code: string, message: string) { super(message); this.name = "TaskJournalError"; }
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
  return run.state === "running" || (run.state === "failed" && [
    "bridge_stopped", "turn_timeout", "turn_start_failed", "child_exit", "child_error",
    "protocol_write_failed", "malformed_protocol", "oversized_protocol_line",
  ].includes(run.reason ?? ""));
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
      const parsed = snapshotSchema.safeParse(value);
      if (!parsed.success) reject("TASK_JOURNAL_LAYOUT_INVALID", "Journal schema is invalid; preserve records for offline review.");
      const snapshot = parsed.data!;
      const targetId = name.slice(0, -5);
      if (snapshot.runs.some(r => r.workspace_id !== targetId)) {
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
  private diskSnapshot: string | null = null;
  private healthy = true;
  private closed = false;

  constructor(targetWorkspaceId: string) {
    validate(workspace, targetWorkspaceId);
    this.dir = path.join(getStateDir(), "task-journal");
    this.file = path.join(this.dir, `${targetWorkspaceId}.json`);
    this.lock = path.join(this.dir, `${targetWorkspaceId}.lock`);
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
        validate(snapshotSchema, snapshot);
        // Preserve source record property order for JSON.stringify-based evidence hashes.
        this.runs = snapshot.runs;
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

  private save(runs: SavedRun[]): void {
    this.ready();
    this.validateRecords(runs);
    const content = JSON.stringify({ version: 1, runs });
    if (Buffer.byteLength(content) > MAX_BYTES) fail("TASK_JOURNAL_CAPACITY");
    const temp = `${this.file}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      this.checkParents();
      if (!this.ownsLock()) throw new Error("Lost lock");
      if (this.read(this.file, MAX_BYTES) !== this.diskSnapshot) throw new Error("Journal changed outside this writer");
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, this.file);
      this.syncDirectory();
      this.runs = runs;
      this.diskSnapshot = content;
    } catch { this.healthy = false; fail("TASK_JOURNAL_UNAVAILABLE"); }
    finally { try { fs.unlinkSync(temp); } catch { /* Already renamed or unavailable. */ } }
  }

  private bound(workspaceId: string, taskId: string): SavedRun[] {
    this.ready(); validate(workspace, workspaceId); validate(task, taskId);
    const runs = this.runs.filter((r) => r.task_id === taskId);
    if (runs.some((r) => r.workspace_id !== workspaceId)) fail("TASK_WORKSPACE_MISMATCH");
    return runs;
  }

  private result(run: SavedRun): CodexRunResult {
    return { task_id: run.task_id, iteration: run.iteration, run_id: run.run_id, state: run.state,
      ...(run.summary === undefined ? {} : { summary: safeText(run.summary, 8192) }),
      ...(run.reason === undefined ? {} : { reason: safeText(run.reason, 2048) }) };
  }

  checkStart(workspaceId: string, taskId: string, turn: number, instruction: string): CodexRunResult | null {
    const runs = this.bound(workspaceId, taskId);
    validate(iteration, turn);
    const digest = hash(instruction);
    const saved = runs.find((r) => r.iteration === turn);
    if (saved) {
      if (saved.request_sha256 !== digest) fail("TASK_REQUEST_MISMATCH");
      if (runs.some((r) => r.reconciliation) || (uncertain(saved) && saved.runtime_id !== this.runtimeId)) fail("TASK_RECOVERY_REQUIRED");
      return this.result(saved);
    }
    if (runs.some((r) => r.runtime_id !== this.runtimeId)) fail("TASK_RECOVERY_REQUIRED");
    if (this.runs.some((r) => r.workspace_id === workspaceId && r.runtime_id !== this.runtimeId && uncertain(r) && !r.reconciliation)) fail("WORKSPACE_RECOVERY_REQUIRED");
    if (runs.some((r) => r.state === "running")) fail("TASK_ALREADY_RUNNING");
    return null;
  }

  begin(workspaceId: string, run: CodexRunResult, instruction: string): void {
    validate(identifier, run.run_id);
    if (this.checkStart(workspaceId, run.task_id, run.iteration, instruction) || this.runs.some((r) => r.run_id === run.run_id)) fail("TASK_RUN_EXISTS");
    if (run.state !== "running" || run.summary !== undefined || run.reason !== undefined) fail("TASK_JOURNAL_INVALID");
    const excerpt = redactAndTruncate(instruction, 2048);
    const now = new Date().toISOString();
    this.save([...this.runs, { task_id: run.task_id, workspace_id: workspaceId, iteration: run.iteration,
      run_id: run.run_id, state: "running", runtime_id: this.runtimeId, instruction_excerpt: excerpt.text,
      instruction_truncated: excerpt.truncated, request_sha256: hash(instruction), started_at: now, updated_at: now }]);
  }

  complete(workspaceId: string, run: CodexRunResult): void {
    const runs = this.bound(workspaceId, run.task_id);
    validate(identifier, run.run_id); validate(iteration, run.iteration);
    if (!runs.length) fail("TASK_NOT_FOUND");
    const saved = runs.find((r) => r.run_id === run.run_id && r.iteration === run.iteration);
    if (!saved) fail("RUN_NOT_FOUND");
    if (!["completed", "blocked", "failed"].includes(run.state)) fail("TASK_JOURNAL_INVALID");
    const terminal: CodexRunResult = { task_id: run.task_id, iteration: run.iteration, run_id: run.run_id, state: run.state,
      ...(run.summary === undefined ? {} : { summary: safeText(run.summary, 8192) }),
      ...(run.reason === undefined ? {} : { reason: safeText(run.reason, 2048) }) };
    if (saved.state !== "running") {
      if (JSON.stringify(this.result(saved)) !== JSON.stringify(terminal)) fail("TASK_RESULT_MISMATCH");
      return;
    }
    if (saved.runtime_id !== this.runtimeId) fail("TASK_RECOVERY_REQUIRED");
    try {
      this.save(this.runs.map((r) => r === saved ? { ...saved, ...terminal, updated_at: new Date().toISOString() } : r));
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
    if (runs.some((r) => r.reconciliation) || (saved.runtime_id !== this.runtimeId && uncertain(saved))) fail("TASK_RECOVERY_REQUIRED");
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
    // Version 1 accepts absent metadata, but older strict readers must reject this extension.
    try {
      this.save(this.runs.map((r) => r.run_id === current.run_id ? { ...r, reconciliation } : r));
    } catch { this.healthy = false; fail("TASK_JOURNAL_UNAVAILABLE"); }
  }

  status(workspaceId: string, taskId?: string, limit = 10): object {
    this.ready(); validate(workspace, workspaceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("TASK_JOURNAL_INVALID");
    const selected = taskId === undefined ? this.runs : this.bound(workspaceId, taskId);
    if (taskId !== undefined && selected.length === 0) fail("TASK_NOT_FOUND");
    const latest = new Map<string, SavedRun>();
    for (const run of selected) if (run.workspace_id === workspaceId) latest.set(run.task_id, run);
    return { workspace_id: workspaceId, tasks: [...latest.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.started_at.localeCompare(a.started_at)).slice(0, limit).map((run) => {
      const previous = run.runtime_id !== this.runtimeId;
      const interrupted = previous && uncertain(run);
      const { state: _state, ...result } = this.result(run);
      return { ...result, workspace_id: run.workspace_id,
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
