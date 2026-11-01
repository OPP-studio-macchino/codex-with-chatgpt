import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServer } from "../src/codex/app-server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { CODEX_TURN_TIMEOUT_MS } from "../src/security/owner-dialog-timeouts.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
function withoutShield<T extends Record<string, any>>(run: T): Omit<T, "timeout_shield" | "next_action"> {
  // Compare the unchanged worker result independently of additive response guidance.
  const { timeout_shield: _shield, next_action: _guidance, ...base } = run;
  return base;
}

async function fixture() {
  const root = makeTmpDir("input");
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  vi.stubEnv("C2C_STATE_DIR", state);
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  const binary = path.join(root, "fake.mjs");
  fs.writeFileSync(binary, fs.readFileSync(new URL("./fixtures/codex-input.mjs", import.meta.url)), { mode: 0o700 });
  const workspace = new Workspace(workspaceRoot);
  const journal = new TaskJournal(workspace.id);
  let currentJournal = journal;
  const terminal = vi.fn((run) => journal.complete(workspace.id, run));
  const logger = { ...nullLogger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const codex = new CodexAppServer({ workspaceRoot, binary, logger,
    onRunStarting: (run, instruction) => journal.begin(workspace.id, run, instruction), onRunTerminal: terminal, onElicitation: (run, event) => journal.recordElicitation(workspace.id, run, event) });
  const taskWorkspaces = new Map<string, string>();
  const otherRoot = path.join(root, "other"); fs.mkdirSync(otherRoot);
  const other = new Workspace(otherRoot);
  const server = createMcpServer({ workspace, logger, codex, taskWorkspaces, getTaskJournal: () => currentJournal,
    resolveWorkspace: id => ({ workspace: id === other.id ? other : workspace, codexNetworkHosts: [] }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let scopes = ["codex.execute", "workspace.read"];
  const send = a.send.bind(a);
  a.send = (m, options) => send(m, { ...options, authInfo: { token: "fixture", clientId: "fixture", scopes } });
  const client = new Client({ name: "input-fixture", version: "1" });
  await server.connect(b); await client.connect(a);
  closes.push(async () => { await client.close(); await server.close(); await codex.close(); journal.close(); cleanup(root); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    try { return JSON.parse(text); } catch { return { error: result.isError ? "SCHEMA_REJECTED" : undefined }; }
  };
  const start = (mode = "ASK", task_id = "task", iteration = 1) => call("codex_turn_start", { task_id, iteration, instruction: mode });
  const wait = (run: any) => call("codex_turn_wait", { task_id: run.task_id, run_id: run.run_id });
  const reply = (run: any, extra = { message: "Small" } as Record<string, unknown>) => call("codex_turn_reply", {
    task_id: run.task_id, run_id: run.run_id, input_request_id: run.input_request_id, ...extra,
  });
  const log = () => fs.existsSync(path.join(root, "requests.jsonl"))
    ? fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { useJournal: (value: TaskJournal) => { currentJournal = value; }, codex, client, call, start, wait, reply, log, journal, workspace, other, terminal, taskWorkspaces, logger,
    executor: () => { scopes = ["codex.execute", "workspace.read"]; }, reader: () => { scopes = ["workspace.read"]; }, executionReader: () => { scopes = ["execution.read"]; } };
}

it("exposes approval status as execution.read only without answering a pending question", async () => {
  const f = await fixture(); const run = await f.wait(await f.start());
  const args = { task_id: run.task_id, run_id: run.run_id };
  expect(await f.call("codex_turn_approval_status", args)).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
  f.executionReader();
  expect(await f.call("codex_turn_approval_status", args)).toMatchObject({ run_id: run.run_id, resumable: true, reason: "user_input_required" });
  expect(await f.call("codex_turn_approval_status", { ...args, workspace_id: f.other.id })).toMatchObject({ error: "TASK_WORKSPACE_MISMATCH" });
  expect(await f.reply(run)).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
  expect(f.log().some(m => m.result?.answers || m.result?.decision)).toBe(false);
  expect(f.terminal).not.toHaveBeenCalled();
});

it.each(["ASK", "NONBLOCKING", "LEGACY"])("keeps %s pending live, records only terminal, and replies on the SAME thread/run", async mode => {
  const f = await fixture();
  const run = await f.wait(await f.start(mode));
  const baseRun = withoutShield(run);
  expect(run).toMatchObject({ state: "blocked", resumable: true, reason: "user_input_required",
    timeout_shield: { yield_required: true, reason: "user_action_required", resume_tool: "codex_turn_wait" } });
  expect(run.input_request_id).toMatch(/^[a-f0-9]{32}$/);
  // A caller passing the public blocked presentation must not freeze the run.
  f.journal.complete(f.workspace.id, baseRun);
  expect(JSON.stringify(run)).not.toMatch(/rpc-1|thread-1|sk-abcdefghijkl|\\u001b|\\u202e/);
  expect(f.terminal).not.toHaveBeenCalled();
  expect(f.journal.status(f.workspace.id, run.task_id)).toMatchObject({ tasks: [{ execution_state: "running" }] });
  f.executionReader();
  expect(await f.call("codex_turn_approval_status", { task_id: run.task_id, run_id: run.run_id })).toMatchObject(baseRun);
  expect(await f.call("task_resume_context", { task_id: run.task_id })).toMatchObject({ live_pending_input: baseRun });
  expect(await f.call("task_resume_context", { task_id: run.task_id, workspace_id: f.other.id })).toMatchObject({ error: "TASK_WORKSPACE_MISMATCH" });
  f.executor();
  expect(f.log().some(m => m.result?.answers || m.result?.decision)).toBe(false);
  expect(readExecutionRecords(f.workspace.id, 10)).toEqual([]);
  expect(await f.call("codex_runtime_status")).toMatchObject({ activeRuns: 1, waitingRuns: 1 });
  expect(await f.start("COMPLETE", "competitor")).toMatchObject({ error: "TURN_ACTIVE" });
  expect(await f.reply(run)).toMatchObject({ run_id: run.run_id });
  expect(await f.wait(run)).toMatchObject({ run_id: run.run_id, state: "completed" });
  expect(f.terminal).toHaveBeenCalledTimes(1);
  f.executionReader();
  expect(await f.call("task_resume_context", { task_id: run.task_id })).not.toHaveProperty("live_pending_input");
  f.executor();
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(f.log().filter(m => m.method === "thread/start")).toHaveLength(1);
  expect(f.log().filter(m => m.method === "turn/start")).toHaveLength(1);
  expect(f.log().find(m => m.result?.answers)).toEqual({ id: "rpc-1", result: { answers: { choice: { answers: ["Small"] } } } });
  expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain("Small");
});

it("finds same-runtime live input even when journal presentation is blocked", async () => {
  const f = await fixture(); const run = await f.wait(await f.start()); const baseRun = withoutShield(run);
  const status = f.journal.status.bind(f.journal);
  vi.spyOn(f.journal, "status").mockImplementation((...args) => {
    const saved = status(...args) as { tasks: Array<Record<string, unknown>> };
    return { ...saved, tasks: saved.tasks.map(task => ({ ...task, execution_state: "blocked" })) };
  });
  f.executionReader();
  expect(await f.call("task_resume_context", { task_id: run.task_id })).toMatchObject({
    live_pending_input: baseRun, restores_codex_conversation: false,
  });
  f.executor();
  await f.reply(run);
  expect(await f.wait(run)).toMatchObject({ run_id: run.run_id, state: "completed" });
  f.executionReader();
  expect(await f.call("task_resume_context", { task_id: run.task_id })).not.toHaveProperty("live_pending_input");
});

it.each(["EARLY", "NUMBER_RPC", "MULTI"])("validates protocol identity and supports %s", async mode => {
  const f = await fixture(); const run = await f.wait(await f.start(mode));
  if (mode === "MULTI") expect(await f.reply(run)).toMatchObject({ error: "INVALID_INPUT_REPLY" });
  await f.reply(run, mode === "MULTI" ? { answers: { choice: ["Small"], second: ["Other"] } } : { message: "Small" });
  expect(await f.wait(run)).toMatchObject({ state: "completed" });
});

it.each(["BLOCKING_FLAG", "UNKNOWN_KEY", "SECRET", "FLAG", "PROTOTYPE", "DUPLICATE_QUESTION", "MANY", "OVERSIZE", "OPTIONS", "WRONG_THREAD", "WRONG_TURN", "EARLY_WRONG", "BAD_RPC", "DUPLICATE_RPC"])("fails closed for %s", async mode => {
  const f = await fixture(); const run = await f.wait(await f.start(mode));
  expect(run.state).toBe("failed"); expect(run.resumable).toBeUndefined();
  expect(f.log().some(m => m.result?.answers)).toBe(false);
});

it("rejects ambiguous, malformed, secret-shaped and stale replies without consuming valid input", async () => {
  const f = await fixture(); const run = await f.wait(await f.start("TWICE"));
  for (const args of [ {}, { message: "a", answers: { choice: ["a"] } }, { answers: {} }, { answers: { choice: [] } },
    { answers: { choice: ["a", "a"] } }, { answers: { choice: [1] } }, { answers: { choice: ["a"], constructor: ["b"] } },
    { message: "sk-abcdefghijklmnop123456" }, { message: "password=hidden" }, { message: "\u0000" }, { message: "x".repeat(2049) } ]) {
    // Oversized strings may be rejected by the MCP schema before reaching the handler.
    const result = await f.reply(run, args);
    expect(result.error).toBeTruthy();
    expect((await f.wait(run)).input_request_id).toBe(run.input_request_id);
  }
  expect(await f.reply(run, { message: "a", input_request_id: "0".repeat(32) })).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(await f.reply(run, { message: "a", run_id: "0".repeat(32) })).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(await f.reply(run, { message: "a", workspace_id: f.other.id })).toMatchObject({ error: "TASK_WORKSPACE_MISMATCH" });
  await f.reply(run);
  const second = await f.wait(run);
  expect(second.input_request_id).not.toBe(run.input_request_id);
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  await f.reply(second); expect(await f.wait(run)).toMatchObject({ state: "completed" });
});

it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "mcpServer/elicitation/request"])("does not reply to approval/elicitation %s", async method => {
  const f = await fixture(); const run = await f.wait(await f.start("APPROVAL:" + method));
  expect(run.state).toBe(method === "mcpServer/elicitation/request" ? "failed" : "blocked"); expect(run.resumable).toBe(method === "mcpServer/elicitation/request" ? undefined : false);
  expect(run.reason).toBe(method === "mcpServer/elicitation/request" ? "mcp_elicitation_unsupported" : "read_only_approval_denied");
  expect(run.input_request_id).toBeUndefined();
  expect(run.questions).toBeUndefined();
  expect(f.terminal).toHaveBeenCalledTimes(1);
  f.executionReader();
  expect(await f.call("task_resume_context", { task_id: run.task_id })).not.toHaveProperty("live_pending_input");
  f.executor();
  expect(await f.reply({ ...run, input_request_id: "0".repeat(32) })).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
});

it("requires execute scope for replies and diagnostics", async () => {
  const f = await fixture(); const run = await f.wait(await f.start()); f.reader();
  expect(await f.reply(run)).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
  expect(await f.call("codex_runtime_status")).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
  expect(f.log().some(m => m.result?.answers)).toBe(false);
});

it("consumes once on transport write failure and never retries a failed reply", async () => {
  const f = await fixture(); const run = await f.wait(await f.start());
  const child = (f.codex as any).child;
  const write = vi.spyOn(child.stdin, "write").mockImplementation(() => { throw new Error("fixture write failure"); });
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REPLY_FAILED" });
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(write).toHaveBeenCalledTimes(1); write.mockRestore();
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "protocol_write_failed" });
});

it("rejects concurrent duplicate replies and ignores stale-epoch request/resolution", async () => {
  const f = await fixture(); const run = await f.wait(await f.start());
  const runtime = f.codex as any;
  runtime.onMessage({ id: "stale", method: "item/tool/requestUserInput", params: {} }, runtime.activeEpoch - 1);
  runtime.onMessage({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "rpc-1" } }, runtime.activeEpoch - 1);
  runtime.onMessage({ method: "serverRequest/resolved", params: { threadId: "wrong", requestId: "rpc-1" } }, runtime.activeEpoch);
  expect((await f.wait(run)).input_request_id).toBe(run.input_request_id);
  const results = await Promise.all([f.reply(run), f.reply(run)]);
  expect(results.filter(r => r.error === "INPUT_REQUEST_NOT_FOUND")).toHaveLength(1);
  expect(await f.wait(run)).toMatchObject({ state: "completed" });
  runtime.onMessage({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "rpc-1" } }, runtime.activeEpoch);
  expect((await f.wait(run)).resumable).toBeUndefined();
});

it("keeps the write-ahead record running; restart cannot recreate pending input", async () => {
  const f = await fixture(); const run = await f.wait(await f.start());
  expect(f.journal.recoveredRun(f.workspace.id, run.task_id, run.run_id)).toBeNull();
  // Release the journal without writing terminal state, simulating process loss.
  f.journal.close();
  const recovered = new TaskJournal(f.workspace.id);
  try {
    f.useJournal(recovered);
    f.executionReader();
    const context = await f.call("task_resume_context", { task_id: run.task_id });
    expect(context).toMatchObject({ tasks: [{ execution_state: "interrupted", can_resume_original_context: false }] });
    expect(context).not.toHaveProperty("live_pending_input");
    expect(() => recovered.recoveredRun(f.workspace.id, run.task_id, run.run_id)).toThrow("TASK RECOVERY REQUIRED");
    expect(() => recovered.checkStart(f.workspace.id, run.task_id, 1, "ASK")).toThrow("TASK RECOVERY REQUIRED");
  } finally { recovered.close(); }
});

it.each(["EXIT", "INTERRUPT", "RESOLVED"])("cleans pending input on %s without revival", async mode => {
  const f = await fixture(); const run = await f.wait(await f.start(mode));
  expect(run.input_request_id).toMatch(/^[a-f0-9]{32}$/);
  // Synchronize with parent-observed cleanup, not elapsed time since child scheduling.
  await vi.waitFor(() => {
    const current = (f.codex as any).runs.get(run.run_id);
    expect(current.input).toBeUndefined();
    if (mode === "EXIT") expect(current).toMatchObject({ state: "failed", reason: "child_exit" });
    else if (mode === "INTERRUPT") expect(current).toMatchObject({ state: "failed", reason: "codex_turn_failed" });
    else {
      expect(mode).toBe("RESOLVED");
      expect(current.state).toBe("running");
      expect(f.terminal).not.toHaveBeenCalled();
    }
  }, { interval: 10, timeout: 2000 });
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect((await f.wait(run)).resumable).toBeUndefined();
});

it("bounds pending time with the original turn timer and rejects after close", async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const run = await f.wait(await f.start());
  await vi.advanceTimersByTimeAsync(CODEX_TURN_TIMEOUT_MS);
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "turn_timeout" });
  vi.useRealTimers();
  const g = await fixture(); const other = await g.wait(await g.start()); await g.codex.close();
  expect(await g.reply(other)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
});

it.each([undefined, "4", "12", "invalid"])("reports actual limits without spawning/registering for env %s", async setting => {
  vi.stubEnv("C2C_CODEX_MAX_ITERATIONS", setting);
  vi.stubEnv("C2C_CODEX_WAIT_TIMEOUT_MS", "invalid");
  const f = await fixture(); const status = await f.call("codex_runtime_status");
  expect(status).toMatchObject({ maxIterations: null, hardMaxIterations: null,
    iterationConfiguration: { key: "C2C_CODEX_MAX_ITERATIONS", source: "removed" },
    wait: { defaultMs: 1000, effectiveMs: 1000, hardCeilingMs: 3000, source: "invalid_env_fallback" }, activeRuns: 0, waitingRuns: 0 });
  expect(f.log()).toEqual([]); expect(f.taskWorkspaces.size).toBe(0);
  expect((f.codex as any).child).toBeNull();
  expect((f.codex as any).epochCounter).toBe(0);
  const tools = (await f.client.listTools()).tools;
  expect(tools.find(t => t.name === "codex_runtime_status")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(tools.find(t => t.name === "codex_turn_reply")?.description).toContain("current user's explicit answer");
  expect(tools.find(t => t.name === "codex_turn_reply")?.description).toContain("approval_required and mcpServer elicitation are NOT enabled");
  for (let iteration = 1; iteration <= 14; iteration++) {
    expect(await f.wait(await f.start("COMPLETE", "task", iteration))).toMatchObject({ state: "completed" });
  }
  await expect(f.codex.startTurn("task", 16, "COMPLETE")).rejects.toMatchObject({ code: "INVALID_ITERATION" });
  await expect(f.codex.startTurn("task", 1.5, "COMPLETE")).rejects.toMatchObject({ code: "INVALID_ITERATION" });
});

it.each([null, 1200000])("accepts bounded nullable autoResolutionMs=%s and clears its timer on reply", async value => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const run = await f.wait(await f.start("DEADLINE:" + JSON.stringify(value)));
  expect(run.resumable).toBe(true);
  await f.reply(run);
  expect(await f.wait(run)).toMatchObject({ state: "completed" });
  await vi.advanceTimersByTimeAsync(1200000);
  expect(await f.wait(run)).toMatchObject({ state: "completed" });
  expect(f.terminal).toHaveBeenCalledTimes(1);
});

it.each([-1, 0.5, 1200001, "100", true, {}])("rejects malformed autoResolutionMs=%s", async value => {
  const f = await fixture(); const run = await f.wait(await f.start("DEADLINE:" + JSON.stringify(value)));
  expect(run).toMatchObject({ state: "failed", reason: "invalid_input_request" });
  expect(f.log().some(m => m.result?.answers)).toBe(false);
});

it.each([0, 100])("expires an explicit input deadline (%s ms), invalidates its nonce and never answers", async ms => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const run = await f.wait(await f.start("DEADLINE:" + ms));
  await vi.advanceTimersByTimeAsync(ms);
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "input_timeout" });
  expect(f.codex.hasBlockingRun()).toBe(false);
  expect(f.terminal).toHaveBeenCalledTimes(1);
  expect(f.log().some(m => m.result?.answers)).toBe(false);
});

it("rejects an expired nonce even before the deadline callback runs", async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const run = await f.wait(await f.start("DEADLINE:100"));
  vi.setSystemTime(Date.now() + 101);
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "input_timeout" });
});

it.each([false, true])("bounds backpressure with no callback; late callback=%s cannot affect a later epoch", async late => {
  const f = await fixture(); const run = await f.wait(await f.start());
  const runtime = f.codex as any;
  const epoch = runtime.activeEpoch;
  let callback: (error?: Error) => void = () => { throw new Error("missing callback"); };
  const write = vi.spyOn(runtime.child.stdin, "write").mockImplementation((_data, cb) => { callback = cb as typeof callback; return false; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = f.codex.reply(run.task_id, run.run_id, run.input_request_id, "Small").catch(error => error);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await pending).toMatchObject({ code: "INPUT_REPLY_FAILED" });
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "input_reply_timeout" });
  expect(await f.reply(run)).toMatchObject({ error: "INPUT_REQUEST_NOT_FOUND" });
  expect(write).toHaveBeenCalledTimes(1); write.mockRestore();
  vi.useRealTimers();
  const next = await f.wait(await f.start("ASK", "fixture-next-epoch"));
  expect(runtime.activeEpoch).toBeGreaterThan(epoch);
  if (late) { callback(); callback(new Error("late failure")); }
  expect((await f.wait(next)).input_request_id).toBe(next.input_request_id);
  expect(f.terminal).toHaveBeenCalledTimes(1);
  await f.reply(next); expect(await f.wait(next)).toMatchObject({ state: "completed" });
});

it("clears the reply delivery timer on successful callback", async () => {
  const f = await fixture(); const run = await f.wait(await f.start());
  const runtime = f.codex as any;
  let callback: (error?: Error) => void = () => { throw new Error("missing callback"); };
  const write = vi.spyOn(runtime.child.stdin, "write").mockImplementation((_data, cb) => { callback = cb as typeof callback; return false; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = f.codex.reply(run.task_id, run.run_id, run.input_request_id, "Small");
  expect(vi.getTimerCount()).toBe(1);
  callback(); expect(await pending).toMatchObject({ state: "running" });
  expect(vi.getTimerCount()).toBe(0);
  callback(new Error("duplicate callback"));
  expect(f.terminal).not.toHaveBeenCalled();
  write.mockRestore(); vi.useRealTimers();
});
