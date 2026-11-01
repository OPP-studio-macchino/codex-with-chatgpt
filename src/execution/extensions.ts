import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v3";
import { getStateDir } from "../config/paths.js";
import { checkPrivateParents, privateMode, readPrivateFile, syncPrivateDirectory, writePrivateFile } from "../security/stable-file.js";
import { approvalDiagnosticSchema } from "../codex/approval-diagnostic.js";
import { elicitationEvidenceSchema } from "../codex/mcp-elicitation.js";
import { executionModeSchema } from "../codex/execution-mode.js";
import { processEvidenceSchema, reconciliationCodeSchema } from "./reconciliation-processes.js";

const id = z.string().regex(/^[a-f0-9]{32}$/);
const sha = z.string().regex(/^[a-fA-F0-9]{64}$/);
const workspace = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const task = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const bounded = (n: number) => z.string().refine(s => Buffer.byteLength(s) <= n);
export const notificationSchema = z.object({ event_id: bounded(256), state: z.enum(["completed", "blocked", "failed"]),
  reason: bounded(2048).optional(), created_at: z.string().datetime(), kind: z.enum(["completion", "owner_attention"]) }).strict();
export const notificationOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("process_exit"), exit_code: z.number().int().nullable() }).strict(),
  z.object({ outcome: z.literal("notice_acknowledged") }).strict(),
  z.object({ outcome: z.enum(["process_error", "timeout", "unavailable"]) }).strict(),
]);
export type NotificationOutcome = z.infer<typeof notificationOutcomeSchema>;
const notificationDispatchSchema = z.object({ event_id: bounded(256), observed_at: z.string().datetime(),
  observation: z.union([z.object({ outcome: z.literal("dispatch_intent") }).strict(), notificationOutcomeSchema]) }).strict();
export const recoverySchema = z.object({ recovery_id: id, workspace_id: z.string().regex(/^[a-f0-9]{24}$/),
  state: z.enum(["recovered", "denied", "blocked", "cancelled"]),
  code: reconciliationCodeSchema.optional(),
  processes: processEvidenceSchema.optional(),
  evidence_sha256: sha.optional(), updated_at: z.string().datetime(),
  records: z.array(z.object({ task_id: task, run_id: id, source_record_sha256: sha }).strict()).min(1).max(50),
}).strict();
const bindingSchema = z.object({ workspace_id: z.string().regex(/^[a-f0-9]{24}$/), task_id: task, run_id: id, iteration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  runtime_id: id, request_sha256: sha, source_sha256: sha }).strict();
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execution_mode"), binding: bindingSchema, execution_mode: executionModeSchema }).strict(),
  z.object({ kind: z.literal("elicitation"), binding: bindingSchema, evidence: elicitationEvidenceSchema,
    phase: z.enum(["captured", "pending", "response_attempted", "write_acknowledged", "channel_closed"]),
    observed_at: z.string().datetime(), action: z.enum(["accept", "decline", "cancel"]).optional(), reason: bounded(128).optional() }).strict(),
  z.object({ kind: z.literal("diagnostic"), binding: bindingSchema, diagnostic: approvalDiagnosticSchema }).strict(),
  z.object({ kind: z.literal("notification"), binding: bindingSchema, reservation: notificationSchema }).strict(),
  z.object({ kind: z.literal("notification_dispatch"), binding: bindingSchema, dispatch: notificationDispatchSchema }).strict(),
  z.object({ kind: z.literal("recovery"), recovery: recoverySchema, bindings: z.array(bindingSchema).min(1).max(50),
    reconciled_sha256: z.array(sha).max(50) }).strict(),
  z.object({ kind: z.literal("execution_diagnostic"), task_id: task, run_id: id.optional(), iteration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    record_sha256: sha, diagnostic: approvalDiagnosticSchema }).strict(),
]);
export type Extension = z.infer<typeof payloadSchema>;
const entrySchema = z.object({ id: sha, payload: payloadSchema }).strict();
const ledgerSchema = z.object({ version: z.literal(1), workspace_id: workspace, domain: z.enum(["journal", "records"]),
  entries: z.array(entrySchema).max(4000), committed: z.array(sha).max(4000) }).strict();
const anchorSchema = ledgerSchema.pick({ version: true, workspace_id: true, domain: true }).strict();
export const extensionHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const MAX = 4 * 1024 * 1024;

/** Evidence-only ledger. Entries are append-only; commit markers never confer authority. */
export class ExtensionStore {
  readonly file: string;
  readonly anchor: string;
  private raw: string | null = null;
  private ledger: z.infer<typeof ledgerSchema>;
  available = true;
  constructor(readonly workspaceId: string, readonly domain: "journal" | "records", mainFile: string) {
    workspace.parse(workspaceId);
    const expectedMain = path.join(getStateDir(), domain === "journal" ? "task-journal" : "executions",
      `${workspaceId}.${domain === "journal" ? "json" : "jsonl"}`);
    if (path.resolve(mainFile) !== path.resolve(expectedMain)) throw new Error("TASK_EXTENSION_IDENTITY_MISMATCH");
    this.file = path.join(getStateDir(), "task-extensions", `${workspaceId}.${domain}.json`);
    this.anchor = path.join(getStateDir(), "task-extension-anchors", `${workspaceId}.${domain}.json`);
    this.ledger = { version: 1, workspace_id: workspaceId, domain, entries: [], committed: [] };
    try {
      const anchor = this.read(this.anchor);
      this.raw = this.read(this.file);
      if ((anchor === null) !== (this.raw === null)) throw new Error("Missing extension storage");
      if (anchor !== null && JSON.stringify(anchorSchema.parse(JSON.parse(anchor))) !== JSON.stringify({ version: 1, workspace_id: this.workspaceId, domain: this.domain })) throw new Error("Identity mismatch");
      if (this.raw !== null) {
        const ledger = ledgerSchema.parse(JSON.parse(this.raw));
        if (ledger.workspace_id !== workspaceId || ledger.domain !== domain ||
            new Set(ledger.entries.map(e => e.id)).size !== ledger.entries.length ||
            new Set(ledger.committed).size !== ledger.committed.length ||
            ledger.entries.some(e => e.id !== extensionHash(JSON.stringify(e.payload)) ||
              (domain === "records" ? e.payload.kind !== "execution_diagnostic" : e.payload.kind === "execution_diagnostic") ||
              (e.payload.kind === "recovery" ? e.payload.bindings.some(b => b.workspace_id !== workspaceId) :
                e.payload.kind !== "execution_diagnostic" && e.payload.binding.workspace_id !== workspaceId) ||
              (e.payload.kind === "recovery" && e.payload.recovery.workspace_id !== workspaceId)) ||
            ledger.committed.some(id => !ledger.entries.some(e => e.id === id))) throw new Error("Invalid ledger");
        this.ledger = ledger;
      }
    } catch { this.available = false; }
  }
  private parents = checkPrivateParents;
  private read = (file: string): string | null => readPrivateFile(file, MAX);
  private sync = syncPrivateDirectory;
  private write = (file: string, text: string): void => writePrivateFile(file, text, MAX);
  assertWritable(): void {
    if (!this.available) throw new Error("TASK_EXTENSION_UNAVAILABLE");
    try {
      if (this.read(this.file) !== this.raw || (this.raw !== null && this.read(this.anchor) !== JSON.stringify({ version: 1, workspace_id: this.workspaceId, domain: this.domain }))) throw new Error("Extension changed");
    } catch { this.available = false; throw new Error("TASK_EXTENSION_UNAVAILABLE"); }
  }
  private save(ledger: typeof this.ledger): void {
    this.assertWritable();
    const text = JSON.stringify(ledgerSchema.parse(ledger));
    try {
      // Empty ledger is durable before the separate presence anchor. A crash in
      // bootstrap is fail-closed; it never makes prepared evidence committed.
      if (this.raw === null) {
        this.write(this.file, JSON.stringify(this.ledger)); this.raw = JSON.stringify(this.ledger);
        this.write(this.anchor, JSON.stringify({ version: 1, workspace_id: this.workspaceId, domain: this.domain }));
      }
      this.write(this.file, text); this.raw = text; this.ledger = ledger;
    } catch { this.available = false; throw new Error("TASK_EXTENSION_UNAVAILABLE"); }
  }
  prepare(payload: Extension): string {
    this.assertWritable();
    const safe = payloadSchema.parse(payload), id = extensionHash(JSON.stringify(safe));
    if ((this.domain === "records") !== (safe.kind === "execution_diagnostic")) throw new Error("TASK_EXTENSION_INVALID");
    if (safe.kind === "recovery" ? safe.recovery.workspace_id !== this.workspaceId || safe.bindings.some(b => b.workspace_id !== this.workspaceId) :
        safe.kind !== "execution_diagnostic" && safe.binding.workspace_id !== this.workspaceId) throw new Error("TASK_EXTENSION_IDENTITY_MISMATCH");
    if (this.ledger.entries.some(e => e.id === id)) return id;
    if (this.ledger.entries.length >= 4000) throw new Error("TASK_EXTENSION_CAPACITY");
    this.save({ ...this.ledger, entries: [...this.ledger.entries, { id, payload: safe }] });
    return id;
  }
  commit(ids: string[]): void {
    if (ids.some(id => !this.ledger.entries.some(e => e.id === id))) throw new Error("TASK_EXTENSION_INVALID");
    const committed = [...new Set([...this.ledger.committed, ...ids])];
    if (committed.length !== this.ledger.committed.length) this.save({ ...this.ledger, committed });
  }
  entries(): Array<{ id: string; payload: Extension; committed: boolean }> {
    const committed = new Set(this.ledger.committed);
    return this.available ? this.ledger.entries.map(e => ({ ...e, committed: committed.has(e.id) })) : [];
  }
  archive(raw: string): string {
    this.assertWritable();
    const file = path.join(path.dirname(this.file), `${this.workspaceId}.${this.domain}.${extensionHash(raw)}.archive`);
    const existing = this.read(file);
    if (existing !== null && existing !== raw) throw new Error("TASK_EXTENSION_ARCHIVE_CHANGED");
    if (existing === null) {
      let bytes = Buffer.byteLength(raw), count = 0;
      try {
        for (const name of fs.readdirSync(path.dirname(file))) {
          if (!name.startsWith(`${this.workspaceId}.${this.domain}.`) || !name.endsWith(".archive")) continue;
          const s = fs.lstatSync(path.join(path.dirname(file), name));
          if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || !privateMode(s)) throw new Error("TASK_EXTENSION_ARCHIVE_UNSAFE");
          bytes += s.size; count++;
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (count >= 128 || bytes > 64 * 1024 * 1024) throw new Error("TASK_EXTENSION_CAPACITY");
      this.write(file, raw);
    }
    return file;
  }
  replaceMain(file: string, expected: string | null, text: string): void {
    this.assertWritable();
    if (this.read(file) !== expected) throw new Error("TASK_EXTENSION_MAIN_CHANGED");
    this.write(file, text);
  }
  withMainLock<T>(file: string, action: () => T): T {
    this.parents(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); this.parents(file);
    const lock = `${file}.write-lock`, nonce = randomBytes(16).toString("hex");
    // Stale/ambiguous record writer locks require explicit offline inspection.
    // Never reclaim a lock merely because its writer is not visible here.
    const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let identity: fs.Stats;
    try { fs.writeFileSync(fd, nonce); fs.fsyncSync(fd); identity = fs.fstatSync(fd); }
    finally { fs.closeSync(fd); }
    this.sync(path.dirname(file));
    try { return action(); }
    finally {
      const s = fs.lstatSync(lock);
      if (!s.isSymbolicLink() && s.dev === identity.dev && s.ino === identity.ino && this.read(lock) === nonce) {
        fs.unlinkSync(lock); this.sync(path.dirname(file));
      }
    }
  }
}
