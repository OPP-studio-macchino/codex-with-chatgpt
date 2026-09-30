import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { ensureTrustedTunnelToken, TRUSTED_TUNNEL_HEADER } from "../src/auth/trusted-tunnel.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const cleanupActions: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanupActions.splice(0).reverse()) await f(); });

function setup() {
  const previous = process.env.C2C_STATE_DIR;
  const state = isolateStateDir();
  const root = makeTmpDir("durable-http");
  cleanupActions.push(() => {
    cleanup(root); cleanup(state);
    if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous;
  });
  for (const name of ["alpha", "beta"]) write(root, `${name}/marker.txt`, name);
  const alpha = new Workspace(path.join(root, "alpha"));
  const beta = new Workspace(path.join(root, "beta"));
  const config = write(root, "profiles.json", JSON.stringify({ version: 1, defaultProfileId: "alpha", profiles: [
    { id: "alpha", path: alpha.root }, { id: "beta", path: beta.root },
  ] }));
  fs.chmodSync(config, 0o600);
  const events = path.join(root, "events.jsonl");
  const binary = write(root, "fake-codex.mjs", `#!/usr/bin/env node
import fs from 'node:fs';
const log=${JSON.stringify(events)};
fs.appendFileSync(log,JSON.stringify({event:'spawn'})+'\\n');
let buffer='', t=0,u=0;
const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){
 const i=buffer.indexOf('\\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'fake'}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'+(++t)}}});
 if(m.method==='turn/start'){
  fs.appendFileSync(log,JSON.stringify({event:'turn'})+'\\n');
  const id='u'+(++u),threadId=m.params.threadId;
  send({id:m.id,result:{turn:{id,status:'inProgress',items:[],error:null}}});
  setTimeout(()=>{
   const item={type:'agentMessage',id:'msg',text:'fixture execution ended; tests were not run'};
   send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',items:[item],error:null}}});
  },100);
 }
}});
`);
  fs.chmodSync(binary, 0o700);
  const tokenState = ensureTrustedTunnelToken(alpha.id);
  const token = fs.readFileSync(tokenState.file, "utf8").trim();
  async function start() {
    const bridge = await startBridge({ workspaceRoot: alpha.root, workspaceProfilesFile: config,
      port: 0, persistRuntime: false, trustedTunnelTokenFile: tokenState.file,
      codexExecution: true, codexBinary: binary, authStoreFile: path.join(root,"auth.json"),
    });
    cleanupActions.push(() => bridge.close());
    const client = new Client({ name: "restart-fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { [TRUSTED_TUNNEL_HEADER]: token } },
    }));
    cleanupActions.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse((r.content as Array<{text:string}>)[0]!.text);
    };
    return { bridge, client, call };
  }
  return { root, state, alpha, beta, events, start };
}

it("saves completion without any wait and returns it after a real bridge close/reopen without executing again", async () => {
  const s = setup(); const a = await s.start();
  const args = { workspace_id: s.alpha.id, task_id: "finished", iteration: 1, instruction: "fixture request; do not claim tests passed" };
  const started = await a.call("codex_turn_start", args);
  expect(started.state).toBe("running");
  await a.client.close(); // No codex_turn_wait has ever been called.
  const journalFile = path.join(s.state, "task-journal", `${s.alpha.id}.json`);
  await expect.poll(() => {
    const snapshot = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    return snapshot.runs.find((r: {task_id:string}) => r.task_id === "finished")?.state;
  }, { timeout: 4000 }).toBe("completed");
  expect(readExecutionRecords(s.alpha.id).filter(r => r.runId === started.run_id)).toHaveLength(1);
  await a.bridge.close();
  const before = fs.readFileSync(s.events,"utf8");
  const b = await s.start();
  await b.call("workspace_select", { profile_id: "beta" });
  const status = await b.call("task_status", { workspace_id: s.alpha.id });
  expect(status.tasks).toHaveLength(1);
  expect(status.tasks[0]).toMatchObject({ execution_state:"completed", from_previous_runtime:true,
    can_resume_original_context:false, tests:null, review:"not_recorded", goal_status:"unverified" });
  const handoff = await b.call("task_resume_context", { workspace_id:s.alpha.id, task_id:"finished" });
  expect(handoff).toMatchObject({ auto_replay:false, restores_codex_conversation:false, grants_authority:false,
    current_files_verified:false, source_revision_verified:false });
  const restored = await b.call("codex_turn_wait", { workspace_id:s.alpha.id, task_id:"finished", run_id:started.run_id });
  expect(restored).toMatchObject({ state:"completed", run_id:started.run_id, recovered_from_journal:true });
  expect((await b.call("codex_turn_start", args)).run_id).toBe(started.run_id);
  expect((await b.call("codex_turn_start", {...args,instruction:"changed request"})).error).toBe("TASK_REQUEST_MISMATCH");
  expect((await b.call("codex_turn_start", {...args,iteration:2})).error).toBe("TASK_RECOVERY_REQUIRED");
  expect((await b.call("codex_turn_start", {...args,workspace_id:s.beta.id})).error).toBe("TASK_WORKSPACE_MISMATCH");
  expect(fs.readFileSync(s.events,"utf8")).toBe(before);
  expect(readExecutionRecords(s.alpha.id).filter(r => r.runId === started.run_id)).toHaveLength(1);
}, 15_000);

it("recovers a journal left by a terminated process as unknown outcome and blocks old and new work in that workspace", async () => {
  const s = setup();
  const task = { task_id:"interrupted",iteration:1,state:"running",run_id:"b".repeat(32) };
  const module = pathToFileURL(path.join(process.cwd(),"src/execution/task-journal.ts")).href;
  const seed = write(s.root,"exit-without-cleanup.mjs",`
import {TaskJournal} from ${JSON.stringify(module)};
const journal=new TaskJournal(${JSON.stringify(s.alpha.id)});
journal.begin(${JSON.stringify(s.alpha.id)},${JSON.stringify(task)},'fixture interrupted request');
process.exit(0); // Deliberately omit close: simulated abrupt owner-process termination.
`);
  const child = spawnSync(process.execPath,["--import","tsx",seed],{ cwd:process.cwd(),encoding:"utf8",timeout:5000,
    env:{...process.env,C2C_STATE_DIR:s.state} });
  expect(child.status,child.stderr).toBe(0);
  const a = await s.start();
  const status = await a.call("task_status", { workspace_id:s.alpha.id,task_id:task.task_id });
  expect(status.tasks[0]).toMatchObject({ execution_state:"interrupted",outcome_known:false,
    requires_reconciliation:true,from_previous_runtime:true,can_resume_original_context:false });
  const input = { workspace_id:s.alpha.id,task_id:task.task_id,iteration:1,instruction:"fixture interrupted request" };
  expect((await a.call("codex_turn_start",input)).error).toBe("TASK_RECOVERY_REQUIRED");
  expect((await a.call("codex_turn_wait",{...input,run_id:task.run_id})).error).toBe("TASK_RECOVERY_REQUIRED");
  expect((await a.call("codex_turn_start",{...input,task_id:"new-attempt"})).error).toBe("WORKSPACE_RECOVERY_REQUIRED");
  expect(fs.existsSync(s.events)).toBe(false);
}, 15_000);

it("requires the specific workspace for task inspection in multi-profile mode", async () => {
  const s = setup(); const a = await s.start();
  expect((await a.call("task_status")).error).toBe("WORKSPACE_ID_REQUIRED");
  expect((await a.call("task_status",{workspace_id:"0".repeat(24)})).error).toBe("WORKSPACE_ID_UNKNOWN");
  expect((await a.call("task_status",{workspace_id:s.alpha.id})).tasks).toEqual([]);
  expect(fs.existsSync(s.events)).toBe(false);
});
