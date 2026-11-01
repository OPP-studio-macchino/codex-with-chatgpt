import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceProfiles } from "../src/workspace/profiles.js";
import { WorkspaceRegistration } from "../src/workspace/registration.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
const cleanupActions: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanupActions.splice(0).reverse()) await f(); });
async function setup(auth: AuthInfo, registeredBeta = false) {
  const previous = process.env.C2C_STATE_DIR, state = isolateStateDir(), root = makeTmpDir("registration-auth");
  cleanupActions.push(() => { cleanup(root); cleanup(state); if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous; });
  write(root, "alpha/file.txt", "fixture"); write(root, "beta/file.txt", "fixture");
  const workspace = new Workspace(path.join(root, "alpha"));
  const config = write(root, "profiles.json", JSON.stringify({ version: 1, defaultProfileId: "alpha", profiles: [
    { id: "alpha", path: workspace.root }, ...(registeredBeta ? [{ id: "beta", path: path.join(root, "beta") }] : []),
  ] }));
  fs.chmodSync(config, 0o600); const profiles = WorkspaceProfiles.load(workspace, config)!;
  const choose = vi.fn(async () => path.join(root, "beta")), approve = vi.fn(async () => "denied" as const);
  const registration = new WorkspaceRegistration(profiles, { supported: true, choose, approve });
  cleanupActions.push(() => registration.close());
  const server = createMcpServer({ workspace, workspaceProfiles: profiles, workspaceRegistration: registration, logger: nullLogger });
  const [a,b] = InMemoryTransport.createLinkedPair(); const send = a.send.bind(a);
  a.send = (m,o) => send(m, { ...o, authInfo: auth });
  const client = new Client({ name: "registration-auth", version: "1" }); await server.connect(b); await client.connect(a);
  cleanupActions.push(async () => { await client.close(); await server.close(); });
  return { client, registration, choose, approve, config };
}
it.each([
  { token: "reader", clientId: "reader", scopes: ["workspace.read"], code: "INSUFFICIENT_SCOPE" },
  { token: "oauth", clientId: "oauth", scopes: ["workspace.read", "codex.execute"], code: "TRUSTED_TUNNEL_REQUIRED" },
  { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["codex.execute"], code: "INSUFFICIENT_SCOPE" },
])("does not open a dialog for unauthorized caller $code", async data => {
  const s = await setup(data), before = fs.readFileSync(s.config, "utf8");
  const result = await s.client.callTool({ name: "workspace_register_start", arguments: {} });
  expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain(data.code);
  expect(s.choose).not.toHaveBeenCalled(); expect(s.approve).not.toHaveBeenCalled();
  expect(fs.readFileSync(s.config, "utf8")).toBe(before);
});
it("advertises only a start request and a read-only result, never remote approval/path fields", async () => {
  const s = await setup({ token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "codex.execute"] });
  const tools = (await s.client.listTools()).tools;
  const start = tools.find(t => t.name === "workspace_register_start")!;
  expect(Object.keys(start.inputSchema.properties ?? {})).toEqual([]);
  expect(start.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  const status = tools.find(t => t.name === "workspace_register_status")!;
  expect(Object.keys(status.inputSchema.properties ?? {})).toEqual(["registration_id"]);
  expect(status.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(s.client.getInstructions()).toContain("workspace_register_start");
  expect(s.client.getInstructions()).toContain("workspace_unregister_start");
  const result = await s.client.callTool({ name: "workspace_register_status", arguments: { registration_id: "f".repeat(32) } });
  expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain("WORKSPACE_REGISTRATION_NOT_FOUND");
  expect(s.choose).not.toHaveBeenCalled();
  const remove = tools.find(t => t.name === "workspace_unregister_start")!;
  expect(Object.keys(remove.inputSchema.properties ?? {})).toEqual(["profile_id"]);
  expect(remove.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  const removeStatus = tools.find(t => t.name === "workspace_unregister_status")!;
  expect(Object.keys(removeStatus.inputSchema.properties ?? {})).toEqual(["registration_id"]);
  expect(removeStatus.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
});

it("does not accept path or caller approval to remove a protected registration", async () => {
  const s = await setup({ token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "codex.execute"] });
  const before = fs.readFileSync(s.config, "utf8");
  const result = await s.client.callTool({ name: "workspace_unregister_start", arguments: {
    profile_id: "alpha", path: "/caller-cannot-delete-this", approved: true,
  } });
  expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain("default anchor");
  expect(s.choose).not.toHaveBeenCalled(); expect(s.approve).not.toHaveBeenCalled();
  expect(fs.readFileSync(s.config, "utf8")).toBe(before);
});

it("removes a listed non-selected profile only through the owner-approved MCP flow", async () => {
  const s = await setup({ token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "codex.execute"] }, true);
  const before = fs.readFileSync(s.config, "utf8");
  const result = await s.client.callTool({ name: "workspace_unregister_start", arguments: { profile_id: "beta" } });
  expect(result.isError ?? false).toBe(false);
  const started = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  expect(started).toMatchObject({ operation: "unregister", state: expect.stringMatching(/queued|awaiting_owner/) });
  await expect.poll(() => (s.registration.status(started.registration_id) as { state: string }).state).toBe("denied");
  const status = await s.client.callTool({ name: "workspace_unregister_status", arguments: { registration_id: started.registration_id } });
  expect(JSON.stringify(status.content)).toContain("OWNER_DENIED");
  expect(s.choose).not.toHaveBeenCalled(); expect(s.approve).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(s.config, "utf8")).toBe(before);
});

it("cannot replace native folder choice or approval with caller arguments", async () => {
  const s = await setup({ token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "codex.execute"] });
  const before = fs.readFileSync(s.config, "utf8");
  const result = await s.client.callTool({ name: "workspace_register_start", arguments: {
    path: "/caller-cannot-choose-this", profile_id: "injected", approved: true,
  } });
  if (!result.isError) {
    const started = JSON.parse((result.content as Array<{text:string}>)[0]!.text);
    expect(started.timeout_shield).toMatchObject({
      yield_required: true,
      reason: "background_work_active",
      background_continues: true,
      resume_tool: "workspace_register_status",
      do_not_poll_again_in_same_response: true,
    });
    await expect.poll(() => (s.registration.status(started.registration_id) as {state:string}).state).toBe("denied");
    expect(s.choose).toHaveBeenCalledTimes(1); expect(s.approve).toHaveBeenCalledTimes(1);
  }
  expect(fs.readFileSync(s.config, "utf8")).toBe(before);
});
