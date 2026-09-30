import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import {
  ensureTrustedTunnelToken,
  TRUSTED_TUNNEL_HEADER,
} from "../src/auth/trusted-tunnel.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const cleanupPaths: string[] = [];
const bridges: Bridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined);
  for (const item of cleanupPaths.splice(0)) cleanup(item);
});

function makeRoot(name: string): string {
  const root = makeTmpDir(name);
  cleanupPaths.push(root);
  makeGitRepo(root);
  write(root, ".c2c.json", JSON.stringify({ name }));
  return root;
}

function makeFakeCodex(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-profile-codex-"));
  cleanupPaths.push(dir);
  const binary = path.join(dir, "codex-fake.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
import path from "node:path";
let buffer=""; let thread=0; let turn=0;
const send=(v)=>process.stdout.write(JSON.stringify(v)+"\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data",(chunk)=>{ buffer+=chunk; while(buffer.includes("\\n")){
 const i=buffer.indexOf("\\n"); const line=buffer.slice(0,i); buffer=buffer.slice(i+1); if(!line.trim()) continue;
 const m=JSON.parse(line);
 if(m.method==="initialize") send({id:m.id,result:{userAgent:"fake"}});
 else if(m.method==="thread/start") send({id:m.id,result:{thread:{id:"t"+(++thread)}}});
 else if(m.method==="turn/start"){
   const id="u"+(++turn);
   send({id:m.id,result:{turn:{id,status:"inProgress",items:[],error:null}}});
   const cwdName=path.basename(process.cwd());
   setTimeout(()=>{
     const item={type:"agentMessage",id:"m1",text:"cwd-name:"+cwdName};
     send({method:"item/completed",params:{threadId:m.params.threadId,turnId:id,item}});
     send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{id,status:"completed",items:[item],error:null}}});
   },600);
 }
}});
`, { mode: 0o700 });
  return binary;
}

function jsonOf<T>(result: { content?: unknown }): T {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0]?.text ?? "{}") as T;
}

describe("workspace profiles with Codex execution", () => {
  it("runs Codex in the selected profile and blocks switching while the turn is active", async () => {
    isolateStateDir();
    const alpha = makeRoot("profile-codex-alpha");
    const beta = makeRoot("profile-codex-beta");
    const configDir = makeTmpDir("profile-codex-config");
    cleanupPaths.push(configDir);
    const configFile = path.join(configDir, "workspace-profiles.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        defaultProfileId: "alpha",
        profiles: [
          { id: "alpha", path: alpha },
          { id: "beta", path: beta },
        ],
      }),
      { mode: 0o600 }
    );
    fs.chmodSync(configFile, 0o600);

    const anchor = new Workspace(alpha);
    const tokenState = ensureTrustedTunnelToken(anchor.id);
    const token = fs.readFileSync(tokenState.file, "utf8").trim();

    const bridge = await startBridge({
      workspaceRoot: alpha,
      workspaceProfilesFile: configFile,
      port: 0,
      persistRuntime: false,
      trustedTunnelTokenFile: tokenState.file,
      codexExecution: true,
      codexBinary: makeFakeCodex(),
      authStoreFile: path.join(makeTmpDir("profile-codex-auth"), "store.json"),
    });
    bridges.push(bridge);

    const client = new Client({ name: "profile-codex-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${bridge.localBaseUrl()}/mcp`),
      { requestInit: { headers: { [TRUSTED_TUNNEL_HEADER]: token } } }
    );
    await client.connect(transport);
    clients.push(client);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("workspace_profiles");
    expect(names).toContain("workspace_select");
    expect(names).toContain("codex_turn_start");
    expect(names).toContain("codex_turn_wait");

    expect(
      (await client.callTool({
        name: "workspace_select",
        arguments: { profile_id: "beta" },
      })).isError ?? false
    ).toBe(false);

    const selected = jsonOf<{
      workspaceProfileId: string;
      workspaceName: string;
      registeredCapabilities: { codexExecution: boolean; desktopWrite: boolean };
    }>(
      await client.callTool({ name: "workspace_info", arguments: {} })
    );
    expect(selected.workspaceProfileId).toBe("beta");
    expect(selected.registeredCapabilities.codexExecution).toBe(true);
    expect(selected.registeredCapabilities.desktopWrite).toBe(false);

    const started = jsonOf<{ run_id: string; state: string }>(
      await client.callTool({
        name: "codex_turn_start",
        arguments: {
          workspace_id: new Workspace(beta).id, task_id: "profile-readonly",
          iteration: 1,
          instruction: "Read-only inspection only. Do not modify files.",
        },
      })
    );
    expect(started.state).toBe("running");

    const busy = await client.callTool({
      name: "workspace_select",
      arguments: { profile_id: "alpha" },
    });
    expect(busy.isError).toBe(true);
    expect((busy.content as Array<{ text: string }>)[0]?.text).toContain("WORKSPACE_BUSY");

    const waited = jsonOf<{ state: string; summary?: string }>(
      await client.callTool({
        name: "codex_turn_wait",
        arguments: { workspace_id: new Workspace(beta).id, task_id: "profile-readonly", run_id: started.run_id },
      })
    );
    expect(waited.state).toBe("completed");
    expect(waited.summary).toBe(`cwd-name:${path.basename(beta)}`);
    expect(waited.summary).not.toContain(beta);

    const summary = jsonOf<{ records: Array<{ taskId: string }> }>(
      await client.callTool({ name: "execution_summary", arguments: { limit: 5 } })
    );
    expect(summary.records.some((record) => record.taskId === "profile-readonly")).toBe(true);

    expect(
      (await client.callTool({
        name: "workspace_select",
        arguments: { profile_id: "alpha" },
      })).isError ?? false
    ).toBe(false);
    const other = new Client({ name: "second-client", version: "1" });
    await other.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { [TRUSTED_TUNNEL_HEADER]: token } },
    }));
    clients.push(other);
    const alphaId = anchor.id;
    const betaId = new Workspace(beta).id;
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      jsonOf<Record<string, any>>(await c.callTool({ name, arguments: args }));
    const startArgs = { task_id: "bound-alpha", iteration: 1, instruction: "Inspect only" };
    expect((await call(client, "codex_turn_start", startArgs)).error).toBe("WORKSPACE_ID_REQUIRED");
    expect((await call(client, "codex_turn_wait", { task_id: "bound-alpha", run_id: "a".repeat(32) })).error).toBe("WORKSPACE_ID_REQUIRED");
    expect((await call(client, "codex_turn_start", { ...startArgs, workspace_id: "0".repeat(24) })).error).toBe("WORKSPACE_ID_UNKNOWN");
    await call(other, "workspace_select", { profile_id: "beta" });
    write(alpha, "target.txt", "alpha marker");
    write(beta, "target.txt", "beta marker");
    expect(JSON.stringify(await call(client, "read_file", { workspace_id: alphaId, path: "target.txt" }))).toContain("alpha marker");
    expect((await call(client, "workspace_info", { workspace_id: alphaId })).workspaceProfileId).toBe("alpha");
    expect((await call(other, "workspace_info", {})).workspaceProfileId).toBe("beta");
    const [a, b, reused] = await Promise.all([
      call(client, "codex_turn_start", { ...startArgs, workspace_id: alphaId }),
      call(other, "codex_turn_start", { ...startArgs, task_id: "bound-beta", workspace_id: betaId }),
      call(other, "codex_turn_start", { ...startArgs, workspace_id: betaId }),
    ]);
    expect(a.state).toBe("running");
    expect(b.state).toBe("running");
    expect(reused.error).toBe("TASK_WORKSPACE_MISMATCH");
    expect((await call(other, "codex_turn_wait", { task_id: "bound-alpha", run_id: a.run_id, workspace_id: betaId })).error).toBe("TASK_WORKSPACE_MISMATCH");
    const collision = await call(client, "codex_turn_start", { ...startArgs, task_id: "collision", workspace_id: alphaId });
    expect(collision.error).toBe("TURN_ACTIVE");
    const [doneA, doneB] = await Promise.all([
      call(client, "codex_turn_wait", { task_id: "bound-alpha", run_id: a.run_id, workspace_id: alphaId }),
      call(other, "codex_turn_wait", { task_id: "bound-beta", run_id: b.run_id, workspace_id: betaId }),
    ]);
    expect(doneA.summary).toBe(`cwd-name:${path.basename(alpha)}`);
    expect(doneB.summary).toBe(`cwd-name:${path.basename(beta)}`);

  });
});
