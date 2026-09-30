import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { ensureTrustedTunnelToken, TRUSTED_TUNNEL_HEADER } from "../src/auth/trusted-tunnel.js";
import type { FolderDecision, FolderOwner } from "../src/workspace/registration.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function setup(decision: FolderDecision = "approved") {
  const previous = process.env.C2C_STATE_DIR, state = isolateStateDir(), root = makeTmpDir("register-http");
  cleanups.push(() => { cleanup(root); cleanup(state); if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous; });
  write(root, "alpha/marker.txt", "alpha"); write(root, "beta/marker.txt", "beta");
  const alpha = new Workspace(path.join(root, "alpha"));
  const config = write(root, "profiles.json", JSON.stringify({ version: 1, defaultProfileId: "alpha", profiles: [
    { id: "alpha", path: alpha.root, codexNetworkHosts: ["example.com"] },
  ] })); fs.chmodSync(config, 0o600);
  const events = path.join(root, "events.jsonl");
  const binary = write(root, "fake-codex.mjs", `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const log=${JSON.stringify(events)};
fs.appendFileSync(log,JSON.stringify({event:'spawn',cwd:path.basename(process.cwd())})+'\\n');
let buffer='',t=0,u=0;const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{buffer+=c;while(buffer.includes('\\n')){
 const i=buffer.indexOf('\\n'),l=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'+(++t)}}});
 if(m.method==='turn/start'){
  const id='u'+(++u),threadId=m.params.threadId;
  send({id:m.id,result:{turn:{id,status:'inProgress',items:[],error:null}}});
  setTimeout(()=>{const item={type:'agentMessage',id:'msg',text:'finished:'+path.basename(process.cwd())};
   send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',items:[item],error:null}}});},600);
 }
}});
`); fs.chmodSync(binary, 0o700);
  const tokenState = ensureTrustedTunnelToken(alpha.id), token = fs.readFileSync(tokenState.file, "utf8").trim();
  const choose = vi.fn(async () => path.join(root, "beta"));
  const approve = vi.fn(async () => decision);
  const owner: FolderOwner = { supported: true, choose, approve };
  async function start() {
    const bridge = await startBridge({ workspaceRoot: alpha.root, workspaceProfilesFile: config,
      port: 0, persistRuntime: false, trustedTunnelTokenFile: tokenState.file,
      codexExecution: true, codexBinary: binary, authStoreFile: path.join(root, "auth.json"), folderOwner: owner,
    }); cleanups.push(() => bridge.close());
    const client = new Client({ name: "registration-fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { [TRUSTED_TUNNEL_HEADER]: token } },
    })); cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    return { bridge, client, call };
  }
  return { root, config, alpha, events, owner, choose, approve, start };
}
async function terminal(call: (name: string, args?: Record<string, unknown>) => Promise<any>, started: any, task: string, id: string) {
  let r = started;
  for (let i = 0; i < 5 && r.state === "running"; i++) r = await call("codex_turn_wait", { task_id: task, run_id: r.run_id, workspace_id: id });
  expect(r.state).toBe("completed"); return r;
}

it("adds a native-owner-approved project to the same HTTP bridge while another Codex task remains usable", async () => {
  const s = await setup(), a = await s.start();
  const old = await a.call("codex_turn_start", { workspace_id: s.alpha.id, task_id: "alpha-task", iteration: 1, instruction: "fixture only" });
  expect(old.state).toBe("running");
  const job = await a.call("workspace_register_start");
  let result: any;
  await expect.poll(async () => { result = await a.call("workspace_register_status", { registration_id: job.registration_id }); return result.state; }, { timeout: 3000 }).toBe("registered");
  const betaId = result.profile.workspaceId;
  expect((await a.call("workspace_profiles")).selectedProfileId).toBe("alpha");
  expect((await a.call("workspace_info", { workspace_id: betaId })).workspaceId).toBe(betaId);
  expect((await a.call("read_file", { workspace_id: betaId, path: "marker.txt" })).content).toBe("beta");
  const next = await a.call("codex_turn_start", { workspace_id: betaId, task_id: "beta-task", iteration: 1, instruction: "fixture only" });
  expect((await terminal(a.call, old, "alpha-task", s.alpha.id)).summary).toBe("finished:alpha");
  expect((await terminal(a.call, next, "beta-task", betaId)).summary).toBe("finished:beta");
  expect(s.approve).toHaveBeenCalledTimes(1);
  await a.client.close(); await a.bridge.close();
  const stored = fs.readFileSync(s.config, "utf8"), b = await s.start();
  expect((await b.call("workspace_profiles")).profiles.map((p: any) => p.workspaceId)).toContain(betaId);
  expect((await b.call("read_file", { workspace_id: betaId, path: "marker.txt" })).content).toBe("beta");
  expect(s.approve).toHaveBeenCalledTimes(1); expect(fs.readFileSync(s.config, "utf8")).toBe(stored);
  const events = fs.readFileSync(s.events, "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(events).toEqual([{ event: "spawn", cwd: "alpha" }, { event: "spawn", cwd: "beta" }]);
}, 15_000);

it("does not add any project or invoke Codex when the native owner denies", async () => {
  const s = await setup("denied"), a = await s.start(), before = fs.readFileSync(s.config, "utf8");
  const job = await a.call("workspace_register_start");
  await expect.poll(async () => (await a.call("workspace_register_status", { registration_id: job.registration_id })).state).toBe("denied");
  expect((await a.call("workspace_profiles")).profiles).toHaveLength(1);
  expect(fs.readFileSync(s.config, "utf8")).toBe(before); expect(fs.existsSync(s.events)).toBe(false);
});


it("phase06 regression: registering a second project does not break an existing no-ID wait", async () => {
  const s = await setup(), a = await s.start();
  const started = await a.call("codex_turn_start", { task_id: "before-second-project", iteration: 1, instruction: "fixture only" });
  expect(started.state).toBe("running");
  const job = await a.call("workspace_register_start");
  let registration: any;
  await expect.poll(async () => {
    registration = await a.call("workspace_register_status", { registration_id: job.registration_id });
    return registration.state;
  }, { timeout: 3000 }).toBe("registered");
  await a.call("workspace_select", { profile_id: registration.profile.id });
  let result = await a.call("codex_turn_wait", { task_id: "before-second-project", run_id: started.run_id });
  for (let i=0;i<5 && result.state==="running";i++) {
    result = await a.call("codex_turn_wait", { task_id: "before-second-project", run_id: started.run_id });
  }
  expect(result).toMatchObject({ state: "completed", summary: "finished:alpha", workspace_id: s.alpha.id });
  expect((await a.call("codex_turn_wait", { task_id: "unknown-task", run_id: started.run_id })).error).toBe("WORKSPACE_ID_REQUIRED");
}, 15000);
