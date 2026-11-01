import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskJournal } from "../src/execution/task-journal.js";
import { TaskReconciler } from "../src/execution/task-reconciler.js";
import { ExtensionStore } from "../src/execution/extensions.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = { id: "a".repeat(24), root: "/fixture", name: "fixture" };
const run = { task_id: "mode", iteration: 1, run_id: "b".repeat(32), state: "running" as const };
const evidence = { digest: "c".repeat(64), head: "d".repeat(40), fileCount: 1, changedCount: 0,
  processScope: "same-user-cwd" as const, fileScope: "git-index-status-and-dirty-worktree-excluding-appledouble" as const };
let state: string, previous: string | undefined;
const journals: TaskJournal[] = [];
const open = () => { const j = new TaskJournal(workspace.id); journals.push(j); return j; };
const main = () => path.join(state, "task-journal", `${workspace.id}.json`);
beforeEach(() => { previous = process.env.C2C_STATE_DIR; state = isolateStateDir(); });
afterEach(() => {
  vi.restoreAllMocks(); for (const j of journals.splice(0)) j.close(); cleanup(state);
  if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous;
});

it.each([undefined, "read_only", "workspace_write"] as const)("durably binds normalized mode %s without changing the canonical request hash", mode => {
  const j = open(), started = { ...run, execution_mode: mode };
  j.begin(workspace.id, started, "same instruction"); j.complete(workspace.id, { ...started, state: "completed" });
  j.complete(workspace.id, { ...started, state: "completed" });
  const before = fs.readFileSync(main(), "utf8"), base = JSON.parse(before).runs[0];
  expect(base.execution_mode).toBeUndefined();
  expect(base.request_sha256).toBe(createHash("sha256").update("same instruction").digest("hex"));
  j.close();
  const next = open(), normalized = mode ?? "read_only", other = normalized === "read_only" ? "workspace_write" : "read_only";
  expect(next.checkStart(workspace.id, run.task_id, 1, "same instruction", normalized)).toMatchObject({ execution_mode: normalized });
  expect(next.recoveredRun(workspace.id, run.task_id, run.run_id)).toMatchObject({ execution_mode: normalized });
  for (const iteration of [1, 2]) expect(() => next.checkStart(workspace.id, run.task_id, iteration, "same instruction", other)).toThrow("EXECUTION MODE MISMATCH");
  expect(() => next.checkStart(workspace.id, run.task_id, 1, "changed", normalized)).toThrow("TASK REQUEST MISMATCH");
  expect(fs.readFileSync(main(), "utf8")).toBe(before);
});

it.each(["read_only", "workspace_write"] as const)("rejects contradictory completion mode without changing %s evidence", mode => {
  const j = open(); j.begin(workspace.id, { ...run, execution_mode: mode }, "work");
  const before = fs.readFileSync(main(), "utf8");
  for (const changed of [null, {}, "writer", mode === "read_only" ? "workspace_write" : "read_only"]) {
    expect(() => j.complete(workspace.id, { ...run, state: "completed", execution_mode: changed as any })).toThrow();
    expect(fs.readFileSync(main(), "utf8")).toBe(before);
  }
  j.complete(workspace.id, { ...run, state: "completed" });
  j.complete(workspace.id, { ...run, state: "completed", execution_mode: mode });
  expect(j.recoveredRun(workspace.id, run.task_id, run.run_id)?.execution_mode).toBe(mode);
});

it("keeps historical records byte-identical and their unknown mode below writer authority", () => {
  const j = open(); j.begin(workspace.id, run, "old"); j.complete(workspace.id, { ...run, state: "completed" }); j.close();
  // A real historical canonical record has no mode sidecar or anchor.
  fs.rmSync(path.join(state, "task-extensions"), { recursive: true });
  fs.rmSync(path.join(state, "task-extension-anchors"), { recursive: true });
  const before = fs.readFileSync(main(), "utf8"), next = open();
  expect(next.recoveredRun(workspace.id, run.task_id, run.run_id)?.execution_mode).toBeUndefined();
  expect(next.checkExecutionMode(workspace.id, run.task_id)).toBe("read_only");
  expect(() => next.checkExecutionMode(workspace.id, run.task_id, "workspace_write")).toThrow("EXECUTION MODE MISMATCH");
  expect(fs.readFileSync(main(), "utf8")).toBe(before);
});

it.each([null, "writer", {}, [], true])("rejects malformed journal modes before durable begin: %j", mode => {
  const j = open();
  expect(() => j.begin(workspace.id, { ...run, execution_mode: mode as any }, "work")).toThrow();
  expect(fs.existsSync(main())).toBe(false);
});

it("cannot use prepared but uncommitted mode evidence after a failed durable start", () => {
  const j = open(), commit = vi.spyOn(ExtensionStore.prototype, "commit").mockImplementation(() => { throw new Error("fixture commit failure"); });
  expect(() => j.begin(workspace.id, { ...run, execution_mode: "workspace_write" }, "work")).toThrow();
  commit.mockRestore(); j.close();
  const next = open();
  for (const mode of ["read_only", "workspace_write"] as const) {
    expect(() => next.checkExecutionMode(workspace.id, run.task_id, mode)).toThrow("TASK EXECUTION MODE UNVERIFIED");
  }
  expect(next.extensionStatus()).toMatchObject({ evidence: [{ classification: "prepared_uncommitted", approval_granted: false }] });
});

it.each(["conflict", "wrong-binding"])("fails closed on committed but invalid mode evidence: %s", fault => {
  const j = open(); j.begin(workspace.id, { ...run, execution_mode: "read_only" }, "work");
  j.complete(workspace.id, { ...run, state: "completed" });
  const before = fs.readFileSync(main(), "utf8"), store = (j as any).extensions as ExtensionStore;
  const payload = structuredClone(store.entries()[0].payload);
  if (payload.kind !== "execution_mode") throw new Error("expected mode evidence");
  if (fault === "conflict") payload.execution_mode = "workspace_write";
  else payload.binding.request_sha256 = "f".repeat(64);
  store.commit([store.prepare(payload)]);
  j.close(); const next = open();
  for (const mode of ["read_only", "workspace_write"] as const) {
    expect(() => next.checkExecutionMode(workspace.id, run.task_id, mode)).toThrow("TASK EXECUTION MODE UNVERIFIED");
  }
  expect(next.recoveredRun(workspace.id, run.task_id, run.run_id)?.execution_mode).toBeUndefined();
  expect(fs.readFileSync(main(), "utf8")).toBe(before);
});

it.each(["read_only", "workspace_write"] as const)("checkpoint admission preserves %s and burns no approval on mode mismatch", async mode => {
  const first = open(); first.begin(workspace.id, { ...run, execution_mode: mode }, "old"); first.complete(workspace.id, { ...run, state: "completed" }); first.close();
  const journal = open(), target = journal.checkpointTarget(workspace.id, run.task_id, 2, "fresh");
  journal.approveCheckpoint(target, "fresh", evidence.digest, new Date().toISOString(), "e".repeat(32));
  const inspect = vi.fn(async () => evidence);
  const reconciler = new TaskReconciler({ journal, inspect, approve: vi.fn(), isBusy: () => false });
  const startCheckpointTurn = vi.fn(async (task_id, iteration, instruction, admit, execution_mode) => {
    const result = { task_id, iteration, execution_mode, state: "running" as const, run_id: "f".repeat(32) };
    admit(result); return result;
  });
  try {
    await expect(reconciler.continueCheckpoint(workspace as any, run.task_id, 2, "fresh", { startCheckpointTurn }, mode === "read_only" ? "workspace_write" : undefined)).rejects.toMatchObject({ code: "EXECUTION_MODE_MISMATCH" });
    expect(inspect).not.toHaveBeenCalled(); expect(startCheckpointTurn).not.toHaveBeenCalled();
    expect(journal.checkpointStatus(workspace.id, run.task_id)).toMatchObject([{ status: "approved" }]);
    const result = await reconciler.continueCheckpoint(workspace as any, run.task_id, 2, "fresh", { startCheckpointTurn }, mode);
    expect(result.execution_mode).toBe(mode);
    expect(journal.checkpointStatus(workspace.id, run.task_id)).toMatchObject([{ status: "consumed" }]);
    expect(journal.checkStart(workspace.id, run.task_id, 2, "fresh", mode)).toMatchObject({ execution_mode: mode });
    expect(() => journal.beginCheckpoint(workspace.id, { ...result, execution_mode: mode === "read_only" ? "workspace_write" : "read_only" }, "fresh", "e".repeat(32), evidence.digest)).toThrow("EXECUTION MODE MISMATCH");
  } finally { reconciler.close(); }
});
