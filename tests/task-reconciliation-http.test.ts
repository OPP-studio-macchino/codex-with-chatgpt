import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import type { OwnerDecision, ReconciliationEvidence } from "../src/execution/task-reconciler.js";
import { ensureTrustedTunnelToken, TRUSTED_TUNNEL_HEADER } from "../src/auth/trusted-tunnel.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const actions:Array<()=>unknown>=[];
afterEach(async()=>{for(const f of actions.splice(0).reverse())await f();});
async function setup(){
 const previous=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("owner-reconcile-http");
 actions.push(()=>{cleanup(root);cleanup(state);if(previous===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=previous;});
 for(const name of ["alpha","beta"])write(root,name+"/marker.txt",name);
 const alpha=new Workspace(path.join(root,"alpha")),beta=new Workspace(path.join(root,"beta"));
 const config=write(root,"profiles.json",JSON.stringify({version:1,defaultProfileId:"alpha",profiles:[{id:"alpha",path:alpha.root},{id:"beta",path:beta.root}]}));
 fs.chmodSync(config,0o600);
 const run={task_id:"interrupted",iteration:1,run_id:"a".repeat(32),state:"running" as const};
 const seed=new TaskJournal(alpha.id);seed.begin(alpha.id,run,"original request");seed.close();
 const log=path.join(root,"child-events.txt");
 const binary=write(root,"fake.mjs",`#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)},'spawn\\n');
let b='',t=0,u=0;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;while(b.includes('\\n')){
 const i=b.indexOf('\\n'),l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'t'+(++t)}}});
 if(m.method==='turn/start'){
  fs.appendFileSync(${JSON.stringify(log)},'turn\\n');const id='u'+(++u),threadId=m.params.threadId;
  send({id:m.id,result:{turn:{id,status:'inProgress',items:[],error:null}}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',items:[],error:null}}}),30);
 }
}});
`);fs.chmodSync(binary,0o700);
 const tokenInfo=ensureTrustedTunnelToken(alpha.id),token=fs.readFileSync(tokenInfo.file,"utf8").trim();
 const evidence:ReconciliationEvidence={digest:"b".repeat(64),head:"c".repeat(40),fileCount:2,changedCount:1,processScope:"same-user-cwd",fileScope:"tracked-and-nonignored-untracked"};
 const inspect=vi.fn(async()=>({...evidence}));let decision!:(d:OwnerDecision)=>void;
 const approve=vi.fn(()=>new Promise<OwnerDecision>(resolve=>{decision=resolve;}));
 async function connect(){
  const bridge=await startBridge({workspaceRoot:alpha.root,workspaceProfilesFile:config,port:0,persistRuntime:false,
   trustedTunnelTokenFile:tokenInfo.file,codexExecution:true,codexBinary:binary,authStoreFile:path.join(root,"auth.json"),
   reconciliationInspect:inspect,reconciliationApprove:approve});actions.push(()=>bridge.close());
  const client=new Client({name:"reconcile-test",version:"1"});
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl()+"/mcp"),{requestInit:{headers:{[TRUSTED_TUNNEL_HEADER]:token}}}));
  actions.push(()=>client.close());
  const call=async(name:string,args:Record<string,unknown>={})=>{
   const r=await client.callTool({name,arguments:args});return JSON.parse((r.content as {text:string}[])[0]!.text);
  };
  return {bridge,client,call};
 }
 return {alpha,beta,run,inspect,approve,decide:(d:OwnerDecision)=>decision(d),connect,log,state};
}
it("owner confirmation unlocks only new work, without replay; survives bridge restart",async()=>{
 const s=await setup(),a=await s.connect();
 const args={workspace_id:s.alpha.id,task_id:s.run.task_id,run_id:s.run.run_id};
 const pending=await a.call("task_reconcile_start",args);expect(pending.state).toBe("inspecting");
 const status=()=>a.call("task_reconcile_status",{workspace_id:s.alpha.id,reconciliation_id:pending.reconciliation_id});
 await expect.poll(async()=>(await status()).state).toBe("awaiting_owner");
 await a.call("workspace_select",{profile_id:"beta"});
 const newArgs={workspace_id:s.alpha.id,task_id:"fresh",iteration:1,instruction:"new request after review"};
 expect((await a.call("codex_turn_start",newArgs)).error).toBe("WORKSPACE_RECOVERY_REQUIRED");
 expect(fs.existsSync(s.log)).toBe(false);
 s.decide("approved");await expect.poll(async()=>(await status()).state).toBe("reconciled");
 expect(s.inspect).toHaveBeenCalledTimes(2);expect(s.approve).toHaveBeenCalledTimes(1);expect(fs.existsSync(s.log)).toBe(false);
 expect((await a.call("codex_turn_start",{...newArgs,task_id:"interrupted",instruction:"original request"})).error).toBe("TASK_RECOVERY_REQUIRED");
 const original=(await a.call("task_status",{workspace_id:s.alpha.id,task_id:"interrupted"})).tasks[0];
 expect(original).toMatchObject({execution_state:"interrupted",outcome_known:false,requires_reconciliation:false,goal_status:"unverified"});
 await a.client.close();await a.bridge.close();
 const b=await s.connect();const started=await b.call("codex_turn_start",newArgs);expect(started.state).toBe("running");
 await expect.poll(async()=> (await b.call("codex_turn_wait",{...newArgs,run_id:started.run_id})).state).toBe("completed");
 expect(fs.readFileSync(s.log,"utf8")).toBe("spawn\nturn\n");
},15000);
it("a caller-supplied approved flag never replaces local owner approval",async()=>{
 const s=await setup(),a=await s.connect();
 const pending=await a.call("task_reconcile_start",{workspace_id:s.alpha.id,task_id:s.run.task_id,run_id:s.run.run_id,approved:true});
 const status=()=>a.call("task_reconcile_status",{workspace_id:s.alpha.id,reconciliation_id:pending.reconciliation_id});
 await expect.poll(async()=>(await status()).state).toBe("awaiting_owner");s.decide("denied");
 await expect.poll(async()=>(await status()).state).toBe("denied");
 expect((await a.call("codex_turn_start",{workspace_id:s.alpha.id,task_id:"fresh",iteration:1,instruction:"next"})).error).toBe("WORKSPACE_RECOVERY_REQUIRED");
 expect(fs.existsSync(s.log)).toBe(false);
});
it("evidence changes invalidate approval, and cross-workspace status is rejected",async()=>{
 const s=await setup(),a=await s.connect();
 const pending=await a.call("task_reconcile_start",{workspace_id:s.alpha.id,task_id:s.run.task_id,run_id:s.run.run_id});
 const status=()=>a.call("task_reconcile_status",{workspace_id:s.alpha.id,reconciliation_id:pending.reconciliation_id});
 await expect.poll(async()=>(await status()).state).toBe("awaiting_owner");
 expect((await a.call("task_reconcile_status",{workspace_id:s.beta.id,reconciliation_id:pending.reconciliation_id})).error).toBe("RECONCILIATION_NOT_FOUND");
 s.inspect.mockResolvedValue({...await s.inspect.mock.results[0]!.value,digest:"d".repeat(64)});s.decide("approved");
 await expect.poll(async()=>(await status()).code).toBe("RECONCILIATION_EVIDENCE_CHANGED");
 expect(fs.existsSync(s.log)).toBe(false);
});
