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
import { dispatchRunNotification, type LocalRunNotice, type RunNotifier } from "../src/notifications/local-sound.js";
import { TaskJournal as R32, inspectTaskJournalLayout as r32Layout } from "./fixtures/legacy-r32/dist/execution/task-journal.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const closes: Array<() => Promise<void>> = [];
const processExit: RunNotifier = async () => ({ outcome: "process_exit", exit_code: 0 });
afterEach(async () => { vi.useRealTimers(); for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

// The live run carries one bounded ephemeral diagnostic. A terminal recovered
// from the journal retains committed, sanitized evidence in elicitation_history
// instead. Never infer a live reply ID or invent a missing capture.
function capturedEvidence(run: any): any {
  if (run.recovered_from_journal === true) {
    expect(run).not.toHaveProperty("elicitation_evidence");
    expect(run.elicitation_history).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "captured", evidence: expect.any(Object),
        resumable: false, delivery_proven: false, goal_verified: false }),
    ]));
    return run.elicitation_history.find((event: any) => event.phase === "captured").evidence;
  }
  expect(run).toHaveProperty("elicitation_evidence");
  return run.elicitation_evidence;
}

async function fixture(notify?: RunNotifier) {
  const root = makeTmpDir("elicitation");
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  vi.stubEnv("C2C_STATE_DIR", state);
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  const binary = path.join(root, "fake.mjs");
  fs.writeFileSync(binary, fs.readFileSync(new URL("./fixtures/codex-elicitation.mjs", import.meta.url)), { mode: 0o700 });
  const workspace = new Workspace(workspaceRoot);
  const journal = new TaskJournal(workspace.id);
  let currentJournal = journal;
  const terminal = vi.fn((run) => journal.complete(workspace.id, run));
  const logger = { ...nullLogger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const notices: LocalRunNotice[] = [], notificationWrites: Promise<void>[] = [];
  const codex = new CodexAppServer({ workspaceRoot, binary, logger,
    ...(notify ? { onRunNotification: (run, eventId) => { notificationWrites.push(dispatchRunNotification(journal, workspace.id, run, eventId,
      logger, async (notice, log) => { notices.push(notice); return notify(notice, log); })); } } : {}),
    onRunStarting: (run, instruction) => journal.begin(workspace.id, run, instruction), onRunTerminal: terminal, onElicitation: (run, event) => journal.recordElicitation(workspace.id, run, event) });
  const taskWorkspaces = new Map<string, string>();
  const otherRoot = path.join(root, "other"); fs.mkdirSync(otherRoot);
  const other = new Workspace(otherRoot);
  const server = createMcpServer({ workspace, logger, codex, taskWorkspaces, getTaskJournal: () => currentJournal,
    resolveWorkspace: id => ({ workspace: id === other.id ? other : workspace, codexNetworkHosts: [] }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let scopes = ["codex.execute", "workspace.read"], trusted = true;
  const send = a.send.bind(a);
  a.send = (m, options) => send(m, { ...options, authInfo: { token: trusted ? "trusted-tunnel" : "fixture", clientId: trusted ? "openai-secure-tunnel" : "fixture", scopes } });
  const client = new Client({ name: "input-fixture", version: "1" });
  await server.connect(b); await client.connect(a);
  closes.push(async () => { await client.close(); await server.close(); await codex.close(); await Promise.all(notificationWrites); journal.close(); cleanup(root); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    try { return JSON.parse(text); } catch { return { error: result.isError ? "SCHEMA_REJECTED" : undefined }; }
  };
  const start = (mode = "ASK", task_id = "task", iteration = 1) => call("codex_turn_start", { task_id, iteration, instruction: mode });
  const wait = (run: any) => call("codex_turn_wait", { task_id: run.task_id, run_id: run.run_id });
  const reply = (run: any, extra = { action: "accept", content: { choice: "Small", count: 1, confirm: true } } as Record<string, unknown>) => call("codex_mcp_elicitation_reply", {
    workspace_id: workspace.id, task_id: run.task_id, run_id: run.run_id, elicitation_request_id: run.elicitation_request_id, ...extra,
  });
  const log = () => fs.existsSync(path.join(root, "requests.jsonl"))
    ? fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, state, workspaceRoot, notices, flushNotices: () => Promise.all(notificationWrites), untrust: () => { trusted = false; }, useJournal: (value: TaskJournal) => { currentJournal = value; }, codex, client, call, start, wait, reply, log, journal, workspace, other, terminal, taskWorkspaces, logger,
    executor: () => { scopes = ["codex.execute", "workspace.read"]; }, reader: () => { scopes = ["workspace.read"]; }, executionReader: () => { scopes = ["execution.read"]; } };
}

it.each(["accept", "decline", "cancel"])("stage3a discovers a prompt and %s terminal result without duplicate polls or receipt claims", async action => {
  const f = await fixture(processExit), run = await f.wait(await f.start());
  await f.flushNotices();
  expect(f.notices).toEqual([{ workspace_id: f.workspace.id, task_id: run.task_id, run_id: run.run_id, state: "blocked", category: "mcp_elicitation_required", notification_id: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  const main = path.join(f.state, "task-journal", f.workspace.id + ".json");
  expect(JSON.parse(fs.readFileSync(main, "utf8")).runs[0].state).toBe("running");
  await Promise.all([f.wait(run), f.wait(run)]);
  f.executionReader();
  const handoff = await f.call("task_resume_context", { workspace_id: f.workspace.id, task_id: run.task_id });
  expect(handoff).toMatchObject({ live_pending_input: { elicitation_request_id: run.elicitation_request_id },
    tasks: [{ notifications: [{ event_id: "elicitation:1", reservation: "committed", os_presentation: "unknown", user_receipt: "unknown",
      observations: [{ observation: { outcome: "dispatch_intent" } }, { observation: { outcome: "process_exit", exit_code: 0 } }],
      handoff: { arguments: { workspace_id: f.workspace.id, task_id: run.task_id }, run_id: run.run_id, grants_authority: false } }] }] });
  expect(f.log().some(m => m.result?.action)).toBe(false);
  f.executor(); await f.reply(run, { action, ...(action === "accept" ? { content: { choice: "Small", count: 1, confirm: true } } : {}) });
  expect(await f.wait(run)).toMatchObject({ state: "completed", summary: "disposable fixture test passed" });
  await f.flushNotices(); await f.wait(run);
  expect(f.notices).toHaveLength(2); expect(f.notices[1]).toMatchObject({ state: "completed", run_id: run.run_id });
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(action === "accept");
  f.executionReader(); expect(await f.call("task_resume_context", { task_id: run.task_id })).toMatchObject({
    tasks: [{ execution_state: "completed", goal_status: "unverified", notifications: [{ event_id: "elicitation:1" }, { event_id: "terminal" }] }] });
  const noticeBytes = JSON.stringify(f.notices) + JSON.stringify((f.journal.status(f.workspace.id) as any).tasks[0].notifications);
  expect(noticeBytes).not.toContain(run.elicitation_request_id); expect(noticeBytes).not.toContain("Choose the disposable");
  expect(noticeBytes).not.toContain('"content"');
});

it("stage3a gives two live waits distinct bounded identities and one terminal notice", async () => {
  const f = await fixture(processExit), first = await f.wait(await f.start("MULTIPLE"));
  await f.reply(first, { action: "cancel" }); const second = await f.wait(first);
  expect(second.elicitation_request_id).not.toBe(first.elicitation_request_id);
  await f.reply(second, { action: "decline" }); expect(await f.wait(second)).toMatchObject({ state: "completed" });
  await f.flushNotices();
  expect((f.journal.status(f.workspace.id) as any).tasks[0].notifications.map((n: any) => n.event_id)).toEqual(["elicitation:1", "elicitation:2", "terminal"]);
  expect(f.notices).toHaveLength(3); expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("native notice acknowledgement neither answers an elicitation nor resumes or authorizes work", async () => {
  const f = await fixture(async () => ({ outcome: "notice_acknowledged" })), run = await f.wait(await f.start());
  await f.flushNotices(); await f.wait(run); await f.wait(run);
  expect(f.notices).toHaveLength(1);
  expect(await f.wait(run)).toMatchObject({ state: "blocked", reason: "mcp_elicitation_required", resumable: true });
  expect(f.log().some(m => m.result?.action || m.result?.decision || m.result?.answers)).toBe(false);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
  const status = (f.journal.status(f.workspace.id) as any).tasks[0];
  expect(status.notifications[0]).toMatchObject({ notice_acknowledgement: "acknowledged", user_receipt: "notice_acknowledged",
    acknowledgement_grants_authority: false, automatic_host_reentry: false, goal_verified: false, handoff: { grants_authority: false } });
  expect(f.journal.checkpointStatus(f.workspace.id, run.task_id)).toEqual([]);
  f.reader();
  expect(await f.reply(run, { action: "accept", content: { choice: "Small", count: 1, confirm: true } }))
    .toMatchObject({ error: "INSUFFICIENT_SCOPE" });
  expect(f.log().some(m => m.result?.action)).toBe(false);
});

it.each(["URL", "OPENAI_FORM_ALIAS", "USER_VERIFICATION"])("stage3a notifies terminal unsupported %s without a reply or operation", async mode => {
  const f = await fixture(processExit), run = await f.wait(await f.start(mode)); await f.flushNotices();
  expect(run).toMatchObject({ state: "failed", reason: "mcp_elicitation_unsupported" });
  expect(f.notices).toEqual([{ workspace_id: f.workspace.id, task_id: run.task_id, run_id: run.run_id, state: "failed", category: "failed", notification_id: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(await f.reply(run, { action: "cancel", elicitation_request_id: "a".repeat(32) })).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(f.log().some(m => m.result?.action || m.result?.decision)).toBe(false);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("stage3a restart retains bounded failed notice evidence and loses reply authority", async () => {
  const f = await fixture(async () => ({ outcome: "timeout" })), run = await f.wait(await f.start());
  await f.flushNotices(); f.journal.close();
  const main = path.join(f.state, "task-journal", f.workspace.id + ".json"), before = fs.readFileSync(main, "utf8");
  const old = new R32(f.workspace.id); expect(old.status(f.workspace.id)).toMatchObject({ tasks: [{ execution_state: "interrupted" }] });
  old.close(); expect(fs.readFileSync(main, "utf8")).toBe(before);
  const reopened = new TaskJournal(f.workspace.id); closes.push(async () => reopened.close()); f.useJournal(reopened); f.executionReader();
  const handoff = await f.call("task_resume_context", { task_id: run.task_id });
  expect(handoff).not.toHaveProperty("live_pending_input");
  expect(handoff).toMatchObject({ tasks: [{ execution_state: "interrupted", notification_evidence_available: true,
    notifications: [{ observations: [{ observation: { outcome: "dispatch_intent" } }, { observation: { outcome: "timeout" } }], automatic_retry: false,
      user_receipt: "unknown", handoff: { run_id: run.run_id, revalidate_live_channel: true } }] }] });
  expect(JSON.stringify(handoff)).not.toContain(run.elicitation_request_id);
  expect(f.notices).toHaveLength(1); expect(reopened.workspaceBlockers(f.workspace.id)).toHaveLength(1);
});

it("retrieves the actual form, explicitly accepts once, changes/tests a disposable file and retrieves completion", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  expect(run).toMatchObject({ state: "blocked", reason: "mcp_elicitation_required", resumable: true,
    elicitation_evidence: { method: "mcpServer/elicitation/request", server: "controlled-fixture", originating_tool: "unavailable" },
    elicitation_prompt: { message: "Choose the disposable fixture change.", untrusted_data: true },
    next_action: { kind: "present_live_mcp_form", tool: "codex_mcp_elicitation_reply", ready_to_execute: false } });
  expect(run.elicitation_request_id).toMatch(/^[a-f0-9]{32}$/);
  expect(f.terminal).not.toHaveBeenCalled();
  f.journal.complete(f.workspace.id, run);
  expect(f.journal.status(f.workspace.id, "task")).toMatchObject({ tasks: [{ execution_state: "running", outcome_known: false }] });
  f.executionReader();
  expect(await f.call("codex_turn_approval_status", { task_id: "task", run_id: run.run_id })).toMatchObject({ elicitation_request_id: run.elicitation_request_id });
  expect(await f.call("task_resume_context", { task_id: "task" })).toMatchObject({ live_pending_input: { elicitation_request_id: run.elicitation_request_id } });
  expect(await f.reply(run)).toMatchObject({ error: "INSUFFICIENT_SCOPE" }); f.executor();
  expect(await f.reply(run)).toMatchObject({ state: "running", elicitation_response: { action: "accept", transport_write_acknowledged: true, delivery_proven: false, goal_verified: false } });
  expect(await f.wait(run)).toMatchObject({ state: "completed", summary: "disposable fixture test passed" });
  expect(fs.readFileSync(path.join(f.workspaceRoot, "disposable.txt"), "utf8")).toBe("Small\n");
  expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(f.log().filter(m => m.result?.action)).toEqual([{ id: "elicitation-1", result: { action: "accept", content: { choice: "Small", count: 1, confirm: true } } }]);
  expect(f.log().filter(m => m.method === "turn/start")).toHaveLength(1);
  const bytes = fs.readFileSync(path.join(f.state, "task-extensions", f.workspace.id + ".journal.json"), "utf8");
  expect(bytes).not.toContain(run.elicitation_request_id); expect(bytes).not.toContain('"content":');
  const main = JSON.parse(fs.readFileSync(path.join(f.state, "task-journal", f.workspace.id + ".json"), "utf8"));
  expect(main.runs[0]).not.toHaveProperty("elicitation_evidence");
  f.executionReader(); expect(await f.call("task_resume_context", { task_id: "task" })).not.toHaveProperty("live_pending_input");
});

it.each(["decline", "cancel"])("sends %s exactly once without the gated disposable operation", async action => {
  const f = await fixture(), run = await f.wait(await f.start());
  await f.reply(run, { action }); expect(await f.wait(run)).toMatchObject({ state: "completed" });
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
  expect(f.log().filter(m => m.result?.action)).toEqual([{ id: "elicitation-1", result: { action } }]);
  expect(await f.reply(run, { action })).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
});

it.each([undefined, {}, { choice: "Small" }, { choice: "Large", count: 1, confirm: true },
  { choice: "Small", count: 1.5, confirm: true }, { choice: "Small", count: 3, confirm: true },
  { choice: "Small", count: 1, confirm: "true" }, { choice: "Small", count: 1, confirm: true, extra: true }])("rejects invalid original content %j without consuming authority", async content => {
  const f = await fixture(), run = await f.wait(await f.start());
  expect(await f.reply(run, { action: "accept", ...(content === undefined ? {} : { content }) })).toMatchObject({ error: "INVALID_ELICITATION_REPLY" });
  expect(f.log().some(m => m.result?.action)).toBe(false);
  expect(await f.wait(run)).toMatchObject({ elicitation_request_id: run.elicitation_request_id, resumable: true });
});

it("rejects missing decision, stale ID, wrong run/task/workspace and decline with content", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  expect(await f.reply(run, {})).toHaveProperty("error");
  expect(await f.reply(run, { action: "decline", content: {} })).toMatchObject({ error: "INVALID_ELICITATION_REPLY" });
  expect(await f.reply(run, { action: "cancel", elicitation_request_id: "a".repeat(32) })).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(await f.reply(run, { action: "cancel", run_id: "a".repeat(32) })).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(await f.reply(run, { action: "cancel", task_id: "other" })).toMatchObject({ error: "TASK_NOT_FOUND" });
  expect(await f.reply(run, { action: "cancel", workspace_id: f.other.id })).toMatchObject({ error: "TASK_WORKSPACE_MISMATCH" });
  expect(f.log().some(m => m.result?.action)).toBe(false);
});

it.each(["URL", "SECRET", "EXTRA_SCHEMA", "DEFAULT", "FREE_TEXT", "META", "MALFORMED", "NULL_TURN", "OVERSIZE", "UNKNOWN_METHOD", "OPENAI_FORM", "OPTIONAL", "MANY_FIELDS", "BAD_URL"])("retains safe %s diagnostics without a reply channel", async mode => {
  const f = await fixture(), run = await f.wait(await f.start(mode));
  expect(run).toMatchObject({ state: "failed", reason: "mcp_elicitation_unsupported" });
  expect(capturedEvidence(run)).toMatchObject({ originating_tool: "unavailable" });
  expect(run).not.toHaveProperty("elicitation_request_id");
  expect(f.log().some(m => m.result?.action || m.result?.decision)).toBe(false);
  const safe = JSON.stringify(f.journal.extensionStatus());
  expect(safe).toContain("correlation_sha256"); expect(safe).not.toMatch(/do-not-retain|secret-path|never-copy-this|credential=|#secret/);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("journal terminal preserves captured safe evidence without restoring reply authority", async () => {
  const f = await fixture();
  const started = await f.start("EXTRA_SCHEMA");
  // Local journal observation waits for terminal persistence; no repeat MCP wait,
  // approval, replay, fake completion or host-polling bypass.
  await vi.waitFor(() => {
    const saved = f.journal.recoveredRun(f.workspace.id, started.task_id, started.run_id);
    expect(saved?.state).toBe("failed");
  }, { interval: 50, timeout: 8_000 });
  const result = await f.wait(started);
  expect(result).toMatchObject({ state: "failed", reason: "mcp_elicitation_unsupported", recovered_from_journal: true });
  expect(capturedEvidence(result)).toMatchObject({ originating_tool: "unavailable" });
  expect(result).not.toHaveProperty("elicitation_request_id");
  expect(f.log().some(m => m.result?.action || m.result?.decision)).toBe(false);
});

it("concurrent duplicate decisions send only one actual protocol response", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  const results = await Promise.all([f.reply(run, { action: "decline" }), f.reply(run, { action: "cancel" })]);
  expect(results.filter(r => r.error === "ELICITATION_REQUEST_NOT_FOUND")).toHaveLength(1);
  expect(await f.wait(run)).toMatchObject({ state: "completed" });
  expect(f.log().filter(m => m.result?.action)).toHaveLength(1);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("rejects duplicate required names at capture without exposing an impossible live form", async () => {
  const f = await fixture(), run = await f.wait(await f.start("DUPLICATE_REQUIRED"));
  expect(run).toMatchObject({ state: "failed", reason: "mcp_elicitation_unsupported" });
  expect(capturedEvidence(run)).toMatchObject({ classification: "unsupported_schema", observed_mode: "form" });
  expect(run).not.toHaveProperty("elicitation_request_id"); expect(run).not.toHaveProperty("elicitation_prompt");
  expect(await f.reply({ ...run, elicitation_request_id: "a".repeat(32) }, { action: "accept", content: { field: true } }))
    .toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(f.log().some(m => m.result?.action || m.result?.decision)).toBe(false);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
  expect(JSON.stringify(f.journal.extensionStatus())).toContain("unsupported_schema");
});

it.each([
  ["OPENAI_FORM_ALIAS", "openaiForm", "form", "unsupported_schema"],
  ["USER_VERIFICATION", "openai/userVerification", "verification", "unsupported_verification"],
])("retains the official 0.160.0 %s mode without a reply or native approval", async (fixtureMode, observed_mode, request_kind, classification) => {
  const f = await fixture(), run = await f.wait(await f.start(fixtureMode));
  expect(run).toMatchObject({ state: "failed", reason: "mcp_elicitation_unsupported" });
  expect(capturedEvidence(run)).toMatchObject({ observed_mode, request_kind, classification });
  expect(run).not.toHaveProperty("elicitation_request_id"); expect(run).not.toHaveProperty("elicitation_prompt");
  expect(run).not.toHaveProperty("waiting_for_local_approval"); expect(run).not.toHaveProperty("approval_type");
  const saved = JSON.stringify(f.journal.extensionStatus());
  expect(saved).toContain(observed_mode); expect(saved).not.toContain("never-retain-device-challenge");
  if (fixtureMode === "USER_VERIFICATION") expect(saved).toContain("device_auth_challenge_and_proof_omitted");
  expect(f.log().some(m => m.result?.action || m.result?.decision)).toBe(false);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("official serverRequest/resolved without a turn ID closes pending transport without a response", async () => {
  const f = await fixture(), run = await f.wait(await f.start("RESOLVED"));
  await new Promise(r => setTimeout(r, 150));
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "elicitation_resolved_without_reply" });
  expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(f.log().some(m => m.result?.action)).toBe(false);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("official started/completed lifecycle remains separate from explicit form response", async () => {
  const f = await fixture(), run = await f.wait(await f.start("STARTED_EVENT"));
  expect(run).toMatchObject({ state: "blocked", reason: "mcp_elicitation_required", resumable: true });
  expect(f.log().some(m => m.result?.action)).toBe(false);
  expect(await f.reply(run)).toMatchObject({ state: "running", elicitation_response: { server_acceptance_proven: false, run_resumption_proven: false, goal_verified: false } });
  expect(await f.wait(run)).toMatchObject({ state: "completed", summary: "disposable fixture test passed" });
  expect(fs.readFileSync(path.join(f.workspaceRoot, "disposable.txt"), "utf8")).toBe("Small\n");
});

it("actual r32 treats a new failed elicitation as uncertain without changing its main grammar", async () => {
  const f = await fixture(), run = await f.wait(await f.start("EXTRA_SCHEMA"));
  expect(run).toMatchObject({ reason: "mcp_elicitation_unsupported" });
  expect(await f.wait(run)).toMatchObject({ reason: "mcp_elicitation_unsupported", legacy_terminal_reason: "protocol_write_failed" });
  const main = path.join(f.state, "task-journal", f.workspace.id + ".json"), before = fs.readFileSync(main, "utf8");
  expect(JSON.parse(before).runs[0]).toMatchObject({ state: "failed", reason: "protocol_write_failed" });
  f.journal.close(); const old = new R32(f.workspace.id); closes.push(async () => old.close());
  expect(old.status(f.workspace.id, "task")).toMatchObject({ tasks: [{ execution_state: "interrupted", outcome_known: false, requires_reconciliation: true }] });
  old.close(); expect(fs.readFileSync(main, "utf8")).toBe(before);
  const reopened = new TaskJournal(f.workspace.id); closes.push(async () => reopened.close());
  expect(JSON.stringify(reopened.status(f.workspace.id, "task"))).toContain("mcp_elicitation_unsupported");
  expect(reopened.workspaceBlockers(f.workspace.id)).toHaveLength(1);
});

it.each(["WRONG_TURN", "MISSING_ID", "DUPLICATE"])("captures before rejecting %s correlation", async mode => {
  const f = await fixture(), run = await f.wait(await f.start(mode));
  expect(run.state).toBe("failed");
  if (mode === "WRONG_TURN") {
    expect(["invalid_elicitation_correlation", "elicitation_identity_mismatch"]).toContain(run.reason);
  } else {
    expect(run.reason).toBe("invalid_elicitation_correlation");
  }
  expect(capturedEvidence(run)).toMatchObject({ correlation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(f.journal.extensionStatus())).toContain("correlation_sha256");
  expect(f.log().some(m => m.result?.action)).toBe(false);
});

it("transport loss and reopening retain historical evidence without an ephemeral response ID", async () => {
  const f = await fixture(), run = await f.wait(await f.start("EXIT"));
  await new Promise(r => setTimeout(r, 150));
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "child_exit" });
  expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  f.journal.close(); const reopened = new TaskJournal(f.workspace.id); closes.push(async () => reopened.close());
  const history = JSON.stringify(reopened.status(f.workspace.id, "task"));
  expect(history).toContain("channel_closed"); expect(history).not.toContain(run.elicitation_request_id);
  expect(reopened.workspaceBlockers(f.workspace.id)).toHaveLength(1);
  f.useJournal(reopened); f.executionReader();
  expect(await f.call("task_resume_context", { task_id: "task" })).not.toHaveProperty("live_pending_input");
});

it("expires the original live request without sending a response", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
  try { expect(await f.reply(run, { action: "cancel" })).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" }); }
  finally { vi.restoreAllMocks(); }
  expect(f.log().some(m => m.result?.action)).toBe(false);
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "elicitation_expired" });
});

it.each(["captured", "response_attempted"])("recording failure at %s never sends or executes", async phase => {
  const f = await fixture(); const original = f.journal.recordElicitation.bind(f.journal);
  vi.spyOn(f.journal, "recordElicitation").mockImplementation((w, r, e) => { if (e.phase === phase) throw new Error("controlled storage failure"); original(w, r, e); });
  const run = await f.wait(await f.start());
  if (phase === "response_attempted") expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_RECORDING_FAILED" });
  expect(f.codex.approvalStatus(run.task_id, run.run_id)).toMatchObject({ state: "failed", reason: "elicitation_recording_failed" });
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "protocol_write_failed" });
  expect(f.log().some(m => m.result?.action)).toBe(false);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("does not treat unsolicited completion during a pending elicitation as success", async () => {
  const f = await fixture(), run = await f.wait(await f.start("UNSOLICITED_COMPLETE"));
  await new Promise(r => setTimeout(r, 150));
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "elicitation_completed_without_reply" });
});

it("rejects an untrusted tunnel even with execution scope", async () => {
  const f = await fixture(), run = await f.wait(await f.start()); f.untrust();
  expect(await f.reply(run)).toMatchObject({ error: "TRUSTED_TUNNEL_REQUIRED" });
  expect(f.log().some(m => m.result?.action)).toBe(false);
});

it("write failure burns the ID without delivery claims or retransmission", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  const child = (f.codex as any).child;
  vi.spyOn(child.stdin, "write").mockImplementation((_line: unknown, callback: any) => { callback(new Error("controlled transport failure")); return false; });
  expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_REPLY_FAILED" });
  expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(f.codex.approvalStatus(run.task_id, run.run_id)).toMatchObject({ state: "failed", elicitation_response: { transport_write_acknowledged: false, delivery_proven: false } });
  expect(await f.wait(run)).toMatchObject({ state: "failed", elicitation_history: [{ phase: "captured", delivery_proven: false }, { phase: "pending", delivery_proven: false }, { phase: "response_attempted", delivery_proven: false }, { phase: "channel_closed", reason: "elicitation_reply_failed", delivery_proven: false }] });
  expect(f.log().some(m => m.result?.action)).toBe(false);
  expect(fs.existsSync(path.join(f.workspaceRoot, "disposable.txt"))).toBe(false);
});

it("failure after a real transport write keeps the result uncertain and never retransmits", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  const original = f.journal.recordElicitation.bind(f.journal);
  vi.spyOn(f.journal, "recordElicitation").mockImplementation((w, r, e) => { if (e.phase === "write_acknowledged") throw new Error("controlled acknowledgment persistence failure"); original(w, r, e); });
  expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_RECORDING_FAILED" });
  expect(await f.reply(run)).toMatchObject({ error: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(f.codex.approvalStatus(run.task_id, run.run_id)).toMatchObject({ state: "failed", reason: "elicitation_recording_failed" });
  expect(await f.wait(run)).toMatchObject({ state: "failed", reason: "protocol_write_failed" });
  expect(f.log().filter(m => m.result?.action).length).toBeLessThanOrEqual(1);
});

it("pending bytes remain readable by actual r32 and a new runtime cannot reply", async () => {
  const f = await fixture(), run = await f.wait(await f.start());
  const main = path.join(f.state, "task-journal", f.workspace.id + ".json"), before = fs.readFileSync(main, "utf8");
  f.journal.close();
  const old = new R32(f.workspace.id); closes.push(async () => old.close());
  expect(r32Layout(f.state)).toMatchObject({ journals: 1, runs: 1 });
  expect(old.status(f.workspace.id, "task")).toMatchObject({ tasks: [{ execution_state: "interrupted", outcome_known: false }] });
  old.close(); expect(fs.readFileSync(main, "utf8")).toBe(before);
  const reopened = new TaskJournal(f.workspace.id); closes.push(async () => reopened.close());
  const history = JSON.stringify(reopened.status(f.workspace.id, "task"));
  expect(history).toContain('"phase":"pending"'); expect(history).not.toContain(run.elicitation_request_id);
  expect(reopened.workspaceBlockers(f.workspace.id)).toHaveLength(1);
  const fresh = new CodexAppServer({ workspaceRoot: f.workspaceRoot, binary: path.join(f.root, "fake.mjs"), logger: nullLogger });
  closes.push(async () => fresh.close());
  await expect(fresh.elicitationReply(run.task_id, run.run_id, run.elicitation_request_id, "accept", { choice: "Small", count: 1, confirm: true })).rejects.toMatchObject({ code: "ELICITATION_REQUEST_NOT_FOUND" });
  expect(f.log().some(m => m.result?.action)).toBe(false);
});
