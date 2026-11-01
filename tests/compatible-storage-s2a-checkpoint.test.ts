import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskJournal } from "../src/execution/task-journal.js";
import { TaskJournal as R32Journal } from "./fixtures/legacy-r32/dist/execution/task-journal.js";
import { readLegacySnapshot as r32Snapshot, readExecutionRecords as r32Records } from "./fixtures/legacy-r32/dist/execution/records.js";
import { appendExecutionRecord, readLegacySnapshot } from "../src/execution/records.js";
import { approvalDiagnostic } from "../src/codex/approval-diagnostic.js";
import { cleanup, isolateStateDir } from "./helpers.js";

// Actual untouched-r32 compatibility fixtures; original checkpoint is retained in evidence baseline.
const workspace = "a".repeat(24);
const run = { task_id: "storage-fixture", iteration: 1, run_id: "b".repeat(32), state: "running" as const };
let state: string, previous: string | undefined;
const journals: Array<TaskJournal | R32Journal> = [];
const current = () => { const j = new TaskJournal(workspace); journals.push(j); return j; };
const old = () => { const j = new R32Journal(workspace); journals.push(j); return j; };
const bytes = () => fs.readFileSync(path.join(state, "task-journal", `${workspace}.json`), "utf8");
function appendWithOldWriter(j: R32Journal) {
  // Real r32 mutation; fixture authorization only, no native owner decision.
  const rows = (j.status(workspace) as { tasks: Array<{ requires_reconciliation: boolean; task_id: string; run_id: string }> }).tasks;
  for (const row of rows.filter(row => row.requires_reconciliation)) {
    j.reconcileConfirmed(j.reconciliationTarget(workspace, row.task_id, row.run_id), "e".repeat(64), new Date().toISOString());
  }
  const next = { task_id: "r32-append", iteration: 1, run_id: "f".repeat(32), state: "running" as const };
  j.begin(workspace, next, "old writer fixture"); j.complete(workspace, { ...next, state: "completed" });
}
beforeEach(() => { previous = process.env.C2C_STATE_DIR; state = isolateStateDir(); fs.chmodSync(state, 0o700); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const j of journals.splice(0)) j.close();
  cleanup(state);
  if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous;
});

it.each([false, true])("characterizes recovery write failure afterRename=%s without claiming a returned success", afterRename => {
  const first = current(); first.begin(workspace, run, "fixture"); first.close();
  const j = current(), targets = j.workspaceBlockers(workspace), before = bytes();
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) !== path.join(state, "task-journal", `${workspace}.json`)) return rename(from, to);
    if (afterRename) rename(from, to);
    throw new Error("controlled write failure");
  });
  expect(() => j.recordWorkspaceRecovery(workspace, "c".repeat(32), targets, "recovered", undefined,
    "d".repeat(64), new Date().toISOString())).toThrow(expect.objectContaining({ code: "TASK_JOURNAL_UNAVAILABLE" }));
  expect(() => j.status(workspace)).toThrow(expect.objectContaining({ code: "TASK_JOURNAL_UNAVAILABLE" }));
  failure.mockRestore(); j.close();
  const next = current();
  expect(next.workspaceBlockers(workspace)).toHaveLength(afterRename ? 0 : 1);
  expect(next.workspaceRecoveryStatus(workspace, "c".repeat(32))).toMatchObject({ state: "prepared_uncommitted" });
  if (!afterRename) expect(bytes()).toBe(before);
  // After rename the actual approved reconciliation is present; this is not a
  // simulated power-loss/fsync durability guarantee or a sidecar test.
});

it("round-trips ordinary actual current journal bytes through untouched r32 and current", () => {
  const j = current(); j.begin(workspace, run, "fixture"); j.complete(workspace, { ...run, state: "completed" }); j.close();
  const before = bytes(), r32 = old();
  expect(r32.recoveredRun(workspace, run.task_id, run.run_id)).toMatchObject({ state: "completed" }); r32.close();
  expect(current().recoveredRun(workspace, run.task_id, run.run_id)).toMatchObject({ state: "completed" });
  expect(bytes()).toBe(before);
});

it("round-trips diagnostics through untouched r32 without exposing them to old projections", () => {
  const j = current(); j.begin(workspace, run, "fixture");
  j.complete(workspace, { ...run, state: "blocked", reason: "approval_required", approval_diagnostic: approvalDiagnostic({}, "schema") }); j.close();
  const r32 = old(); expect(r32.recoveredRun(workspace, run.task_id, run.run_id)).not.toHaveProperty("approval_diagnostic");
  appendWithOldWriter(r32); r32.close(); const before = bytes();
  expect(current().recoveredRun(workspace, run.task_id, run.run_id)).toMatchObject({ approval_diagnostic_available: true, resumable: false });
  expect(bytes()).toBe(before);
});

it.each(["recovered", "denied", "cancelled"] as const)("round-trips recovery %s evidence through untouched r32", outcome => {
  const first = current(); first.begin(workspace, run, "fixture"); first.close();
  const j = current(), targets = j.workspaceBlockers(workspace);
  j.recordWorkspaceRecovery(workspace, "c".repeat(32), targets, outcome,
    outcome === "denied" ? "OWNER_DENIED" : outcome === "cancelled" ? "RECONCILIATION_CANCELLED" : undefined,
    outcome === "recovered" ? "d".repeat(64) : undefined,
    outcome === "recovered" ? new Date().toISOString() : undefined); j.close();
  const r32 = old(); r32.status(workspace); appendWithOldWriter(r32); r32.close(); const before = bytes();
  const next = current(); expect(next.workspaceRecoveryStatus(workspace, "c".repeat(32))).toMatchObject({ state: outcome });
  expect(next.workspaceBlockers(workspace)).toHaveLength(0);
  next.workspaceRecoveryStatus(workspace, "c".repeat(32)); expect(bytes()).toBe(before);
});

it.each(["completed", "blocked", "failed"] as const)("round-trips notification %s reservations through untouched r32", outcome => {
  const j = current(); j.begin(workspace, run, "fixture");
  const terminal = { ...run, state: outcome }; j.complete(workspace, terminal);
  expect(j.recordNotification(workspace, terminal, "fixture-event")).toBe(true);
  expect(j.recordNotification(workspace, terminal, "fixture-event")).toBe(false); j.close();
  const r32 = old(); r32.status(workspace); appendWithOldWriter(r32); r32.close(); const before = bytes();
  expect(current().status(workspace, run.task_id)).toMatchObject({ tasks: [{ notifications: [{ event_id: "terminal" }, { event_id: "fixture-event" }] }] });
  expect(bytes()).toBe(before);
});

it("keeps ordinary execution JSONL within actual current and r32 strict admission", () => {
  appendExecutionRecord(workspace, { taskId: run.task_id, iteration: 1, runId: run.run_id,
    changedFiles: null, tests: null, exitStatus: "ok", timestamp: new Date().toISOString() });
  const file = path.join(state, "executions", `${workspace}.jsonl`), before = fs.readFileSync(file, "utf8");
  expect(JSON.parse(before)).not.toHaveProperty("approval_diagnostic_available");
  expect(r32Records(workspace)).toMatchObject([{ taskId: run.task_id, runId: run.run_id }]);
  expect(r32Snapshot(workspace, run.task_id)).toMatchObject({ records: [{ taskId: run.task_id }] });
  expect(readLegacySnapshot(workspace, run.task_id)).toMatchObject({ records: [{ taskId: run.task_id }] });
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});
