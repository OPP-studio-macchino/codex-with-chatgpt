import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskJournal } from "../src/execution/task-journal.js";
import type { CodexRunResult } from "../src/codex/app-server.js";

const workspace = "a".repeat(24);
const other = "b".repeat(24);
const run: CodexRunResult = { task_id: "task", iteration: 1, run_id: "c".repeat(32), state: "running" };
let dir: string;
let original: string | undefined;
let journals: TaskJournal[];
const open = (): TaskJournal => { const journal = new TaskJournal(workspace); journals.push(journal); return journal; };
const file = (): string => path.join(dir, "task-journal", `${workspace}.json`);
const lock = (): string => path.join(dir, "task-journal", `${workspace}.lock`);
beforeEach(() => {
  original = process.env.C2C_STATE_DIR;
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "task-journal-test-"));
  process.env.C2C_STATE_DIR = dir;
  journals = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals) journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = original;
});

describe("durable task journal", () => {
  it("persists completion without waiting and replays without mutation", () => {
    const first = open();
    first.begin(workspace, run, "do work");
    const terminal: CodexRunResult = { ...run, state: "completed", summary: "done" };
    first.complete(workspace, terminal);
    first.close();
    const before = fs.readFileSync(file(), "utf8");
    const next = open();
    expect(next.checkStart(workspace, "task", 1, "do work")).toEqual(terminal);
    expect(next.recoveredRun(workspace, "task", run.run_id)).toEqual(terminal);
    next.complete(workspace, terminal);
    next.status(workspace);
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
    expect(() => next.checkStart(workspace, "task", 2, "next")).toThrow("TASK RECOVERY REQUIRED");
  });

  it("reports unknown interrupted outcomes and blocks orphaned workspace work", () => {
    const first = open(); first.begin(workspace, run, "work");
    expect(first.recoveredRun(workspace, "task", run.run_id)).toBeNull();
    expect(first.checkStart(workspace, "task", 1, "work")).toEqual(run);
    first.close();
    const next = open();
    expect(next.status(workspace)).toMatchObject({ tasks: [{ execution_state: "interrupted", outcome_known: false,
      from_previous_runtime: true, requires_reconciliation: true, can_resume_original_context: false,
      tests: null, review: "not_recorded", goal_status: "unverified" }] });
    expect(() => next.checkStart(workspace, "task", 1, "work")).toThrow("TASK RECOVERY REQUIRED");
    expect(() => next.checkStart(workspace, "new", 1, "work")).toThrow("WORKSPACE RECOVERY REQUIRED");
    expect(() => next.recoveredRun(workspace, "task", run.run_id)).toThrow("TASK RECOVERY REQUIRED");
    expect(() => next.complete(workspace, { ...run, state: "failed" })).toThrow("TASK RECOVERY REQUIRED");
    expect(next.checkStart(other, "new", 1, "work")).toBeNull();
  });

  it("rejects changed requests, cross-workspace binding, duplicates and fabricated results", () => {
    const journal = open(); journal.begin(workspace, run, "work");
    expect(() => journal.checkStart(workspace, "task", 1, "work ")).toThrow("TASK REQUEST MISMATCH");
    expect(() => journal.checkStart(other, "task", 1, "work")).toThrow("TASK WORKSPACE MISMATCH");
    expect(() => journal.begin(workspace, run, "work")).toThrow("TASK RUN EXISTS");
    expect(() => journal.complete(workspace, { ...run, run_id: "d".repeat(32), state: "failed" })).toThrow("RUN NOT FOUND");
    expect(() => journal.recoveredRun(workspace, "absent", run.run_id)).toThrow("TASK NOT FOUND");
    journal.complete(workspace, { ...run, state: "blocked" });
    expect(() => journal.complete(workspace, { ...run, state: "completed" })).toThrow("TASK RESULT MISMATCH");
  });

  it("bounds and redacts instructions, summary and reason, excluding unknown fields", () => {
    const journal = open(); const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    journal.begin(workspace, run, `${secret} ${"界".repeat(3000)}`);
    journal.complete(workspace, { ...run, state: "failed", summary: `${secret} ${"x".repeat(10000)}`, reason: secret });
    const serialized = fs.readFileSync(file(), "utf8");
    expect(serialized).not.toContain(secret);
    const record = JSON.parse(serialized).runs[0];
    expect(Buffer.byteLength(record.instruction_excerpt)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(record.summary)).toBeLessThanOrEqual(8192);
    expect(record.instruction_truncated).toBe(true);
    const report = JSON.stringify(journal.status(workspace));
    expect(report).not.toMatch(/runtime_id|nonce|pid|thread/);
    expect(report).not.toContain(secret);
  });

  it.each(["corrupt", "oversize", "unknown-field", "file-symlink", "parent-symlink", "lock-symlink"])("fails closed for %s", (kind) => {
    const first = open(); first.begin(workspace, run, "work"); first.close();
    const outside = path.join(dir, "outside");
    fs.writeFileSync(outside, "{}");
    if (kind === "corrupt") fs.writeFileSync(file(), "{");
    if (kind === "oversize") fs.writeFileSync(file(), " ".repeat(4 * 1024 * 1024 + 1));
    if (kind === "unknown-field") {
      const data = JSON.parse(fs.readFileSync(file(), "utf8")); data.runs[0].thread_id = "secret";
      fs.writeFileSync(file(), JSON.stringify(data));
    }
    if (kind === "file-symlink") { fs.unlinkSync(file()); fs.symlinkSync(outside, file()); }
    if (kind === "lock-symlink") fs.symlinkSync(outside, lock());
    if (kind === "parent-symlink") {
      const parent = path.dirname(file()); fs.renameSync(parent, `${parent}-real`); fs.symlinkSync(`${parent}-real`, parent);
    }
    expect(() => open()).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("{}");
  });

  it.each(["begin", "complete"])("makes %s write failures permanently unhealthy", (operation) => {
    const journal = open();
    if (operation === "complete") journal.begin(workspace, run, "work");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk failure"); });
    expect(() => operation === "begin" ? journal.begin(workspace, run, "work") : journal.complete(workspace, { ...run, state: "completed" })).toThrow("TASK JOURNAL UNAVAILABLE");
    expect(() => journal.status(workspace)).toThrow("TASK JOURNAL UNAVAILABLE");
    expect(() => journal.checkStart(workspace, "task", 1, "work")).toThrow("TASK JOURNAL UNAVAILABLE");
    vi.restoreAllMocks(); journal.close();
    const next = open();
    if (operation === "begin") expect(next.checkStart(workspace, "task", 1, "work")).toBeNull();
    else expect(() => next.checkStart(workspace, "task", 1, "work")).toThrow("TASK RECOVERY REQUIRED");
  });

  it("refuses live owners including own PID and preserves lock on contention", () => {
    const first = open(); const before = fs.readFileSync(lock(), "utf8");
    expect(() => open()).toThrow("TASK JOURNAL BUSY");
    expect(fs.readFileSync(lock(), "utf8")).toBe(before);
    // The sandbox filesystem may report an extra owner execute bit.
    expect(fs.statSync(lock()).mode & 0o077).toBe(0);
    expect(fs.statSync(path.dirname(lock())).mode & 0o777).toBe(0o700);
    first.close(); expect(fs.existsSync(lock())).toBe(false);
  });

  it("reclaims only clearly dead locks; malformed and EPERM locks stay busy", () => {
    open().close();
    fs.writeFileSync(lock(), "partial"); expect(() => open()).toThrow("TASK JOURNAL BUSY");
    fs.writeFileSync(lock(), JSON.stringify({ pid: 12345, nonce: "f".repeat(32) }));
    fs.chmodSync(lock(), 0o600);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(), { code: "EPERM" }); });
    expect(() => open()).toThrow("TASK JOURNAL BUSY");
    kill.mockImplementation(() => { throw Object.assign(new Error(), { code: "ESRCH" }); });
    const journal = open(); expect(kill).toHaveBeenCalledWith(12345, 0); journal.close();
  });

  it("does not remove a replaced lock", () => {
    const journal = open();
    const replacement = JSON.stringify({ pid: process.pid, nonce: "e".repeat(32) });
    fs.writeFileSync(lock(), replacement);
    journal.close();
    expect(fs.readFileSync(lock(), "utf8")).toBe(replacement);
  });

  it("fails closed after a post-rename durability failure", () => {
    const journal = open(); journal.begin(workspace, run, "work");
    const sync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("directory sync failure");
      sync(fd);
    });
    expect(() => journal.complete(workspace, { ...run, state: "completed" })).toThrow("TASK JOURNAL UNAVAILABLE");
    expect(() => journal.status(workspace)).toThrow("TASK JOURNAL UNAVAILABLE");
  });

  it("validates identifiers, iteration and report limits", () => {
    const journal = open();
    expect(() => journal.checkStart("../outside", "task", 1, "work")).toThrow();
    expect(() => journal.checkStart(workspace, "bad/task", 1, "work")).toThrow();
    for (const turn of [0, 13, 1.5]) expect(() => journal.checkStart(workspace, "task", turn, "work")).toThrow();
    expect(() => journal.begin(workspace, { ...run, run_id: "bad" }, "work")).toThrow();
    for (const limit of [0, 51, NaN]) expect(() => journal.status(workspace, undefined, limit)).toThrow();
  });

  it("does not treat a forced bridge stop as a known outcome after restart", () => {
    const first = open(); first.begin(workspace, run, "work");
    first.complete(workspace, { ...run, state: "failed", reason: "bridge_stopped" }); first.close();
    const next = open();
    expect(next.status(workspace)).toMatchObject({ tasks: [{ execution_state:"interrupted",outcome_known:false,requires_reconciliation:true }] });
    expect(() => next.checkStart(workspace,"task",1,"work")).toThrow("TASK RECOVERY REQUIRED");
    expect(() => next.checkStart(workspace,"new",1,"work")).toThrow("WORKSPACE RECOVERY REQUIRED");
    expect(() => next.recoveredRun(workspace,"task",run.run_id)).toThrow("TASK RECOVERY REQUIRED");
  });

  it("does not overwrite an externally changed snapshot", () => {
    const journal = open(); journal.begin(workspace,run,"work");
    fs.writeFileSync(file(), "corrupt-after-open");
    expect(() => journal.complete(workspace,{...run,state:"completed"})).toThrow("TASK JOURNAL UNAVAILABLE");
    expect(fs.readFileSync(file(),"utf8")).toBe("corrupt-after-open");
  });

  it("rejects a readable-by-others journal on POSIX", () => {
    if (process.platform === "win32") return;
    const first = open();first.begin(workspace,run,"work");first.close();fs.chmodSync(file(),0o644);
    expect(() => open()).toThrow("TASK JOURNAL UNAVAILABLE");
  });

  it("captures the state directory and reads without disk mutation", () => {
    const journal = open(); journal.begin(workspace, run, "work");
    const before = fs.statSync(file());
    process.env.C2C_STATE_DIR = path.join(dir, "unused");
    journal.status(workspace); journal.recoveredRun(workspace, "task", run.run_id);
    expect(fs.statSync(file()).mtimeMs).toBe(before.mtimeMs);
    journal.complete(workspace, { ...run, state: "completed" });
    expect(fs.existsSync(path.join(dir, "unused"))).toBe(false);
  });
});
