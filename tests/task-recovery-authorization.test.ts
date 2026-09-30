import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function setup(scopes: string[]) {
  const previous = process.env.C2C_STATE_DIR, state = isolateStateDir(), root = makeTmpDir("recovery-auth");
  cleanups.push(() => { cleanup(root);cleanup(state); if(previous===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=previous; });
  const workspace = new Workspace(root), journal = new TaskJournal(workspace.id);
  cleanups.push(() => journal.close());
  const task = {task_id:"saved",iteration:1,run_id:"c".repeat(32),state:"running" as const};
  journal.begin(workspace.id,task,"fixture");journal.complete(workspace.id,{...task,state:"completed",summary:"fixture ended"});
  const getCodex = vi.fn(() => { throw new Error("Must not acquire executor during status"); });
  const server = createMcpServer({workspace,getTaskJournal:()=>journal,logger:nullLogger,getCodex});
  const [a,b] = InMemoryTransport.createLinkedPair();
  const auth: AuthInfo = {token:"reader",clientId:"reader",scopes};
  const send=a.send.bind(a);a.send=(m,o)=>send(m,{...o,authInfo:auth});
  const client = new Client({name:"recovery-read-auth",version:"1"});
  await server.connect(b);await client.connect(a);
  cleanups.push(async()=>{await client.close();await server.close();});
  return {client,workspace,journal,getCodex};
}

it("allows execution.read to inspect recovery without codex.execute or child acquisition",async()=>{
  const s=await setup(["execution.read"]);
  const tools=(await s.client.listTools()).tools;
  for(const name of ["task_status","task_resume_context"]){
    expect(tools.find(t=>t.name===name)?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
    const result=await s.client.callTool({name,arguments:{workspace_id:s.workspace.id,task_id:"saved"}});
    expect(result.isError??false).toBe(false);
    expect(JSON.stringify(result.content)).not.toMatch(/runtime_id|nonce|threadId|adminToken/);
  }
  expect(s.getCodex).not.toHaveBeenCalled();
});

it("denies inspection without execution.read",async()=>{
  const s=await setup(["workspace.read"]);
  for(const name of ["task_status","task_resume_context"]){
    const result=await s.client.callTool({name,arguments:{workspace_id:s.workspace.id,task_id:"saved"}});
    expect(result.isError).toBe(true);expect(JSON.stringify(result.content)).toContain("INSUFFICIENT_SCOPE");
  }
  expect(s.getCodex).not.toHaveBeenCalled();
});

it("reports an absent task rather than inventing a handoff",async()=>{
  const s=await setup(["execution.read"]);
  const result=await s.client.callTool({name:"task_resume_context",arguments:{workspace_id:s.workspace.id,task_id:"absent"}});
  expect(result.isError).toBe(true);expect(JSON.stringify(result.content)).toContain("TASK_NOT_FOUND");
  expect(s.getCodex).not.toHaveBeenCalled();
});
