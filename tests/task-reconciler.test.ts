import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TaskJournal, TaskJournalError } from "../src/execution/task-journal.js";
import { TaskReconciler, type OwnerDecision, type ReconciliationEvidence } from "../src/execution/task-reconciler.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { createNativeRecoveryApproval, RECOVERY_APPROVAL_SCRIPT } from "../src/execution/reconciliation-approval.js";

const cleanupActions: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of cleanupActions.splice(0).reverse()) f(); });
const evidence: ReconciliationEvidence = { digest:"a".repeat(64), head:"b".repeat(40), fileCount:2,changedCount:1,
  processScope:"same-user-cwd",fileScope:"tracked-and-nonignored-untracked" };
function setup() {
  const previous=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("reconcile-job");
  cleanupActions.push(()=>{cleanup(root);cleanup(state);if(previous===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=previous;});
  const workspace=new Workspace(root);
  const run={ task_id:"old",iteration:1,run_id:"c".repeat(32),state:"running" as const };
  const old=new TaskJournal(workspace.id);old.begin(workspace.id,run,"prior request");old.close();
  const journal=new TaskJournal(workspace.id);cleanupActions.push(()=>journal.close());
  const inspect=vi.fn(async()=>({...evidence}));
  const approve=vi.fn(async():Promise<OwnerDecision>=>"approved");
  const isBusy=vi.fn(()=>false);
  const manager=new TaskReconciler({journal,inspect,approve,isBusy});cleanupActions.push(()=>manager.close());
  const start=()=>manager.start(workspace,run.task_id,run.run_id) as {reconciliation_id:string;state:string};
  const status=(id:string)=>manager.status(workspace.id,id) as {state:string;code?:string};
  const file=path.join(state,"task-journal",workspace.id+".json");
  return {workspace,run,journal,inspect,approve,isBusy,manager,start,status,file};
}
it("returns immediately, rechecks after approval, preserves uncertainty and never replays",async()=>{
  const s=setup();let decide!:(d:OwnerDecision)=>void;
  s.approve.mockImplementation(()=>new Promise(resolve=>{decide=resolve;}));
  const pending=s.start();expect(pending.state).toBe("inspecting");
  await expect.poll(()=>s.status(pending.reconciliation_id).state).toBe("awaiting_owner");
  expect(s.start().reconciliation_id).toBe(pending.reconciliation_id);
  expect(()=>s.journal.checkStart(s.workspace.id,"new",1,"next")).toThrow("WORKSPACE RECOVERY REQUIRED");
  decide("approved");
  await expect.poll(()=>s.status(pending.reconciliation_id).state).toBe("reconciled");
  expect(s.inspect).toHaveBeenCalledTimes(2);expect(s.approve).toHaveBeenCalledTimes(1);
  expect(s.journal.checkStart(s.workspace.id,"new",1,"next")).toBeNull();
  expect(()=>s.journal.checkStart(s.workspace.id,"old",1,"prior request")).toThrow("TASK RECOVERY REQUIRED");
  const saved=JSON.parse(fs.readFileSync(s.file,"utf8")).runs[0];
  expect(saved.state).toBe("running");expect(saved.reconciliation.resolution).toBe("allow_new_task_only");
  const before=fs.readFileSync(s.file,"utf8");s.status(pending.reconciliation_id);s.status(pending.reconciliation_id);
  expect(fs.readFileSync(s.file,"utf8")).toBe(before);expect(()=>s.start()).toThrow();
});
it.each(["denied","timed_out","unavailable"] as OwnerDecision[])("does not unlock after %s",async decision=>{
  const s=setup();s.approve.mockResolvedValue(decision);const before=fs.readFileSync(s.file,"utf8");const j=s.start();
  await expect.poll(()=>s.status(j.reconciliation_id).state).toBe("denied");
  expect(s.inspect).toHaveBeenCalledTimes(1);expect(fs.readFileSync(s.file,"utf8")).toBe(before);
});
it("burns a decision when the reviewed contents change",async()=>{
  const s=setup();s.inspect.mockResolvedValueOnce(evidence).mockResolvedValueOnce({...evidence,digest:"d".repeat(64)});
  const j=s.start();await expect.poll(()=>s.status(j.reconciliation_id).state).toBe("blocked");
  expect(s.status(j.reconciliation_id).code).toBe("RECONCILIATION_EVIDENCE_CHANGED");
  expect(()=>s.journal.checkStart(s.workspace.id,"new",1,"next")).toThrow("WORKSPACE RECOVERY REQUIRED");
});
it.each(["close","cancelPending"] as const)("%s invalidates a pending native decision",async action=>{
  const s=setup();let decide!:(d:OwnerDecision)=>void;
  s.approve.mockImplementation(()=>new Promise(resolve=>{decide=resolve;}));const j=s.start();
  await expect.poll(()=>s.status(j.reconciliation_id).state).toBe("awaiting_owner");
  s.manager[action]();decide("approved");await new Promise(r=>setTimeout(r,5));
  expect(s.status(j.reconciliation_id).state).toBe("cancelled");expect(s.inspect).toHaveBeenCalledTimes(1);
  expect(()=>s.journal.checkStart(s.workspace.id,"new",1,"next")).toThrow();
});
it("blocks residual-process inspection failure before opening a dialog",async()=>{
  const s=setup();s.inspect.mockRejectedValue(new TaskJournalError("RECONCILIATION_PROCESS_PRESENT","Residual process"));
  const j=s.start();await expect.poll(()=>s.status(j.reconciliation_id).state).toBe("blocked");
  expect(s.approve).not.toHaveBeenCalled();
});
it("rechecks current execution before applying any owner decision",async()=>{
  const s=setup();s.approve.mockImplementation(async()=>{s.isBusy.mockReturnValue(true);return "approved";});
  const j=s.start();await expect.poll(()=>s.status(j.reconciliation_id).state).toBe("blocked");expect(s.status(j.reconciliation_id).code).toBe("WORKSPACE_BUSY");
});
it("cannot query another workspace's request",()=>{
  const s=setup();const j=s.start();expect(()=>s.manager.status("f".repeat(24),j.reconciliation_id)).toThrow("RECONCILIATION NOT FOUND");
});
it("native approval uses a fixed default-deny script and rejects unknown/late answers",async()=>{
  const p={workspaceName:"fixture",workspaceRoot:"/fixture",taskId:"old",runId:"c".repeat(32),evidence};
  expect(RECOVERY_APPROVAL_SCRIPT).toContain('default button "拒否"');expect(RECOVERY_APPROVAL_SCRIPT).toContain('giving up after 30');
  const executor=vi.fn(async()=>"approved");const approve=createNativeRecoveryApproval("darwin",executor);
  expect(await approve(p,new AbortController().signal)).toBe("approved");
  executor.mockResolvedValue("approved\nextra");expect(await approve(p,new AbortController().signal)).toBe("denied");
  expect(await createNativeRecoveryApproval("linux",executor)(p,new AbortController().signal)).toBe("unavailable");
  expect(await approve({...p,workspaceName:"forged\nbutton"},new AbortController().signal)).toBe("denied");
  const controller=new AbortController();executor.mockImplementation(async()=>{controller.abort();return "approved";});
  expect(await approve(p,controller.signal)).toBe("denied");
});
