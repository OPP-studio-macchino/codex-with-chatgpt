import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { fingerprintWorkspace, parseCwdRecords, parseSingleCwdRecord, isConfirmedZombieState } from "../src/execution/reconciliation-evidence.js";
import { Workspace } from "../src/workspace/manager.js";
import { gitStatus, GitReadError } from "../src/workspace/git.js";
import { cleanup, isolateStateDir, makeTmpDir, makeGitRepo, git, write } from "./helpers.js";
const actions: Array<()=>void>=[];
afterEach(()=>{for(const f of actions.splice(0).reverse())f();});
function setup(){
 const previous=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("reconcile-evidence");
 actions.push(()=>{cleanup(root);cleanup(state);if(previous===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=previous;});
 makeGitRepo(root);return {root,workspace:new Workspace(root)};
}
it("binds dirty tracked/untracked contents plus index and full status",()=>{
 const s=setup();const a=fingerprintWorkspace(s.workspace);
 expect(fingerprintWorkspace(s.workspace).digest).toBe(a.digest);
 write(s.root,"new.bin",Buffer.from([1,2,3]).toString("binary"));
 const b=fingerprintWorkspace(s.workspace);expect(b.digest).not.toBe(a.digest);
 fs.writeFileSync(path.join(s.root,"new.bin"),Buffer.from([3,2,1]));
 const c=fingerprintWorkspace(s.workspace);expect(c.digest).not.toBe(b.digest);
 git(s.root,"add","new.bin");expect(fingerprintWorkspace(s.workspace).digest).not.toBe(c.digest);
 write(s.root,"hello.txt","changed");expect(fingerprintWorkspace(s.workspace).digest).not.toBe(a.digest);
});
it("binds branch changes even at identical HEAD and allows dirty/staged evidence",()=>{
 const s=setup(),before=fingerprintWorkspace(s.workspace);
 git(s.root,"branch","continuity-fixture");git(s.root,"symbolic-ref","HEAD","refs/heads/continuity-fixture");
 const changed=fingerprintWorkspace(s.workspace);
 expect(changed.head).toBe(before.head);expect(changed.digest).not.toBe(before.digest);expect(changed.branch).toBe("continuity-fixture");
 write(s.root,"hello.txt","dirty permitted");git(s.root,"add","hello.txt");
 const staged=fingerprintWorkspace(s.workspace);expect(staged.staged).toBe(true);expect(staged.changedCount).toBe(1);
});
it("binds in-place linked-worktree pointer changes with identical branch, HEAD and worktree",()=>{
 const s=setup(),linked=makeTmpDir("linked-recovery");actions.push(()=>cleanup(linked));
 git(s.root,"worktree","add","--detach",linked,"HEAD");
 const workspace=new Workspace(linked),before=fingerprintWorkspace(workspace);
 const marker=path.join(linked,".git"),pointer=fs.readFileSync(marker,"utf8");
 const original=pointer.trim().slice("gitdir: ".length),replacement=original+"-continuity";
 fs.cpSync(original,replacement,{recursive:true});
 fs.writeFileSync(marker,`gitdir: ${replacement}\n`);
 const after=fingerprintWorkspace(workspace);
 expect(after.head).toBe(before.head);expect(after.branch).toBe(before.branch);expect(after.changedCount).toBe(before.changedCount);
 expect(after.digest).not.toBe(before.digest);
});
it("states its ignored-file scope rather than claiming all disk was inspected",()=>{
 const s=setup();write(s.root,".gitignore","ignored.txt\n");git(s.root,"add",".gitignore");git(s.root,"commit","-m","ignore");
 const a=fingerprintWorkspace(s.workspace);write(s.root,"ignored.txt","not inspected");
 expect(fingerprintWorkspace(s.workspace).digest).toBe(a.digest);
 expect(a.fileScope).toBe("git-index-status-and-dirty-worktree-excluding-appledouble");
});
it("refuses protected paths rather than silently omitting them",()=>{
 const s=setup();write(s.root,".env","DO_NOT_READ=this-is-a-fixture");git(s.root,"add",".env");
 expect(()=>fingerprintWorkspace(s.workspace)).toThrow();
});
it("excludes only untracked AppleDouble OS metadata from evidence scope",()=>{
 const s=setup();const before=fingerprintWorkspace(s.workspace);
 write(s.root,"._finder-sidecar","metadata");
 const after=fingerprintWorkspace(s.workspace);
 expect(after.digest).toBe(before.digest);
 expect(after.changedCount).toBe(before.changedCount);
 expect(after.fileScope).toBe("git-index-status-and-dirty-worktree-excluding-appledouble");
 git(s.root,"add","-f","._finder-sidecar");
 expect(()=>fingerprintWorkspace(s.workspace)).toThrow();
});
it("refuses symlinks and excessive files without claiming complete evidence",()=>{
 const s=setup();fs.symlinkSync(path.join(s.root,"hello.txt"),path.join(s.root,"linked.txt"));
 expect(()=>fingerprintWorkspace(s.workspace)).toThrow();fs.unlinkSync(path.join(s.root,"linked.txt"));
 fs.writeFileSync(path.join(s.root,"oversize.bin"),Buffer.alloc(8*1024*1024+1));
 expect(()=>fingerprintWorkspace(s.workspace)).toThrowError(expect.objectContaining({code:"RECONCILIATION_FILE_SCOPE_LIMIT"}));
});
it("does not confuse the 500-entry status presentation cap with reconciliation scope",()=>{
 const s=setup();const before=fingerprintWorkspace(s.workspace);
 for(let index=0;index<510;index++) write(s.root,`bulk-${String(index).padStart(3,"0")}.txt`,"x\\n");
 const evidence=fingerprintWorkspace(s.workspace);
 expect(evidence.changedCount-before.changedCount).toBe(510);
 expect(evidence.fileCount-before.fileCount).toBe(510);
});
it("accepts a staged deletion with an untracked replacement at the same path",()=>{
 const s=setup();
 git(s.root,"rm","hello.txt");
 write(s.root,"hello.txt","replacement outside index\\n");
 const evidence=fingerprintWorkspace(s.workspace);
 expect(evidence.changedCount).toBeGreaterThanOrEqual(2);
 expect(evidence.fileCount).toBeGreaterThanOrEqual(1);
 expect(evidence.fileScope).toBe("git-index-status-and-dirty-worktree-excluding-appledouble");
});
it("still rejects an unmerged conflict",()=>{
 const s=setup();
 git(s.root,"checkout","-b","conflict-side");
 write(s.root,"hello.txt","conflict side\\n");git(s.root,"add","hello.txt");git(s.root,"commit","-m","conflict side");
 git(s.root,"checkout","main");
 write(s.root,"hello.txt","main side\\n");git(s.root,"add","hello.txt");git(s.root,"commit","-m","main side");
 expect(()=>git(s.root,"merge","conflict-side")).toThrow();
 expect(gitStatus(s.root).conflicted).toContain("hello.txt");
 const started=performance.now();
 let failure: unknown;
 try { fingerprintWorkspace(s.workspace); } catch(error) { failure=error; }
 const code=failure && typeof failure==="object" && "code" in failure ? failure.code : undefined;
 // Retain the actual typed failure without exposing repository paths/content.
 const diagnostic={code,elapsed_ms:performance.now()-started,
  ...(failure instanceof GitReadError ? {stage:failure.stage,reason:failure.reason,snapshot_ms:failure.snapshotMs} : {})};
 expect(failure,JSON.stringify(diagnostic)).toEqual(expect.objectContaining({code:"RECONCILIATION_CONFLICT_PRESENT"}));
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


it("strictly validates one refreshed cwd record for the requested pid",()=>{
 expect(parseSingleCwdRecord("p42\0\nfcwd\0n/project\0\n",42)).toBe("/project");
 expect(parseSingleCwdRecord("p42\0fcwd\0n/project\0",42)).toBe("/project");
 for(const raw of [
  "p41\0\nfcwd\0n/project\0\n",
  "p42\0n/project\0",
  "p42\0\nfcwd\0",
  "p42\0\nfcwd\0n/project\0\np43\0",
  "p42\0\nfcwd\0n/project\0n/other\0",
  "p42\0\nfcwd\0nrelative\0",
  "p42\0\nfcwd\0n/project\0unexpected\0",
  "p42\0\nfcwd\0n/project",
  "p42\0\0\nfcwd\0n/project\0\n",
  "p42\0\nfcwd\0n/project\0\0\n",
  "p42\0\nfcwd\0\nn/project\0\n",
  "p42\0\nfcwd\0n/project\0\n\n",
  "p042\0\nfcwd\0n/project\0\n",
  "p42\0\nfcwd\0n/bad\nname\0\n",
  "p42\0\nfcwd\0fcwd\0n/project\0\n",
  "p42\0\nfcwd\0n/"+"x".repeat(64*1024)+"\0\n",
 ]) expect(()=>parseSingleCwdRecord(raw,42)).toThrow();
 for(const pid of [0,-1,42.5,Number.MAX_SAFE_INTEGER+1]) {
  expect(()=>parseSingleCwdRecord("p42\0\nfcwd\0n/project\0\n",pid)).toThrow();
 }
});
