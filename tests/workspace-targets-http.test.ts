import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { ensureTrustedTunnelToken, TRUSTED_TUNNEL_HEADER } from "../src/auth/trusted-tunnel.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const finalizers: Array<() => unknown> = [];
afterEach(async () => { for (const f of finalizers.splice(0).reverse()) await f(); });

async function setup() {
  const previous = process.env.C2C_STATE_DIR;
  const state = isolateStateDir();
  const root = makeTmpDir("workspace-target-http");
  finalizers.push(() => {
    cleanup(root); cleanup(state);
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
  });
  for (const name of ["alpha", "beta"]) write(root, `${name}/target.txt`, name);
  const alpha = new Workspace(path.join(root, "alpha"));
  const beta = new Workspace(path.join(root, "beta"));
  const config = write(root, "profiles.json", JSON.stringify({
    version: 1, defaultProfileId: "alpha", profiles: [
      { id: "alpha", path: alpha.root }, { id: "beta", path: beta.root },
    ],
  }));
  fs.chmodSync(config, 0o600);
  const binary = write(root, "fake-codex.mjs", `#!/usr/bin/env node
import path from 'node:path';
let buffer='', thread=0, turn=0;
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{buffer+=chunk;while(buffer.includes('\\n')){
 const i=buffer.indexOf('\\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'+(++thread)}}});
 if(m.method==='turn/start'){
  const id='u'+(++turn),threadId=m.params.threadId;
  send({id:m.id,result:{turn:{id,status:'inProgress',items:[],error:null}}});
  setTimeout(()=>{
   const item={type:'agentMessage',id:'msg',text:'cwd:'+path.basename(process.cwd())};
   send({method:'item/completed',params:{threadId,turnId:id,item}});
   send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',items:[item],error:null}}});
  },900);
 }
}});
`);
  fs.chmodSync(binary, 0o700);
  const tokenState = ensureTrustedTunnelToken(alpha.id);
  const token = fs.readFileSync(tokenState.file, "utf8").trim();
  const bridge = await startBridge({ workspaceRoot: alpha.root, workspaceProfilesFile: config,
    port: 0, persistRuntime: false, trustedTunnelTokenFile: tokenState.file,
    codexExecution: true, codexBinary: binary, authStoreFile: path.join(root, "auth.json"),
  });
  finalizers.push(() => bridge.close());
  async function connect() {
    const client = new Client({ name: "isolated-target-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { [TRUSTED_TUNNEL_HEADER]: token } },
    }));
    finalizers.push(() => client.close());
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
  }
  return { a: await connect(), b: await connect(), alpha: alpha.id, beta: beta.id };
}

it("two HTTP clients run in their explicitly bound repos while the global selection differs", async () => {
  const s = await setup();
  await s.b("workspace_select", { profile_id: "beta" });
  expect((await s.a("read_file", { path: "target.txt", workspace_id: s.alpha })).content).toBe("alpha");
  expect((await s.a("workspace_info", { workspace_id: s.alpha })).workspaceId).toBe(s.alpha);
  expect((await s.b("workspace_info")).workspaceId).toBe(s.beta);
  const args = { iteration: 1, instruction: "fixture only" };
  const [a, b] = await Promise.all([
    s.a("codex_turn_start", { ...args, task_id: "alpha-task", workspace_id: s.alpha }),
    s.b("codex_turn_start", { ...args, task_id: "beta-task", workspace_id: s.beta }),
  ]);
  expect(a.state).toBe("running"); expect(b.state).toBe("running");
  expect(a.workspace_id).toBe(s.alpha); expect(b.workspace_id).toBe(s.beta);
  expect((await s.a("codex_turn_start", { ...args, task_id: "same-tree", workspace_id: s.alpha })).error).toBe("TURN_ACTIVE");
  expect((await s.b("codex_turn_start", { ...args, task_id: "alpha-task", workspace_id: s.beta })).error).toBe("TASK_WORKSPACE_MISMATCH");
  async function finish(call: typeof s.a, task: string, id: string, run: string) {
    let result;
    for (let i = 0; i < 5; i++) {
      result = await call("codex_turn_wait", { task_id: task, workspace_id: id, run_id: run });
      if (result.state !== "running") return result;
    }
    throw new Error("fixture did not finish");
  }
  const [ra, rb] = await Promise.all([
    finish(s.a, "alpha-task", s.alpha, a.run_id), finish(s.b, "beta-task", s.beta, b.run_id),
  ]);
  expect(ra).toMatchObject({ state: "completed", summary: "cwd:alpha", workspace_id: s.alpha });
  expect(rb).toMatchObject({ state: "completed", summary: "cwd:beta", workspace_id: s.beta });
  await s.a("workspace_select", { profile_id: "alpha" });
  expect((await s.b("read_file", { path: "target.txt", workspace_id: s.beta })).content).toBe("beta");
  const records = await s.a("execution_summary", { workspace_id: s.alpha });
  expect(records.records.map((r: {taskId: string}) => r.taskId)).toEqual(["alpha-task"]);
}, 20_000);

it("missing and unknown targets return actionable errors over HTTP without executing", async () => {
  const s = await setup();
  const args = { task_id: "missing", iteration: 1, instruction: "fixture only", run_id: "a".repeat(32) };
  for (const name of ["codex_turn_start", "codex_turn_wait"]) {
    expect((await s.a(name, args)).error).toBe("WORKSPACE_ID_REQUIRED");
    expect((await s.a(name, { ...args, workspace_id: "0".repeat(24) })).error).toBe("WORKSPACE_ID_UNKNOWN");
  }
  expect((await s.a("execution_summary", { workspace_id: s.alpha })).records).toEqual([]);
});
