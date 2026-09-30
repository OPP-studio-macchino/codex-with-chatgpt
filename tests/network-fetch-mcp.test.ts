import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceProfiles } from "../src/workspace/profiles.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const item of cleanupPaths.splice(0)) cleanup(item);
});

function profiles(hosts: string[]): { workspace: Workspace; profiles: WorkspaceProfiles } {
  isolateStateDir();
  const root = makeTmpDir("network-fetch-mcp-root");
  cleanupPaths.push(root);
  const configDir = makeTmpDir("network-fetch-mcp-config");
  cleanupPaths.push(configDir);
  const config = path.join(configDir, "workspace-profiles.json");
  fs.writeFileSync(config, JSON.stringify({
    version: 1,
    defaultProfileId: "alpha",
    profiles: [{ id: "alpha", path: root, codexNetworkHosts: hosts }],
  }), { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  const workspace = new Workspace(root);
  return { workspace, profiles: WorkspaceProfiles.load(workspace, config)! };
}

async function connect(authInfo: AuthInfo, hosts = ["ttc.taxi-inf.jp"]) {
  const setup = profiles(hosts);
  const server = createMcpServer({
    workspace: setup.workspace,
    workspaceProfiles: setup.profiles,
    logger: nullLogger,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo });
  const client = new Client({ name: "network-fetch-mcp-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const trustedAuth: AuthInfo = {
  token: "trusted-tunnel",
  clientId: "openai-secure-tunnel",
  scopes: ["codex.execute"],
};

describe("network_fetch_image MCP tool", () => {
  it("returns image content only for the owner-approved host over the trusted tunnel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      { status: 200, headers: { "content-type": "image/jpeg" } }
    )));
    const connection = await connect(trustedAuth);
    try {
      const tools = await connection.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("network_fetch_image");

      const result = await connection.client.callTool({
        name: "network_fetch_image",
        arguments: { url: "https://ttc.taxi-inf.jp/Real109.jpg" },
      });
      expect(result.isError ?? false).toBe(false);
      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0]?.type).toBe("text");
      expect(content[1]).toMatchObject({
        type: "image",
        mimeType: "image/jpeg",
        data: "/9j/2Q==",
      });
    } finally {
      await connection.close();
    }
  });

  it("requires the trusted tunnel identity in addition to codex.execute", async () => {
    const connection = await connect({
      token: "oauth-token",
      clientId: "oauth-client",
      scopes: ["codex.execute"],
    });
    try {
      const result = await connection.client.callTool({
        name: "network_fetch_image",
        arguments: { url: "https://ttc.taxi-inf.jp/Real109.jpg" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]?.text).toContain("TRUSTED_TUNNEL_REQUIRED");
    } finally {
      await connection.close();
    }
  });

  it("fails closed when the selected workspace has no approved network host", async () => {
    let called = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      called = true;
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }));
    const connection = await connect(trustedAuth, []);
    try {
      const result = await connection.client.callTool({
        name: "network_fetch_image",
        arguments: { url: "https://ttc.taxi-inf.jp/Real109.jpg" },
      });
      expect(result.isError).toBe(true);
      expect(called).toBe(false);
    } finally {
      await connection.close();
    }
  });
});
