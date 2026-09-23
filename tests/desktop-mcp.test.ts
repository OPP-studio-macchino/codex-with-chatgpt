import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it } from "vitest";
import { nullLogger } from "../src/logger/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  DesktopAgentError,
  type DesktopAgent,
  type DesktopAgentRequest,
} from "../src/desktop/client.js";

class FakeDesktopAgent implements DesktopAgent {
  readonly calls: DesktopAgentRequest[] = [];
  constructor(private readonly handler?: (request: DesktopAgentRequest) => unknown | Promise<unknown>) {}

  async call(request: DesktopAgentRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.handler) return this.handler(request);
    return { echoed: request };
  }
}

async function connect(
  desktopAgent?: DesktopAgent,
  authInfo?: AuthInfo
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({
    workspace: new Workspace(process.cwd()),
    logger: nullLogger,
    desktopAgent,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, { ...options, authInfo });
  }
  const client = new Client({ name: "desktop-mcp-test", version: "1" });
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

const desktopTools = [
  "desktop_accessibility_action_profiles",
  "desktop_accessibility_apps",
  "desktop_accessibility_confirm",
  "desktop_accessibility_find",
  "desktop_accessibility_grant_press",
  "desktop_accessibility_grants",
  "desktop_accessibility_press",
  "desktop_accessibility_request_grant",
  "desktop_accessibility_status",
  "desktop_accessibility_tree",
  "desktop_app_launch",
  "desktop_app_profiles",
  "desktop_git_status",
  "desktop_inspect",
  "desktop_list",
  "desktop_mkdir",
  "desktop_process_output",
  "desktop_process_profiles",
  "desktop_process_run",
  "desktop_process_start",
  "desktop_process_status",
  "desktop_process_stop",
  "desktop_read",
  "desktop_remove",
  "desktop_roots",
  "desktop_screenshot_capture",
  "desktop_screenshot_list",
  "desktop_screenshot_remove",
  "desktop_write",
].sort();

describe("Desktop Agent MCP surface", () => {
  it("is absent when Desktop Agent is not configured", async () => {
    const connection = await connect();
    try {
      const names = (await connection.client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("desktop_"))).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it("registers the bounded desktop tool set when configured", async () => {
    const connection = await connect(new FakeDesktopAgent());
    try {
      const names = (await connection.client.listTools()).tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("desktop_"))
        .sort();
      expect(names).toEqual(desktopTools);
    } finally {
      await connection.close();
    }
  });

  it("requires desktop.read for read operations and forwards bounded arguments", async () => {
    const desktop = new FakeDesktopAgent(() => ({ roots: [{ id: "target", writable: true }] }));
    const denied = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["workspace.read"] }
    );
    try {
      const result = await denied.client.callTool({ name: "desktop_roots", arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain("desktop.read");
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await denied.close();
    }

    const allowed = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.read"] }
    );
    try {
      const result = await allowed.client.callTool({
        name: "desktop_list",
        arguments: { root_id: "target", path: ".agents", limit: 25 },
      });
      expect(result.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "list",
        rootId: "target",
        path: ".agents",
        limit: 25,
      });
    } finally {
      await allowed.close();
    }
  });

  it("keeps write/remove behind desktop.write separately from desktop.read", async () => {
    const desktop = new FakeDesktopAgent();
    const readOnly = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.read"] }
    );
    try {
      const result = await readOnly.client.callTool({
        name: "desktop_write",
        arguments: { root_id: "target", path: "README.md", content: "x" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain("desktop.write");
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await readOnly.close();
    }

    const writer = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.write"] }
    );
    try {
      const result = await writer.client.callTool({
        name: "desktop_remove",
        arguments: {
          root_id: "target",
          path: ".agents",
          expected_digest: "a".repeat(64),
        },
      });
      expect(result.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "remove",
        rootId: "target",
        path: ".agents",
        expectedDigest: "a".repeat(64),
      });
    } finally {
      await writer.close();
    }
  });

  it("keeps process execution behind desktop.process with no caller-supplied argv", async () => {
    const desktop = new FakeDesktopAgent(() => ({
      profileId: "safe-profile",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    }));

    const denied = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.read", "desktop.write"] }
    );
    try {
      const result = await denied.client.callTool({
        name: "desktop_process_run",
        arguments: { profile_id: "safe-profile" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain("desktop.process");
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await denied.close();
    }

    const allowed = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.process"] }
    );
    try {
      const profiles = await allowed.client.callTool({
        name: "desktop_process_profiles",
        arguments: {},
      });
      expect(profiles.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({ op: "processProfiles" });

      const result = await allowed.client.callTool({
        name: "desktop_process_run",
        arguments: { profile_id: "safe-profile" },
      });
      expect(result.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "processRun",
        profileId: "safe-profile",
      });

      const started = await allowed.client.callTool({
        name: "desktop_process_start",
        arguments: { profile_id: "background-profile" },
      });
      expect(started.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "processStart",
        profileId: "background-profile",
      });

      const status = await allowed.client.callTool({
        name: "desktop_process_status",
        arguments: { profile_id: "background-profile" },
      });
      expect(status.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "processStatus",
        profileId: "background-profile",
      });

      const output = await allowed.client.callTool({
        name: "desktop_process_output",
        arguments: {
          profile_id: "background-profile",
          stream: "stderr",
          offset: 12,
          max_bytes: 2048,
        },
      });
      expect(output.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "processOutput",
        profileId: "background-profile",
        stream: "stderr",
        offset: 12,
        maxBytes: 2048,
      });

      const stopped = await allowed.client.callTool({
        name: "desktop_process_stop",
        arguments: { profile_id: "background-profile" },
      });
      expect(stopped.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "processStop",
        profileId: "background-profile",
      });
    } finally {
      await allowed.close();
    }
  });

  it("keeps Accessibility inspection behind desktop.accessibility.read and forwards only bounded read arguments", async () => {
    const desktop = new FakeDesktopAgent();
    const denied = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.read"] }
    );
    try {
      const result = await denied.client.callTool({
        name: "desktop_accessibility_tree",
        arguments: {
          app_id: "google-chrome",
          max_depth: 2,
          max_nodes: 40,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain(
        "desktop.accessibility.read"
      );
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await denied.close();
    }

    const allowed = await connect(
      desktop,
      {
        token: "token",
        clientId: "client",
        scopes: ["desktop.accessibility.read"],
      }
    );
    try {
      await allowed.client.callTool({
        name: "desktop_accessibility_status",
        arguments: {},
      });
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityStatus",
      });

      await allowed.client.callTool({
        name: "desktop_accessibility_apps",
        arguments: {},
      });
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityApps",
      });

      const tree = await allowed.client.callTool({
        name: "desktop_accessibility_tree",
        arguments: {
          app_id: "google-chrome",
          max_depth: 2,
          max_nodes: 40,
        },
      });
      expect(tree.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityTree",
        appId: "google-chrome",
        maxDepth: 2,
        maxNodes: 40,
      });

      const found = await allowed.client.callTool({
        name: "desktop_accessibility_find",
        arguments: {
          app_id: "google-chrome",
          role: "AXButton",
          title: "Reload",
          enabled: true,
          match: "contains",
          case_sensitive: false,
          max_depth: 3,
          max_nodes: 80,
          max_results: 5,
        },
      });
      expect(found.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityFind",
        appId: "google-chrome",
        role: "AXButton",
        subrole: undefined,
        title: "Reload",
        label: undefined,
        enabled: true,
        focused: undefined,
        match: "contains",
        caseSensitive: false,
        maxDepth: 3,
        maxNodes: 80,
        maxResults: 5,
      });

      const confirmed = await allowed.client.callTool({
        name: "desktop_accessibility_confirm",
        arguments: {
          app_id: "google-chrome",
          role: "AXButton",
          title: "Reload",
          case_sensitive: false,
          max_depth: 6,
          max_nodes: 300,
        },
      });
      expect(confirmed.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityConfirm",
        appId: "google-chrome",
        role: "AXButton",
        subrole: undefined,
        title: "Reload",
        label: undefined,
        focused: undefined,
        caseSensitive: false,
        maxDepth: 6,
        maxNodes: 300,
      });
    } finally {
      await allowed.close();
    }
  });

  it("keeps Accessibility mutation behind desktop.accessibility.action and forwards only an action profile id", async () => {
    const desktop = new FakeDesktopAgent();

    const denied = await connect(
      desktop,
      {
        token: "token",
        clientId: "client",
        scopes: ["desktop.accessibility.read"],
      }
    );
    try {
      const result = await denied.client.callTool({
        name: "desktop_accessibility_press",
        arguments: { action_profile_id: "textedit-cancel-smoke" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain(
        "desktop.accessibility.action"
      );
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await denied.close();
    }

    const allowed = await connect(
      desktop,
      {
        token: "token",
        clientId: "client",
        scopes: ["desktop.accessibility.action"],
      }
    );
    try {
      const profiles = await allowed.client.callTool({
        name: "desktop_accessibility_action_profiles",
        arguments: {},
      });
      expect(profiles.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityActionProfiles",
      });

      const pressed = await allowed.client.callTool({
        name: "desktop_accessibility_press",
        arguments: { action_profile_id: "textedit-cancel-smoke" },
      });
      expect(pressed.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityPress",
        actionProfileId: "textedit-cancel-smoke",
      });
    } finally {
      await allowed.close();
    }
  });

  it("keeps one-time grants behind desktop.accessibility.action and never exposes grant creation", async () => {
    const desktop = new FakeDesktopAgent();

    const denied = await connect(
      desktop,
      {
        token: "token",
        clientId: "client",
        scopes: ["desktop.accessibility.read"],
      }
    );
    try {
      const result = await denied.client.callTool({
        name: "desktop_accessibility_grants",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain(
        "desktop.accessibility.action"
      );
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await denied.close();
    }

    const allowed = await connect(
      desktop,
      {
        token: "token",
        clientId: "client",
        scopes: ["desktop.accessibility.action"],
      }
    );
    try {
      const requested = await allowed.client.callTool({
        name: "desktop_accessibility_request_grant",
        arguments: {
          app_id: "google-chrome",
          title: "Reload",
          case_sensitive: false,
        },
      });
      expect(requested.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityApprovalRequest",
        appId: "google-chrome",
        role: "AXButton",
        title: "Reload",
        label: undefined,
        focused: undefined,
        caseSensitive: false,
        maxDepth: 6,
        maxNodes: 300,
        ttlMs: 60_000,
      });

      const grants = await allowed.client.callTool({
        name: "desktop_accessibility_grants",
        arguments: {},
      });
      expect(grants.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityGrantList",
      });

      const grantId = "a".repeat(32);
      const consumed = await allowed.client.callTool({
        name: "desktop_accessibility_grant_press",
        arguments: { grant_id: grantId },
      });
      expect(consumed.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "accessibilityGrantConsume",
        grantId,
      });

      const names = (await allowed.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(names).not.toContain("desktop_accessibility_grant_create");
    } finally {
      await allowed.close();
    }
  });

  it("keeps application launch behind desktop.app and forwards only an app id", async () => {
    const desktop = new FakeDesktopAgent();
    const denied = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.read"] }
    );
    try {
      const result = await denied.client.callTool({
        name: "desktop_app_launch",
        arguments: { app_id: "google-chrome" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain("desktop.app");
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await denied.close();
    }

    const allowed = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.app"] }
    );
    try {
      await allowed.client.callTool({ name: "desktop_app_profiles", arguments: {} });
      expect(desktop.calls.at(-1)).toEqual({ op: "appProfiles" });

      const launched = await allowed.client.callTool({
        name: "desktop_app_launch",
        arguments: { app_id: "google-chrome" },
      });
      expect(launched.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({
        op: "appLaunch",
        appId: "google-chrome",
      });
    } finally {
      await allowed.close();
    }
  });

  it("keeps local screenshots behind desktop.screen and never exposes an image-read tool", async () => {
    const desktop = new FakeDesktopAgent();
    const denied = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.read"] }
    );
    try {
      const result = await denied.client.callTool({
        name: "desktop_screenshot_capture",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain("desktop.screen");
      expect(desktop.calls).toHaveLength(0);
    } finally {
      await denied.close();
    }

    const allowed = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.screen"] }
    );
    try {
      const capture = await allowed.client.callTool({
        name: "desktop_screenshot_capture",
        arguments: {},
      });
      expect(capture.isError ?? false).toBe(false);
      expect(desktop.calls.at(-1)).toEqual({ op: "screenshotCapture" });

      await allowed.client.callTool({ name: "desktop_screenshot_list", arguments: {} });
      expect(desktop.calls.at(-1)).toEqual({ op: "screenshotList" });

      await allowed.client.callTool({
        name: "desktop_screenshot_remove",
        arguments: { screenshot_id: "a".repeat(32) },
      });
      expect(desktop.calls.at(-1)).toEqual({
        op: "screenshotRemove",
        screenshotId: "a".repeat(32),
      });

      const names = (await allowed.client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("desktop_screenshot_read");
      expect(names).not.toContain("desktop_screenshot_download");
    } finally {
      await allowed.close();
    }
  });

  it("preserves Desktop Agent error codes without leaking an internal stack", async () => {
    const desktop = new FakeDesktopAgent(() => {
      throw new DesktopAgentError("WRITE_CONFLICT", "Target changed since it was read.");
    });
    const connection = await connect(
      desktop,
      { token: "token", clientId: "client", scopes: ["desktop.write"] }
    );
    try {
      const result = await connection.client.callTool({
        name: "desktop_write",
        arguments: {
          root_id: "target",
          path: "README.md",
          content: "x",
          expected_sha256: "b".repeat(64),
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({
        error: "WRITE_CONFLICT",
        message: "Target changed since it was read.",
      });
    } finally {
      await connection.close();
    }
  });
});
