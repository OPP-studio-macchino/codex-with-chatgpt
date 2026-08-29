import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  TRUSTED_TUNNEL_HEADER,
  ensureTrustedTunnelToken,
} from "../src/auth/trusted-tunnel.js";

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("port-a");
    const rootB = makeTmpDir("port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const preferred = 47000 + Math.floor(Math.random() * 1000);

    const bridgeA = await startBridge({
      workspaceRoot: rootA,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "a.json"),
    });
    const bridgeB = await startBridge({
      workspaceRoot: rootB,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "b.json"),
    });

    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // Public health is deliberately minimal and does not disclose workspace identity.
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA).toEqual({ service: "c2c-bridge", status: "ok" });
    expect(healthB).toEqual({ service: "c2c-bridge", status: "ok" });
    expect(JSON.stringify(healthA)).not.toContain(bridgeA.workspace.id);

    await bridgeA.close();
    await bridgeB.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = makeTmpDir("port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({ workspaceRoot: root, host: "0.0.0.0", persistRuntime: false })
    ).rejects.toThrow(/loopback/);
    cleanup(root);
  });

  it("uses only an explicitly configured HTTPS origin for public metadata", async () => {
    const root = makeTmpDir("port-external");
    write(root, "app.txt", "safe\n");
    const managed = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      externalBaseUrl: "https://mcp.example.com",
      authStoreFile: path.join(makeTmpDir("auth"), "external.json"),
    });
    const metadata = await fetch(`${managed.localBaseUrl()}/.well-known/oauth-authorization-server`);
    expect(((await metadata.json()) as { issuer: string }).issuer).toBe("https://mcp.example.com");
    const stopManagedTransport = await fetch(`${managed.localBaseUrl()}/admin/tunnel/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${managed.adminToken}` },
    });
    expect(stopManagedTransport.status).toBe(409);
    expect(managed.getPublicBaseUrl()).toBe("https://mcp.example.com");
    await managed.close();

    await expect(
      startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: false,
        externalBaseUrl: "https://mcp.example.com/unexpected-path",
      })
    ).rejects.toThrow(/without a path or query/);
    cleanup(root);
  });

  it("authenticates before parsing a large MCP body", async () => {
    const root = makeTmpDir("port-auth-first");
    write(root, "app.txt", "safe\n");
    const local = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "auth-first.json"),
    });
    const response = await fetch(`${local.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 100),
    });
    expect(response.status).toBe(401);
    await local.close();
    cleanup(root);
  });

  it("accepts the owner-only static header for OpenAI Secure MCP Tunnel and revokes it", async () => {
    const root = makeTmpDir("port-trusted-tunnel");
    write(root, "app.txt", "safe\n");
    const workspace = new Workspace(root);
    const tokenState = ensureTrustedTunnelToken(workspace.id);
    const token = fs.readFileSync(tokenState.file, "utf8").trim();
    const local = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      trustedTunnelTokenFile: tokenState.file,
      authStoreFile: path.join(makeTmpDir("auth"), "trusted-tunnel.json"),
    });
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

    await local.close();
    cleanup(root);
  });
});
