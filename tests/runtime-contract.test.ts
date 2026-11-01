import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { FIRST_TURN_CONTRACT_PREFIX, RUNTIME_CONTRACT } from "../src/codex/runtime-contract.js";
import { CODEX_TURN_TIMEOUT_MS, OWNER_DIALOG_TIMEOUT_MS } from "../src/security/owner-dialog-timeouts.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";
import { spawn, spawnSync, exec, execFile } from "node:child_process";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("Unexpected subprocess"); }),
  spawnSync: vi.fn(() => { throw new Error("Unexpected subprocess"); }),
  exec: vi.fn(() => { throw new Error("Unexpected subprocess"); }),
  execFile: vi.fn(() => { throw new Error("Unexpected subprocess"); }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(["1", "0"])("matches actual first-turn UTF-8 validation with economy=%s", async economy => {
  vi.stubEnv("C2C_CODEX_ECONOMY_MODE", economy);
  vi.stubEnv("C2C_CODEX_MAX_INSTRUCTION_BYTES", "1024");
  vi.stubEnv("C2C_CODEX_MAX_SUMMARY_BYTES", "2048");
  const client = new CodexAppServer({ workspaceRoot: process.cwd(), binary: process.execPath, logger: nullLogger });
  // Closed clients still perform real instruction validation before the CLOSED guard.
  await client.close();
  const status = client.runtimeStatus();
  const overhead = economy === "1" ? Buffer.byteLength(FIRST_TURN_CONTRACT_PREFIX, "utf8") : 0;
  expect(FIRST_TURN_CONTRACT_PREFIX.endsWith("\n\n")).toBe(true);
  expect(status).toMatchObject({ instruction_max_utf8_bytes: 1024,
    first_turn_internal_contract_utf8_bytes: overhead, usable_first_turn_utf8_bytes: 1024 - overhead,
    summary_max_utf8_bytes: 2048, turn_timeout_ms: CODEX_TURN_TIMEOUT_MS,
    owner_dialog_timeout_ms: OWNER_DIALOG_TIMEOUT_MS, wait_ceiling_ms: status.wait.hardCeilingMs,
    max_iterations: status.maxIterations });
  // Changing the environment after capture cannot change the effective budget.
  vi.stubEnv("C2C_CODEX_MAX_INSTRUCTION_BYTES", "4096");
  for (const unit of ["a", "日"]) {
    const budget = status.usable_first_turn_utf8_bytes;
    const exact = unit.repeat(Math.floor(budget / Buffer.byteLength(unit))) + "a".repeat(budget % Buffer.byteLength(unit));
    expect(Buffer.byteLength(exact)).toBe(budget);
    await expect(client.startTurn("boundary", 1, exact)).rejects.toMatchObject({ code: "CLOSED" });
    await expect(client.startTurn("boundary", 1, exact + "a")).rejects.toMatchObject({ code: "INVALID_INSTRUCTION" });
  }
  expect(spawn).not.toHaveBeenCalled();
});

it("keeps unknown distinct from unsupported and source implementation distinct from live acceptance", () => {
  expect(RUNTIME_CONTRACT.environment.mcp_inventory).toEqual({ status: "unknown", tools: null });
  expect(RUNTIME_CONTRACT.environment).toMatchObject({ executable_version: "unknown", executable_preflight: "unverified", app_server_compatibility: "unverified", version_string_proves_compatibility: false });
  expect(RUNTIME_CONTRACT.capabilities.exact_workspace_command_approval.implementation).toBe("implemented");
  expect(RUNTIME_CONTRACT.capabilities.mcp_elicitation_form.implementation).toBe("implemented");
  expect(RUNTIME_CONTRACT.capabilities.mcp_elicitation_url.implementation).toBe("unsupported");
  expect(RUNTIME_CONTRACT.capabilities.background_host_reentry).toMatchObject({ implementation: "unsupported", automatic: false });
  expect(RUNTIME_CONTRACT.capabilities.automatic_notification.boundary).toContain("Exit zero is not OS presentation");
  for (const capability of Object.values(RUNTIME_CONTRACT.capabilities)) expect(capability.live_acceptance).toBe("unverified");
});

it("offers inspection and native-owner guidance without approval or terminal revival", () => {
  const guidance = RUNTIME_CONTRACT.guidance;
  expect(guidance).toMatchObject({ kind: "advisory_response_and_templates", persisted_state_wiring: "bounded_notification_evidence_only" });
  expect(guidance.states.live_input).toMatchObject({ tool: "codex_turn_reply", required_arguments: ["workspace_id", "task_id", "run_id", "input_request_id"], one_of_arguments: ["message", "answers"] });
  expect(guidance.states.live_input.condition).toContain("resumable:true");
  expect(guidance.states.local_approval.native_owner_action).toContain("assistant never approves");
  for (const state of ["unsupported_terminal", "timeout", "restart_interruption"] as const) {
    expect(["task_status", "task_resume_context"]).toContain(guidance.states[state].tool);
    expect(guidance.states[state].required_arguments).toContain("workspace_id");
  }
  expect(guidance.states.unsupported_terminal.condition).toContain("no reply, replay or invented continuation");
});

it("MCP runtime status reads without subprocess, task, approval, state writes or result mutation", async () => {
  const root = makeTmpDir("stage1-status-workspace");
  const state = makeTmpDir("stage1-status-state");
  vi.stubEnv("C2C_STATE_DIR", state);
  const workspace = new Workspace(root);
  const hooks = { onRunStarting: vi.fn(), onRunTerminal: vi.fn(), onRunNotification: vi.fn() };
  const codex = new CodexAppServer({ workspaceRoot: root, binary: process.execPath, logger: nullLogger, ...hooks });
  const taskWorkspaces = new Map<string, string>();
  const journal = vi.fn(() => { throw new Error("Unexpected journal access"); });
  const reconciler = vi.fn(() => { throw new Error("Unexpected approval access"); });
  const server = createMcpServer({ workspace, codex, taskWorkspaces, getTaskJournal: journal, getTaskReconciler: reconciler, logger: nullLogger });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stage1-status", version: "1" });
  try {
    await server.connect(b); await client.connect(a);
    const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs, "mkdirSync"), vi.spyOn(fs, "renameSync")];
    const before = codex.runtimeStatus();
    const result = await client.callTool({ name: "codex_runtime_status", arguments: { workspace_id: workspace.id } });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body).toMatchObject({ ...before, workspace_id: workspace.id, activeRuns: 0, waitingRuns: 0 });
    // Returned contract is detached from shared source data.
    before.runtime_contract.environment.mcp_inventory.tools = [] as never;
    expect(codex.runtimeStatus().runtime_contract.environment.mcp_inventory.tools).toBeNull();
    expect(taskWorkspaces.size).toBe(0);
    for (const name of ["tasks", "runs", "pending"] ) expect(Reflect.get(codex, name).size).toBe(0);
    for (const fn of [...writes, ...Object.values(hooks), journal, reconciler, spawn, spawnSync, exec, execFile]) expect(fn).not.toHaveBeenCalled();
    for (const spy of writes) spy.mockRestore();
  } finally {
    vi.restoreAllMocks(); await client.close(); await server.close(); await codex.close(); cleanup(root); cleanup(state);
  }
});
