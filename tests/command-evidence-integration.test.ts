import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { recordCommandObservation, readCommandEvidence } from "../src/execution/command-evidence.js";
import { appendExecutionRecordOnce } from "../src/execution/records.js";
import { TaskJournal, TaskJournalError } from "../src/execution/task-journal.js";
import { TaskReconciler } from "../src/execution/task-reconciler.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";
const actions: Array<() => unknown> = [];
afterEach(async () => { for (const action of actions.splice(0).reverse()) await action(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const root = makeTmpDir("command-integration"), state = makeTmpDir("command-integration-state");
  actions.push(() => cleanup(root), () => cleanup(state)); fs.chmodSync(state, 0o700); vi.stubEnv("C2C_STATE_DIR", state);
  write(root, "source.py", "fixture\n"); const workspace = new Workspace(root);
  const observe = vi.fn((run, item) => recordCommandObservation(workspace.id, root, run, item));
  const codex = new CodexAppServer({ workspaceRoot: root, binary: process.execPath, logger: nullLogger, onCommandObservation: observe });
  actions.push(() => codex.close()); const internal = codex as any;
  vi.spyOn(internal, "ensureInitialized").mockImplementation(async () => { internal.activeEpoch = 7; });
  vi.spyOn(internal, "request").mockImplementation(async (...args: unknown[]) => args[0] === "thread/start"
    ? { cwd: root, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, thread: { id: "thread-1" } }
    : { turn: { id: "turn-1" } });
  const run = await codex.startTurn("task", 1, "inspect fixture");
  const item = (completed: boolean, extra = {}, binding = {}, epoch = 7) => internal.onStdout(Buffer.from(JSON.stringify({ method: completed ? "item/completed" : "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "command", command: "python3 -m unittest", cwd: root,
      status: completed ? "completed" : "inProgress", exitCode: completed ? 0 : null, aggregatedOutput: completed ? "Ran 6 tests in 0.1s\nOK\n" : null, ...extra }, ...binding } }) + "\n"), epoch);
  return { root, workspace, codex, observe, internal, run, item };
}
it("observes only bound command events, never agent-message PASS or a different turn", async () => {
  const f = await fixture();
  f.item(true, {}, { turnId: "other" }); f.item(true, { type: "agentMessage", text: "PASS" });
  f.item(false, {}, {}, 6); expect(f.observe).not.toHaveBeenCalled();
  f.item(false); f.item(true);
  const evidence = readCommandEvidence(f.workspace.id, f.root, f.run) as any;
  expect(evidence.commands[0]).toMatchObject({ exit_code: 0, reported_counts: { passed: 6 }, current_source_match: true });
  expect(f.codex.observeRun("task", f.run.run_id).state).toBe("running");
});
it("MCP exposes durable run-bound evidence separately from legacy narrative and completion status", async () => {
  const f = await fixture(); f.item(false); f.item(true);
  appendExecutionRecordOnce(f.workspace.id, { taskId: "task", iteration: 1, runId: f.run.run_id, changedFiles: null, tests: null,
    exitStatus: "ok", timestamp: new Date().toISOString(), notes: "not test attestation" });
  const server = createMcpServer({ workspace: f.workspace, codex: f.codex, logger: nullLogger });
  const [a, b] = InMemoryTransport.createLinkedPair(), send = a.send.bind(a);
  a.send = (message, options) => send(message, { ...options, authInfo: { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "execution.read"] } });
  const client = new Client({ name: "command-evidence-fixture", version: "1" }); await server.connect(b); await client.connect(a);
  actions.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string) => JSON.parse(((await client.callTool({ name, arguments: {} })).content as Array<{ text: string }>)[0].text);
  const status = await call("test_status");
  expect(status).toMatchObject({ available: true, tests: null, exitStatus: null, test_verdict: "NOT_INDEPENDENTLY_VERIFIED", command_evidence: { available: true, run_id: f.run.run_id } });
  const summary = await call("execution_summary");
  expect(summary).toMatchObject({ execution_completion_is_test_pass: false });
  expect(summary.command_evidence[0].evidence.commands[0].reported_counts.passed).toBe(6);
});
it("known approval expiry remains a known terminal failure while checkpoint safety is UNKNOWN", async () => {
  const f = await fixture(); const journal = new TaskJournal(f.workspace.id); actions.push(() => journal.close());
  journal.begin(f.workspace.id, f.run, "prior instruction"); journal.complete(f.workspace.id, { ...f.run, state: "failed", reason: "local_approval_expired" });
  const approve = vi.fn(), reconciler = new TaskReconciler({ journal, isBusy: () => false, approve,
    inspect: async () => { throw new TaskJournalError("RECONCILIATION_CWD_UNRESOLVED", "unresolved"); } });
  actions.push(() => reconciler.close());
  const initial = reconciler.prepareCheckpoint(f.workspace, "task", 2, "fresh instruction") as any;
  await Promise.resolve(); await Promise.resolve();
  const result = reconciler.status(f.workspace.id, initial.reconciliation_id) as any;
  expect(result).toMatchObject({ state: "blocked", code: "RECONCILIATION_CWD_UNRESOLVED", original_execution_result: { known: true, state: "failed", reason: "local_approval_expired" },
    original_outcome_known: false, original_outcome_scope: "effects-and-historical-resolution", process_safety: "UNKNOWN", original_task_replayed: false });
  expect(approve).not.toHaveBeenCalled(); expect(journal.observedTaskOutcome(f.workspace.id, "task").known).toBe(true);
  expect(result.recovery_guidance.automatic_retry).toBe(false);
  const later = { ...f.run, iteration: 2, run_id: "d".repeat(32), state: "running" as const };
  journal.begin(f.workspace.id, later, "new instruction");
  journal.complete(f.workspace.id, { ...later, state: "completed" });
  expect((reconciler.status(f.workspace.id, initial.reconciliation_id) as any).original_execution_result).toMatchObject({ run_id: f.run.run_id, state: "failed" });
});
it("legacy checkpoint without a recorded run ID never borrows a later run's known outcome", async () => {
  const f = await fixture(), observedTaskOutcome = vi.fn(() => ({ known: true, state: "completed", run_id: "e".repeat(32), reason: null }));
  const journal = { observedTaskOutcome, checkpointTarget: () => ({ workspace_id: f.workspace.id, task_id: "legacy", next_iteration: 2,
    source: "legacy_execution_records", source_sha256: "a".repeat(64), known_records: [{ iteration: 1, run_id: null }], request_sha256: "b".repeat(64), instruction_excerpt: "fresh", instruction_truncated: false }),
    revokeCheckpoints: () => undefined } as unknown as TaskJournal;
  const reconciler = new TaskReconciler({ journal, isBusy: () => false, approve: vi.fn(), inspect: async () => { throw new TaskJournalError("RECONCILIATION_CWD_UNRESOLVED", "unresolved"); } });
  actions.push(() => reconciler.close());
  const result = reconciler.prepareCheckpoint(f.workspace, "legacy", 2, "fresh") as any;
  expect(result.original_execution_result).toEqual({ known: false, state: "unknown", run_id: null, reason: null });
  expect(observedTaskOutcome).not.toHaveBeenCalled();
});
