import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it } from "vitest";
import { nullLogger } from "../src/logger/index.js";
import type { CodexAppServer } from "../src/codex/app-server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";

async function connect(
  notifier?: () => void,
  authInfo?: AuthInfo,
  codex?: CodexAppServer
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({
    workspace: new Workspace(process.cwd()),
    logger: nullLogger,
    codex,
    completionNotifier: notifier,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, { ...options, authInfo });
  }
  const client = new Client({ name: "completion-notify-test", version: "1" });
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

describe("completion_notify MCP tool", () => {
  it("is absent without a configured notifier", async () => {
    const connection = await connect();
    try {
      const tools = await connection.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain("completion_notify");
    } finally {
      await connection.close();
    }
  });

  it("is absent when a notifier exists without Codex execution", async () => {
    const connection = await connect(() => undefined);
    try {
      const tools = await connection.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain("completion_notify");
      expect(connection.client.getInstructions()).not.toContain("completion_notify");
    } finally {
      await connection.close();
    }
  });

  it("advertises cooperative completion signaling with Codex execution and a configured notifier", async () => {
    const connection = await connect(() => undefined, undefined, {} as CodexAppServer);
    try {
      const tools = await connection.client.listTools();
      const completionTool = tools.tools.find((tool) => tool.name === "completion_notify");
      expect(completionTool?.description).toContain("last C2C tool call");
      expect(completionTool?.description).toContain("ChatGPT Web/macOS MCP signal");
      expect(connection.client.getInstructions()).toContain("fully complete");
      expect(connection.client.getInstructions()).toContain("cooperative ChatGPT Web/macOS MCP signal");
    } finally {
      await connection.close();
    }
  });

  it("calls the configured notifier once and confirms the request", async () => {
    let notifications = 0;
    const connection = await connect(
      () => { notifications++; },
      undefined,
      {} as CodexAppServer
    );
    try {
      const result = await connection.client.callTool({ name: "completion_notify", arguments: {} });
      expect(result.isError ?? false).toBe(false);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ notification: "requested" });
      expect(notifications).toBe(1);
    } finally {
      await connection.close();
    }
  });

  it("requires codex.execute for authenticated callers", async () => {
    let notifications = 0;
    const connection = await connect(
      () => {
        notifications++;
      },
      { token: "test-token", clientId: "test-client", scopes: ["workspace.read"] },
      {} as CodexAppServer
    );
    try {
      const result = await connection.client.callTool({ name: "completion_notify", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({
        error: "INSUFFICIENT_SCOPE",
        message: "This operation requires the 'codex.execute' scope.",
      });
      expect(notifications).toBe(0);
    } finally {
      await connection.close();
    }
  });
});
