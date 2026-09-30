import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { ensureTrustedTunnelToken, TRUSTED_TUNNEL_HEADER } from "../src/auth/trusted-tunnel.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const bridges: Bridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined);
  for (const root of roots.splice(0)) cleanup(root);
});

function makeRoot(name: string, projectName: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  makeGitRepo(root);
  write(root, ".c2c.json", JSON.stringify({ name: projectName }));
  return root;
}

function writeProfilesFile(
  file: string,
  defaultProfileId: string,
  profiles: Array<{ id: string; path: string }>
): void {
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, defaultProfileId, profiles }, null, 2),
    { mode: 0o600 }
  );
  fs.chmodSync(file, 0o600);
}

async function connect(bridge: Bridge, trustedToken: string): Promise<Client> {
  const client = new Client({ name: "workspace-profiles-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${bridge.localBaseUrl()}/mcp`),
    { requestInit: { headers: { [TRUSTED_TUNNEL_HEADER]: trustedToken } } }
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

function jsonOf<T>(result: { content?: unknown }): T {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "{}") as T;
}

describe("owner-approved workspace profiles", () => {
  it("selects only configured ids, hides paths, and persists selection across restart", async () => {
    isolateStateDir();
    const alpha = makeRoot("profiles-alpha", "alpha-project");
    const beta = makeRoot("profiles-beta", "beta-project");
    const configDir = makeTmpDir("profiles-config");
    roots.push(configDir);
    const configFile = path.join(configDir, "workspace-profiles.json");
    writeProfilesFile(configFile, "alpha", [
      { id: "alpha", path: alpha },
      { id: "beta", path: beta },
    ]);

    const anchor = new Workspace(alpha);
    const tokenState = ensureTrustedTunnelToken(anchor.id);
    const trustedToken = fs.readFileSync(tokenState.file, "utf8").trim();

    const start = async (): Promise<{ bridge: Bridge; client: Client }> => {
      const bridge = await startBridge({
        workspaceRoot: alpha,
        workspaceProfilesFile: configFile,
        port: 0,
        persistRuntime: false,
        trustedTunnelTokenFile: tokenState.file,
        authStoreFile: path.join(makeTmpDir("profiles-auth"), "store.json"),
      });
      bridges.push(bridge);
      return { bridge, client: await connect(bridge, trustedToken) };
    };

    let { bridge, client } = await start();
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("workspace_profiles");
    expect(tools).toContain("workspace_select");

    const profilesResult = await client.callTool({ name: "workspace_profiles", arguments: {} });
    const profilesText = (profilesResult.content as Array<{ text: string }>)[0]?.text ?? "";
    const profiles = JSON.parse(profilesText) as {
      selectedProfileId: string;
      profiles: Array<{ id: string; workspaceName: string; selected: boolean }>;
    };
    expect(profiles.selectedProfileId).toBe("alpha");
    expect(profiles.profiles.map((profile) => profile.id)).toEqual(["alpha", "beta"]);
    expect(profilesText).not.toContain(alpha);
    expect(profilesText).not.toContain(beta);

    const initial = jsonOf<{ workspaceProfileId: string; workspaceName: string }>(
      await client.callTool({ name: "workspace_info", arguments: {} })
    );
    expect(initial).toMatchObject({
      workspaceProfileId: "alpha",
      workspaceName: "alpha-project",
    });

    const rejected = await client.callTool({
      name: "workspace_select",
      arguments: { profile_id: "/tmp/not-approved" },
    });
    expect(rejected.isError).toBe(true);

    const selected = await client.callTool({
      name: "workspace_select",
      arguments: { profile_id: "beta" },
    });
    expect(selected.isError ?? false).toBe(false);
    const after = jsonOf<{ workspaceProfileId: string; workspaceName: string }>(
      await client.callTool({ name: "workspace_info", arguments: {} })
    );
    expect(after).toMatchObject({
      workspaceProfileId: "beta",
      workspaceName: "beta-project",
    });
    const status = jsonOf<{ isRepo: boolean; branch: string }>(
      await client.callTool({ name: "git_status", arguments: {} })
    );
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");

    await client.close();
    clients.splice(clients.indexOf(client), 1);
    await bridge.close();
    bridges.splice(bridges.indexOf(bridge), 1);

    ({ bridge, client } = await start());
    const restored = jsonOf<{ workspaceProfileId: string; workspaceName: string }>(
      await client.callTool({ name: "workspace_info", arguments: {} })
    );
    expect(restored).toMatchObject({
      workspaceProfileId: "beta",
      workspaceName: "beta-project",
    });
  });

  it("rejects a non-owner-only profile config", async () => {
    isolateStateDir();
    const alpha = makeRoot("profiles-mode-alpha", "alpha-project");
    const configDir = makeTmpDir("profiles-mode-config");
    roots.push(configDir);
    const configFile = path.join(configDir, "workspace-profiles.json");
    writeProfilesFile(configFile, "alpha", [{ id: "alpha", path: alpha }]);
    if (process.platform !== "win32") fs.chmodSync(configFile, 0o644);

    await expect(
      startBridge({
        workspaceRoot: alpha,
        workspaceProfilesFile: configFile,
        port: 0,
        persistRuntime: false,
      })
    ).rejects.toThrow(/owner-only/);
  });
});
