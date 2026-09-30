import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskJournal } from "../src/execution/task-journal.js";
import type { CodexRunResult } from "../src/codex/app-server.js";

const workspace = "a".repeat(24), other = "b".repeat(24), evidence = "e".repeat(64);
const run: CodexRunResult = { task_id: "old", iteration: 1, run_id: "c".repeat(32), state: "running" };
let dir: string, original: string | undefined, journals: TaskJournal[];
const open = () => { const journal = new TaskJournal(workspace); journals.push(journal); return journal; };
const file = () => path.join(dir, "task-journal", `${workspace}.json`);
const read = () => fs.readFileSync(file(), "utf8");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const restart = (failed = false) => {
  const first = open(); first.begin(workspace, run, "work");
  if (failed) first.complete(workspace, { ...run, state: "failed", reason: "bridge_stopped", summary: "partial" });
  first.close(); return open();
};
const target = (journal: TaskJournal) => journal.reconciliationTarget(workspace, run.task_id, run.run_id);
beforeEach(() => {
  original = process.env.C2C_STATE_DIR;
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reconciliation-test-"));
  process.env.C2C_STATE_DIR = dir; journals = [];
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const journal of journals) journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = original;
});

describe("local owner-confirmed journal reconciliation", () => {
  it.each([false, true])("preserves history and unknown outcome across restart (failed=%s)", (failed) => {
    const journal = restart(failed), before = read(), source = JSON.parse(before).runs[0];
    const selection = target(journal);
    expect(selection).toEqual({ workspace_id: workspace, task_id: "old", run_id: run.run_id, source_record_sha256: digest(source) });
    journal.status(workspace); expect(read()).toBe(before);
    journal.reconcileConfirmed(selection, evidence, new Date().toISOString());
    const after = read(), saved = JSON.parse(after).runs[0];
    const { reconciliation, ...unchanged } = saved;
    expect(unchanged).toEqual(source); expect(JSON.parse(after).runs).toHaveLength(1);
    expect(reconciliation).toMatchObject({ resolution: "allow_new_task_only", source_record_sha256: digest(source), evidence_sha256: evidence });
    let current = journal;
    for (const restarted of [false, true]) {
      if (restarted) { journal.close(); current = open(); }
      expect(current.checkStart(workspace, "new", 1, "work")).toBeNull();
      expect(() => current.checkStart(workspace, "old", 1, "work")).toThrow("TASK RECOVERY REQUIRED");
      expect(() => current.checkStart(workspace, "old", 2, "work")).toThrow("TASK RECOVERY REQUIRED");
      expect(() => current.checkStart(workspace, "old", 1, "changed")).toThrow("TASK REQUEST MISMATCH");
      expect(() => current.checkStart(other, "old", 1, "work")).toThrow("TASK WORKSPACE MISMATCH");
      expect(() => current.recoveredRun(workspace, "old", run.run_id)).toThrow("TASK RECOVERY REQUIRED");
      expect(current.status(workspace)).toMatchObject({ tasks: [{ execution_state: "interrupted", outcome_known: false,
        requires_reconciliation: false, reconciliation, next_action: "START_NEW_TASK_AFTER_REVIEW", tests: null, review: "not_recorded" }] });
      expect(() => current.reconcileConfirmed(selection, evidence, new Date().toISOString())).toThrow();
      expect(read()).toBe(after);
    }
  });

  it.each(["workspace_id", "task_id", "run_id", "source_record_sha256"] as const)("rejects changed %s and duplicate confirmation", (key) => {
    const journal = restart(), selection = target(journal), before = read();
    const values = { workspace_id: other, task_id: "missing", run_id: "d".repeat(32), source_record_sha256: "f".repeat(64) };
    expect(() => journal.reconcileConfirmed({ ...selection, [key]: values[key] }, evidence, new Date().toISOString())).toThrow();
    expect(read()).toBe(before);
    journal.reconcileConfirmed(selection, evidence, new Date().toISOString());
    expect(journal.checkStart(workspace, "new", 1, "work")).toBeNull();
    expect(() => target(journal)).toThrow();
    expect(() => journal.reconcileConfirmed(selection, evidence, new Date().toISOString())).toThrow();
    journal.begin(workspace, { ...run, task_id: "new", run_id: "d".repeat(32) }, "work");
    expect(() => journal.checkStart(workspace, "new", 2, "work")).toThrow("TASK ALREADY RUNNING");
  });

  it.each([-60_001, 1, NaN])("rejects stale, future or invalid approval (%s)", (offset) => {
    const journal = restart(), selection = target(journal), before = read();
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const approved = Number.isNaN(offset) ? "not-a-date" : new Date(Date.now() + offset).toISOString();
    expect(() => journal.reconcileConfirmed(selection, evidence, approved)).toThrow();
    expect(read()).toBe(before);
  });

  it("validates hashes, strict target fields, UTC and the inclusive 60-second boundary", () => {
    const journal = restart(), selection = target(journal);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    for (const bad of ["", "g".repeat(64), "a".repeat(63)]) {
      expect(() => journal.reconcileConfirmed(selection, bad, new Date().toISOString())).toThrow();
    }
    expect(() => journal.reconcileConfirmed({ ...selection, approved: true } as typeof selection, evidence, new Date().toISOString())).toThrow();
    expect(() => journal.reconcileConfirmed(selection, evidence, "2026-09-30T12:00:00+00:00")).toThrow();
    journal.reconcileConfirmed(selection, evidence, new Date(Date.now() - 60_000).toISOString());
  });

  it("rejects current-runtime and known terminal records", () => {
    const journal = open(); journal.begin(workspace, run, "work");
    expect(() => target(journal)).toThrow();
    journal.complete(workspace, { ...run, state: "completed" }); journal.close();
    expect(() => target(open())).toThrow();
  });

  it("keeps every iteration of the reconciled task non-replayable", () => {
    const first = open(); first.begin(workspace, run, "work");
    first.complete(workspace, { ...run, state: "completed" });
    const interrupted = { ...run, iteration: 2, run_id: "d".repeat(32) };
    first.begin(workspace, interrupted, "next"); first.close();
    const journal = open();
    journal.reconcileConfirmed(journal.reconciliationTarget(workspace, "old", interrupted.run_id), evidence, new Date().toISOString());
    expect(() => journal.checkStart(workspace, "old", 1, "work")).toThrow("TASK RECOVERY REQUIRED");
    expect(() => journal.recoveredRun(workspace, "old", run.run_id)).toThrow("TASK RECOVERY REQUIRED");
    expect(journal.checkStart(workspace, "new", 1, "work")).toBeNull();
  });

  it("keeps the workspace blocked until every uncertain old record is reconciled", () => {
    const first = open(); first.begin(workspace, run, "work");
    const second = { ...run, task_id: "second", run_id: "d".repeat(32) };
    first.begin(workspace, second, "work"); first.close();
    const journal = open(); journal.reconcileConfirmed(target(journal), evidence, new Date().toISOString());
    expect(() => journal.checkStart(workspace, "new", 1, "work")).toThrow("WORKSPACE RECOVERY REQUIRED");
    journal.reconcileConfirmed(journal.reconciliationTarget(workspace, second.task_id, second.run_id), evidence, new Date().toISOString());
    expect(journal.checkStart(workspace, "new", 1, "work")).toBeNull();
  });

  it("rejects a target and confirmation when any current-runtime record in that workspace is running", () => {
    const journal = restart(), selection = target(journal);
    // Seed an overlapping runtime record to exercise the guard independently of checkStart.
    const internal = journal as unknown as { runs: unknown[]; save(runs: unknown[]): void };
    const source = JSON.parse(read()).runs[0];
    internal.save([...internal.runs, { ...source, task_id: "active", run_id: "d".repeat(32), runtime_id: journal.runtimeId }]);
    expect(() => target(journal)).toThrow("WORKSPACE BUSY");
    expect(() => journal.reconcileConfirmed(selection, evidence, new Date().toISOString())).toThrow("WORKSPACE BUSY");
  });

  it.each(["tamper", "lock", "rename", "directory-sync"])("fails closed on %s", (kind) => {
    const journal = restart(), selection = target(journal), before = read();
    if (kind === "tamper") fs.writeFileSync(file(), before + " ");
    if (kind === "lock") fs.writeFileSync(file().replace(/json$/, "lock"), "{}");
    if (kind === "rename") vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("write failure"); });
    if (kind === "directory-sync") {
      const sync = fs.fsyncSync.bind(fs);
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { if (fs.fstatSync(fd).isDirectory()) throw new Error("sync failure"); sync(fd); });
    }
    expect(() => journal.reconcileConfirmed(selection, evidence, new Date().toISOString())).toThrow("TASK JOURNAL UNAVAILABLE");
    expect(() => journal.status(workspace)).toThrow("TASK JOURNAL UNAVAILABLE");
    expect(() => journal.checkStart(workspace, "new", 1, "work")).toThrow("TASK JOURNAL UNAVAILABLE");
    if (kind === "rename") expect(read()).toBe(before);
    if (kind === "tamper") expect(read()).toBe(before + " ");
  });

  it("hashes the exact loaded property order and never mutates snapshots on reads", () => {
    const first = restart(); first.close();
    const snapshot = JSON.parse(read());
    snapshot.runs[0] = Object.fromEntries(Object.entries(snapshot.runs[0]).reverse());
    fs.writeFileSync(file(), JSON.stringify(snapshot, null, 2));
    const before = read(), journal = open();
    const selection = target(journal);
    expect(selection.source_record_sha256).toBe(digest(snapshot.runs[0]));
    journal.status(workspace); expect(read()).toBe(before);
    journal.reconcileConfirmed(selection, evidence, new Date().toISOString());
    journal.close(); expect(open().checkStart(workspace, "new", 1, "work")).toBeNull();
  });

  it.each(["known-outcome", "extra", "hash", "timestamp"])("rejects invalid persisted reconciliation: %s", (kind) => {
    const journal = restart(); journal.reconcileConfirmed(target(journal), evidence, new Date().toISOString()); journal.close();
    const snapshot = JSON.parse(read()), saved = snapshot.runs[0];
    if (kind === "known-outcome") saved.state = "completed";
    if (kind === "extra") saved.reconciliation.approved = true;
    if (kind === "hash") saved.reconciliation.source_record_sha256 = "0".repeat(64);
    if (kind === "timestamp") saved.reconciliation.owner_approved_at = "invalid";
    fs.writeFileSync(file(), JSON.stringify(snapshot));
    expect(() => open()).toThrow("TASK JOURNAL INVALID");
  });
});
