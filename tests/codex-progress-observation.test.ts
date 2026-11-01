import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { CodexAppServer, type CodexAppServerOptions } from "../src/codex/app-server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const actions: Array<() => unknown> = [];
afterEach(async () => {
  for (const action of actions.splice(0).reverse()) await action();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

// Deterministic JSON-line App Server fixture: real start admission and event parser,
// fixed request replies, no provider process, clock or scheduling dependency.
async function fixture(options: Partial<CodexAppServerOptions> = {}) {
  const root = makeTmpDir("progress"); actions.push(() => cleanup(root));
  const codex = new CodexAppServer({ workspaceRoot: root, binary: process.execPath, logger: nullLogger, ...options });
  actions.push(() => codex.close());
  const internal = codex as any;
  vi.spyOn(internal, "ensureInitialized").mockImplementation(async () => { internal.activeEpoch = 7; });
  vi.spyOn(internal, "request").mockImplementation(async (...args: unknown[]) => args[0] === "thread/start"
    ? { cwd: root, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, thread: { id: "thread-1" } }
    : { turn: { id: "turn-1" } });
  const started = await codex.startTurn("task", 1, "inspect fixture");
  const run = internal.runs.get(started.run_id);
  const event = (method: string, params: unknown, epoch = 7) =>
    internal.onStdout(Buffer.from(JSON.stringify({ method, params }) + "\n"), epoch);
  const item = (completed: boolean, id: unknown = "item-1", fields = {}, binding = {}, epoch = 7) => event(
    completed ? "item/completed" : "item/started",
    { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id,
      status: completed ? "completed" : "inProgress", exitCode: completed ? 0 : null, ...fields }, ...binding }, epoch);
  const milestone = (id: unknown = "item-1", fields = {}) => { item(false, id, fields); item(true, id, fields); };
  const read = () => codex.observeRun("task", started.run_id);
  const terminal = (status = "completed", items: unknown[] = []) => event("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status, items } });
  return { codex, internal, run, started, event, item, milestone, read, terminal, root };
}

it("advances once for a validated completion; snapshots, reads, waits and duplicates stay stable", async () => {
  const f = await fixture();
  expect(f.read()).toEqual({ state: "running" });
  f.item(false); expect(f.read().progress).toBeUndefined();
  f.item(true);
  const first = f.read().progress!;
  expect(first).toEqual({ cursor: expect.stringMatching(/^[a-f0-9]{36}$/), phase: "command_completed" });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(128);
  expect(f.codex.approvalStatus("task", f.started.run_id)).not.toHaveProperty("progress");
  expect(await f.codex.startTurn("task", 1, "duplicate")).not.toHaveProperty("progress");
  for (let i = 0; i < 20; i++) { f.milestone(); expect(f.read().progress).toEqual(first); }
  vi.useFakeTimers();
  const waited = f.codex.wait("task", f.started.run_id);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await waited).not.toHaveProperty("progress");
  vi.useRealTimers();
  const detached = f.read(); detached.progress!.cursor = "changed";
  expect(f.read().progress).toEqual(first);
  f.milestone("item-2");
  expect(f.read().progress!.cursor > first.cursor).toBe(true);
  expect(f.read().progress!.cursor.slice(0, 32)).toBe(first.cursor.slice(0, 32));
});

it.each(["heartbeat", "turn/started", "thread/tokenUsage/updated", "item/agentMessage/delta", "item/reasoning/textDelta", "item/commandExecution/outputDelta"])("ignores %s without retaining or leaking text", async method => {
  const f = await fixture();
  f.event(method, { threadId: "thread-1", turnId: "turn-1", text: "private:/path?nonce=secret", tokens: 999 });
  expect(f.read()).toEqual({ state: "running" });
  expect(f.run.progressItems.size).toBe(0);
});

it.each(["agentMessage", "reasoning", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "plan", "contextCompaction", "tool"])("does not count unsupported %s completion", async type => {
  const f = await fixture(); f.milestone("private-id", { type, text: "private text" });
  expect(f.read()).toEqual({ state: "running" }); expect(f.run.progressItems.size).toBe(0);
});

it.each([undefined, null, 1, {}, "", "x".repeat(257), "日".repeat(86), "bad\n", "bad\u200b"])("rejects missing or unbounded identity %#", async id => {
  const f = await fixture(); f.milestone(id === undefined ? null : id);
  if (id === undefined) { f.item(false, "ignored", { id: undefined }); f.item(true, "ignored", { id: undefined }); }
  expect(f.read().progress).toBeUndefined(); expect(f.run.progressItems.size).toBe(0);
});

it("accepts bounded UTF-8 private IDs but exports only fixed phase and independent opaque cursor", async () => {
  const f = await fixture();
  const id = "日".repeat(85) + "a";
  f.milestone(id, { command: "secret argv", cwd: "/private/path", aggregatedOutput: "SECRET", env: { TOKEN: "secret" }, url: "https://private", label: "private", approvalNonce: "secret" });
  expect(f.read().progress?.phase).toBe("command_completed");
  const serialized = JSON.stringify(f.read());
  for (const text of [id, "secret", "private", "argv", "TOKEN", "https", "SECRET"]) expect(serialized).not.toContain(text);
  expect(Object.keys(f.read().progress!)).toEqual(["cursor", "phase"]);
});

it.each([{ status: "failed" }, { status: "declined" }, { status: "inProgress" }, { status: null }, { exitCode: 1 }, { exitCode: "0" }, { exitCode: null }, { exitCode: undefined }])("rejects malformed/unsuccessful completion and never replays it: %j", async fields => {
  const f = await fixture(); f.item(false); f.item(true, "item-1", fields); f.milestone();
  expect(f.read().progress).toBeUndefined();
});

it("rejects out-of-order completion, then start/replay, and events before turn identity is known", async () => {
  const f = await fixture();
  f.item(true); f.milestone(); expect(f.read().progress).toBeUndefined();
  f.run.turnId = undefined; f.milestone("early"); f.run.turnId = "turn-1";
  f.item(true, "early"); expect(f.read().progress).toBeUndefined();
  f.milestone("fresh"); expect(f.read().progress).toBeDefined();
});

it.each([{ threadId: "wrong" }, { turnId: "wrong" }, { threadId: null }, { turnId: null }])("ignores wrong binding %j", async binding => {
  const f = await fixture(); f.item(false, "item", {}, binding); f.item(true, "item", {}, binding);
  expect(f.read().progress).toBeUndefined(); expect(f.run.progressItems.size).toBe(0);
  expect(f.codex.observeRun("other-task", f.started.run_id)).toEqual({ state: "unknown" });
  expect(f.codex.observeRun("task", "a".repeat(32))).toEqual({ state: "unknown" });
});

it("ignores old child epoch and late previous-turn events without moving either run", async () => {
  const f = await fixture(); f.item(false, "epoch", {}, {}, 6); f.item(true, "epoch", {}, {}, 6);
  expect(f.run.progressItems.size).toBe(0);
  f.milestone(); const first = f.read(); f.terminal();
  f.milestone("late"); expect(f.read().progress).toEqual(first.progress);
  (f.internal.request as ReturnType<typeof vi.fn>).mockResolvedValue({ turn: { id: "turn-2" } });
  const second = await f.codex.startTurn("task", 2, "continue");
  f.milestone("previous-turn");
  expect(f.codex.observeRun("task", second.run_id)).toEqual({ state: "running" });
  f.item(false, "next", {}, { turnId: "turn-2" }); f.item(true, "next", {}, { turnId: "turn-2" });
  expect(f.codex.observeRun("task", second.run_id).progress!.cursor.slice(0, 32)).not.toBe(first.progress!.cursor.slice(0, 32));
});

it.each(["approval", "input", "elicitation"])("WAITING for %s never advances, clears or consumes it", async kind => {
  const f = await fixture(); f.milestone("before"); const prior = f.read().progress;
  f.item(false, "waiting");
  const pending = { turnId: "turn-1", nonce: "PRIVATE_NONCE", params: { itemId: "approval-other" } }; f.run[kind] = pending;
  expect(f.read()).toEqual({ state: "waiting", progress: prior });
  f.item(true, "waiting"); expect(f.run[kind]).toBe(pending);
  expect(f.read().progress).toEqual(prior);
  delete f.run[kind]; f.milestone("waiting"); expect(f.read().progress).toEqual(prior);
});

it("caps retained IDs at 256 and permanently withdraws progress on overflow", async () => {
  const f = await fixture();
  for (let i = 0; i < 256; i++) f.milestone("item-" + i);
  expect(f.run.progressItems.size).toBe(256); expect(f.run.progressCount).toBe(256);
  expect(f.read().progress!.cursor).toMatch(/0100$/);
  f.milestone("overflow");
  for (let i = 0; i < 1000; i++) f.milestone("extra-" + i);
  expect(f.run.progressItems.size).toBe(0); expect(f.run.progressCount).toBe(256);
  expect(f.read()).toEqual({ state: "running" });
});

it.each(["completed", "failed", "interrupted"])("terminal %s does not create a milestone or goal success", async status => {
  const f = await fixture(); f.terminal(status, [{ type: "commandExecution", id: "hidden", status: "completed", exitCode: 0 }]);
  expect(f.read()).toEqual({ state: status === "completed" ? "completed" : "failed" });
  expect(f.codex.approvalStatus("task", f.started.run_id).progress).toBeUndefined();
});

it("lost child, close and new runtime have no reconstructed cursor", async () => {
  const f = await fixture(); f.milestone();
  f.internal.failChild("child_exit", 7);
  expect(f.read()).toEqual({ state: "unknown" });
  expect(f.codex.approvalStatus("task", f.started.run_id).progress).toBeUndefined();
  await f.codex.close(); expect(f.read()).toEqual({ state: "unknown" });
  const replacement = new CodexAppServer({ workspaceRoot: f.root, binary: process.execPath, logger: nullLogger });
  actions.push(() => replacement.close());
  expect(replacement.observeRun("task", f.started.run_id)).toEqual({ state: "unknown" });
});

it("milestones have no notification/journal writes; strict recovery never reconstructs progress", async () => {
  const root = makeTmpDir("progress-journal"); actions.push(() => cleanup(root));
  vi.stubEnv("C2C_STATE_DIR", root);
  const workspace = "a".repeat(24), journal = new TaskJournal(workspace);
  actions.push(() => journal.close());
  const onRunStarting = vi.fn((run, instruction) => journal.begin(workspace, run, instruction));
  const onRunTerminal = vi.fn(run => journal.complete(workspace, run));
  const onRunNotification = vi.fn();
  const f = await fixture({ onRunStarting, onRunTerminal, onRunNotification });
  const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs, "renameSync")];
  for (let i = 0; i < 10; i++) { f.milestone("id-" + i); f.read(); }
  for (const write of writes) { expect(write).not.toHaveBeenCalled(); write.mockRestore(); }
  expect(onRunStarting).toHaveBeenCalledTimes(1); expect(onRunTerminal).not.toHaveBeenCalled(); expect(onRunNotification).not.toHaveBeenCalled();
  f.terminal("failed"); expect(f.read().state).toBe("failed"); expect(f.read().progress).toBeDefined();
  expect(onRunTerminal).toHaveBeenCalledTimes(1); expect(onRunNotification).toHaveBeenCalledTimes(1);
  expect(journal.recoveredRun(workspace, "task", f.started.run_id)?.progress).toBeUndefined();
  journal.close();
  const recovered = new TaskJournal(workspace); actions.push(() => recovered.close());
  expect(recovered.recoveredRun(workspace, "task", f.started.run_id)?.progress).toBeUndefined();
  expect(JSON.stringify(recovered.status(workspace, "task"))).not.toContain("command_completed");
});

it("does not serialize observed progress in terminal, notification or execution-record callbacks", async () => {
  const onRunTerminal = vi.fn(), onRunNotification = vi.fn();
  const f = await fixture({ onRunTerminal, onRunNotification });
  f.milestone("terminal-command");
  const cursor = f.read().progress!.cursor;
  f.terminal("completed");
  expect(onRunTerminal).toHaveBeenCalledTimes(1);
  expect(onRunNotification).toHaveBeenCalledTimes(1);
  for (const payload of [onRunTerminal.mock.calls[0]![0], onRunNotification.mock.calls[0]![0]]) {
    expect(payload).not.toHaveProperty("progress");
    expect(JSON.stringify(payload)).not.toContain(cursor);
  }
  expect(onRunNotification.mock.calls[0]![1]).toBe("terminal");
  const record = vi.fn();
  const terminal = await f.codex.waitAndRecordTerminalResult("task", f.started.run_id, record);
  expect(terminal).not.toHaveProperty("progress");
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0]![0]).not.toHaveProperty("progress");
  expect(JSON.stringify(record.mock.calls[0]![0])).not.toContain(cursor);
  expect(f.read().progress!.cursor).toBe(cursor);
});

it("does not serialize observed progress in an answered input or its protocol reply", async () => {
  const f = await fixture();
  f.milestone("reply-command");
  const cursor = f.read().progress!.cursor;
  const inputId = "a".repeat(32);
  f.run.input = { rpcId: "request-1", turnId: "turn-1", nonce: inputId,
    questions: [{ id: "q", header: "Fixture", question: "Continue?" }] };
  const writes: string[] = [];
  // In-memory writable child only: no provider spawn, socket, disk, or actual input.
  f.internal.child = { exitCode: 0, signalCode: null, stdin: {
    writable: true,
    write: (data: string, callback: (error?: Error) => void) => {
      writes.push(data); callback(); return true;
    },
  } };
  const reply = await f.codex.reply("task", f.started.run_id, inputId, "fixture answer");
  expect(reply).toMatchObject({ task_id: "task", state: "running" });
  expect(reply).not.toHaveProperty("progress");
  expect(JSON.stringify(reply)).not.toContain(cursor);
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!)).toEqual({ id: "request-1",
    result: { answers: { q: { answers: ["fixture answer"] } } } });
  expect(writes[0]).not.toContain(cursor);
  expect(f.read().progress!.cursor).toBe(cursor);
});

const trusted: AuthInfo = { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "execution.read"] };
async function mcpFixture(auth: AuthInfo | null = trusted) {
  const f = await fixture(); const workspace = new Workspace(f.root);
  const otherRoot = makeTmpDir("progress-other"); actions.push(() => cleanup(otherRoot));
  const other = new Workspace(otherRoot);
  const taskWorkspaces = new Map([["task", workspace.id]]);
  const getTaskJournal = vi.fn(() => { throw new Error("journal must not be opened"); });
  const getTaskReconciler = vi.fn(() => { throw new Error("reconciler must not be opened"); });
  const getCodex = vi.fn(() => f.codex);
  const server = createMcpServer({ workspace, codex: f.codex, getCodex, taskWorkspaces, getTaskJournal, getTaskReconciler, logger: nullLogger,
    resolveWorkspace: id => { if (id === workspace.id) return { workspace, codexNetworkHosts: [] };
      if (id === other.id) return { workspace: other, codexNetworkHosts: [] }; throw new Error("unexpected target"); } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const send = a.send.bind(a);
  a.send = (message, options) => send(message, { ...options, authInfo: auth ?? undefined });
  const client = new Client({ name: "progress-fixture", version: "1" });
  await server.connect(b); await client.connect(a); actions.push(async () => { await client.close(); await server.close(); });
  const args = { workspace_id: workspace.id, task_id: "task", run_id: f.started.run_id };
  const call = async (overrides = {}) => {
    const result = await client.callTool({ name: "codex_run_observation", arguments: { ...args, ...overrides } });
    return { result, body: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  };
  return { ...f, workspace, other, taskWorkspaces, client, args, call, getTaskJournal, getTaskReconciler, getCodex };
}

it("MCP observation is bounded, stable, read-only and does not wait or weaken Timeout Shield", async () => {
  const f = await mcpFixture(); f.milestone();
  const wait = vi.spyOn(f.codex, "wait"), reply = vi.spyOn(f.codex, "reply"), preflight = vi.spyOn(f.codex, "executionPreflight");
  const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs, "renameSync")];
  const first = await f.call();
  expect(first.result.isError).not.toBe(true);
  expect(first.body).toEqual({ version: 1, ...f.args, source: "current_runtime", goal_verified: false, ...f.read() });
  expect(Buffer.byteLength(JSON.stringify(first.result))).toBeLessThan(1024);
  for (let i = 0; i < 10; i++) expect((await f.call()).body).toEqual(first.body);
  for (const fn of [wait, reply, preflight, ...writes, f.getTaskJournal, f.getTaskReconciler]) expect(fn).not.toHaveBeenCalled();
  expect([...f.taskWorkspaces]).toEqual([["task", f.workspace.id]]);
  const tool = (await f.client.listTools()).tools.find(t => t.name === "codex_run_observation")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expect(tool.inputSchema.additionalProperties).toBe(false);
  expect(tool.description).toContain("prior Timeout Shield yield");
  f.terminal("failed"); const failed = (await f.call()).body;
  expect(failed.state).toBe("failed"); expect(failed.goal_verified).toBe(false); expect(failed.progress).toEqual(first.body.progress);
});

it.each([
  { ...trusted, scopes: [] }, { ...trusted, scopes: ["execution.read"] }, { ...trusted, scopes: ["workspace.read"] },
  { ...trusted, token: "oauth", clientId: "oauth" }, { ...trusted, clientId: "wrong" }, { ...trusted, token: "wrong" },
])("denies auth before reading runtime: %j", async auth => {
  const f = await mcpFixture(auth); const { result, body } = await f.call();
  expect(result.isError).toBe(true);
  expect(body.error).toBe(auth.scopes.length < 2 ? "INSUFFICIENT_SCOPE" : "TRUSTED_TUNNEL_REQUIRED");
  expect(f.getCodex).not.toHaveBeenCalled(); expect(f.getTaskJournal).not.toHaveBeenCalled();
});

it("rejects absent auth, cross-workspace binding and extra authority arguments", async () => {
  const f = await mcpFixture();
  const mismatch = await f.call({ workspace_id: f.other.id });
  expect(mismatch.body.error).toBe("TASK_WORKSPACE_MISMATCH"); expect(f.getCodex).not.toHaveBeenCalled();
  for (const overrides of [{ workspace_id: undefined }, { workspace_id: "bad" }, { path: "/private" }, { approval: true }, { run_id: "x".repeat(33) }]) {
    const result = await f.client.callTool({ name: "codex_run_observation", arguments: { ...f.args, ...overrides } });
    expect(result.isError).toBe(true);
  }
  const noAuth = await mcpFixture(null);
  expect((await noAuth.call()).body.error).toBe("TRUSTED_TUNNEL_REQUIRED");
  expect(noAuth.getCodex).not.toHaveBeenCalled();
  expect(f.getCodex).not.toHaveBeenCalled();
});

it("unknown run, lost binding and restart do not open a journal, provider or write bindings", async () => {
  const f = await mcpFixture();
  expect((await f.call({ run_id: "f".repeat(32) })).body.state).toBe("unknown");
  f.taskWorkspaces.clear(); f.getCodex.mockClear();
  expect((await f.call()).body).toEqual({ version: 1, ...f.args, source: "current_runtime", goal_verified: false, state: "unknown" });
  expect(f.getCodex).not.toHaveBeenCalled(); expect(f.getTaskJournal).not.toHaveBeenCalled(); expect(f.getTaskReconciler).not.toHaveBeenCalled();
  expect(f.taskWorkspaces.size).toBe(0);
});
