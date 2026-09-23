import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { SUPPORTED_SCOPES, filterScopes, invalidScopes } from "../src/auth/store.js";
import {
  ensureTrustedTunnelToken,
  TRUSTED_TUNNEL_HEADER,
} from "../src/auth/trusted-tunnel.js";
import { Workspace } from "../src/workspace/manager.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

const roots: string[] = [];
const external: string[] = [];
const bridges: Bridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined);
  for (const dir of roots.splice(0)) cleanup(dir);
  for (const dir of external.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  makeGitRepo(root);
  return root;
}

function makeFakeCodex(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-mcp-codex-"));
  external.push(dir);
  const binary = path.join(dir, "codex-fake.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
let buffer=""; let thread=0; let turn=0;
const send=(v)=>process.stdout.write(JSON.stringify(v)+"\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data",(chunk)=>{ buffer+=chunk; while(buffer.includes("\\n")){
 const i=buffer.indexOf("\\n"); const line=buffer.slice(0,i); buffer=buffer.slice(i+1); if(!line.trim()) continue;
 const m=JSON.parse(line); if(m.method==="initialize") send({id:m.id,result:{userAgent:"fake"}});
 else if(m.method==="thread/start") send({id:m.id,result:{thread:{id:"t"+(++thread)}}});
 else if(m.method==="turn/start"){ const id="u"+(++turn); send({id:m.id,result:{turn:{id,status:"inProgress",items:[],error:null}}});
  const item={type:"agentMessage",id:"m1",text:"done"}; send({method:"item/completed",params:{threadId:m.params.threadId,turnId:id,item}});
  send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{id,status:"completed",items:[item],error:null}}}); }
 }});
`, { mode: 0o700 });
  return binary;
}

async function connect(
  bridge: Bridge,
  headers: Record<string, string>
): Promise<Client> {
  const client = new Client({ name: "codex-mcp-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${bridge.localBaseUrl()}/mcp`),
    { requestInit: { headers } }
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function makeExecutionBridge(name: string): Promise<{ bridge: Bridge; client: Client }> {
  isolateStateDir();
  const root = makeRoot(name);
  const workspace = new Workspace(root);
  const tokenState = ensureTrustedTunnelToken(workspace.id);
  const token = fs.readFileSync(tokenState.file, "utf8").trim();
  const bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    trustedTunnelTokenFile: tokenState.file,
    codexExecution: true,
    codexBinary: makeFakeCodex(),
    authStoreFile: path.join(makeTmpDir("auth"), `${name}.json`),
  });
  bridges.push(bridge);
  return { bridge, client: await connect(bridge, { [TRUSTED_TUNNEL_HEADER]: token }) };
}

function toolNames(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

const DEFAULT_TOOLS = [
  "execution_summary", "git_diff", "git_status", "list_directory",
  "read_file", "search_workspace", "test_status", "workspace_info",
].sort();

describe("Codex MCP execution opt-in", () => {
  it("keeps the default surface at exactly eight tools", async () => {
    isolateStateDir();
    const root = makeRoot("codex-mcp-default");
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "default.json"),
    });
    bridges.push(bridge);
    const token = bridge.authStore.issueTokens({
      clientId: "default-client",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    }).accessToken;
    const client = await connect(bridge, { authorization: `Bearer ${token}` });
    expect(toolNames((await client.listTools()).tools)).toEqual(DEFAULT_TOOLS);
  });

  it("adds exactly two tools only for trusted tunnel execution", async () => {
    isolateStateDir();
    const root = makeRoot("codex-mcp-exec");
    const workspace = new Workspace(root);
    const tokenState = ensureTrustedTunnelToken(workspace.id);
    const token = fs.readFileSync(tokenState.file, "utf8").trim();
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      trustedTunnelTokenFile: tokenState.file,
      codexExecution: true,
      codexBinary: makeFakeCodex(),
      authStoreFile: path.join(makeTmpDir("auth"), "exec.json"),
    });
    bridges.push(bridge);
    const client = await connect(bridge, { [TRUSTED_TUNNEL_HEADER]: token });
    const names = toolNames((await client.listTools()).tools);
    expect(names).toEqual([...DEFAULT_TOOLS, "codex_turn_start", "codex_turn_wait"].sort());

    const started = await client.callTool({
      name: "codex_turn_start",
      arguments: { task_id: "mcp-task", iteration: 1, instruction: "test" },
    });
    expect(started.isError ?? false).toBe(false);
    const startBody = JSON.parse((started.content as { text: string }[])[0].text) as { run_id: string };
    const waited = await client.callTool({
      name: "codex_turn_wait",
      arguments: { task_id: "mcp-task", run_id: startBody.run_id },
    });
    const waitBody = JSON.parse((waited.content as { text: string }[])[0].text) as { state: string };
    expect(waitBody.state).toBe("completed");

    const summary = await client.callTool({
      name: "execution_summary",
      arguments: { limit: 5 },
    });
    const records = JSON.parse((summary.content as { text: string }[])[0].text) as {
      records: Array<Record<string, unknown>>;
    };
    expect(records.records).toEqual([
      expect.objectContaining({
        taskId: "mcp-task",
        iteration: 1,
        changedFiles: null,
        tests: null,
        exitStatus: "ok",
        runId: startBody.run_id,
      }),
    ]);

    const testStatus = await client.callTool({ name: "test_status", arguments: {} });
    expect(JSON.parse((testStatus.content as { text: string }[])[0].text)).toMatchObject({
      available: false,
      taskId: "mcp-task",
      iteration: 1,
      tests: null,
      exitStatus: null,
    });

    await client.callTool({
      name: "codex_turn_wait",
      arguments: { task_id: "mcp-task", run_id: startBody.run_id },
    });
    const repeatedSummary = await client.callTool({
      name: "execution_summary",
      arguments: { limit: 5 },
    });
    const repeatedRecords = JSON.parse(
      (repeatedSummary.content as { text: string }[])[0].text
    ) as { records: Array<{ runId?: string }> };
    expect(repeatedRecords.records.filter((record) => record.runId === startBody.run_id)).toHaveLength(1);
  });

  it("lets the trusted tunnel request a configured completion notification", async () => {
    isolateStateDir();
    const root = makeRoot("codex-mcp-notify");
    const workspace = new Workspace(root);
    const tokenState = ensureTrustedTunnelToken(workspace.id);
    const token = fs.readFileSync(tokenState.file, "utf8").trim();
    let notifications = 0;
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      trustedTunnelTokenFile: tokenState.file,
      codexExecution: true,
      codexBinary: makeFakeCodex(),
      completionNotifier: () => { notifications++; },
      authStoreFile: path.join(makeTmpDir("auth"), "notify.json"),
    });
    bridges.push(bridge);
    const client = await connect(bridge, { [TRUSTED_TUNNEL_HEADER]: token });
    expect(toolNames((await client.listTools()).tools)).toEqual(
      [...DEFAULT_TOOLS, "codex_turn_start", "codex_turn_wait", "completion_notify"].sort()
    );
    const result = await client.callTool({ name: "completion_notify", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ notification: "requested" });
    expect(notifications).toBe(1);
  });

  it("does not re-record a retained run after its record rotates out", async () => {
    const { bridge, client } = await makeExecutionBridge("codex-mcp-rotation");
    const started = await client.callTool({
      name: "codex_turn_start",
      arguments: { task_id: "rotation-task", iteration: 1, instruction: "test" },
    });
    const runId = (JSON.parse((started.content as { text: string }[])[0].text) as { run_id: string }).run_id;
    await client.callTool({
      name: "codex_turn_wait",
      arguments: { task_id: "rotation-task", run_id: runId },
    });

    for (let index = 0; index < 100; index++) {
      appendExecutionRecord(bridge.workspace.id, {
        taskId: `manual-${index}`,
        iteration: 1,
        changedFiles: 0,
        tests: "manual pass",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });
    }
    const before = readExecutionRecords(bridge.workspace.id, 100);
    expect(before.some((record) => record.runId === runId)).toBe(false);
    expect(before.at(-1)?.taskId).toBe("manual-99");

    await client.callTool({
      name: "codex_turn_wait",
      arguments: { task_id: "rotation-task", run_id: runId },
    });
    const after = readExecutionRecords(bridge.workspace.id, 100);
    expect(after.some((record) => record.runId === runId)).toBe(false);
    expect(after.at(-1)?.taskId).toBe("manual-99");
  });

  it("keeps explicit test evidence visible and scoped to the latest task iteration", async () => {
    const { bridge, client } = await makeExecutionBridge("codex-mcp-test-status");
    const status = async () => JSON.parse(
      ((await client.callTool({ name: "test_status", arguments: {} })).content as { text: string }[])[0].text
    ) as {
      available: boolean;
      taskId?: string;
      iteration?: number;
      tests: string | null;
      exitStatus: string | null;
    };
    const start = async (taskId: string, iteration: number) => {
      const started = await client.callTool({
        name: "codex_turn_start",
        arguments: { task_id: taskId, iteration, instruction: "test" },
      });
      return (JSON.parse((started.content as { text: string }[])[0].text) as { run_id: string }).run_id;
    };
    const wait = (taskId: string, runId: string) => client.callTool({
      name: "codex_turn_wait",
      arguments: { task_id: taskId, run_id: runId },
    });
    const manual = (taskId: string, iteration: number, tests: string, exitStatus: "ok" | "failed") =>
      appendExecutionRecord(bridge.workspace.id, {
        taskId,
        iteration,
        changedFiles: 0,
        tests,
        exitStatus,
        timestamp: new Date().toISOString(),
      });

    const firstRun = await start("manual-before", 1);
    manual("manual-before", 1, "1 failed", "failed");
    await wait("manual-before", firstRun);
    expect(await status()).toMatchObject({
      available: true,
      taskId: "manual-before",
      iteration: 1,
      tests: "1 failed",
      exitStatus: "failed",
    });

    const secondRun = await start("manual-after", 1);
    await wait("manual-after", secondRun);
    manual("manual-after", 1, "2 failed", "failed");
    expect(await status()).toMatchObject({
      available: true,
      taskId: "manual-after",
      iteration: 1,
      tests: "2 failed",
      exitStatus: "failed",
    });

    manual("manual-after", 1, "3 passed", "ok");
    expect(await status()).toMatchObject({
      available: true,
      taskId: "manual-after",
      iteration: 1,
      tests: "3 passed",
      exitStatus: "ok",
    });

    const noTestsRun = await start("no-tests", 1);
    await wait("no-tests", noTestsRun);
    expect(await status()).toMatchObject({
      available: false,
      taskId: "no-tests",
      iteration: 1,
      tests: null,
      exitStatus: null,
    });

    const noTestsIterationTwo = await start("no-tests", 2);
    await wait("no-tests", noTestsIterationTwo);
    expect(await status()).toMatchObject({
      available: false,
      taskId: "no-tests",
      iteration: 2,
      tests: null,
      exitStatus: null,
    });
  });

  it("declares the terminal wait record side effect", async () => {
    const { client } = await makeExecutionBridge("codex-mcp-wait-annotations");
    const waitTool = (await client.listTools()).tools.find((tool) => tool.name === "codex_turn_wait");
    expect(waitTool?.description).toMatch(/terminal.*execution record/i);
    expect(waitTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("never grants codex.execute through OAuth", async () => {
    expect(SUPPORTED_SCOPES).not.toContain("codex.execute" as never);
    expect(filterScopes("workspace.read codex.execute")).toEqual(["workspace.read"]);
    expect(invalidScopes("workspace.read codex.execute")).toEqual(["codex.execute"]);

    isolateStateDir();
    const root = makeRoot("codex-mcp-oauth");
    const workspace = new Workspace(root);
    const tunnel = ensureTrustedTunnelToken(workspace.id);
    let notifications = 0;
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      trustedTunnelTokenFile: tunnel.file,
      codexExecution: true,
      codexBinary: makeFakeCodex(),
      completionNotifier: () => { notifications++; },
      authStoreFile: path.join(makeTmpDir("auth"), "oauth.json"),
    });
    bridges.push(bridge);
    const token = bridge.authStore.issueTokens({
      clientId: "oauth-client",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    }).accessToken;
    const client = await connect(bridge, { authorization: `Bearer ${token}` });
    expect(toolNames((await client.listTools()).tools)).toEqual(
      [...DEFAULT_TOOLS, "codex_turn_start", "codex_turn_wait", "completion_notify"].sort()
    );
    const denied = await client.callTool({
      name: "codex_turn_start",
      arguments: { task_id: "oauth-task", iteration: 1, instruction: "test" },
    });
    expect(denied.isError).toBe(true);
    expect((denied.content as { text: string }[])[0].text).toContain("INSUFFICIENT_SCOPE");
    const notifyDenied = await client.callTool({ name: "completion_notify", arguments: {} });
    expect(notifyDenied.isError).toBe(true);
    expect((notifyDenied.content as { text: string }[])[0].text).toContain("INSUFFICIENT_SCOPE");
    expect(notifications).toBe(0);
  });
});
