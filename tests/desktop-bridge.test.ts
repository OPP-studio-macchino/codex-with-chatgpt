import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import type { DesktopAgent, DesktopAgentRequest } from "../src/desktop/client.js";
import {
  ensureTrustedTunnelToken,
  TRUSTED_TUNNEL_HEADER,
} from "../src/auth/trusted-tunnel.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

class FakeDesktopAgent implements DesktopAgent {
  readonly calls: DesktopAgentRequest[] = [];

  async call(request: DesktopAgentRequest): Promise<unknown> {
    this.calls.push(request);
    if (request.op === "roots") {
      return { roots: [{ id: "target", writable: true }] };
    }
    return { request };
  }
}

const roots: string[] = [];
const bridges: Bridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined);
  for (const root of roots.splice(0)) cleanup(root);
});

function makeRoot(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  makeGitRepo(root);
  return root;
}

async function connect(
  bridge: Bridge,
  headers: Record<string, string>
): Promise<Client> {
  const client = new Client({ name: "desktop-bridge-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${bridge.localBaseUrl()}/mcp`),
    { requestInit: { headers } }
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("Desktop Agent trusted-tunnel bridge", () => {
  it("grants desktop tools only on the configured trusted tunnel", async () => {
    isolateStateDir();
    const root = makeRoot("desktop-bridge");
    const workspace = new Workspace(root);
    const tokenState = ensureTrustedTunnelToken(workspace.id);
    const token = fs.readFileSync(tokenState.file, "utf8").trim();
    const desktopAgent = new FakeDesktopAgent();

    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      trustedTunnelTokenFile: tokenState.file,
      desktopAgent,
      authStoreFile: path.join(makeTmpDir("auth"), "desktop-bridge.json"),
    });
    bridges.push(bridge);

    const trusted = await connect(bridge, { [TRUSTED_TUNNEL_HEADER]: token });
    const names = (await trusted.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("desktop_roots");
    expect(names).toContain("desktop_write");
    expect(names).toContain("desktop_process_run");
    expect(names).toContain("desktop_accessibility_status");
    expect(names).toContain("desktop_accessibility_apps");
    expect(names).toContain("desktop_accessibility_tree");
    expect(names).toContain("desktop_accessibility_find");
    expect(names).toContain("desktop_accessibility_confirm");
    expect(names).toContain("desktop_accessibility_action_profiles");
    expect(names).toContain("desktop_accessibility_press");
    expect(names).toContain("desktop_accessibility_request_grant");
    expect(names).toContain("desktop_accessibility_grants");
    expect(names).toContain("desktop_accessibility_grant_press");
    expect(names).not.toContain("desktop_accessibility_grant_create");
    expect(names).toContain("desktop_app_launch");
    expect(names).toContain("desktop_screenshot_capture");
    expect(names).toContain("desktop_process_start");
    expect(names).toContain("desktop_process_status");
    expect(names).toContain("desktop_process_output");
    expect(names).toContain("desktop_process_stop");

    const rootsResult = await trusted.callTool({ name: "desktop_roots", arguments: {} });
    expect(rootsResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls).toEqual([{ op: "roots" }]);

    const processResult = await trusted.callTool({
      name: "desktop_process_run",
      arguments: { profile_id: "safe-profile" },
    });
    expect(processResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "processRun",
      profileId: "safe-profile",
    });

    const accessibilityResult = await trusted.callTool({
      name: "desktop_accessibility_tree",
      arguments: {
        app_id: "textedit-smoke",
        max_depth: 2,
        max_nodes: 40,
      },
    });
    expect(accessibilityResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "accessibilityTree",
      appId: "textedit-smoke",
      maxDepth: 2,
      maxNodes: 40,
    });

    const actionResult = await trusted.callTool({
      name: "desktop_accessibility_press",
      arguments: { action_profile_id: "textedit-cancel-smoke" },
    });
    expect(actionResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "accessibilityPress",
      actionProfileId: "textedit-cancel-smoke",
    });

    const approvalResult = await trusted.callTool({
      name: "desktop_accessibility_request_grant",
      arguments: {
        app_id: "textedit-smoke",
        title: "Cancel",
        case_sensitive: false,
      },
    });
    expect(approvalResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "accessibilityApprovalRequest",
      appId: "textedit-smoke",
      role: "AXButton",
      title: "Cancel",
      label: undefined,
      focused: undefined,
      caseSensitive: false,
      maxDepth: 6,
      maxNodes: 300,
      ttlMs: 60_000,
    });

    const grantListResult = await trusted.callTool({
      name: "desktop_accessibility_grants",
      arguments: {},
    });
    expect(grantListResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "accessibilityGrantList",
    });

    const grantId = "b".repeat(32);
    const grantPressResult = await trusted.callTool({
      name: "desktop_accessibility_grant_press",
      arguments: { grant_id: grantId },
    });
    expect(grantPressResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "accessibilityGrantConsume",
      grantId,
    });

    const appResult = await trusted.callTool({
      name: "desktop_app_launch",
      arguments: { app_id: "textedit-smoke" },
    });
    expect(appResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "appLaunch",
      appId: "textedit-smoke",
    });

    const screenshotResult = await trusted.callTool({
      name: "desktop_screenshot_capture",
      arguments: {},
    });
    expect(screenshotResult.isError ?? false).toBe(false);
    expect(desktopAgent.calls.at(-1)).toEqual({
      op: "screenshotCapture",
    });

    const oauthToken = bridge.authStore.issueTokens({
      clientId: "oauth-client",
      scopes: ["workspace.read"],
    }).accessToken;
    const oauth = await connect(bridge, { authorization: `Bearer ${oauthToken}` });
    const denied = await oauth.callTool({ name: "desktop_roots", arguments: {} });
    expect(denied.isError).toBe(true);
    expect((denied.content as { text: string }[])[0].text).toContain("desktop.read");

    expect(() =>
      bridge.authStore.issueTokens({
        clientId: "oauth-client",
        scopes: ["desktop.read"],
      })
    ).toThrow(/Unsupported OAuth scope/);

    expect(() =>
      bridge.authStore.issueTokens({
        clientId: "oauth-client",
        scopes: ["desktop.process"],
      })
    ).toThrow(/Unsupported OAuth scope/);

    expect(() =>
      bridge.authStore.issueTokens({
        clientId: "oauth-client",
        scopes: ["desktop.app"],
      })
    ).toThrow(/Unsupported OAuth scope/);

    expect(() =>
      bridge.authStore.issueTokens({
        clientId: "oauth-client",
        scopes: ["desktop.screen"],
      })
    ).toThrow(/Unsupported OAuth scope/);

    expect(() =>
      bridge.authStore.issueTokens({
        clientId: "oauth-client",
        scopes: ["desktop.accessibility.read"],
      })
    ).toThrow(/Unsupported OAuth scope/);

    expect(() =>
      bridge.authStore.issueTokens({
        clientId: "oauth-client",
        scopes: ["desktop.accessibility.action"],
      })
    ).toThrow(/Unsupported OAuth scope/);
  });

  it("does not advertise desktop tools when no Desktop Agent is configured", async () => {
    isolateStateDir();
    const root = makeRoot("desktop-bridge-none");
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "desktop-none.json"),
    });
    bridges.push(bridge);

    const token = bridge.authStore.issueTokens({
      clientId: "client",
      scopes: ["workspace.read"],
    }).accessToken;
    const client = await connect(bridge, { authorization: `Bearer ${token}` });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith("desktop_"))).toBe(false);
  });
});
