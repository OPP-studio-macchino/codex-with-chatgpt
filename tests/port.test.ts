import { beforeEach, afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { cleanup, write, isolateStateDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  TRUSTED_TUNNEL_HEADER,
  ensureTrustedTunnelToken,
} from "../src/auth/trusted-tunnel.js";

const originalState = process.env.C2C_STATE_DIR;
let state: string;
const bridges: Bridge[] = [];
beforeEach(() => { state = isolateStateDir(); });
afterEach(async () => {
  try {
    const closed = await Promise.allSettled(bridges.splice(0).map(bridge => bridge.close()));
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  } finally {
    cleanup(state);
    if (originalState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = originalState;
  }
});
const isolated = { host: "127.0.0.1", persistRuntime: false,
  completionNotifier: () => undefined, runNotifier: async () => ({ outcome: "unavailable" as const }) };

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    const rootA = path.join(state, "port-a");
    const rootB = path.join(state, "port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const bridgeA = await startBridge({
      ...isolated,
      workspaceRoot: rootA,
      port: 0,
      authStoreFile: path.join(state, "a.json"),
    });
    bridges.push(bridgeA);
    const preferred = bridgeA.port;
    expect(preferred).toBeGreaterThan(0);
    const bridgeB = await startBridge({
      ...isolated,
      workspaceRoot: rootB,
      port: preferred,
      authStoreFile: path.join(state, "b.json"),
    });
    bridges.push(bridgeB);

    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // Public health is deliberately minimal and does not disclose workspace identity.
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA).toEqual({ service: "c2c-bridge", status: "ok" });
    expect(healthB).toEqual({ service: "c2c-bridge", status: "ok" });
    expect(JSON.stringify(healthA)).not.toContain(bridgeA.workspace.id);

  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = path.join(state, "port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({ ...isolated, workspaceRoot: root, host: "0.0.0.0" })
    ).rejects.toThrow(/loopback/);
  });

  it("uses only an explicitly configured HTTPS origin for public metadata", async () => {
    const root = path.join(state, "port-external");
    write(root, "app.txt", "safe\n");
    const managed = await startBridge({
      ...isolated,
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      externalBaseUrl: "https://mcp.example.com",
      authStoreFile: path.join(state, "external.json"),
    });
    bridges.push(managed);
    const metadata = await fetch(`${managed.localBaseUrl()}/.well-known/oauth-authorization-server`);
    expect(((await metadata.json()) as { issuer: string }).issuer).toBe("https://mcp.example.com");
    const stopManagedTransport = await fetch(`${managed.localBaseUrl()}/admin/tunnel/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${managed.adminToken}` },
    });
    expect(stopManagedTransport.status).toBe(409);
    expect(managed.getPublicBaseUrl()).toBe("https://mcp.example.com");

    await expect(
      startBridge({
        ...isolated,
        workspaceRoot: root,
        port: 0,
        persistRuntime: false,
        externalBaseUrl: "https://mcp.example.com/unexpected-path",
      })
    ).rejects.toThrow(/without a path or query/);
  });

  it("authenticates before parsing a large MCP body", async () => {
    const root = path.join(state, "port-auth-first");
    write(root, "app.txt", "safe\n");
    const local = await startBridge({
      ...isolated,
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(state, "auth-first.json"),
    });
    bridges.push(local);
    const response = await fetch(`${local.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 100),
    });
    expect(response.status).toBe(401);
  });

  it("accepts the owner-only static header for OpenAI Secure MCP Tunnel and revokes it", async () => {
    const root = path.join(state, "port-trusted-tunnel");
    write(root, "app.txt", "safe\n");
    const workspace = new Workspace(root);
    const tokenState = ensureTrustedTunnelToken(workspace.id);
    const token = fs.readFileSync(tokenState.file, "utf8").trim();
    const local = await startBridge({
      ...isolated,
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      trustedTunnelTokenFile: tokenState.file,
      authStoreFile: path.join(state, "trusted-tunnel.json"),
    });
    bridges.push(local);
    const call = (presented: string): Promise<Response> =>
      fetch(`${local.localBaseUrl()}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          [TRUSTED_TUNNEL_HEADER]: presented,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    expect((await call("wrong-token")).status).toBe(401);
    expect((await call(token)).status).toBe(200);

    const publicTunnelAttempt = await fetch(`${local.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${local.adminToken}` },
    });
    expect(publicTunnelAttempt.status).toBe(409);

    const revoke = await fetch(`${local.localBaseUrl()}/admin/revoke-all`, {
      method: "POST",
      headers: { authorization: `Bearer ${local.adminToken}` },
    });
    expect(revoke.status).toBe(200);
    expect(fs.existsSync(tokenState.file)).toBe(false);
    expect((await call(token)).status).toBe(401);

  });
});
