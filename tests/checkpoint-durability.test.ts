import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskJournal } from "../src/execution/task-journal.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { makeTmpDir, cleanup } from "./helpers.js";

// Owner runner supplies external scratch with verified chmod/hardlink semantics.
// Never run these durability tests using the checkout's default fixture root.
const external = process.env.C2C_TEST_TMP_ROOT;
const relative = external ? path.relative(process.cwd(), path.resolve(external)) : "";
const enabled = Boolean(external && relative.startsWith(`..${path.sep}`));
const id = "a".repeat(24), missing = { iteration: 4, run_id: "4".repeat(32) };
const instruction = "Fresh reviewed current-state instruction";
const directories: string[] = [], journals: TaskJournal[] = [];
const originalState = process.env.C2C_STATE_DIR;
afterEach(() => {
  vi.restoreAllMocks(); for (const journal of journals.splice(0)) journal.close();
  for (const dir of directories.splice(0)) cleanup(dir);
  if (originalState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = originalState;
});
function setup() {
  const state = makeTmpDir("checkpoint-durable"); directories.push(state); fs.chmodSync(state, 0o700);
  process.env.C2C_STATE_DIR = state;
  for (const iteration of [1, 2, 3]) appendExecutionRecord(id, { taskId: "same", iteration, runId: String(iteration).repeat(32), changedFiles: null,
    tests: null, exitStatus: "ok", timestamp: "2026-09-30T00:00:00Z" });
  const journal = new TaskJournal(id); journals.push(journal);
  const target = journal.checkpointTarget(id, "same", 5, instruction, missing);
  journal.approveCheckpoint(target, instruction, "e".repeat(64), new Date().toISOString(), "c".repeat(32));
  const file = path.join(state, "task-journal", `${id}.json`);
  const run = { task_id: "same", iteration: 5, run_id: "5".repeat(32), state: "running" as const };
  return { journal, file, run };
}
function reopen(journal: TaskJournal) {
  journal.close(); const reopened = new TaskJournal(id); journals.push(reopened); return reopened;
}
describe.skipIf(!enabled)("owner-only real checkpoint durability (external filesystem)", () => {
  it("reopens an unused approval as expired in the new runtime", () => {
    const { journal } = setup(); const next = reopen(journal);
    expect(next.checkpointStatus(id, "same")[0]).toMatchObject({ status: "expired" });
    expect(() => next.approvedCheckpoint(id, "same", 5, instruction)).toThrow();
  });
  it("atomically persists consumed checkpoint and only run5, supports duplicate complete and saved results", () => {
    const { journal, file, run } = setup();
    journal.beginCheckpoint(id, run, instruction, "c".repeat(32), "e".repeat(64));
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(disk.runs.map((r: { iteration: number }) => r.iteration)).toEqual([5]);
    expect(disk.checkpoints[0]).toMatchObject({ status: "consumed", consumed_run_id: run.run_id });
    const complete = { ...run, state: "completed" as const, summary: "process ended" };
    journal.complete(id, complete); journal.complete(id, complete);
    const next = reopen(journal);
    expect(next.recoveredRun(id, "same", run.run_id)).toMatchObject({ state: "completed", checkpoint_continuation: true });
    expect(() => next.beginCheckpoint(id, run, instruction, "c".repeat(32), "e".repeat(64))).toThrow();
    expect(() => next.checkStart(id, "same", 6, "fresh6")).toThrow();
  });
  it.each(["before", "after"])("%s rename failure cannot duplicate admission/spawn after restart", phase => {
    const { journal, file, run } = setup();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) !== file) return rename(from, to);
      if (phase === "after") rename(from, to);
      throw new Error("injected rename-boundary failure");
    });
    const spawned = vi.fn();
    expect(() => { journal.beginCheckpoint(id, run, instruction, "c".repeat(32), "e".repeat(64)); spawned(); }).toThrow();
    expect(spawned).not.toHaveBeenCalled(); vi.restoreAllMocks();
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(disk.runs.length).toBe(phase === "after" ? 1 : 0);
    expect(disk.checkpoints[0].status).toBe(phase === "after" ? "consumed" : "approved");
    const next = reopen(journal);
    expect(() => next.beginCheckpoint(id, run, instruction, "c".repeat(32), "e".repeat(64))).toThrow();
    if (phase === "after") expect(() => next.recoveredRun(id, "same", run.run_id)).toThrow("TASK RECOVERY REQUIRED");
  });
});
