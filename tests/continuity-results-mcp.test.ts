import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { cleanup, isolateStateDir, makeTmpDir, makeGitRepo, write } from "./helpers.js";
// Source tests use the same isolated compiled worker as the real-worker suite.
// No live dist replacement and no mocked Git result or deadline.
vi.mock("node:worker_threads", async original => {
 const real=await original<typeof import("node:worker_threads")>();
 return {...real,Worker:class extends real.Worker {
  constructor(url:URL,options:import("node:worker_threads").WorkerOptions){
   const build=process.env.C2C_RECONCILIATION_TEST_BUILD;
   super(build&&url.pathname.endsWith("/workspace/git-read-worker.js")?pathToFileURL(path.resolve(build,"workspace/git-read-worker.js")):url,options);
  }
 }};
});
const actions:Array<()=>unknown>=[];
afterEach(async()=>{for(const a of actions.splice(0).reverse())await a();});
it("retrieves bounded path-filtered results and exposes invalid present metadata as a typed public error",async()=>{
 const old=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("continuity-results");
 actions.push(()=>{cleanup(root);cleanup(state);if(old===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=old;});
 makeGitRepo(root);const workspace=new Workspace(root);
 write(root,"hello.txt",Array.from({length:3000},(_,i)=>`bounded line ${i}\n`).join(""));
 const server=createMcpServer({workspace,logger:nullLogger});const [a,b]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:"continuity-results",version:"1"});await server.connect(b);await client.connect(a);
 actions.push(async()=>{await client.close();await server.close();});
 const call=async(name:string,args:Record<string,unknown>={})=>{
  const result=await client.callTool({name,arguments:args});
  return {error:result.isError===true,body:JSON.parse((result.content as Array<{text:string}>)[0].text)};
 };
 const status=await call("git_status");expect(status.error,JSON.stringify(status.body)).toBe(false);expect(status.body.isRepo).toBe(true);
 const diff=await call("git_diff",{path:"hello.txt",max_bytes:1024});
 expect(diff.error).toBe(false);expect(diff.body.hasMore).toBe(true);expect(diff.body.nextOffset).toBeGreaterThan(0);
 expect(Buffer.byteLength(diff.body.diff)).toBeLessThanOrEqual(1024);
 appendExecutionRecord(workspace.id,{taskId:"legacy",iteration:1,changedFiles:null,tests:null,exitStatus:"blocked",timestamp:new Date().toISOString()});
 const file=path.join(state,"executions",`${workspace.id}.jsonl`);fs.appendFileSync(file,"null\n{broken\n");
 for(const limit of [3,10,50]){const r=await call("execution_summary",{limit});expect(r.error).toBe(false);expect(JSON.stringify(r.body)).not.toContain("INTERNAL_ERROR");}
 expect((await call("test_status")).error).toBe(false);
 fs.renameSync(path.join(root,".git"),path.join(root,"saved-metadata"));write(root,".git","gitdir: /unverified-fixture\n");
 for(const tool of ["git_status","git_diff"]){const result=await call(tool);expect(result.error).toBe(true);expect(result.body.error).toBe("GIT_READ_FAILED");expect(result.body.message).toContain("layout: unverified");}
});
