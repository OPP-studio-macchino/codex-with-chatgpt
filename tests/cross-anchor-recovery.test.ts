import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { Workspace } from "../src/workspace/manager.js";
import { ensureTrustedTunnelToken, TRUSTED_TUNNEL_HEADER } from "../src/auth/trusted-tunnel.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const cleanupActions: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanupActions.splice(0).reverse()) await fn(); });

it("an unresolved target journal follows the target across different bridge anchors", async () => {
  const previous = process.env.C2C_STATE_DIR;
  const state = isolateStateDir();
  const root = makeTmpDir("cross-anchor-recovery");
  cleanupActions.push(() => {
    cleanup(root); cleanup(state);
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
  });
  const alphaRoot = path.join(root, "alpha");
  const betaRoot = path.join(root, "beta");
  fs.mkdirSync(alphaRoot); fs.mkdirSync(betaRoot);
  const alpha = new Workspace(alphaRoot), beta = new Workspace(betaRoot);
  const configA = write(root, "profiles-a.json", JSON.stringify({
    version: 1, defaultProfileId: "alpha",
    profiles: [{ id: "alpha", path: alpha.root }, { id: "beta", path: beta.root }],
  }));
  const configB = write(root, "profiles-b.json", JSON.stringify({
    version: 1, defaultProfileId: "beta",
    profiles: [{ id: "beta", path: beta.root }, { id: "alpha", path: alpha.root }],
  }));
  fs.chmodSync(configA, 0o600); fs.chmodSync(configB, 0o600);
  const events = path.join(root, "events.jsonl");
  const binary = write(root, "fake-codex.mjs", `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({event:'spawn'})+'\\n');
let buffer='',thread=0,turn=0;
const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){
 const i=buffer.indexOf('\\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'+(++thread)}}});
 if(m.method==='turn/start'){fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({event:'turn'})+'\\n');
  const id='u'+(++turn),threadId=m.params.threadId;send({id:m.id,result:{turn:{id,status:'inProgress',items:[],error:null}}});
 }
}});
`);
  fs.chmodSync(binary, 0o700);

  const stale = new TaskJournal(beta.id);
  const interrupted = { task_id: "interrupted", iteration: 1, run_id: "b".repeat(32), state: "running" as const };
  stale.begin(beta.id, interrupted, "fixture interrupted");
  stale.close();

  async function openBridge(anchor: Workspace, config: string) {
    const tokenState = ensureTrustedTunnelToken(anchor.id);
    const token = fs.readFileSync(tokenState.file, "utf8").trim();
    const bridge = await startBridge({
      workspaceRoot: anchor.root, workspaceProfilesFile: config, port: 0, persistRuntime: false,
      trustedTunnelTokenFile: tokenState.file, codexExecution: true, codexBinary: binary,
      authStoreFile: path.join(root, `auth-${anchor.id}.json`), desktopAgent: null, completionNotifier: () => undefined,
    });
    cleanupActions.push(() => bridge.close());
    const client = new Client({ name: `cross-anchor-${anchor.name}`, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { [TRUSTED_TUNNEL_HEADER]: token } },
    }));
    cleanupActions.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return JSON.parse((response.content as Array<{text:string}>)[0]!.text);
    };
    return { bridge, client, call };
  }

  const a = await openBridge(alpha, configA);
  const status = await a.call("task_status", { workspace_id: beta.id, task_id: "interrupted" });
  expect(status.tasks[0]).toMatchObject({
    execution_state: "interrupted", requires_reconciliation: true, outcome_known: false,
  });

  const b = await openBridge(beta, configB);
  expect((await b.call("task_status", { workspace_id: beta.id, task_id: "interrupted" })).error)
    .toBe("TASK_JOURNAL_BUSY");
  expect((await b.call("codex_turn_start", {
    workspace_id: beta.id, task_id: "bypass", iteration: 1, instruction: "must not execute",
  })).error).toBe("TASK_JOURNAL_BUSY");
  expect(fs.existsSync(events)).toBe(false);

  await a.client.close(); await a.bridge.close();
  const afterRelease = await b.call("codex_turn_start", {
    workspace_id: beta.id, task_id: "bypass", iteration: 1, instruction: "must not execute",
  });
  expect(afterRelease.error).toBe("WORKSPACE_RECOVERY_REQUIRED");
  expect(fs.existsSync(events)).toBe(false);
}, 15_000);
