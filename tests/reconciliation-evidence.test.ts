import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { fingerprintWorkspace, parseCwdRecords, isConfirmedZombieState } from "../src/execution/reconciliation-evidence.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, makeGitRepo, git, write } from "./helpers.js";
const actions: Array<()=>void>=[];
afterEach(()=>{for(const f of actions.splice(0).reverse())f();});
function setup(){
 const previous=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("reconcile-evidence");
 actions.push(()=>{cleanup(root);cleanup(state);if(previous===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=previous;});
 makeGitRepo(root);return {root,workspace:new Workspace(root)};
}
it("binds tracked contents, binary and nonignored untracked contents plus index",()=>{
 const s=setup();const a=fingerprintWorkspace(s.workspace);
 expect(fingerprintWorkspace(s.workspace).digest).toBe(a.digest);
 write(s.root,"new.bin",Buffer.from([1,2,3]).toString("binary"));
 const b=fingerprintWorkspace(s.workspace);expect(b.digest).not.toBe(a.digest);
 fs.writeFileSync(path.join(s.root,"new.bin"),Buffer.from([3,2,1]));
 const c=fingerprintWorkspace(s.workspace);expect(c.digest).not.toBe(b.digest);
 git(s.root,"add","new.bin");expect(fingerprintWorkspace(s.workspace).digest).not.toBe(c.digest);
 write(s.root,"hello.txt","changed");expect(fingerprintWorkspace(s.workspace).digest).not.toBe(a.digest);
});
it("states its ignored-file scope rather than claiming all disk was inspected",()=>{
 const s=setup();write(s.root,".gitignore","ignored.txt\n");git(s.root,"add",".gitignore");git(s.root,"commit","-m","ignore");
 const a=fingerprintWorkspace(s.workspace);write(s.root,"ignored.txt","not inspected");
 expect(fingerprintWorkspace(s.workspace).digest).toBe(a.digest);
 expect(a.fileScope).toBe("tracked-and-nonignored-untracked");
});
it("refuses protected paths rather than silently omitting them",()=>{
 const s=setup();write(s.root,".env","DO_NOT_READ=this-is-a-fixture");git(s.root,"add",".env");
 expect(()=>fingerprintWorkspace(s.workspace)).toThrow();
});
it("refuses symlinks and excessive files without claiming complete evidence",()=>{
 const s=setup();fs.symlinkSync(path.join(s.root,"hello.txt"),path.join(s.root,"linked.txt"));
 expect(()=>fingerprintWorkspace(s.workspace)).toThrow();fs.unlinkSync(path.join(s.root,"linked.txt"));
 fs.writeFileSync(path.join(s.root,"oversize.bin"),Buffer.alloc(8*1024*1024+1));
 expect(()=>fingerprintWorkspace(s.workspace)).toThrow();
});
it("parses only bounded unambiguous cwd records",()=>{
 expect([...parseCwdRecords("p12\0\nfcwd\0n/project\0\np13\0\nfcwd\0n/other\0\n")]).toEqual([[12,"/project"],[13,"/other"]]);
 for(const data of ["n/no-pid\0", "p12\0n/one\0n/two\0", "p12\0nrelative\0", "p12\0n/bad\nname\0", "unexpected\0"]){
  expect(()=>parseCwdRecords(data)).toThrow();
 }
});

it("does not treat missing, live or unknown process states as stopped",()=>{
 expect(isConfirmedZombieState("Z")).toBe(true);expect(isConfirmedZombieState("Z+")).toBe(true);
 for(const state of [undefined,"S","R","T","unknown","Z-invalid"])expect(isConfirmedZombieState(state)).toBe(false);
});
