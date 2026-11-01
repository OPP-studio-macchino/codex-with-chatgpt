import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { PREFLIGHT_TIMEOUT_MS, PREFLIGHT_CLEANUP_MS } from "../src/codex/environment-preflight.js";
import { createMcpServer, type McpContext } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const actions: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const action of actions.splice(0).reverse()) await action();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function fixture(body = 'console.log("codex-cli 0.123.0-alpha.2");') {
  const root = makeTmpDir("preflight");
  actions.push(() => cleanup(root));
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  vi.stubEnv("C2C_STATE_DIR", path.join(root, "state"));
  const binary = path.join(root, "configured-launcher.mjs");
  const record = path.join(root, "observation.json");
  const heartbeat = path.join(root, "heartbeat");
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const heartbeatPath = ${JSON.stringify(heartbeat)};
// Only this freshly spawned harmless fixture's own live detached group.
// The explicit parent argument is used by the owned-driver lifecycle test.
const fixtureParent = Number(process.argv[3] ?? ${process.pid});
const stopFixture = () => process.kill(-process.pid, "SIGKILL");
if (process.ppid !== fixtureParent) stopFixture();
setInterval(() => {
  if (process.ppid !== fixtureParent) {
    try { fs.writeFileSync(${JSON.stringify(record + ".parent-change")}, JSON.stringify({before:fixtureParent,after:process.ppid})); }
    finally { stopFixture(); }
  }
}, 25).unref();
setTimeout(stopFixture, 5000).unref();
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),pid:process.pid,secretPresent:!!process.env.C2C_TEST_SECRET}));
${body}\n`, { mode: 0o700 });
  const hooks = { onRunStarting: vi.fn(), onRunTerminal: vi.fn(), onRunNotification: vi.fn() };
  const codex = new CodexAppServer({ workspaceRoot, binary, logger: nullLogger, ...hooks });
  actions.push(() => codex.close());
  return { root, workspaceRoot, binary, record, heartbeat, hooks, codex };
}

async function mcp(auth: AuthInfo, multiProfile = false) {
  const f = fixture();
  const workspace = new Workspace(f.workspaceRoot);
  const taskWorkspaces = new Map<string, string>();
  const getCodex = vi.fn(() => f.codex);
  const getTaskJournal = vi.fn(() => { throw new Error("Unexpected journal"); });
  const getTaskReconciler = vi.fn(() => { throw new Error("Unexpected approval"); });
  const server = createMcpServer({ workspace, codex: f.codex, getCodex, taskWorkspaces,
    getTaskJournal, getTaskReconciler, logger: nullLogger,
    // Exercise the existing target/auth gate without loading or modifying profiles.
    workspaceProfiles: multiProfile ? { count: 2 } as McpContext["workspaceProfiles"] : undefined,
    resolveWorkspace: id => {
      if (id !== workspace.id) throw new Error("Unexpected workspace");
      return { workspace, codexNetworkHosts: [] };
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const send = a.send.bind(a);
  a.send = (message, options) => send(message, { ...options, authInfo: auth });
  const client = new Client({ name: "preflight-test", version: "1" });
  await server.connect(b); await client.connect(a);
  actions.push(async () => { await client.close(); await server.close(); });
  const call = async (args: Record<string, unknown> = { workspace_id: workspace.id }, name = "codex_execution_preflight") => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { error: result.isError === true, body: text.startsWith("{") ? JSON.parse(text) : { message: text } };
  };
  return { ...f, workspace, client, call, getCodex, getTaskJournal, getTaskReconciler, taskWorkspaces };
}

it("observes only fixed --version in the bound cwd with sanitized environment and detached cache", async () => {
  vi.stubEnv("C2C_TEST_SECRET", "fixture-only-do-not-forward");
  const f = fixture();
  expect(f.codex.runtimeStatus().execution_environment_observation).toBeNull();
  const observed = await f.codex.executionPreflight();
  expect(observed).toMatchObject({ probe_status: "observed", observed_version: "0.123.0-alpha.2",
    evidence_scope: "fixed_version_probe_only", identity_stability: "unchanged_at_boundaries", cleanup: "child_closed",
    app_server_compatibility: "unverified", mcp_inventory: { status: "unknown", tools: null }, live_acceptance: "unverified" });
  expect(Date.parse(observed.observed_at)).not.toBeNaN();
  expect(observed.configured_entry).toMatchObject({ canonical_entry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    metadata_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), underlying_toolchain: "unverified",
    fingerprint_scope: "canonical_path_and_file_metadata_not_content" });
  expect(JSON.parse(fs.readFileSync(f.record, "utf8"))).toMatchObject({ argv: ["--version"], cwd: f.workspaceRoot, secretPresent: false });
  expect(JSON.stringify(observed)).not.toContain(f.root);
  observed.mcp_inventory.status = "altered" as never;
  const cached = f.codex.runtimeStatus().execution_environment_observation!;
  expect(cached.mcp_inventory.status).toBe("unknown");
  expect(cached.age_ms).toBeGreaterThanOrEqual(0);
  cached.observed_version = "altered";
  expect(f.codex.runtimeStatus().execution_environment_observation!.observed_version).toBe("0.123.0-alpha.2");
  for (const hook of Object.values(f.hooks)) expect(hook).not.toHaveBeenCalled();
  for (const key of ["tasks", "runs", "pending"]) expect(Reflect.get(f.codex, key).size).toBe(0);
});

it.each([
  ['console.error("fixture-secret-stderr"); process.exit(7);', "failed_exit"],
  ['console.log("fixture-secret-stdout");', "invalid_version_output"],
  ['process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000);', "output_limit"],
  ['process.stderr.write("x".repeat(100000)); setInterval(()=>{},1000);', "output_limit"],
])("bounds and sanitizes failure output (%s)", async (body, status) => {
  const f = fixture(body);
  const observed = await f.codex.executionPreflight();
  expect(observed).toMatchObject({ probe_status: status, observed_version: null, cleanup: "child_closed" });
  expect(JSON.stringify(observed)).not.toContain("fixture-secret");
  const pid = JSON.parse(fs.readFileSync(f.record, "utf8")).pid;
  expect(() => process.kill(pid, 0)).toThrow();
});

it("times out, kills its process group and closes pipes even for a resistant launcher", async () => {
  const f = fixture(`process.on("SIGTERM",()=>{});
spawn(process.execPath,["-e",'const fs=require("node:fs");process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),5000);setInterval(()=>fs.appendFileSync(process.argv[1],"."),50)',heartbeatPath],{stdio:["ignore","pipe","pipe"]});
setInterval(()=>{},1000);`);
  const start = Date.now();
  const observed = await f.codex.executionPreflight();
  expect(observed).toMatchObject({ probe_status: "timed_out", cleanup: "child_closed", observed_version: null });
  expect(Date.now() - start).toBeLessThan(PREFLIGHT_TIMEOUT_MS + PREFLIGHT_CLEANUP_MS + 1000);
  const pid = JSON.parse(fs.readFileSync(f.record, "utf8")).pid;
  expect(() => process.kill(pid, 0)).toThrow();
  const heartbeat = fs.readFileSync(f.heartbeat, "utf8");
  expect(heartbeat.length).toBeGreaterThan(0);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(fs.readFileSync(f.heartbeat, "utf8")).toBe(heartbeat);
});

it.each(["SIGTERM", "SIGKILL"] as const)("self-cleans the detached fixture group when its owned driver receives %s", async signal => {
  const f = fixture(`process.on("SIGTERM",()=>{});
spawn(process.execPath,["-e",'const fs=require("node:fs");process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),5000);setInterval(()=>fs.appendFileSync(process.argv[1],"."),25)',heartbeatPath],{stdio:["ignore",1,2]});
setInterval(()=>{},1000);`);
  // The driver owns the detached probe; inherited pipes let its close event
  // observe probe/descendant closure even after the driver itself has exited.
  const driver = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    spawn(${JSON.stringify(f.binary)},['--version',String(process.pid)],{detached:true,stdio:['ignore',1,2]});
    setTimeout(()=>process.exit(2),6000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve, reject) => {
    driver.once("error", reject); driver.once("close", () => resolve());
  });
  let closeTimer: NodeJS.Timeout | undefined;
  try {
    const readyBy = performance.now() + 1500;
    while ((!fs.existsSync(f.heartbeat) || fs.statSync(f.heartbeat).size === 0) && performance.now() < readyBy) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(fs.readFileSync(f.heartbeat, "utf8").length).toBeGreaterThan(0);
    const started = performance.now();
    expect(driver.kill(signal)).toBe(true); // Retained, unreaped owned handle only.
    await Promise.race([closed, new Promise<never>((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error("owned fixture closure exceeded grace")), 1500);
    })]);
    expect(performance.now() - started).toBeLessThan(1500);
    const reparented = JSON.parse(fs.readFileSync(f.record + ".parent-change", "utf8"));
    expect(reparented.before).toBe(driver.pid);
    expect(reparented.after).not.toBe(driver.pid);
    const heartbeat = fs.readFileSync(f.heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fs.readFileSync(f.heartbeat, "utf8")).toBe(heartbeat);
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
    if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
    // The fixture also self-expires; never signal a recorded/recycled probe PID.
    await closed;
  }
});

it("detects changed launcher metadata without asserting executed-byte or toolchain identity", async () => {
  const f = fixture('fs.appendFileSync(fileURLToPath(import.meta.url), "\\n// changed by fixture\\n"); console.log("codex-cli 0.123.0");');
  const observed = await f.codex.executionPreflight();
  expect(observed).toMatchObject({ probe_status: "identity_changed", identity_stability: "changed", app_server_compatibility: "unverified" });
  expect(observed.configured_entry!.metadata_sha256).not.toBe(observed.identity_after!.metadata_sha256);
});

it("marks unavailable post-probe identity unknown, and missing entry prevents execution", async () => {
  const f = fixture('fs.unlinkSync(fileURLToPath(import.meta.url)); console.log("codex-cli 0.123.0");');
  const observed = await f.codex.executionPreflight();
  expect(observed.identity_stability).toBe("unknown");
  expect(observed.identity_after).toBeNull();
  const record = fs.readFileSync(f.record, "utf8");
  expect(await f.codex.executionPreflight()).toMatchObject({ probe_status: "identity_unavailable", cleanup: "no_child", observed_version: null });
  expect(fs.readFileSync(f.record, "utf8")).toBe(record);
});

it("reports spawn failure safely without retaining OS errors or paths", async () => {
  const f = fixture();
  fs.writeFileSync(f.binary, "#!/definitely-not-installed/c2c-fixture-interpreter\n");
  const observed = await f.codex.executionPreflight();
  expect(observed).toMatchObject({ probe_status: "spawn_failed", cleanup: "no_child", observed_version: null });
  expect(JSON.stringify(observed)).not.toContain("definitely-not-installed");
  expect(fs.existsSync(f.record)).toBe(false);
});

it("rejects concurrent probes and cancels/cleans a probe on client close", async () => {
  const f = fixture("setInterval(()=>{},1000);");
  const pending = f.codex.executionPreflight();
  await expect(f.codex.executionPreflight()).rejects.toMatchObject({ code: "PREFLIGHT_BUSY" });
  await f.codex.close();
  expect(await pending).toMatchObject({ probe_status: "cancelled", cleanup: "child_closed" });
  await expect(f.codex.executionPreflight()).rejects.toMatchObject({ code: "CLOSED" });
});

it("bounds unconfirmed cleanup and blocks further probes rather than accumulating uncertain children", async () => {
  const f = fixture();
  // No actual child: simulate a transport that never acknowledges closure.
  vi.spyOn(process, "kill").mockImplementation(() => true);
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  vi.useFakeTimers();
  const pending = f.codex.executionPreflight();
  await vi.advanceTimersByTimeAsync(PREFLIGHT_TIMEOUT_MS + PREFLIGHT_CLEANUP_MS);
  expect(await pending).toMatchObject({ probe_status: "cleanup_unconfirmed", cleanup: "unconfirmed", observed_version: null });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(f.codex.executionPreflight()).rejects.toMatchObject({ code: "PREFLIGHT_CLEANUP_REQUIRED" });
  expect(vi.mocked(spawn).mock.calls.length).toBe(1);
});

const trusted = { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["codex.execute"] };
it("MCP rejects path/argv/env overrides and binds an authorized fixed probe; status does not rerun it", async () => {
  const f = await mcp(trusted);
  const tool = (await f.client.listTools()).tools.find(t => t.name === "codex_execution_preflight")!;
  expect(Object.keys(tool.inputSchema.properties!)).toEqual(["workspace_id"]);
  expect(tool.inputSchema.additionalProperties).toBe(false);
  expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  for (const extra of [{ executable: "forbidden" }, { path: "forbidden" }, { argv: ["app-server"] }, { shell: "forbidden" }, { env: {} }]) {
    expect((await f.call({ workspace_id: f.workspace.id, ...extra })).error).toBe(true);
  }
  expect(f.getCodex).not.toHaveBeenCalled();
  expect(fs.existsSync(f.record)).toBe(false);
  const result = await f.call();
  expect(result).toMatchObject({ error: false, body: { workspace_id: f.workspace.id, probe_status: "observed" } });
  expect(vi.mocked(spawn).mock.calls.map(([binary, argv, options]) => [binary, argv, options?.cwd])).toEqual([
    [f.codex.binary, ["--version"], f.workspaceRoot],
  ]);
  fs.unlinkSync(f.binary);
  const launches = vi.mocked(spawn).mock.calls.length;
  const probe = vi.spyOn(f.codex, "executionPreflight");
  const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs, "mkdirSync"), vi.spyOn(fs, "renameSync")];
  const identityReads = [vi.spyOn(fs.realpathSync, "native"), vi.spyOn(fs, "lstatSync"), vi.spyOn(fs, "accessSync")];
  const status = await f.call({ workspace_id: f.workspace.id }, "codex_runtime_status");
  expect(status.error).toBe(false);
  expect(status.body.execution_environment_observation).toMatchObject({ probe_status: "observed", age_ms: expect.any(Number), cache_scope: "this_client_memory_only; identity_not_rechecked_by_status" });
  expect(status.body.runtime_contract.environment).toMatchObject({ app_server_compatibility: "unverified", mcp_inventory: { status: "unknown", tools: null } });
  for (const hook of [...writes, ...identityReads, ...Object.values(f.hooks), probe, f.getTaskJournal, f.getTaskReconciler]) expect(hook).not.toHaveBeenCalled();
  expect(vi.mocked(spawn).mock.calls.length).toBe(launches);
  expect(f.taskWorkspaces.size).toBe(0);
});

it("execution.read alone cannot run the configured executable", async () => {
  const f = await mcp({ token: "reader", clientId: "reader", scopes: ["execution.read"] });
  expect(await f.call()).toMatchObject({ error: true, body: { error: "INSUFFICIENT_SCOPE" } });
  expect(f.getCodex).not.toHaveBeenCalled();
  expect(fs.existsSync(f.record)).toBe(false);
});

it("enforces existing multi-workspace target and trusted-tunnel boundaries before execution", async () => {
  const f = await mcp({ token: "oauth", clientId: "oauth", scopes: ["codex.execute"] }, true);
  expect(await f.call({})).toMatchObject({ error: true, body: { error: "WORKSPACE_ID_REQUIRED" } });
  expect(await f.call()).toMatchObject({ error: true, body: { error: "TRUSTED_TUNNEL_REQUIRED" } });
  expect(f.getCodex).not.toHaveBeenCalled();
  expect(fs.existsSync(f.record)).toBe(false);
});
