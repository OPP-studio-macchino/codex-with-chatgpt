import { afterEach, expect, it, vi } from "vitest";
import { TaskJournal } from "../src/execution/task-journal.js";
import { TaskReconciler } from "../src/execution/task-reconciler.js";
import { approvalMessage } from "../src/execution/reconciliation-approval.js";
import { createHash } from "node:crypto";
import { readExecutionRecords, readLegacySnapshot } from "../src/execution/records.js";
import fs from "node:fs";
import { CodexAppServer } from "../src/codex/app-server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { nullLogger } from "../src/logger/index.js";
vi.mock("../src/execution/records.js", () => ({ readExecutionRecords: vi.fn(), readLegacySnapshot: vi.fn() }));

const workspace = { id: "a".repeat(24), root: "/approved/fixture", name: "fixture" };
const missing = { iteration: 4, run_id: "4".repeat(32) };
const evidence = { digest: "e".repeat(64), head: "a".repeat(40), fileCount: 1, changedCount: 0,
  processScope: "same-user-cwd" as const, fileScope: "git-index-status-and-dirty-worktree-excluding-appledouble" as const };
const instruction = "Inspect current state only; no historical replay.";
function fixture() {
  const records = [1, 2, 3].map(iteration => ({ taskId: "same", iteration, runId: String(iteration).repeat(32),
    changedFiles: null, tests: "untrusted PASS", exitStatus: "ok" as const, timestamp: "2026-09-30T00:00:00Z" }));
  vi.mocked(readExecutionRecords).mockImplementation(id => id === workspace.id ? records : []);
  // Pure journal fixture: no constructor, lock acquisition, filesystem or live writer.
  vi.mocked(readLegacySnapshot).mockImplementation((id, task) => {
    if (id !== workspace.id || task !== "same") throw new Error("absent source");
    return { records, sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex") };
  });
  const journal = Object.assign(Object.create(TaskJournal.prototype), { targetWorkspaceId: workspace.id,
    runtimeId: "f".repeat(32), runs: [], checkpoints: [], healthy: true, closed: false, diskSnapshot: null,
    extensions: { available: true, entries: () => [] },
    ownsLock: () => true, read: () => null });
  const save = vi.fn((runs, checkpoints = journal.checkpoints) => {
    runs = runs.map(({ execution_mode, ...run }: any) => run);
    journal.validateRecords(runs); journal.validateCheckpoints(runs, checkpoints);
    journal.runs = runs; journal.checkpoints = checkpoints;
  });
  journal.save = save;
  const approve = vi.fn(async () => "approved" as const);
  const inspect = vi.fn(async () => evidence);
  const reconciler = new TaskReconciler({ journal, inspect, approve, isBusy: () => false });
  const spawned = vi.fn();
  const codex = { startCheckpointTurn: vi.fn(async (task_id, iteration, _instruction, admit) => {
    const run = { task_id, iteration, run_id: "5".repeat(32), state: "running" as const,
      checkpoint_continuation: true as const, original_context_restored: false as const };
    admit(run); spawned(); return run;
  }) };
  return { journal, save, approve, inspect, reconciler, spawned, codex, records };
}
async function prepare(f: ReturnType<typeof fixture>) {
  const job = f.reconciler.prepareCheckpoint(workspace as never, "same", 5, instruction, missing) as { reconciliation_id: string };
  for (let n = 0; n < 12; n++) await Promise.resolve();
  return f.reconciler.status(workspace.id, job.reconciliation_id);
}
afterEach(() => vi.restoreAllMocks());

it("keeps checkpoint grants at exactly 60 seconds after the owner clicks approve", async () => {
  const f = fixture();
  try {
    await prepare(f);
    const checkpoint = f.journal.checkpoints[0];
    expect(Date.parse(checkpoint.expires_at) - Date.parse(checkpoint.owner_approved_at)).toBe(60_000);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(checkpoint.expires_at) - 1);
    expect(f.journal.approvedCheckpoint(workspace.id, "same", 5, instruction)).toBeTruthy();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(checkpoint.expires_at));
    expect(() => f.journal.approvedCheckpoint(workspace.id, "same", 5, instruction)).toThrow();
  } finally { f.reconciler.close(); }
});

it("describes an approved Git publish as a direct one-time structured mutation, not a Codex continuation", () => {
  const message = approvalMessage({
    workspaceName: "fixture", workspaceRoot: workspace.root, taskId: "same", evidence,
    checkpoint: {
      workspace_id: workspace.id, task_id: "same", next_iteration: 5,
      source: "legacy_execution_records", source_sha256: "a".repeat(64),
      known_records: [{ iteration: 3, run_id: "3".repeat(32) }],
      request_sha256: "b".repeat(64),
      instruction_excerpt: "C2C Git publish v1: stage exact paths; force selected index modes 100644; commit exact index; non-force HTTPS push.",
      instruction_truncated: false,
    },
  });
  expect(message).toContain("構造化Git publish");
  expect(message).toContain("100644");
  expect(message).toContain("non-force HTTPS push");
  expect(message).toContain("汎用shell");
  expect(message).not.toContain("新しい一時的な会話");
});

it("approves SAME task5 with known1..3 and UNKNOWN4, consumes before fake spawn, no fake4", async () => {
  const f = fixture();
  expect(await prepare(f)).toMatchObject({ state: "reconciled", purpose: "checkpoint_continuation", next_iteration: 5 });
  expect(f.spawned).not.toHaveBeenCalled();
  expect(f.journal.runs).toEqual([]);
  expect(f.journal.checkpoints[0]).toMatchObject({ status: "approved", reported_missing_run: { ...missing, provenance: "user_reported_unknown" } });
  const display = approvalMessage(f.approve.mock.calls[0][0]);
  expect(display).toContain("UNKNOWN"); expect(display).toContain("元の会話は復元しません");
  const run = await f.reconciler.continueCheckpoint(workspace as never, "same", 5, instruction, f.codex);
  expect(run).toMatchObject({ task_id: "same", iteration: 5, original_context_restored: false });
  expect(f.journal.runs.map((r: { iteration: number }) => r.iteration)).toEqual([5]);
  expect(f.journal.checkpoints[0]).toMatchObject({ status: "consumed", consumed_run_id: run.run_id });
  expect(f.inspect).toHaveBeenCalledTimes(3); expect(f.approve).toHaveBeenCalledTimes(1); expect(f.spawned).toHaveBeenCalledTimes(1);
  await expect(f.reconciler.continueCheckpoint(workspace as never, "same", 5, instruction, f.codex)).rejects.toThrow("CHECKPOINT UNAVAILABLE");
  expect(f.journal.checkStart(workspace.id, "same", 5, instruction)).toMatchObject({ run_id: run.run_id, checkpoint_continuation: true });
  f.reconciler.close();
});

it.each(["wrong_workspace", "absent", "rewind", "skip", "conflict", "corrupt"])("rejects preparation: %s", kind => {
  const f = fixture();
  if (kind === "corrupt") f.journal.healthy = false;
  expect(() => f.journal.checkpointTarget(kind === "wrong_workspace" ? "b".repeat(24) : workspace.id,
    kind === "absent" ? "absent" : "same", kind === "rewind" ? 3 : kind === "skip" ? 6 : 5, instruction,
    kind === "conflict" ? { ...missing, run_id: "3".repeat(32) } : missing)).toThrow();
  expect(f.save).not.toHaveBeenCalled(); expect(f.spawned).not.toHaveBeenCalled(); f.reconciler.close();
});

it.each(["denied", "unavailable", "timed_out"])("does not admit without owner approval: %s", async decision => {
  const f = fixture(); f.approve.mockResolvedValue(decision as never);
  expect(await prepare(f)).toMatchObject({ state: "denied" });
  expect(f.save).not.toHaveBeenCalled(); expect(f.spawned).not.toHaveBeenCalled(); f.reconciler.close();
});

it.each(["expiry", "runtime", "instruction", "evidence", "legacy", "persist"])("refuses stale/invalid admission before spawn: %s", async kind => {
  const f = fixture(); await prepare(f);
  if (kind === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
  if (kind === "runtime") f.journal.runtimeId = "b".repeat(32);
  if (kind === "evidence") f.inspect.mockResolvedValue({ ...evidence, digest: "d".repeat(64) });
  if (kind === "legacy") f.records[0].timestamp = "2026-09-29T00:00:00Z";
  if (kind === "persist") f.save.mockImplementation(() => { throw new Error("disk failure"); });
  await expect(f.reconciler.continueCheckpoint(workspace as never, "same", 5,
    kind === "instruction" ? "different" : instruction, f.codex)).rejects.toThrow();
  expect(f.spawned).not.toHaveBeenCalled(); f.reconciler.close();
});

it("rejects malformed checkpoint shapes and preserves ordinary empty-journal start", () => {
  const f = fixture();
  expect(() => f.journal.validateCheckpoints([], [{ status: "approved" }])).toThrow();
  expect(f.journal.checkStart(workspace.id, "ordinary", 1, "fresh")).toBeNull();
  expect(f.journal.checkpoints).toEqual([]); f.reconciler.close();
});

it("keeps the existing reconciliation controller path", async () => {
  const f = fixture();
  const target = { workspace_id: workspace.id, task_id: "old", run_id: "9".repeat(32), source_record_sha256: "a".repeat(64) };
  f.journal.reconciliationTarget = vi.fn(() => target);
  f.journal.reconciliationProcessContext = vi.fn(() => undefined); // This controller-only fixture has no historical run rows.
  f.journal.reconcileConfirmed = vi.fn();
  const job = f.reconciler.start(workspace as never, "old", target.run_id) as { reconciliation_id: string };
  for (let n = 0; n < 12; n++) await Promise.resolve();
  expect(f.reconciler.status(workspace.id, job.reconciliation_id)).toMatchObject({ state: "reconciled", next_action: "REVIEW_REMAINING_BLOCKERS_THEN_NEW_TASK" });
  expect(f.journal.reconcileConfirmed).toHaveBeenCalledTimes(1);
  expect(f.save).not.toHaveBeenCalled(); f.reconciler.close();
});

it.each(["legacy", "authoritative", "persist", "cancel", "scope", "retired-cap", "after12"])("MCP with real Codex start logic and fake child protocol: %s", async mode => {
  const f = fixture();
  const nextIteration = mode === "after12" ? 13 : 5;
  const authoritative = mode === "authoritative" || mode === "after12";
  if (authoritative) {
    f.journal.runs = [{ task_id: "same", workspace_id: workspace.id, iteration: nextIteration - 1, run_id: missing.run_id,
      state: "running", runtime_id: "b".repeat(32), instruction_excerpt: "old", instruction_truncated: false,
      request_sha256: "a".repeat(64), started_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z" }];
  }
  vi.spyOn(fs.realpathSync, "native").mockImplementation(p => String(p));
  vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true, mode: 0o755 } as never);
  vi.spyOn(fs, "accessSync").mockImplementation(() => {});
  vi.stubEnv("C2C_CODEX_MAX_ITERATIONS", mode === "retired-cap" ? "4" : "12");
  const codex = new CodexAppServer({ workspaceRoot: workspace.root, binary: "/fixture/codex", logger: nullLogger,
    onRunStarting: (r, i) => f.journal.begin(workspace.id, r, i), onRunTerminal: r => f.journal.complete(workspace.id, r) });
  const child = vi.spyOn(codex as any, "ensureInitialized").mockResolvedValue(undefined);
  const protocol = vi.spyOn(codex as any, "request").mockImplementation(async (method: unknown) => method === "thread/start" ? { thread: { id: "new-ephemeral" }, cwd: workspace.root, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } } : { turn: { id: "turn" } });
  const server = createMcpServer({ workspace: workspace as never, logger: nullLogger, codex,
    getTaskJournal: () => f.journal, getTaskReconciler: () => f.reconciler });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const send = a.send.bind(a);
  a.send = (message, options) => send(message, { ...options, authInfo: { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: mode === "scope" ? ["execution.read"] : ["execution.read", "codex.execute"] } });
  const client = new Client({ name: "checkpoint-integration", version: "1" });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: object) => {
    const response = await client.callTool({ name, arguments: { workspace_id: workspace.id, task_id: "same", ...args } });
    return JSON.parse((response.content as Array<{ text: string }>)[0].text);
  };
  try {
    const job = await call("task_checkpoint_start", { next_iteration: nextIteration, instruction, ...(authoritative ? {} : { reported_missing_run: missing }) });
    if (mode === "scope") { expect(job.error).toBe("INSUFFICIENT_SCOPE"); expect(f.approve).not.toHaveBeenCalled(); return; }
    for (let n = 0; n < 15; n++) await Promise.resolve();
    expect(f.reconciler.status(workspace.id, job.reconciliation_id)).toMatchObject({ state: "reconciled" });
    expect(job.run_id).toBeUndefined();
    if (mode === "persist") f.save.mockImplementation(() => { throw new Error("persist failed"); });
    if (mode === "cancel") f.reconciler.cancelPending();
    const result = await call("codex_turn_start", { iteration: nextIteration, instruction });
    if (mode === "persist" || mode === "cancel") { expect(result.error).toBeDefined(); expect(child).not.toHaveBeenCalled(); return; }
    expect(result).toMatchObject({ task_id: "same", iteration: nextIteration, checkpoint_continuation: true, original_context_restored: false });
    expect((await call("codex_turn_start", { iteration: nextIteration, instruction })).run_id).toBe(result.run_id);
    expect((await call("codex_turn_start", { iteration: nextIteration, instruction: "different" })).error).toBe("TASK_REQUEST_MISMATCH");
    expect(child).toHaveBeenCalledTimes(1);
    const run = (codex as any).runs.get(result.run_id);
    (codex as any).finish(run, "completed");
    const terminal = (codex as any).publicResult(run);
    f.journal.complete(workspace.id, terminal); f.journal.complete(workspace.id, terminal);
    expect((await call("codex_turn_wait", { run_id: result.run_id })).state).toBe("completed");
    const next = await call("codex_turn_start", { iteration: nextIteration + 1, instruction: "new iteration6" });
    expect(next.iteration).toBe(nextIteration + 1);
    expect(protocol.mock.calls.filter(c => c[0] === "thread/start")).toHaveLength(1);
    expect(f.journal.runs.filter((r: any) => r.iteration === nextIteration)).toHaveLength(1);
    if (authoritative) expect(f.journal.runs[0]).toMatchObject({ iteration: nextIteration - 1, state: "running", runtime_id: "b".repeat(32) });
    else expect(f.journal.runs.some((r: any) => r.iteration === 4)).toBe(false);
    const turn = protocol.mock.calls.find(c => c[0] === "turn/start")![1] as any;
    expect(turn.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  } finally {
    for (const run of (codex as any).runs.values()) if (run.timer) clearTimeout(run.timer);
    await client.close(); await server.close(); f.reconciler.close(); vi.unstubAllEnvs();
  }
});

it("legacy-known tasks cannot start5 or rewind1 without approval; other uncertainty still blocks", async () => {
  const f = fixture();
  expect(() => f.journal.checkStart(workspace.id, "same", 5, instruction)).toThrow();
  expect(() => f.journal.checkStart(workspace.id, "same", 1, instruction)).toThrow();
  await prepare(f);
  const run = await f.reconciler.continueCheckpoint(workspace as never, "same", 5, instruction, f.codex);
  f.journal.complete(workspace.id, { ...run, state: "completed" });
  f.journal.runs.push({ ...f.journal.runs[0], task_id: "other", iteration: 1, run_id: "a".repeat(32), runtime_id: "b".repeat(32), state: "running" });
  expect(() => f.journal.checkStart(workspace.id, "same", 6, "fresh6")).toThrow("WORKSPACE RECOVERY REQUIRED");
  f.reconciler.close();
});

it.each(["duplicate_known", "duplicate_checkpoint", "bad_expiry", "consumed_without_run", "approved_with_run", "wrong_workspace", "bad_missing"])("rejects malformed checkpoint semantics %s", async mode => {
  const f = fixture(); await prepare(f);
  const c = structuredClone(f.journal.checkpoints[0]);
  if (mode === "duplicate_known") c.known_records.push(c.known_records[0]);
  if (mode === "bad_expiry") c.expires_at = c.owner_approved_at;
  if (mode === "consumed_without_run") c.status = "consumed";
  if (mode === "approved_with_run") c.consumed_run_id = "a".repeat(32);
  if (mode === "wrong_workspace") c.workspace_id = "b".repeat(24);
  if (mode === "bad_missing") c.reported_missing_run.iteration = 2;
  expect(() => f.journal.validateCheckpoints([], mode === "duplicate_checkpoint" ? [c, c] : [c])).toThrow();
  f.reconciler.close();
});

it.each(["approval", "reinspection"])("cancellation wins the %s race", async phase => {
  const f = fixture();
  let release!: (value: any) => void;
  if (phase === "approval") f.approve.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  if (phase === "approval") {
    f.reconciler.prepareCheckpoint(workspace as never, "same", 5, instruction, missing);
    for (let n = 0; n < 5; n++) await Promise.resolve();
    f.reconciler.cancelPending(); release("approved");
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(f.save).not.toHaveBeenCalled();
  } else {
    await prepare(f); f.inspect.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.reconciler.continueCheckpoint(workspace as never, "same", 5, instruction, f.codex);
    f.reconciler.cancelPending(); release(evidence);
    await expect(pending).rejects.toThrow();
    expect(f.journal.checkpointStatus(workspace.id, "same")[0]).toMatchObject({ status: "revoked" });
  }
  expect(f.spawned).not.toHaveBeenCalled(); f.reconciler.close();
});
