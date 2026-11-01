import os from "node:os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { CodexAppServer } from "../src/codex/app-server.js";
import { nullLogger } from "../src/logger/index.js";
import * as approval from "../src/codex/local-approval.js";
import fs from "node:fs";
import path from "node:path";
import { cleanup, makeTmpDir } from "./helpers.js";

vi.mock("../src/codex/local-approval.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/codex/local-approval.js")>();
  return { ...actual, validateLocalApproval: vi.fn(actual.validateLocalApproval), nativeLocalApproval: vi.fn() };
});

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const clients: CodexAppServer[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function fixture(early?: Record<string, unknown>, workspaceRoot = process.cwd(), executionMode: "read_only" | "workspace_write" = "workspace_write") {
  const wire: any[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const m = JSON.parse(chunk.toString()); wire.push(m);
      if (m.method === "initialize") send({ id: m.id, result: {} });
      if (m.method === "thread/start") send({ id: m.id, result: { cwd: m.params.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: m.params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, thread: { id: "thread" } } });
      if (m.method === "turn/start") {
        if (early) {
          send(early);
          expect(approval.nativeLocalApproval).not.toHaveBeenCalled();
        }
        send({ id: m.id, result: { turn: { id: "turn" } } });
      }
      callback();
    } }),
    kill: vi.fn(() => { queueMicrotask(() => child.emit("exit", 0)); return true; }),
  });
  const send = (m: unknown) => child.stdout.write(JSON.stringify(m) + "\n");
  vi.mocked(spawn).mockReturnValue(child as any);
  const terminal = vi.fn();
  const notifications = vi.fn();
  const codex = new CodexAppServer({ workspaceRoot, binary: "/usr/bin/true", logger: nullLogger,
    allowedNetworkHosts: ["example.com"], onRunTerminal: terminal, onRunNotification: notifications });
  clients.push(codex);
  const run = await codex.startTurn("task", 1, "fixture", executionMode);
  return { codex, run, wire, send, terminal, notifications, child };
}

it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "applyPatchApproval", "execCommandApproval"])("reader rejects %s before any approval reply or native dialog", async method => {
  vi.mocked(approval.nativeLocalApproval).mockImplementation(async (_scope, _task, _run, _signal, phase) => { phase?.("pending_owner"); return "approved"; });
  const f = await fixture(undefined, process.cwd(), "read_only");
  f.send({ id: "reader-approval", method, params: {
    threadId: "thread", turnId: "turn", itemId: "item", command: "touch reader-write", cwd: process.cwd(),
    availableDecisions: ["accept"], networkApprovalContext: { host: "example.com", protocol: "https" },
    additionalPermissions: { network: { enabled: true } }, permissions: { fileSystem: { write: [process.cwd()] } },
  } });
  const result = f.codex.approvalStatus("task", f.run.run_id);
  expect(result).toMatchObject({ execution_mode: "read_only", state: "blocked", reason: "read_only_approval_denied" });
  expect(approval.nativeLocalApproval).not.toHaveBeenCalled();
  expect(f.wire.some(m => m.id === "reader-approval")).toBe(false);
  await expect(f.codex.reply("task", f.run.run_id, "reader-approval", "approved")).rejects.toMatchObject({ code: "INPUT_REQUEST_NOT_FOUND" });
});

it.each(["git commit --only -m message -- a.txt", "git commit && git push", "git commit -m $(id)"])("refuses unproven execution scope: %s", async command => {
  const f = await fixture();
  f.send({ id: "approval-wire-id", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", turnId: "turn", itemId: "item", kind: "command", startedAtMs: Date.now(),
    environmentId: null, command, cwd: process.cwd(), additionalPermissions: null,
  } });
  const blocked = f.codex.approvalStatus("task", f.run.run_id);
  expect(blocked).toMatchObject({
    state: "blocked", reason: "approval_required", resumable: false,
    approval_scope_error: "UNSUPPORTED_APPROVAL_SCOPE",
    approval_scope_reason: "HERMETIC_GIT_COMMAND_REQUIRED",
  });
  expect(blocked.approval_scope_diagnostic).toBeUndefined();
  expect(f.terminal).toHaveBeenCalledTimes(1);
  expect(f.wire.some(m => m.id === "approval-wire-id")).toBe(false);
  await expect(f.codex.reply("task", f.run.run_id, "anything", "yes")).rejects.toMatchObject({ code: "INPUT_REQUEST_NOT_FOUND" });
  expect(() => f.codex.approvalStatus("wrong-task", f.run.run_id)).toThrow();
});

it("preserves question wire ids and the same live run", async () => {
  const f = await fixture();
  f.send({ id: "question-wire-id", method: "item/tool/requestUserInput", params: {
    threadId: "thread", turnId: "turn", itemId: "item", questions: [{ id: "q", header: "Choice", question: "Which?" }],
  } });
  const pending = f.codex.approvalStatus("task", f.run.run_id);
  expect(pending).toMatchObject({ resumable: true, reason: "user_input_required", run_id: f.run.run_id });
  expect(f.terminal).not.toHaveBeenCalled();
  await f.codex.reply("task", f.run.run_id, pending.input_request_id!, "answer");
  expect(f.wire.at(-1)).toEqual({ id: "question-wire-id", result: { answers: { q: { answers: ["answer"] } } } });
});

it("preserves the existing owner network policy and wire id", async () => {
  const f = await fixture();
  f.send({ id: 991, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", turnId: "turn", itemId: "item", networkApprovalContext: { host: "example.com", protocol: "https" },
  } });
  expect(f.wire.at(-1)).toEqual({ id: 991, result: { decision: "accept" } });
  expect(f.codex.approvalStatus("task", f.run.run_id).state).toBe("running");
  expect(f.terminal).not.toHaveBeenCalled();
});

async function pendingFixture(delayMs = 0) {
  const f = await fixture();
  if (delayMs) await vi.advanceTimersByTimeAsync(delayMs);
  const scope = { type: "git_commit" as const, root: process.cwd(), files: ["a.txt"], fingerprint: "fixture-state" };
  vi.mocked(approval.validateLocalApproval).mockReturnValue(scope);
  let decide!: (value: string) => void;
  vi.mocked(approval.nativeLocalApproval).mockImplementation((_scope, _task, _run, _signal, phase) => { phase?.("pending_owner"); return new Promise(resolve => { decide = resolve; }); });
  const request = { id: "original-rpc", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", turnId: "turn", itemId: "item", command: "immutable fixture command" } };
  f.send(request);
  return { ...f, decide, request, scope };
}

function managedRequest() {
  return { id: "managed-rpc", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", turnId: "turn", itemId: "network-item",
    networkApprovalContext: { host: "downloads.example.com", protocol: "https" },
    additionalPermissions: { network: { enabled: true }, fileSystem: null },
    availableDecisions: ["accept", "decline", "cancel"],
  } };
}

it.each(["prepare", "compile", "sign", "launch"] as const)("mocked %s startup hang stops at 45 seconds and late callbacks cannot grant", async phase => {
  vi.useFakeTimers();
  const f = await fixture();
  let report!: NonNullable<Parameters<typeof approval.nativeLocalApproval>[4]>;
  let decide!: (decision: string) => void;
  vi.mocked(approval.nativeLocalApproval).mockImplementation((_s, _t, _r, _signal, onPhase) => {
    report = onPhase!; report(phase);
    return new Promise(resolve => { decide = resolve; });
  });
  f.send(managedRequest());
  expect(f.codex.approvalStatus("task", f.run.run_id).approval_diagnostic?.native_delivery).toEqual({ phase, readiness: "unobserved", user_receipt: "unknown" });
  expect(f.notifications).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(44_999);
  expect(f.terminal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  report("pending_owner"); decide("approved"); await Promise.resolve();
  const result = f.codex.approvalStatus("task", f.run.run_id);
  expect(result).toMatchObject({ state: "failed", reason: "local_approval_unavailable",
    approval_diagnostic: { native_delivery: { phase: "failed", readiness: "unobserved", user_receipt: "unknown", failure_code: `NATIVE_HELPER_${phase.toUpperCase()}_TIMEOUT` } } });
  expect(f.terminal).toHaveBeenCalledOnce();
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("mocked approval without readiness fails closed", async () => {
  const f = await fixture(); vi.mocked(approval.nativeLocalApproval).mockResolvedValue("approved");
  f.send(managedRequest()); await Promise.resolve();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ reason: "local_approval_unavailable",
    approval_diagnostic: { native_delivery: { failure_code: "NATIVE_HELPER_NOT_READY" } } });
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("mocked late readiness cannot outrun an overdue startup timer", async () => {
  vi.useFakeTimers(); const f = await fixture();
  let report!: NonNullable<Parameters<typeof approval.nativeLocalApproval>[4]>;
  let decide!: (decision: string) => void;
  vi.mocked(approval.nativeLocalApproval).mockImplementation((_s, _t, _r, _signal, onPhase) => {
    report = onPhase!; return new Promise(resolve => { decide = resolve; });
  });
  f.send(managedRequest());
  vi.setSystemTime(Date.now() + 45_001);
  report("pending_owner"); decide("approved"); await Promise.resolve();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ reason: "local_approval_unavailable" });
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("mocked readiness is not receipt or consent; duplicate readiness never resets the deadline", async () => {
  vi.useFakeTimers(); const f = await fixture();
  let report!: NonNullable<Parameters<typeof approval.nativeLocalApproval>[4]>;
  let decide!: (decision: string) => void;
  vi.mocked(approval.nativeLocalApproval).mockImplementation((_s, _t, _r, _signal, onPhase) => {
    report = onPhase!; return new Promise(resolve => { decide = resolve; });
  });
  f.send(managedRequest()); await vi.advanceTimersByTimeAsync(40_000);
  report("pending_owner"); report("pending_owner");
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ approval_diagnostic: {
    native_delivery: { phase: "pending_owner", readiness: "helper_reported", user_receipt: "unknown" } } });
  expect(f.notifications).toHaveBeenCalledOnce();
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
  await vi.advanceTimersByTimeAsync(2_665_000);
  report("pending_owner"); decide("approved"); await Promise.resolve();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ reason: "local_approval_expired",
    approval_diagnostic: { native_delivery: { phase: "expired" } } });
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it.each(["NATIVE_HELPER_PREPARE_FAILED", "NATIVE_HELPER_COMPILE_FAILED", "NATIVE_HELPER_SIGN_FAILED", "NATIVE_HELPER_LAUNCH_FAILED", "sample-secret"])("mocked failure %s is safely retained in the same run result", async code => {
  const f = await fixture();
  vi.mocked(approval.nativeLocalApproval).mockRejectedValue(Object.assign(new Error("sample-secret"), { code, path: "/sample-secret" }));
  f.send(managedRequest()); await Promise.resolve(); await Promise.resolve();
  const result = f.codex.approvalStatus("task", f.run.run_id);
  expect(result).toMatchObject({ run_id: f.run.run_id, reason: "local_approval_unavailable", approval_diagnostic: { native_delivery: { phase: "failed" } } });
  expect(result.approval_diagnostic?.native_delivery?.failure_code).toBe(code === "sample-secret" ? undefined : code);
  expect(JSON.stringify(result)).not.toContain("sample-secret");
  expect(await f.codex.wait("task", f.run.run_id)).toEqual(result);
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

async function managedPending() {
  const f = await fixture();
  let decide!: (v: string) => void;
  vi.mocked(approval.nativeLocalApproval).mockImplementation((_scope, _task, _run, _signal, phase) => { phase?.("pending_owner"); return new Promise(resolve => { decide = resolve; }); });
  const request = managedRequest(); f.send(request);
  return { ...f, decide, request };
}

it("managed read-only requests cannot prompt or grant even with valid metadata", async () => {
  const f = await fixture(undefined, process.cwd(), "read_only"); f.send(managedRequest());
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ reason: "read_only_approval_denied", resumable: false });
  expect(approval.nativeLocalApproval).not.toHaveBeenCalled();
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("managed native consent shares the three-request turn cap and burns duplicate ids", async () => {
  const f = await fixture(); vi.mocked(approval.nativeLocalApproval).mockImplementation(async (_scope, _task, _run, _signal, phase) => { phase?.("pending_owner"); return "approved"; });
  for (let i = 0; i < 4; i++) {
    f.send({ ...managedRequest(), id: `managed-${i}` });
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(approval.nativeLocalApproval).toHaveBeenCalledTimes(3);
  expect(f.wire.filter(m => m.result?.decision)).toHaveLength(3);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ resumable: false, approval_scope_reason: "MANAGED_NETWORK_APPROVAL_LIMIT" });
});

it("a consumed managed request cannot be accepted again", async () => {
  const f = await managedPending(); f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  f.send(f.request);
  expect(f.wire.filter(m => m.id === f.request.id)).toHaveLength(1);
  expect(approval.nativeLocalApproval).toHaveBeenCalledTimes(1);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason: "approval_request_changed" });
});

it("managed timeout burns consent even when the mocked helper never resolves", async () => {
  vi.useFakeTimers(); const f = await managedPending();
  await vi.advanceTimersByTimeAsync(2_700_000);
  f.decide("approved"); await Promise.resolve();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ reason: "local_approval_expired" });
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("a restarted runtime needs its own native decision", async () => {
  const old = await managedPending(); await old.codex.close();
  const fresh = await managedPending(); old.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  expect(fresh.wire.some(m => m.result?.decision)).toBe(false);
  expect(fresh.codex.approvalStatus("task", fresh.run.run_id)).toMatchObject({ waiting_for_local_approval: true });
  fresh.decide("denied"); await new Promise(resolve => setImmediate(resolve));
});

it.each(["turn", "wrong-turn"])("managed early request waits for verified turn: %s", async turnId => {
  const request = managedRequest(); request.params.turnId = turnId;
  vi.mocked(approval.nativeLocalApproval).mockImplementation(() => new Promise(() => {}));
  const f = await fixture(request);
  expect(approval.nativeLocalApproval).toHaveBeenCalledTimes(turnId === "turn" ? 1 : 0);
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("managed presentation contains only destination scope and the grouping limitation", () => {
  const scope = approval.validateManagedNetworkApproval(managedRequest().params, process.cwd())!;
  expect(approval.localApprovalPresentation(scope, "task", "run")).toMatchObject({ mode: "approve-network" });
  const { message } = approval.localApprovalPresentation(scope, "task", "run");
  expect(message).toContain("downloads.example.com");
  expect(message).toContain("HTTP 接続一回だけを保証する承認ではありません");
});

it("managed native consent continues the SAME fake run and exposes its executable result through wait/status", async () => {
  const f = await managedPending();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "blocked", resumable: true,
    waiting_for_local_approval: true, approval_type: "managed_network" });
  expect(f.wire.some(m => m.id === f.request.id)).toBe(false);
  f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.filter(m => m.id === f.request.id)).toEqual([{ id: f.request.id, result: { decision: "accept" } }]);
  const item = { id: "result", type: "agentMessage", text: "offline execution complete" };
  f.send({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item } });
  f.send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [item] } } });
  expect(await f.codex.wait("task", f.run.run_id)).toMatchObject({ run_id: f.run.run_id, state: "completed", summary: item.text });
  expect(f.codex.approvalStatus("task", f.run.run_id).state).toBe("completed");
});

it("synthetic OBSERVED shape (not recovered historical request) requires verified destination metadata", async () => {
  const f = await fixture(); const request: any = managedRequest();
  delete request.params.networkApprovalContext;
  request.params.command = "synthetic command";
  f.send(request);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "blocked", resumable: false,
    approval_scope_reason: "MANAGED_NETWORK_SCOPE_REQUIRED", approval_diagnostic: {
      command_present: true, permissions_shape: "object", filesystem_shape: "null", network_requested: true,
      stage: "network", schema_diagnostic: { valid: true },
    } });
  expect(approval.nativeLocalApproval).not.toHaveBeenCalled();
  expect(f.wire.some(m => m.id === request.id)).toBe(false);
});

it.each(["denied", "timed_out", "cancelled", "unavailable"])("managed %s issues no grant", async decision => {
  const f = await managedPending(); f.decide(decision); await new Promise(resolve => setImmediate(resolve));
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason:
    decision === "timed_out" ? "local_approval_expired" : `local_approval_${decision}` });
  expect(f.wire.some(m => m.id === f.request.id)).toBe(false);
});

it.each(["destination", "correlation", "duplicate", "restart", "resolved", "expiry"])("managed %s cannot reuse pending consent", async change => {
  const f = await managedPending();
  if (change === "destination") (f.codex as any).active.approval.params.networkApprovalContext.host = "changed.example.com";
  if (change === "correlation") (f.codex as any).active.approval.params.turnId = "changed-turn";
  if (change === "duplicate") f.send(f.request);
  if (change === "restart") await f.codex.close();
  if (change === "resolved") f.send({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: f.request.id } });
  if (change === "expiry") (f.codex as any).active.approval.expires = Date.now() - 1;
  f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.some(m => m.id === f.request.id)).toBe(false);
});

it.each([
  { networkApprovalContext: { host: "example.com:443", protocol: "https" } },
  { networkApprovalContext: { host: "127.0.0.1", protocol: "https" } },
  { networkApprovalContext: { host: "x.localhost", protocol: "https" } },
  { networkApprovalContext: { host: "*.example.com", protocol: "https" } },
  { networkApprovalContext: { host: "example.com", protocol: "http" } },
  { networkApprovalContext: { host: "example.com", protocol: "https", extra: true } },
  { additionalPermissions: { network: { enabled: true }, fileSystem: { write: ["/tmp"] } } },
  { sandbox_permissions: "require_escalated" },
  { proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }] },
  { proposedExecpolicyAmendment: ["curl"] },
  { availableDecisions: ["acceptForSession"] },
])("managed invalid/mixed scope never prompts: %j", async extra => {
  const f = await fixture(); const request = managedRequest();
  f.send({ ...request, params: { ...request.params, ...extra } });
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ resumable: false, approval_scope_reason: "MANAGED_NETWORK_SCOPE_INVALID" });
  expect(approval.nativeLocalApproval).not.toHaveBeenCalled();
  expect(f.wire.some(m => m.id === request.id)).toBe(false);
});

async function workspaceCommandPending(additionalPermissions: any = null) {
  const f = await fixture();
  let decide!: (value: string) => void;
  vi.mocked(approval.nativeLocalApproval).mockImplementation((_scope, _task, _run, _signal, phase) => { phase?.("pending_owner"); return new Promise(resolve => { decide = resolve; }); });
  const request = {
    id: "workspace-command-rpc",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      startedAtMs: Date.now(),
      environmentId: "local",
      kind: "command",
      command: "/usr/bin/python3 -c \"print(12345)\"",
      cwd: process.cwd(),
      additionalPermissions,
      availableDecisions: ["accept", "cancel"],
    },
  };
  f.send(request);
  await new Promise(resolve => setImmediate(resolve));
  return { ...f, decide, request };
}

it("accepts one exact workspace command through native approval and completes the same run", async () => {
  const f = await workspaceCommandPending();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({
    state: "blocked", reason: "approval_required", resumable: true,
    approval_type: "workspace_command", waiting_for_local_approval: true,
  });
  expect(vi.mocked(approval.nativeLocalApproval).mock.calls[0]?.[0]).toMatchObject({
    type: "workspace_command", command: f.request.params.command, readPaths: [], writePaths: [],
  });
  f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.filter(m => m.id === "workspace-command-rpc")).toEqual([
    { id: "workspace-command-rpc", result: { decision: "accept" } },
  ]);
  f.send({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "workspace-command-rpc" } });
  f.send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } } });
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "completed", run_id: f.run.run_id });
});

it("denies an exact workspace command without writing an accept decision", async () => {
  const f = await workspaceCommandPending();
  f.decide("denied"); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.some(m => m.id === "workspace-command-rpc" && m.result?.decision === "accept")).toBe(false);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason: "local_approval_denied" });
});

it.each([
  ["timed_out", "local_approval_expired"],
  ["cancelled", "local_approval_cancelled"],
])("keeps generic command %s consistent with the terminal reason", async (decision, reason) => {
  const f = await workspaceCommandPending();
  f.decide(decision); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.some(m => m.id === "workspace-command-rpc" && m.result?.decision === "accept")).toBe(false);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason });
});

it("rejects a changed generic permission identity after approval and never accepts", async () => {
  const owned = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "c2c-generic-approval-change-"));
  const target = path.join(owned, "target");
  try {
    const additional = {
      network: null,
      fileSystem: {
        read: null,
        write: [target],
        entries: [{ path: { type: "path", path: target }, access: "write" }],
      },
    };
    const f = await workspaceCommandPending(additional);
    expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ approval_type: "workspace_command" });
    fs.writeFileSync(target, "changed after prompt");
    f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
    expect(f.wire.some(m => m.id === "workspace-command-rpc" && m.result?.decision === "accept")).toBe(false);
    expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason: "local_approval_changed" });
  } finally {
    fs.rmSync(owned, { recursive: true, force: true });
  }
});

it("keeps pending nonterminal then accepts the ORIGINAL RPC and completes the SAME turn", async () => {
  const f = await pendingFixture();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "blocked", resumable: true,
    approval_type: "git_commit", waiting_for_local_approval: true });
  expect(f.codex.runtimeStatus()).toMatchObject({ activeRuns: 1, waitingRuns: 1 });
  expect(f.terminal).not.toHaveBeenCalled();
  await expect(f.codex.reply("task", f.run.run_id, "anything", "yes")).rejects.toMatchObject({ code: "INPUT_REQUEST_NOT_FOUND" });
  f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.filter(m => m.id === "original-rpc")).toEqual([{ id: "original-rpc", result: { decision: "accept" } }]);
  expect(f.terminal).not.toHaveBeenCalled();
  f.send({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "original-rpc" } });
  f.send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } } });
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ run_id: f.run.run_id, state: "completed" });
  expect(f.wire.filter(m => m.method === "turn/start")).toHaveLength(1);
  expect(f.wire.filter(m => m.method === "thread/start")).toHaveLength(1);
  expect(f.terminal).toHaveBeenCalledTimes(1);
});

it.each([
  ["denied", "local_approval_denied"],
  ["timed_out", "local_approval_expired"],
  ["cancelled", "local_approval_cancelled"],
  ["unavailable", "local_approval_unavailable"],
])("does not accept native %s", async (decision, reason) => {
  const f = await pendingFixture(); f.decide(decision); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason });
});

it.each(["resolved", "close", "duplicate", "changed", "timeout", "wrong-turn", "epoch"])("invalidates pending authorization on %s", async mode => {
  const f = await pendingFixture();
  if (mode === "resolved") f.send({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "original-rpc" } });
  if (mode === "close") await f.codex.close();
  if (mode === "duplicate") f.send(f.request);
  if (mode === "changed") vi.mocked(approval.validateLocalApproval).mockReturnValue({ ...f.scope, fingerprint: "changed-index" });
  if (mode === "wrong-turn") f.send({ ...f.request, params: { ...f.request.params, turnId: "other" } });
  if (mode === "epoch") (f.codex as any).activeEpoch++;
  if (mode === "timeout") { (f.codex as any).active.approval.expires = 0; }
  f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("burns an approval before a failed write and never retries", async () => {
  const f = await pendingFixture();
  const write = vi.spyOn(f.child.stdin, "write").mockImplementation(() => { throw new Error("fixture"); });
  f.decide("approved"); await new Promise(resolve => setImmediate(resolve));
  expect(write).toHaveBeenCalledTimes(1);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason: "protocol_write_failed" });
});

it("bounds response backpressure and ignores its late callback", async () => {
  const f = await pendingFixture(); vi.useFakeTimers();
  let callback: any;
  const write = vi.spyOn(f.child.stdin, "write").mockImplementation((_text, cb) => { callback = cb; return false; });
  f.decide("approved"); await vi.advanceTimersByTimeAsync(10_001);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason: "approval_reply_timeout" });
  callback(); expect(write).toHaveBeenCalledTimes(1);
});

it("expires a native dialog even if the helper never resolves", async () => {
  vi.useFakeTimers(); const f = await pendingFixture();
  await vi.advanceTimersByTimeAsync(2_699_999);
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ waiting_for_local_approval: true });
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  f.decide("approved"); await Promise.resolve();
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ reason: "local_approval_expired" });
  expect(f.wire.some(m => m.result?.decision)).toBe(false);
});

it("allows an owner response just before 45 minutes even when the dialog opens late in a turn", async () => {
  vi.useFakeTimers(); const f = await pendingFixture(2_999_000);
  await vi.advanceTimersByTimeAsync(2_699_999);
  f.decide("approved"); await Promise.resolve();
  expect(f.wire.filter(m => m.id === "original-rpc")).toEqual([{ id: "original-rpc", result: { decision: "accept" } }]);
});

it.each(["turn", "wrong-turn"])("queues early approval until turn identity is validated: %s", async turnId => {
  vi.mocked(approval.validateLocalApproval).mockReturnValue({ type: "git_stage", root: process.cwd(), files: ["a.txt"], fingerprint: "fixed" });
  vi.mocked(approval.nativeLocalApproval).mockImplementation(() => new Promise(() => {}));
  const f = await fixture({ id: "early", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId, itemId: "item" } });
  expect(approval.nativeLocalApproval).toHaveBeenCalledTimes(turnId === "turn" ? 1 : 0);
  expect(f.codex.approvalStatus("task", f.run.run_id).state).toBe(turnId === "turn" ? "blocked" : "failed");
});

it.each(["direct", "sh", "zsh", "bad-overlay", "raw-change", "shell-change", "entries", "entries-change", "entry-path-change", "bad-entries", "proposal", "proposal-alternative", "proposal-denied", "proposal-timed-out", "proposal-changed", "proposal-removed", "proposal-replaced", "proposal-expired", "proposal-fresh"])("uses the production scope validator through the same-run lifecycle: %s", async mode => {
  const root = makeTmpDir("approval-production-validator");
  try {
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
    fs.writeFileSync(path.join(root, ".git/HEAD"), "a".repeat(40) + "\n");
    fs.writeFileSync(path.join(root, "a.txt"), "fixture");
    fs.writeFileSync(path.join(root, "acceptance.txt"), "fixture");
    const actual = await vi.importActual<typeof approval>("../src/codex/local-approval.js");
    vi.mocked(approval.validateLocalApproval).mockImplementation(actual.validateLocalApproval);
    let decide!: (value: string) => void;
    vi.mocked(approval.nativeLocalApproval).mockImplementation((_scope, _task, _run, _signal, phase) => { phase?.("pending_owner"); return new Promise(resolve => { decide = resolve; }); });
    const f = await fixture(undefined, root);
    const proposal = mode.startsWith("proposal");
    const inner = approval.LOCAL_GIT_PREFIX + (mode.includes("entr") || proposal
      ? " commit --only -m 'C2C native approval E2E' -- acceptance.txt" : " commit --only -m '修正' -- a.txt");
    const fullProposal = approval.LOCAL_GIT_PREFIX.split(" ").concat(["commit", "--only", "-m", "C2C native approval E2E", "--", "acceptance.txt"]);
    if (proposal) {
      expect(fullProposal).toHaveLength(37);
      expect(createHash("sha256").update(`/bin/sh -c "${inner}"`).digest("hex")).toBe("1645e907642ae6975096d4d7b342421aae0115516c9cef82db76ac330251dd8c");
    }
    f.send({ id: "scoped-production", method: "item/commandExecution/requestApproval", params: {
      environmentId: "local", threadId: "thread", turnId: "turn", itemId: "item", cwd: root,
      ...(proposal ? { kind: "command", startedAtMs: 1, approvalId: null, reason: null, commandActions: null,
        networkApprovalContext: null, proposedNetworkPolicyAmendments: null, proposedExecpolicyAmendment: fullProposal,
        availableDecisions: ["accept", "cancel", ...(mode === "proposal-alternative" ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: fullProposal } }] : [])] } : {}),
      command: mode === "direct" ? inner : `/${mode === "zsh" ? "bin/zsh" : "bin/sh"} -c "${inner}"`,
      additionalPermissions: { network: null, fileSystem: { read: null, write: [mode === "bad-overlay" ? root : path.join(root, ".git")],
        ...(mode.includes("entr") || proposal ? { entries: [{ path: { type: "path", path: mode === "bad-entries" ? root : path.join(root, ".git") }, access: "write" }] } : {}) } },
    } });
    if (mode === "zsh" || mode === "bad-overlay" || mode === "bad-entries") {
      expect(approval.nativeLocalApproval).not.toHaveBeenCalled();
      expect(f.wire.some(m => m.result?.decision)).toBe(false);
      expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ resumable: false });
      return;
    }
    expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ resumable: true, waiting_for_local_approval: true });
    expect(approval.nativeLocalApproval).toHaveBeenCalledTimes(1);
    if (mode === "raw-change") (f.codex as any).active.approval.params.command = inner;
    if (mode === "entries-change") delete (f.codex as any).active.approval.params.additionalPermissions.fileSystem.entries;
    if (mode === "entry-path-change") (f.codex as any).active.approval.params.additionalPermissions.fileSystem.entries[0].path.path = root;
    if (mode === "proposal-changed") (f.codex as any).active.approval.params.proposedExecpolicyAmendment[0] = "other";
    if (mode === "proposal-removed") delete (f.codex as any).active.approval.params.proposedExecpolicyAmendment;
    if (mode === "proposal-replaced") (f.codex as any).active.approval.params.proposedExecpolicyAmendment = [];
    if (mode === "proposal-expired") (f.codex as any).active.approval.expires = 0;
    if (mode === "shell-change") {
      const lstat = fs.lstatSync;
      vi.spyOn(fs, "lstatSync").mockImplementation(((file: any, ...args: any[]) => {
        const value = (lstat as any)(file, ...args);
        return file === "/bin/sh" ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { uid: 501 }) : value;
      }) as any);
    }
    decide(mode === "proposal-denied" ? "denied" : mode === "proposal-timed-out" ? "timed_out" : "approved"); await new Promise(resolve => setImmediate(resolve));
    if (mode === "proposal-denied" || mode === "proposal-timed-out") {
      expect(f.wire.some(m => m.result?.decision)).toBe(false);
      expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed",
        reason: mode === "proposal-denied" ? "local_approval_denied" : "local_approval_expired" });
      return;
    }
    if (mode === "raw-change" || mode === "shell-change" || mode === "entries-change" || mode === "entry-path-change" || ["proposal-changed", "proposal-removed", "proposal-replaced", "proposal-expired"].includes(mode)) {
      expect(f.wire.some(m => m.result?.decision)).toBe(false);
      expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "failed", reason: "local_approval_changed" });
      return;
    }
    expect(f.wire.at(-1)).toEqual({ id: "scoped-production", result: { decision: "accept" } });
    expect(f.terminal).not.toHaveBeenCalled();
    if (mode === "proposal-fresh") {
      f.send({ id: "fresh-rpc", method: "item/commandExecution/requestApproval", params: {
        environmentId: "local", threadId: "thread", turnId: "turn", itemId: "fresh-item", cwd: root,
        command: `/bin/sh -c "${inner}"`, proposedExecpolicyAmendment: fullProposal, availableDecisions: ["accept", "cancel"],
        additionalPermissions: { network: null, fileSystem: { read: null, write: [root + "/.git"] } },
      } });
      expect(approval.nativeLocalApproval).toHaveBeenCalledTimes(2);
      expect(f.wire.filter(m => m.id === "fresh-rpc")).toHaveLength(0);
      expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ waiting_for_local_approval: true });
      decide("denied"); await new Promise(resolve => setImmediate(resolve));
      expect(f.wire.filter(m => m.result?.decision)).toEqual([{ id: "scoped-production", result: { decision: "accept" } }]);
      return;
    }
    f.send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } } });
    expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ run_id: f.run.run_id, state: "completed" });
    expect(f.terminal).toHaveBeenCalledTimes(1);
    expect(f.wire.filter(m => m.id === "scoped-production")).toHaveLength(1);
    await f.codex.close();
  } finally { cleanup(root); }
});

it("emits live question and local approval attention once without status polling", async () => {
  const f = await fixture();
  f.send({ id: "question", method: "item/tool/requestUserInput", params: {
    threadId: "thread", turnId: "turn", itemId: "item", questions: [{ id: "q", header: "Choice", question: "Which?" }],
  } });
  expect(f.notifications).toHaveBeenCalledTimes(1);
  expect(f.notifications.mock.calls[0][0]).toMatchObject({ state: "blocked", reason: "user_input_required" });
  expect(f.notifications.mock.calls[0][1]).toBe("input:1");
  f.codex.approvalStatus("task", f.run.run_id);
  f.codex.approvalStatus("task", f.run.run_id);
  expect(f.notifications).toHaveBeenCalledTimes(1);
  await f.codex.reply("task", f.run.run_id, f.codex.approvalStatus("task", f.run.run_id).input_request_id!, "answer");
  const pending = await pendingFixture();
  expect(pending.notifications).toHaveBeenCalledTimes(1);
  expect(pending.notifications.mock.calls[0][0]).toMatchObject({ state: "blocked", reason: "approval_required", resumable: true });
  expect(pending.notifications.mock.calls[0][1]).toBe("approval:1");
  pending.codex.approvalStatus("task", pending.run.run_id);
  pending.codex.approvalStatus("task", pending.run.run_id);
  expect(pending.notifications).toHaveBeenCalledTimes(1);
  pending.decide("denied"); await new Promise(resolve => setImmediate(resolve));
  expect(pending.notifications).toHaveBeenCalledTimes(2);
  expect(pending.notifications.mock.calls[1]).toEqual([expect.objectContaining({ state: "failed", reason: "local_approval_denied" }), "terminal"]);
  expect(pending.notifications.mock.calls[1][0].resumable).not.toBe(true);
});

it("best-effort notice hook throws preserve a live channel and a completed execution", async () => {
  const f = await fixture(); f.notifications.mockImplementation(() => { throw new Error("private notification error"); });
  f.send({ id: "question", method: "item/tool/requestUserInput", params: {
    threadId: "thread", turnId: "turn", itemId: "item", questions: [{ id: "q", header: "Choice", question: "Which?" }],
  } });
  const pending = f.codex.approvalStatus("task", f.run.run_id);
  expect(pending).toMatchObject({ state: "blocked", resumable: true }); expect(f.terminal).not.toHaveBeenCalled();
  await f.codex.reply("task", f.run.run_id, pending.input_request_id!, "explicit fixture answer");
  f.send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } } });
  expect(f.codex.approvalStatus("task", f.run.run_id)).toMatchObject({ state: "completed" });
  expect(f.terminal).toHaveBeenCalledTimes(1); expect(f.notifications).toHaveBeenCalledTimes(2);
});
