import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer, resolveWorkspaceTarget, type McpContext } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceProfiles } from "../src/workspace/profiles.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const close: Array<() => unknown> = [];
afterEach(async () => { for (const f of close.splice(0).reverse()) await f(); vi.unstubAllGlobals(); });
const auth: AuthInfo = { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "codex.execute"] };
async function setup() {
  const previous = process.env.C2C_STATE_DIR;
  const state = isolateStateDir();
  const root = makeTmpDir("target-test");
  close.push(() => { cleanup(root); cleanup(state); if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous; });
  for (const name of ["alpha", "beta"]) write(root, `${name}/target.txt`, `${name} marker`);
  const workspace = new Workspace(path.join(root, "alpha"));
  const config = write(root, "profiles.json", JSON.stringify({ version: 1, defaultProfileId: "alpha", profiles: [
    { id: "alpha", path: workspace.root, codexNetworkHosts: ["alpha.example"] },
    { id: "beta", path: path.join(root, "beta"), codexNetworkHosts: ["beta.example"] },
  ] }));
  fs.chmodSync(config, 0o600);
  const workspaceProfiles = WorkspaceProfiles.load(workspace, config)!;
  const start = vi.fn(async () => ({ state: "running", run_id: "a".repeat(32) }));
  const wait = vi.fn(async () => ({ state: "completed" }));
  const codex = { startTurn: start, waitAndRecordTerminalResult: wait, hasBlockingRun: () => false } as unknown as NonNullable<McpContext["codex"]>;
  const acquired: string[] = [];
  const ctx: McpContext = { workspace, workspaceProfiles, codex, logger: nullLogger, taskWorkspaces: new Map(),
    resolveWorkspace: id => resolveWorkspaceTarget({ workspace, workspaceProfiles }, id),
    getCodex: target => { acquired.push(target.workspace.id); return codex; },
  };
  async function connect(identity = auth) {
    const server = createMcpServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const send = a.send.bind(a);
    a.send = (message, options) => send(message, { ...options, authInfo: identity });
    const client = new Client({ name: "target-test", version: "1" });
    await server.connect(b); await client.connect(a);
    close.push(async () => { await client.close(); await server.close(); });
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
  }
  return { ctx, connect, start, wait, acquired, alpha: workspace.id, beta: workspaceProfiles.get("beta").workspace.id };
}

it("captures targets across two clients and selection changes, including asynchronous reads and waits", async () => {
  const s = await setup(); const a = await s.connect(); const b = await s.connect();
  await b("workspace_select", { profile_id: "beta" });
  expect((await a("read_file", { workspace_id: s.alpha, path: "target.txt" })).content).toContain("alpha marker");
  expect((await a("workspace_info", { workspace_id: s.alpha })).workspaceProfileId).toBe("alpha");
  expect((await b("workspace_info")).workspaceProfileId).toBe("beta");
  const args = { task_id: "task", iteration: 1, instruction: "inspect", workspace_id: s.alpha };
  const [started, rejected] = await Promise.all([a("codex_turn_start", args), b("codex_turn_start", { ...args, workspace_id: s.beta })]);
  expect(started.state).toBe("running"); expect(rejected.error).toBe("TASK_WORKSPACE_MISMATCH");
  await b("workspace_select", { profile_id: "alpha" });
  await b("workspace_select", { profile_id: "beta" });
  expect((await a("codex_turn_wait", { task_id: "task", run_id: started.run_id, workspace_id: s.beta })).error).toBe("TASK_WORKSPACE_MISMATCH");
  await a("codex_turn_wait", { task_id: "task", run_id: started.run_id, workspace_id: s.alpha });
  expect(s.acquired).toEqual([s.alpha, s.alpha]);
  expect(s.start).toHaveBeenCalledTimes(1); expect(s.wait).toHaveBeenCalledTimes(1);
  expect((await b("workspace_profiles")).selectedProfileId).toBe("beta");
});

it("fails closed before child actions for missing/unknown targets, OAuth and insufficient scopes", async () => {
  const s = await setup(); const a = await s.connect();
  const args = { task_id: "task", iteration: 1, instruction: "inspect", run_id: "a".repeat(32) };
  for (const name of ["codex_turn_start", "codex_turn_wait"]) {
    expect((await a(name, args)).error).toBe("WORKSPACE_ID_REQUIRED");
    expect((await a(name, { ...args, workspace_id: "0".repeat(24) })).error).toBe("WORKSPACE_ID_UNKNOWN");
  }
  const oauth = await s.connect({ ...auth, token: "oauth", clientId: "oauth" });
  const unscoped = await s.connect({ ...auth, scopes: [] });
  for (const name of ["workspace_info", "list_directory", "read_file", "search_workspace", "git_status", "git_diff", "test_status", "execution_summary", "network_fetch_image", "codex_turn_start", "codex_turn_wait"]) {
    const input = { ...args, workspace_id: s.beta, path: "target.txt", query: "marker", url: "https://beta.example/image" };
    expect((await oauth(name, input)).error).toBe("TRUSTED_TUNNEL_REQUIRED");
    expect((await unscoped(name, input)).error).toBe("INSUFFICIENT_SCOPE");
    expect((await a(name, { ...input, workspace_id: "0".repeat(24) })).error).toBe("WORKSPACE_ID_UNKNOWN");
  }
  expect(s.start).not.toHaveBeenCalled(); expect(s.wait).not.toHaveBeenCalled(); expect(s.acquired).toEqual([]);
});

it("uses the captured target host allowlist while another client changes selection", async () => {
  const s = await setup(); const a = await s.connect(); const b = await s.connect();
  const fetch = vi.fn(async () => {
    await b("workspace_select", { profile_id: "beta" });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });
  });
  vi.stubGlobal("fetch", fetch);
  await b("workspace_select", { profile_id: "beta" });
  expect((await a("network_fetch_image", { workspace_id: s.alpha, url: "https://alpha.example/image" })).mimeType).toBe("image/jpeg");
  expect((await a("network_fetch_image", { workspace_id: s.alpha, url: "https://beta.example/image" })).error).toBe("NETWORK_FETCH_DENIED");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("never evicts or rebinds tasks when the bridge-lifetime map reaches its bound", async () => {
  const s = await setup(); const a = await s.connect();
  for (let i = 0; i < 10000; i++) s.ctx.taskWorkspaces!.set(`task-${i}`, s.alpha);
  const args = { task_id: "new", iteration: 1, instruction: "inspect", workspace_id: s.alpha };
  expect((await a("codex_turn_start", args)).error).toBe("TASK_BINDING_LIMIT");
  expect(s.start).not.toHaveBeenCalled();
  expect((await a("codex_turn_start", { ...args, task_id: "task-0" })).state).toBe("running");
  expect((await a("codex_turn_start", { ...args, task_id: "task-0", workspace_id: s.beta })).error).toBe("TASK_WORKSPACE_MISMATCH");
  expect(s.ctx.taskWorkspaces!.size).toBe(10000);
});

it("never falls back to the selected executor if an explicit target executor is absent", async () => {
  const s = await setup();
  delete s.ctx.getCodex;
  const call = await s.connect();
  const result = await call("codex_turn_start", {
    task_id: "no-fallback", iteration: 1, instruction: "inspect", workspace_id: s.beta,
  });
  expect(result.error).toBe("WORKSPACE_EXECUTOR_UNAVAILABLE");
  expect(s.start).not.toHaveBeenCalled();
});


it("phase06 regression: OAuth omitted target stays on its authorized anchor after trusted selection changes", async () => {
  const s = await setup();
  const reader = await s.connect({ ...auth, token: "oauth-reader", clientId: "oauth-reader",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"] });
  const trusted = await s.connect();
  await trusted("workspace_select", { profile_id: "beta" });
  expect((await trusted("workspace_info")).workspaceId).toBe(s.beta);
  expect((await reader("workspace_info")).workspaceId).toBe(s.alpha);
  expect((await reader("read_file", { path: "target.txt" })).content).toContain("alpha marker");
  expect((await reader("read_file", { workspace_id: s.beta, path: "target.txt" })).error).toBe("TRUSTED_TUNNEL_REQUIRED");
  expect(s.start).not.toHaveBeenCalled();
});
