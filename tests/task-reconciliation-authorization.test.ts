import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import type { TaskReconciler } from "../src/execution/task-reconciler.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
const actions:Array<()=>unknown>=[];
afterEach(async()=>{for(const f of actions.splice(0).reverse())await f();});
async function connect(auth:AuthInfo){
 const previous=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("reconcile-auth");
 actions.push(()=>{cleanup(root);cleanup(state);if(previous===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=previous;});
 const workspace=new Workspace(root),start=vi.fn(()=>({state:"inspecting"})),status=vi.fn(()=>({state:"awaiting_owner"}));
 const server=createMcpServer({workspace,logger:nullLogger,getTaskReconciler:()=>({start,status,startWorkspaceRecovery:start,workspaceRecoveryStatus:status} as unknown as TaskReconciler)});
 const [a,b]=InMemoryTransport.createLinkedPair(),send=a.send.bind(a);a.send=(m,o)=>send(m,{...o,authInfo:auth});
 const client=new Client({name:"reconcile-auth",version:"1"});await server.connect(b);await client.connect(a);
 actions.push(async()=>{await client.close();await server.close();});
 const call=async(name:string)=>client.callTool({name,arguments:name.startsWith("workspace_recovery")?{workspace_id:workspace.id}:{workspace_id:workspace.id,task_id:"old",run_id:"a".repeat(32),reconciliation_id:"b".repeat(32)}});
 return {client,start,status,call,workspace};
}
const trusted={token:"trusted-tunnel",clientId:"openai-secure-tunnel",scopes:["codex.execute","execution.read"]};
it("requires existing trusted-tunnel identity even with execution scopes",async()=>{
 const s=await connect({...trusted,token:"oauth",clientId:"oauth"});
 for(const name of ["task_reconcile_start","task_reconcile_status","workspace_recovery_start","workspace_recovery_status"]){const r=await s.call(name);expect(r.isError).toBe(true);expect(JSON.stringify(r.content)).toContain("TRUSTED_TUNNEL_REQUIRED");}
 expect(s.start).not.toHaveBeenCalled();expect(s.status).not.toHaveBeenCalled();
});
it("scope failures precede inspection or a local dialog",async()=>{
 const s=await connect({...trusted,scopes:[]});
 for(const name of ["task_reconcile_start","task_reconcile_status","workspace_recovery_start","workspace_recovery_status"]){const r=await s.call(name);expect(r.isError).toBe(true);expect(JSON.stringify(r.content)).toContain("INSUFFICIENT_SCOPE");}
 expect(s.start).not.toHaveBeenCalled();expect(s.status).not.toHaveBeenCalled();
});
it("workspace recovery requires the exact approved ID and rejects caller paths",async()=>{
 const s=await connect(trusted);
 const bad=await s.client.callTool({name:"workspace_recovery_start",arguments:{workspace_id:s.workspace.id,path:"/arbitrary"}});
 expect(bad.isError).toBe(true);expect(s.start).not.toHaveBeenCalled();
 const unknown=await s.client.callTool({name:"workspace_recovery_start",arguments:{workspace_id:"f".repeat(24)}});
 expect(unknown.isError).toBe(true);expect(JSON.stringify(unknown.content)).toContain("WORKSPACE_ID_UNKNOWN");
 const tools=(await s.client.listTools()).tools,start=tools.find(t=>t.name==="workspace_recovery_start")!;
 expect(Object.keys(start.inputSchema.properties!)).toEqual(["workspace_id"]);expect(start.inputSchema.additionalProperties).toBe(false);
 const pending=await s.call("workspace_recovery_start");expect(pending.isError??false).toBe(false);
 const body=JSON.parse((pending.content as Array<{text:string}>)[0]!.text);
 expect(body.timeout_shield).toMatchObject({yield_required:true,resume_tool:"workspace_recovery_status"});
});
it("advertises exact ID-only inputs and does not give status mutation authority",async()=>{
 const s=await connect(trusted),tools=(await s.client.listTools()).tools;
 const start=tools.find(t=>t.name==="task_reconcile_start")!,status=tools.find(t=>t.name==="task_reconcile_status")!;
 expect(Object.keys(start.inputSchema.properties!)).toEqual(["workspace_id","task_id","run_id"]);
 expect(start.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true});
 expect(status.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
 const pending=await s.call("task_reconcile_status");expect(pending.isError??false).toBe(false);
 const body=JSON.parse((pending.content as Array<{text:string}>)[0]!.text);
 expect(body).toMatchObject({state:"awaiting_owner",timeout_shield:{yield_required:true,reason:"owner_interaction_pending",background_continues:true,resume_tool:"task_reconcile_status",do_not_poll_again_in_same_response:true}});
 expect(s.start).not.toHaveBeenCalled();
});
