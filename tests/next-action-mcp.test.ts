import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const actions: Array<() => unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const action of actions.splice(0).reverse()) await action(); vi.unstubAllEnvs(); });

async function fixture() {
  const root = makeTmpDir("next-action");
  actions.push(() => cleanup(root));
  vi.stubEnv("C2C_STATE_DIR", path.join(root, "state"));
  const cwd = path.join(root, "workspace"), otherRoot = path.join(root, "other");
  fs.mkdirSync(cwd); fs.mkdirSync(otherRoot);
  const workspace = new Workspace(cwd), other = new Workspace(otherRoot);
  const binary = path.join(root, "fake.mjs");
  fs.writeFileSync(binary, fs.readFileSync(new URL("./fixtures/codex-input.mjs", import.meta.url)), { mode: 0o700 });
  const journal = new TaskJournal(workspace.id);
  actions.push(() => journal.close());
  const codex = new CodexAppServer({ workspaceRoot: cwd, binary, logger: nullLogger,
    onRunStarting: (run, instruction) => journal.begin(workspace.id, run, instruction),
    onRunTerminal: run => journal.complete(workspace.id, run) });
  actions.push(() => codex.close());
  const taskWorkspaces = new Map<string, string>();
  const server = createMcpServer({ workspace, codex, taskWorkspaces, logger: nullLogger, getTaskJournal: () => journal,
    resolveWorkspace: id => ({ workspace: id === other.id ? other : workspace, codexNetworkHosts: [] }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const send = a.send.bind(a);
  a.send = (message, options) => send(message, { ...options, authInfo: { token: "fixture", clientId: "fixture", scopes: ["codex.execute", "execution.read"] } });
  const client = new Client({ name: "next-action", version: "1" });
  await server.connect(b); await client.connect(a);
  actions.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { workspace_id: workspace.id, ...args } });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
  const start = (instruction = "ASK", task_id = "task") => call("codex_turn_start", { task_id, iteration: 1, instruction });
  const wait = (run: any) => call("codex_turn_wait", { task_id: run.task_id, run_id: run.run_id });
  const journalHash = () => createHash("sha256").update(fs.readFileSync(path.join(root, "state", "task-journal", workspace.id + ".json"))).digest("hex");
  return { root, workspace, other, codex, journal, taskWorkspaces, call, start, wait, journalHash };
}

it("binds real live input and resume-context guidance without writing journal or answering", async () => {
  const f = await fixture();
  const started = await f.start();
  expect(started.next_action.binding).toMatchObject({ workspace_id: f.workspace.id, task_id: started.task_id, run_id: started.run_id });
  const run = await f.wait(started);
  expect(run.next_action).toMatchObject({ kind: "present_live_question", tool: "codex_turn_reply", arguments: {
    workspace_id: f.workspace.id, task_id: run.task_id, run_id: run.run_id, input_request_id: run.input_request_id },
    yield_required: true, timeout_shield: run.timeout_shield, ready_to_execute: false });
  const before = f.journalHash();
  const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs, "renameSync")];
  const approval = await f.call("codex_turn_approval_status", { task_id: run.task_id, run_id: run.run_id });
  expect(approval.next_action.kind).toBe("present_live_question");
  const resume = await f.call("task_resume_context", { task_id: run.task_id });
  expect(resume.next_action).toMatchObject({ kind: "present_live_question", evidence_source: "current_runtime" });
  expect(resume.live_pending_input.next_action.arguments.input_request_id).toBe(run.input_request_id);
  const status = await f.call("task_status", { task_id: run.task_id });
  expect(status.tasks[0]).toMatchObject({ next_action: "WAIT_FOR_RUN", next_action_guidance: { kind: "inspect_evidence", evidence_source: "journal_current_runtime" } });
  for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  for (const spy of writes) spy.mockRestore();
  expect(f.journalHash()).toBe(before);
  expect(fs.readFileSync(path.join(f.root, "requests.jsonl"), "utf8")).not.toContain('"answers"');
  expect(fs.readFileSync(path.join(f.root, "state", "task-journal", f.workspace.id + ".json"), "utf8")).not.toContain("next_action");
});

it("recovered terminal input never becomes a live reply channel", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  vi.spyOn(f.journal, "recoveredRun").mockReturnValue({ ...run, state: "blocked", reason: "user_input_required", resumable: true } as never);
  const recovered = await f.wait(run);
  expect(recovered.next_action).toMatchObject({ kind: "inspect_evidence", evidence_source: "journal_runtime_unknown" });
  expect(recovered.next_action.tool).not.toBe("codex_turn_reply");
  const status = await f.call("codex_turn_approval_status", { task_id: run.task_id, run_id: "e".repeat(32) });
  expect(status.next_action.tool).not.toBe("codex_turn_reply");
});

it("completion requires independent evidence and unreported tests remain unknown", async () => {
  const f = await fixture(), run = await f.wait(await f.start("COMPLETE"));
  expect(run.state).toBe("completed");
  // A live terminal is known, but a journal-recovered terminal may lack explicit
  // outcome provenance. Preserve UNKNOWN instead of upgrading it to authority.
  const recovered = run.recovered_from_journal === true;
  expect(run.next_action).toMatchObject({ kind: "verify_completion",
    evidence_source: recovered ? "journal_runtime_unknown" : "current_runtime",
    verification: { execution_outcome_known: recovered ? null : true,
      goal: "unverified", tests: "unknown_until_explicit_record_review" } });
  expect(run.next_action.verification_reads.map((read: any) => read.tool)).toEqual(["git_status", "git_diff", "test_status", "execution_summary"]);
  expect(JSON.stringify(run.next_action)).not.toContain('"tool":"completion_notify"');
});

it("journal-recovered terminal remains outcome-unknown without explicit provenance", async () => {
  const f = await fixture(), started = await f.start("COMPLETE");
  // Observe fixture completion locally; do not perform repeated MCP waits.
  await vi.waitFor(() => {
    expect(f.codex.approvalStatus(started.task_id, started.run_id).state).toBe("completed");
  }, { interval: 50, timeout: 8_000 });
  const recovered = await f.wait(started);
  expect(recovered).toMatchObject({ state: "completed", recovered_from_journal: true });
  expect(recovered.next_action).toMatchObject({ kind: "verify_completion",
    evidence_source: "journal_runtime_unknown",
    verification: { execution_outcome_known: null, goal: "unverified",
      tests: "unknown_until_explicit_record_review" }, grants_authority: false });
  expect(JSON.stringify(recovered.next_action)).not.toContain('"tool":"completion_notify"');
});

it("native approval and unsupported elicitation remain native-status/inspection only", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  const read = vi.spyOn(f.codex, "approvalStatus");
  read.mockReturnValueOnce({ task_id: run.task_id, run_id: run.run_id, iteration: 1, state: "blocked", reason: "approval_required", resumable: true, waiting_for_local_approval: true, approval_type: "workspace_command" });
  expect((await f.call("codex_turn_approval_status", { task_id: run.task_id, run_id: run.run_id })).next_action).toMatchObject({ kind: "native_owner_decision", tool: "codex_turn_approval_status" });
  const before = f.journalHash();
  read.mockReturnValueOnce({ task_id: run.task_id, run_id: run.run_id, iteration: 1, state: "blocked", reason: "approval_required", resumable: true, waiting_for_local_approval: true, approval_type: "workspace_command" });
  const nativeHandoff = await f.call("task_resume_context", { task_id: run.task_id });
  expect(nativeHandoff).toMatchObject({ live_pending_input: { waiting_for_local_approval: true },
    next_action: { kind: "native_owner_decision", tool: "codex_turn_approval_status", ready_to_execute: false } });
  expect(f.journalHash()).toBe(before);
  expect(fs.readFileSync(path.join(f.root, "requests.jsonl"), "utf8")).not.toContain('"decision"');
  read.mockReturnValueOnce({ task_id: run.task_id, run_id: run.run_id, iteration: 1, state: "blocked", reason: "mcp_elicitation_required", resumable: false });
  expect((await f.call("codex_turn_approval_status", { task_id: run.task_id, run_id: run.run_id })).next_action.kind).toBe("inspect_evidence");
});

it("wrong workspace and stale run errors preserve errors and expose no invented IDs", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  for (const extra of [{ workspace_id: f.other.id }, { run_id: "e".repeat(32) }]) {
    const result = await f.call("codex_turn_approval_status", { task_id: run.task_id, run_id: run.run_id, ...extra });
    expect(["TASK_WORKSPACE_MISMATCH", "RUN_NOT_FOUND"]).toContain(result.error);
    expect(result.next_action).toMatchObject({ kind: "inspect_evidence", binding: {}, tool: null, arguments: {} });
  }
});

it("task-list rows use their own identities, not the latest run for every row", async () => {
  const f = await fixture();
  const one = await f.wait(await f.start("COMPLETE", "one"));
  const two = await f.wait(await f.start("COMPLETE", "two"));
  const before = f.journalHash();
  const list = await f.call("task_status", {});
  expect(list.tasks).toHaveLength(2);
  for (const row of list.tasks) {
    const expected = row.task_id === "one" ? one : two;
    expect(row.next_action_guidance.binding).toEqual({ workspace_id: f.workspace.id, task_id: expected.task_id, run_id: expected.run_id });
    expect(typeof row.next_action).toBe("string");
  }
  expect(f.journalHash()).toBe(before);
});
