import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskJournal, inspectTaskJournalLayout } from "../src/execution/task-journal.js";
import { ExtensionStore, extensionHash } from "../src/execution/extensions.js";
import { appendExecutionRecord, appendExecutionRecordOnce, executionExtensionStatus, migrateExecutionRecordExtensions, readExecutionRecords } from "../src/execution/records.js";
import { approvalDiagnostic } from "../src/codex/approval-diagnostic.js";
import { TaskJournal as R32, inspectTaskJournalLayout as r32Layout } from "./fixtures/legacy-r32/dist/execution/task-journal.js";
import { appendExecutionRecord as r32Append, readLegacySnapshot as r32Snapshot } from "./fixtures/legacy-r32/dist/execution/records.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = "a".repeat(24), other = "d".repeat(24);
const run = { task_id: "fixture", iteration: 1, run_id: "b".repeat(32), state: "running" as const };
const diagnostic = approvalDiagnostic({ command: "never retained plaintext", cwd: "/fixture-only" }, "schema");
let state: string, previous: string | undefined;
const opened: Array<TaskJournal | R32> = [];
const open = () => { const j = new TaskJournal(workspace); opened.push(j); return j; };
const main = () => path.join(state, "task-journal", `${workspace}.json`);
const ledger = (domain = "journal") => path.join(state, "task-extensions", `${workspace}.${domain}.json`);
const read = () => fs.readFileSync(main(), "utf8");
beforeEach(() => { previous = process.env.C2C_STATE_DIR; state = isolateStateDir(); fs.chmodSync(state, 0o700); });
afterEach(() => {
  vi.restoreAllMocks(); for (const j of opened.splice(0)) j.close(); cleanup(state);
  if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous;
});
function terminal() {
  const j = open(); j.begin(workspace, run, "fixture");
  j.complete(workspace, { ...run, state: "blocked", reason: "approval_required", approval_diagnostic: diagnostic }); j.close();
}

it("keeps layout scans and approval hashes canonical, while reserving notifications separately", () => {
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, { ...run, state: "failed", reason: "child_exit" });
  const before = read(); j.recordNotification(workspace, { ...run, state: "failed", reason: "child_exit" }, "reserved");
  expect(read()).toBe(before); j.close();
  expect(r32Layout(state)).toMatchObject({ journals: 1, runs: 1 }); expect(inspectTaskJournalLayout(state)).toMatchObject({ journals: 1 });
  const next = open(), target = next.reconciliationTarget(workspace, run.task_id, run.run_id);
  expect(target.source_record_sha256).toBe(extensionHash(JSON.stringify(JSON.parse(before).runs[0])));
  next.reconcileConfirmed(target, "c".repeat(64), new Date().toISOString()); next.close();
  const old = new R32(workspace); opened.push(old); old.status(workspace); old.close();
  expect(open().status(workspace, run.task_id)).toMatchObject({ tasks: [{ notifications: [{ event_id: "terminal" }, { event_id: "reserved" }] }] });
});

it.each(["missing", "truncated", "workspace", "symlink", "oversized", "tampered", "missing-anchor"])("main reads stay available but extension writes fail closed: %s", fault => {
  terminal(); const before = read(), file = ledger();
  if (fault === "missing") fs.unlinkSync(file);
  if (fault === "truncated") fs.writeFileSync(file, "{");
  if (fault === "workspace") { const data = JSON.parse(fs.readFileSync(file, "utf8")); data.workspace_id = other; fs.writeFileSync(file, JSON.stringify(data)); }
  if (fault === "symlink") { fs.renameSync(file, `${file}.outside`); fs.symlinkSync(`${file}.outside`, file); }
  if (fault === "oversized") fs.writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
  if (fault === "tampered") { const data = JSON.parse(fs.readFileSync(file, "utf8")); data.entries[0].payload.binding.runtime_id = "f".repeat(32); fs.writeFileSync(file, JSON.stringify(data)); }
  if (fault === "missing-anchor") fs.unlinkSync(path.join(state, "task-extension-anchors", `${workspace}.journal.json`));
  const j = open(); expect(j.recoveredRun(workspace, run.task_id, run.run_id)).toMatchObject({ approval_diagnostic_available: false, resumable: false });
  expect(j.extensionStatus()).toMatchObject({ available: false });
  expect(() => j.begin(workspace, { ...run, task_id: "new", run_id: "c".repeat(32) }, "new")).toThrow();
  expect(read()).toBe(before);
});

it("never hydrates a committed entry copied to a different workspace", () => {
  terminal(); const j = new TaskJournal(other); opened.push(j); j.begin(other, run, "fixture"); j.complete(other, { ...run, state: "blocked", reason: "approval_required" }); j.close();
  const file = path.join(state, "task-extensions", `${other}.journal.json`);
  fs.copyFileSync(ledger(), file);
  const next = new TaskJournal(other); opened.push(next);
  expect(next.recoveredRun(other, run.task_id, run.run_id)).toMatchObject({ approval_diagnostic_available: false });
  expect(next.extensionStatus()).toMatchObject({ available: false });
});

it.each(["prepare", "commit"])("durable diagnostic %s failure remains non-authorizing after restart", phase => {
  const j = open(); j.begin(workspace, run, "fixture"); const before = read(), rename = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === ledger()) {
      const data = JSON.parse(fs.readFileSync(from, "utf8"));
      const entry = data.entries.find((e: any) => e.payload.kind === "diagnostic");
      if (entry && (phase === "prepare" ? !data.committed.includes(entry.id) : data.committed.includes(entry.id))) throw new Error("fixture fault");
    }
    return rename(from, to);
  });
  expect(() => j.complete(workspace, { ...run, state: "blocked", reason: "approval_required", approval_diagnostic: diagnostic })).toThrow();
  fault.mockRestore(); j.close(); const next = open();
  if (phase === "prepare") { expect(read()).toBe(before); expect(next.workspaceBlockers(workspace)).toHaveLength(1); }
  else {
    expect(next.recoveredRun(workspace, run.task_id, run.run_id)).toMatchObject({ approval_diagnostic_available: false });
    expect(next.extensionStatus()).toMatchObject({ evidence: [
      { kind: "execution_mode", classification: "committed_evidence" },
      { kind: "diagnostic", classification: "prepared_uncommitted", approval_granted: false, resumable: false },
      { kind: "notification", classification: "prepared_uncommitted", approval_granted: false, resumable: false }] });
  }
});

it("uncommitted notification reservation is inspectable, never delivered or automatically retried", () => {
  const j = open(); j.begin(workspace, run, "fixture"); const final = { ...run, state: "completed" as const };
  const rename = fs.renameSync, fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === ledger()) {
      const data = JSON.parse(fs.readFileSync(from, "utf8"));
      if (data.entries.some((e: any) => e.payload.kind === "notification" && data.committed.includes(e.id))) throw new Error("commit fault");
    }
    return rename(from, to);
  });
  expect(() => j.recordNotification(workspace, final, "event")).toThrow(); fault.mockRestore(); j.close();
  const next = open(); expect(next.status(workspace, run.task_id)).toMatchObject({ tasks: [{ notifications: [] }] });
  expect(next.extensionStatus()).toMatchObject({ evidence: [
    { kind: "execution_mode", classification: "committed_evidence" },
    { kind: "notification", classification: "prepared_uncommitted", delivery_proven: false, goal_completed: false }] });
  expect(() => next.recordNotification(workspace, final, "event")).toThrow();
});

it("reservation history survives a later terminal update and remains deduplicated after restart", () => {
  const j = open(); j.begin(workspace, run, "fixture");
  const attention = { ...run, state: "blocked" as const, reason: "user_input_required" };
  expect(j.recordNotification(workspace, attention, "attention")).toBe(true);
  j.complete(workspace, { ...run, state: "completed" }); j.close();
  const next = open(); expect(next.status(workspace, run.task_id)).toMatchObject({ tasks: [{ notifications: [{ event_id: "attention" }, { event_id: "terminal" }] }] });
  expect(next.recordNotification(workspace, attention, "attention")).toBe(false);
});

it("even a committed recovery entry cannot substitute for missing main reconciliation", () => {
  const first = open(); first.begin(workspace, run, "fixture"); first.close();
  const j = open(); j.recordWorkspaceRecovery(workspace, "c".repeat(32), j.workspaceBlockers(workspace), "recovered", undefined,
    "d".repeat(64), new Date().toISOString()); j.close();
  const value = JSON.parse(read()); delete value.runs[0].reconciliation; fs.writeFileSync(main(), JSON.stringify(value));
  const next = open(); expect(next.workspaceRecoveryStatus(workspace, "c".repeat(32))).toMatchObject({ state: "prepared_uncommitted", blockers: [{ run_id: run.run_id }] });
  expect(() => next.checkStart(workspace, "new", 1, "fixture")).toThrow(/WORKSPACE RECOVERY REQUIRED/);
});

it("archive write failure leaves WIP main bytes untouched", () => {
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, { ...run, state: "blocked", reason: "approval_required" }); j.close();
  const value = JSON.parse(read()); value.runs[0].approval_diagnostic = diagnostic;
  const original = JSON.stringify(value); fs.writeFileSync(main(), original);
  const next = open(), rename = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to).endsWith(".archive")) throw new Error("archive fault"); return rename(from, to); });
  expect(() => next.migrateExtensions()).toThrow(); fault.mockRestore(); expect(read()).toBe(original);
});

it("archives exact WIP journal bytes before supported migration, preserving projected evidence and idempotence", () => {
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, { ...run, state: "blocked", reason: "approval_required" }); j.close();
  const value = JSON.parse(read()); value.runs[0].approval_diagnostic = diagnostic;
  value.runs[0].notifications = [{ event_id: "old", state: "blocked", kind: "owner_attention", created_at: value.runs[0].updated_at }];
  const original = JSON.stringify(value); fs.writeFileSync(main(), original);
  const next = open(); expect(() => next.begin(workspace, { ...run, task_id: "new", run_id: "c".repeat(32) }, "new")).toThrow(/MIGRATION REQUIRED/);
  const result = next.migrateExtensions(); expect(result.status).toBe("migrated"); expect(fs.readFileSync(result.archive!, "utf8")).toBe(original);
  expect(next.migrateExtensions()).toEqual({ status: "not_required" }); next.close();
  const old = new R32(workspace); opened.push(old); old.status(workspace); old.close();
  expect(open().status(workspace, run.task_id)).toMatchObject({ tasks: [{ approval_diagnostic_available: true, notifications: [{ event_id: "terminal" }, { event_id: "old" }] }] });
});

it("blocks hash-bound WIP migration with original bytes and approval hash untouched", () => {
  const j = new R32(workspace); opened.push(j); j.begin(workspace, run, "fixture"); j.close();
  const value = JSON.parse(read()), source = value.runs[0];
  source.notifications = [{ event_id: "old", state: "failed", kind: "owner_attention", created_at: source.updated_at }];
  const sourceHash = extensionHash(JSON.stringify(source)), now = new Date().toISOString();
  source.reconciliation = { resolution: "allow_new_task_only", source_record_sha256: sourceHash,
    evidence_sha256: "c".repeat(64), owner_approved_at: now, reconciled_at: now };
  const original = JSON.stringify(value); fs.writeFileSync(main(), original);
  const next = open(); expect(() => next.migrateExtensions()).toThrow(expect.objectContaining({ code: "TASK_JOURNAL_HASH_BOUND_EXTENSION_MIGRATION_REQUIRED" }));
  expect(read()).toBe(original); expect(fs.existsSync(ledger())).toBe(false);
  expect(() => new R32(workspace)).toThrow();
});

it.each(["recovered", "denied", "cancelled"] as const)("migrates WIP recovery %s whose target hashes already bind canonical runs", outcome => {
  const j = open(); j.begin(workspace, run, "fixture"); j.close(); const value = JSON.parse(read());
  const source = extensionHash(JSON.stringify(value.runs[0])), now = new Date().toISOString();
  if (outcome === "recovered") value.runs[0].reconciliation = { resolution: "allow_new_task_only", source_record_sha256: source,
    evidence_sha256: "e".repeat(64), owner_approved_at: now, reconciled_at: now };
  value.recoveries = [{ recovery_id: "c".repeat(32), workspace_id: workspace, state: outcome,
    ...(outcome === "recovered" ? { evidence_sha256: "e".repeat(64) } : { code: outcome === "denied" ? "OWNER_DENIED" : "RECONCILIATION_CANCELLED" }), updated_at: now,
    records: [{ task_id: run.task_id, run_id: run.run_id, source_record_sha256: source }] }];
  fs.writeFileSync(main(), JSON.stringify(value)); const next = open(); next.migrateExtensions();
  expect(next.workspaceRecoveryStatus(workspace, "c".repeat(32))).toMatchObject({ state: outcome });
  expect(next.workspaceBlockers(workspace)).toHaveLength(outcome === "recovered" ? 0 : 1);
});

const record = () => ({ taskId: run.task_id, iteration: 1, runId: run.run_id, changedFiles: null, tests: null, exitStatus: "blocked" as const, timestamp: "2026-10-05T00:00:00.000Z" });
it("projects JSONL diagnostics after untouched old writer append, with strict admission and dedup", () => {
  appendExecutionRecordOnce(workspace, { ...record(), approval_diagnostic: diagnostic });
  const before = fs.readFileSync(ledger("records"), "utf8"); appendExecutionRecordOnce(workspace, { ...record(), approval_diagnostic: diagnostic });
  r32Append(workspace, { ...record(), taskId: "old-append", runId: "c".repeat(32) });
  expect(r32Snapshot(workspace, run.task_id).records).toHaveLength(1);
  expect(readExecutionRecords(workspace)).toMatchObject([{ approval_diagnostic_available: true }, { approval_diagnostic_available: false }]);
  readExecutionRecords(workspace); expect(fs.readFileSync(ledger("records"), "utf8")).toBe(before);
});

it("explicit JSONL migration archives byte-exact originals and retains diagnostics without polluting strict rows", () => {
  appendExecutionRecord(workspace, record()); const file = path.join(state, "executions", `${workspace}.jsonl`);
  const original = JSON.stringify({ ...record(), approval_diagnostic_available: true, approval_diagnostic: diagnostic }) + "\n";
  fs.writeFileSync(file, original); expect(() => appendExecutionRecord(workspace, record())).toThrow();
  const migrated = migrateExecutionRecordExtensions(workspace); expect(fs.readFileSync(migrated.archive!, "utf8")).toBe(original);
  expect(migrateExecutionRecordExtensions(workspace)).toEqual({ status: "not_required" });
  expect(r32Snapshot(workspace, run.task_id).records).toHaveLength(1); expect(readExecutionRecords(workspace)[0]).toMatchObject({ approval_diagnostic: diagnostic });
});

it("JSONL main write failure preserves prepared diagnostic without projecting a completed record", () => {
  const file = path.join(state, "executions", `${workspace}.jsonl`), rename = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === file) throw new Error("main fault"); return rename(from, to); });
  expect(() => appendExecutionRecord(workspace, { ...record(), approval_diagnostic: diagnostic })).toThrow(); fault.mockRestore();
  expect(readExecutionRecords(workspace)).toEqual([]);
  expect(executionExtensionStatus(workspace)).toMatchObject({ evidence: [{ classification: "prepared_uncommitted", approval_granted: false }] });
});

it("ledger capacity fails without evicting prepared or committed evidence", () => {
  terminal(); const data = JSON.parse(fs.readFileSync(ledger(), "utf8")), payload = data.entries[0].payload;
  data.entries = Array.from({ length: 4000 }, (_, i) => { const p = { ...payload, binding: { ...payload.binding, task_id: `t${i}` } }; return { id: extensionHash(JSON.stringify(p)), payload: p }; });
  data.committed = []; fs.writeFileSync(ledger(), JSON.stringify(data)); const before = fs.readFileSync(ledger(), "utf8");
  const store = new ExtensionStore(workspace, "journal", main()); expect(store.available).toBe(true);
  expect(() => store.prepare(payload)).toThrow(/CAPACITY/); expect(fs.readFileSync(ledger(), "utf8")).toBe(before);
});

it("continues a twelve-run history only with a fresh checkpoint and preserves it in version 2", () => {
  const first = open();
  for (let iteration = 1; iteration <= 12; iteration++) {
    const current = { ...run, iteration, run_id: iteration.toString(16).padStart(32, "0"), execution_mode: "read_only" as const };
    first.begin(workspace, current, `step ${iteration}`);
    first.complete(workspace, { ...current, state: "completed" });
  }
  first.close();
  expect(JSON.parse(read()).version).toBe(1);
  const old = new R32(workspace); opened.push(old);
  expect(old.status(workspace)).toMatchObject({ tasks: [{ iteration: 12 }] }); old.close();
  const current = open(), instruction = "fresh reviewed continuation";
  const continued = { ...run, iteration: 13, run_id: "d".repeat(32), execution_mode: "read_only" as const };
  expect(() => current.checkStart(workspace, run.task_id, 13, instruction)).toThrow("TASK RECOVERY REQUIRED");
  expect(() => current.beginCheckpoint(workspace, continued, instruction, "e".repeat(32), "f".repeat(64))).toThrow();
  const target = current.checkpointTarget(workspace, run.task_id, 13, instruction);
  expect(target.known_records).toHaveLength(12);
  current.approveCheckpoint(target, instruction, "f".repeat(64), new Date().toISOString(), "e".repeat(32));
  current.beginCheckpoint(workspace, continued, instruction, "e".repeat(32), "f".repeat(64));
  current.complete(workspace, { ...continued, state: "completed" });
  expect(current.checkpointTarget(workspace, run.task_id, 14, "next").known_records).toHaveLength(13);
  current.close();
  const saved = read();
  expect(JSON.parse(saved).version).toBe(2);
  expect(JSON.parse(saved).runs.map((r: { iteration: number }) => r.iteration)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  expect(() => new R32(workspace)).toThrow();
  expect(read()).toBe(saved);
  expect(() => r32Layout()).toThrow();
  const reopened = open();
  expect(reopened.recoveredRun(workspace, run.task_id, continued.run_id)).toMatchObject({ state: "completed", iteration: 13, execution_mode: "read_only" });
  expect(() => reopened.checkStart(workspace, run.task_id, 14, "next")).toThrow("TASK RECOVERY REQUIRED");
  expect(inspectTaskJournalLayout()).toMatchObject({ status: "target_keyed", runs: 13 });
  expect(read()).toBe(saved);
});
