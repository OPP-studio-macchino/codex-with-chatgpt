import { ExtensionStore } from "../src/execution/extensions.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TaskJournal, TaskJournalError } from "../src/execution/task-journal.js";
import { TaskReconciler, type OwnerDecision, type ReconciliationEvidence } from "../src/execution/task-reconciler.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { createNativeRecoveryApproval, RECOVERY_APPROVAL_SCRIPT } from "../src/execution/reconciliation-approval.js";
import { RECONCILIATION_TIMEOUT_MS } from "../src/security/owner-dialog-timeouts.js";
import { compareProcessSnapshots, incompleteProcessEvidence, type ProcessEvidence } from "../src/execution/reconciliation-processes.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { AuthStore } from "../src/auth/store.js";
import * as nativeApproval from "../src/workspace/registration-native.js";

const cleanupActions: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const f of cleanupActions.splice(0).reverse()) f(); });
const evidence: ReconciliationEvidence = { digest:"a".repeat(64), head:"b".repeat(40), fileCount:2,changedCount:1,
  processScope:"same-user-cwd",fileScope:"git-index-status-and-dirty-worktree-excluding-appledouble" };
function savedRecovery(file: string) {
  const main = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(main).not.toHaveProperty("recoveries");
  const workspaceId = path.basename(file, ".json");
  const entry = new ExtensionStore(workspaceId, "journal", file).entries().find(e => e.committed && e.payload.kind === "recovery");
  if (!entry || entry.payload.kind !== "recovery") throw new Error("Missing durable recovery fixture evidence");
  return entry.payload.recovery;
}
function setup(interrupted = false, multiple = false) {
  const previous=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("reconcile-job");
  cleanupActions.push(()=>{cleanup(root);cleanup(state);if(previous===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=previous;});
  const workspace=new Workspace(root);
  const run={ task_id:"old",iteration:1,run_id:"c".repeat(32),state:"running" as const };
  const old=new TaskJournal(workspace.id);old.begin(workspace.id,run,"prior request");
  if (interrupted) old.complete(workspace.id, {...run,state:"failed",reason:"turn_timeout"});
  if (multiple) old.begin(workspace.id,{task_id:"second",iteration:1,run_id:"d".repeat(32),state:"running"},"second request");
  old.close();
  const journal=new TaskJournal(workspace.id);cleanupActions.push(()=>journal.close());
  const inspect=vi.fn(async(_workspace?: Workspace, _signal?: AbortSignal, _historical?: unknown, _observe?: (processes: ProcessEvidence) => void)=>({...evidence}));
  const approve=vi.fn(async():Promise<OwnerDecision>=>"approved");
  const isBusy=vi.fn(()=>false);
  const identity=vi.fn(()=>"current-approved-identity");
  const manager=new TaskReconciler({journal,inspect,approve,isBusy,identity});cleanupActions.push(()=>manager.close());
  const start=()=>manager.start(workspace,run.task_id,run.run_id) as {reconciliation_id:string;state:string};
  const status=(id:string)=>manager.status(workspace.id,id) as {state:string;code?:string};
  const file=path.join(state,"task-journal",workspace.id+".json");
  return {workspace,run,journal,inspect,approve,isBusy,identity,manager,start,status,file};
}

function processEvidence(): ProcessEvidence {
  const observed_at = "2026-10-07T12:00:00.000Z";
  const snapshot = { observed_at, rows: [{ pid: 100, ppid: 0, uid: 501, state: "S", executable: "/bin/node",
    process_start_time: "2026-10-06T00:00:00.000Z" }], cwds: new Map([[100, "/fixture"]]) };
  return compareProcessSnapshots({ root: "/fixture" }, snapshot, snapshot, 501);
}
it.each(["RECONCILIATION_PROCESS_PRESENT", "RECONCILIATION_CWD_UNRESOLVED", "RECONCILIATION_SNAPSHOT_UNSTABLE"] as const)(
  "durably reloads exact %s and bounded process evidence without changing canonical outcome", async code => {
    const s = setup(true), before = fs.readFileSync(s.file, "utf8");
    const processes = code === "RECONCILIATION_PROCESS_PRESENT" ? processEvidence() : incompleteProcessEvidence(processEvidence(), code);
    s.inspect.mockRejectedValue(new TaskJournalError(code, "private argv and environment must not persist", processes));
    const job = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
    await expect.poll(() => s.manager.workspaceRecoveryStatus(s.workspace.id, job.recovery_id)).toMatchObject({ state: "blocked", code, processes });
    expect(s.approve).not.toHaveBeenCalled();
    expect(savedRecovery(s.file)).toMatchObject({ code, processes });
    expect(fs.readFileSync(s.file, "utf8")).toBe(before);
    const ledger = new ExtensionStore(s.workspace.id, "journal", s.file).file;
    const stored = fs.readFileSync(ledger, "utf8");
    for (let i = 0; i < 10; i++) s.manager.workspaceRecoveryStatus(s.workspace.id, job.recovery_id);
    expect(fs.readFileSync(ledger, "utf8")).toBe(stored); // Polls do not append inventories.
    s.manager.close(); s.journal.close();
    const reopened = new TaskJournal(s.workspace.id); cleanupActions.push(() => reopened.close());
    expect(reopened.workspaceRecoveryStatus(s.workspace.id, job.recovery_id)).toMatchObject({ state: "blocked", code,
      processes: { candidate_count: 1, evidence_hash: processes.evidence_hash, observed_at: processes.observed_at },
      quarantine: { old_outcome: "UNKNOWN", context: "NON_RESUMABLE", replay: "PROHIBITED", quiescence: processes.quiescence,
        new_unrelated_writer_admission: "BLOCKED" } });
    expect(() => reopened.checkStart(s.workspace.id, "new", 1, "new work")).toThrow();
    expect(JSON.stringify(savedRecovery(s.file))).not.toMatch(/private argv|environment/);
  });
it("bounds unknown codes and rejects forged metadata at the error boundary", async () => {
  const s = setup(true);
  s.inspect.mockRejectedValue(new TaskJournalError("RECONCILIATION_" + "SECRET".repeat(10000), "secret",
    { ...processEvidence(), argv: "secret" }));
  const j = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await expect.poll(() => s.manager.workspaceRecoveryStatus(s.workspace.id, j.recovery_id)).toMatchObject({ state: "blocked", code: "RECONCILIATION_FAILED" });
  expect(savedRecovery(s.file)).not.toHaveProperty("processes");
  expect(JSON.stringify(savedRecovery(s.file))).not.toContain("SECRET");
});
it("single-run blocked inspection also leaves durable diagnostic evidence without replay", async () => {
  const s = setup(true);
  s.inspect.mockRejectedValue(new TaskJournalError("RECONCILIATION_PROCESS_PRESENT", "blocked", processEvidence()));
  const job = s.start();
  await expect.poll(() => s.status(job.reconciliation_id)).toMatchObject({ state: "blocked", code: "RECONCILIATION_PROCESS_PRESENT" });
  expect(savedRecovery(s.file)).toMatchObject({ recovery_id: job.reconciliation_id, processes: { candidate_count: 1 } });
  expect(s.approve).not.toHaveBeenCalled();
});
it("blocks non-quiescent success-shaped evidence before any approval and preserves it", async () => {
  const s = setup(true), processes = processEvidence();
  s.inspect.mockResolvedValue({ ...evidence, processes });
  const j = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await expect.poll(() => s.manager.workspaceRecoveryStatus(s.workspace.id, j.recovery_id)).toMatchObject({ state: "blocked", code: "RECONCILIATION_PROCESS_PRESENT" });
  expect(s.approve).not.toHaveBeenCalled();
  expect(savedRecovery(s.file)).toMatchObject({ processes });
});
it("blocked inspection never replays turns, checkpoint commands, owner answers or native approvals", async () => {
  const s = setup(true);
  const start = vi.spyOn(CodexAppServer.prototype, "startTurn");
  const checkpoint = vi.spyOn(CodexAppServer.prototype, "startCheckpointTurn");
  const answer = vi.spyOn(CodexAppServer.prototype, "reply");
  const elicitation = vi.spyOn(CodexAppServer.prototype, "elicitationReply");
  const grant = vi.spyOn(AuthStore.prototype, "consumeAuthorizationCode");
  const refresh = vi.spyOn(AuthStore.prototype, "refresh");
  const native = vi.spyOn(nativeApproval, "executeFolderScript").mockRejectedValue(new Error("No native UI in fixtures"));
  const consume = vi.spyOn(s.journal, "consumeCheckpointAction");
  const resolve = vi.spyOn(s.journal, "reconcileConfirmed");
  s.inspect.mockRejectedValue(new TaskJournalError("RECONCILIATION_PROCESS_PRESENT", "blocked", processEvidence()));
  const j = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await expect.poll(() => s.manager.workspaceRecoveryStatus(s.workspace.id, j.recovery_id)).toMatchObject({ state: "blocked" });
  for (const spy of [start, checkpoint, answer, elicitation, grant, refresh, native, consume, resolve, s.approve]) expect(spy).not.toHaveBeenCalled();
});
it("QUIESCENT still needs a fresh owner decision and reinspection before admission", async () => {
  const s = setup(true);
  const snapshot = { rows: [], cwds: new Map<number, string>(), observed_at: new Date().toISOString() };
  const processes = compareProcessSnapshots({ root: "/fixture" }, snapshot, snapshot, 501);
  s.inspect.mockResolvedValue({ ...evidence, processes });
  s.approve.mockResolvedValueOnce("denied");
  const denied = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await expect.poll(() => s.manager.workspaceRecoveryStatus(s.workspace.id, denied.recovery_id)).toMatchObject({ state: "denied",
    quarantine: { quiescence: "QUIESCENT", new_unrelated_writer_admission: "BLOCKED", old_outcome: "UNKNOWN" } });
  s.approve.mockResolvedValueOnce("approved");
  const approved = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await expect.poll(() => s.manager.workspaceRecoveryStatus(s.workspace.id, approved.recovery_id)).toMatchObject({ state: "recovered",
    quarantine: { quiescence: "QUIESCENT", new_unrelated_writer_admission: "ALLOWED", old_outcome: "UNKNOWN", replay: "PROHIBITED" } });
  expect(s.approve).toHaveBeenCalledTimes(2); expect(s.inspect).toHaveBeenCalledTimes(3);
});

it("discovers the actual interrupted timeout blocker, approves once and survives restart without replay",async()=>{
  const s=setup(true);
  expect(s.journal.workspaceRecoveryStatus(s.workspace.id)).toMatchObject({state:"required",blockers:[{task_id:"old",run_id:s.run.run_id}]});
  expect(()=>s.journal.checkStart(s.workspace.id,"never-created",1,"new request")).toThrow("WORKSPACE RECOVERY REQUIRED");
  const pending=s.manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await expect.poll(()=>s.manager.workspaceRecoveryStatus(s.workspace.id,pending.recovery_id)).toMatchObject({state:"recovered"});
  expect(s.approve).toHaveBeenCalledTimes(1);
  expect(s.approve.mock.calls[0][0]).toMatchObject({workspaceRecovery:{workspaceId:s.workspace.id,records:[{run_id:s.run.run_id}]}});
  expect(s.journal.checkStart(s.workspace.id,"never-created",1,"new request")).toBeNull();
  const disk=JSON.parse(fs.readFileSync(s.file,"utf8"));
  expect(disk.runs[0]).toMatchObject({state:"failed",reason:"turn_timeout",reconciliation:{resolution:"allow_new_task_only"}});
  s.manager.close();s.journal.close();const reopened=new TaskJournal(s.workspace.id);cleanupActions.push(()=>reopened.close());
  expect(reopened.workspaceRecoveryStatus(s.workspace.id,pending.recovery_id)).toMatchObject({state:"recovered",blockers:[]});
  expect(reopened.checkStart(s.workspace.id,"never-created",1,"new request")).toBeNull();
  expect(()=>reopened.recordWorkspaceRecovery(s.workspace.id,pending.recovery_id,[],"recovered")).toThrow();
});
it.each(["branch","HEAD","dirty","staged","branch+dirty","root","repository","profile","capabilities"])("fails closed on %s drift during owner approval",async dimension=>{
  const s=setup(true);s.approve.mockImplementation(async()=>{s.identity.mockReturnValue(`changed-${dimension}`);return "approved";});
  const job=s.manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await expect.poll(()=>s.manager.workspaceRecoveryStatus(s.workspace.id,job.recovery_id)).toMatchObject({state:"blocked",code:"WORKSPACE_RECOVERY_CHANGED"});
  expect(()=>s.journal.checkStart(s.workspace.id,"new",1,"next")).toThrow("WORKSPACE RECOVERY REQUIRED");
  expect(savedRecovery(s.file)).toMatchObject({state:"blocked",code:"WORKSPACE_RECOVERY_CHANGED"});
});
it.each(["denied","timed_out","unavailable"] as OwnerDecision[])("durably records workspace owner %s without clearing the gate",async decision=>{
  const s=setup(true);s.approve.mockResolvedValue(decision);const j=s.manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await expect.poll(()=>s.manager.workspaceRecoveryStatus(s.workspace.id,j.recovery_id)).toMatchObject({state:"denied"});
  expect(savedRecovery(s.file)).toMatchObject({state:"denied"});
  expect(()=>s.journal.checkStart(s.workspace.id,"new",1,"next")).toThrow();
});
it("rejects concurrent workspace requests and late approval after cancellation",async()=>{
  const s=setup(true);let decide!:(d:OwnerDecision)=>void;s.approve.mockImplementation(()=>new Promise(resolve=>{decide=resolve;}));
  const j=s.manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await expect.poll(()=>s.manager.workspaceRecoveryStatus(s.workspace.id,j.recovery_id)).toMatchObject({state:"awaiting_owner"});
  expect(()=>s.manager.startWorkspaceRecovery(s.workspace)).toThrow("RECONCILIATION BUSY");
  s.manager.cancelPending();decide("approved");await new Promise(r=>setTimeout(r,5));
  expect(s.manager.workspaceRecoveryStatus(s.workspace.id,j.recovery_id)).toMatchObject({state:"cancelled"});
  expect(()=>s.journal.checkStart(s.workspace.id,"new",1,"next")).toThrow();
});
it("unchanged workspace with no uncertain record needs no recovery",()=>{
  const s=setup(true);s.journal.reconcileConfirmed(s.journal.reconciliationTarget(s.workspace.id,"old",s.run.run_id),"a".repeat(64),new Date().toISOString());
  expect(s.manager.startWorkspaceRecovery(s.workspace)).toMatchObject({state:"not_required",blockers:[]});
  expect(s.approve).not.toHaveBeenCalled();
});
it("accepts the proven current-live all-tracked evidence scope without weakening identity comparison",async()=>{
  const s=setup(true);s.inspect.mockResolvedValue({...evidence,fileScope:"tracked-and-nonignored-untracked"});
  const j=s.manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await expect.poll(()=>s.manager.workspaceRecoveryStatus(s.workspace.id,j.recovery_id)).toMatchObject({state:"recovered"});
});
it("atomically reconciles every discovered uncertain record while preserving both outcomes",async()=>{
  const s=setup(true,true),journal=s.journal,manager=s.manager;
  const j=manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await expect.poll(()=>manager.workspaceRecoveryStatus(s.workspace.id,j.recovery_id)).toMatchObject({state:"recovered",blockers:[]});
  const disk=JSON.parse(fs.readFileSync(s.file,"utf8"));expect(disk.runs).toHaveLength(2);
  expect(disk.runs.map((r:{state:string})=>r.state)).toEqual(["failed","running"]);expect(savedRecovery(s.file).records).toHaveLength(2);
  expect(journal.checkStart(s.workspace.id,"new",1,"new request")).toBeNull();
});
it("records timeout durably even when the approval helper never settles",async()=>{
  const s=setup(true);vi.useFakeTimers();s.approve.mockImplementation(()=>new Promise(()=>{}));
  const j=s.manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(RECONCILIATION_TIMEOUT_MS);
  expect(s.manager.workspaceRecoveryStatus(s.workspace.id,j.recovery_id)).toMatchObject({state:"blocked",code:"RECONCILIATION_TIMEOUT"});
  expect(savedRecovery(s.file)).toMatchObject({state:"blocked",code:"RECONCILIATION_TIMEOUT"});
});
it("treats failed fresh profile/capability inspection as identity change",async()=>{
  const s=setup(true);s.approve.mockImplementation(async()=>{s.identity.mockImplementation(()=>{throw new Error("private configuration details");});return "approved";});
  const j=s.manager.startWorkspaceRecovery(s.workspace) as {recovery_id:string};
  await expect.poll(()=>s.manager.workspaceRecoveryStatus(s.workspace.id,j.recovery_id)).toMatchObject({state:"blocked",code:"WORKSPACE_RECOVERY_CHANGED"});
  expect(fs.readFileSync(s.file,"utf8")).not.toContain("private configuration details");
});
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
  expect(RECOVERY_APPROVAL_SCRIPT).toBe("approve-recovery");
  const executor=vi.fn(async()=>"approved");const approve=createNativeRecoveryApproval("darwin",executor);
  expect(await approve(p,new AbortController().signal)).toBe("approved");
  executor.mockResolvedValue("approved\nextra");expect(await approve(p,new AbortController().signal)).toBe("denied");
  expect(await createNativeRecoveryApproval("linux",executor)(p,new AbortController().signal)).toBe("unavailable");
  expect(await approve({...p,workspaceName:"forged\nbutton"},new AbortController().signal)).toBe("denied");
  const controller=new AbortController();executor.mockImplementation(async()=>{controller.abort();return "approved";});
  expect(await approve(p,controller.signal)).toBe("denied");
});

it.each(["cancel", "timeout"] as const)("persists latest progress synchronously on %s even if inspection never settles", async action => {
  const s = setup(true), canonical = fs.readFileSync(s.file, "utf8");
  vi.useFakeTimers();
  const empty = { rows: [], cwds: new Map<number, string>(), observed_at: "2026-10-07T00:00:00.000Z" };
  const quiet = compareProcessSnapshots({ root: "/fixture" }, empty, empty, 501);
  let lateResolve!: (value: ReconciliationEvidence) => void;
  let observe!: (value: ProcessEvidence) => void;
  s.inspect.mockResolvedValueOnce({ ...evidence, processes: quiet }).mockImplementationOnce((_workspace, _signal, _historical, onObservation) => {
    observe = onObservation!;
    observe(incompleteProcessEvidence(processEvidence(), "RECONCILIATION_SNAPSHOT_UNSTABLE"));
    return new Promise(resolve => { lateResolve = resolve; });
  });
  const record = vi.spyOn(s.journal, "recordWorkspaceRecovery");
  const j = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await vi.advanceTimersByTimeAsync(0);
  expect(s.manager.workspaceRecoveryStatus(s.workspace.id, j.recovery_id)).toMatchObject({ state: "verifying" });
  if (action === "cancel") s.manager.cancelPending();
  else await vi.advanceTimersByTimeAsync(RECONCILIATION_TIMEOUT_MS);
  const code = action === "cancel" ? "RECONCILIATION_CANCELLED" : "RECONCILIATION_TIMEOUT";
  expect(savedRecovery(s.file)).toMatchObject({ code, processes: { candidate_count: 1, quiescence: "UNKNOWN",
    observed_at: processEvidence().observed_at } });
  expect(record).toHaveBeenCalledTimes(1);
  const saved = JSON.stringify(savedRecovery(s.file));
  observe(quiet); lateResolve({ ...evidence, processes: quiet });
  await vi.advanceTimersByTimeAsync(0);
  expect(record).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(savedRecovery(s.file))).toBe(saved);
  expect(fs.readFileSync(s.file, "utf8")).toBe(canonical);
  expect(s.approve).toHaveBeenCalledTimes(1); // fixture decision only; never a second decision or replay
  s.manager.close(); s.journal.close();
  const reopened = new TaskJournal(s.workspace.id); cleanupActions.push(() => reopened.close());
  expect(reopened.workspaceRecoveryStatus(s.workspace.id, j.recovery_id)).toMatchObject({ code,
    processes: { candidate_count: 1, quiescence: "UNKNOWN" },
    quarantine: { old_outcome: "UNKNOWN", replay: "PROHIBITED", new_unrelated_writer_admission: "BLOCKED" } });
  expect(() => reopened.checkStart(s.workspace.id, "new", 1, "new work")).toThrow();
});

it("cancel before the first inspection settles persists partial evidence without any approval", async () => {
  const s = setup(true);
  s.inspect.mockImplementationOnce((_workspace, _signal, _historical, observe) => {
    observe!(processEvidence());
    return new Promise(() => {});
  });
  const j = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await new Promise(resolve => setImmediate(resolve));
  s.manager.cancelPending();
  expect(savedRecovery(s.file)).toMatchObject({ code: "RECONCILIATION_CANCELLED",
    processes: { candidate_count: 1, quiescence: "UNKNOWN" } });
  expect(s.approve).not.toHaveBeenCalled();
  expect(s.manager.workspaceRecoveryStatus(s.workspace.id, j.recovery_id)).toMatchObject({
    quarantine: { new_unrelated_writer_admission: "BLOCKED" } });
});

it("persists post-approval mismatch diagnostics across restart without admitting a writer or reusing approval", async () => {
  const s = setup(true), before = fs.readFileSync(s.file, "utf8");
  const observed_at = new Date().toISOString();
  const empty = { rows: [], cwds: new Map<number, string>(), observed_at };
  const next = { observed_at, rows: [{ pid: 100, ppid: 0, uid: 501, state: "S", executable: "/bin/node",
    process_start_time: "2026-10-06T00:00:00.000Z" }], cwds: new Map([[100, "/outside"]]) };
  const stable = compareProcessSnapshots({ root: "/fixture" }, empty, empty, 501);
  const unstable = compareProcessSnapshots({ root: "/fixture" }, empty, next, 501);
  s.inspect.mockResolvedValueOnce({ ...evidence, processes: stable } as ReconciliationEvidence)
    .mockRejectedValueOnce(new TaskJournalError("RECONCILIATION_SNAPSHOT_UNSTABLE", "discard private error", unstable));
  const job = s.manager.startWorkspaceRecovery(s.workspace) as { recovery_id: string };
  await expect.poll(() => s.manager.workspaceRecoveryStatus(s.workspace.id, job.recovery_id)).toMatchObject({
    state: "blocked", code: "RECONCILIATION_SNAPSHOT_UNSTABLE", processes: unstable,
  });
  expect(s.approve).toHaveBeenCalledTimes(1);
  expect(s.inspect).toHaveBeenCalledTimes(2);
  expect(savedRecovery(s.file)).toMatchObject({ processes: { snapshot_diagnostics: unstable.snapshot_diagnostics } });
  expect(fs.readFileSync(s.file, "utf8")).toBe(before);
  s.manager.close(); s.journal.close();
  const reopened = new TaskJournal(s.workspace.id); cleanupActions.push(() => reopened.close());
  expect(reopened.workspaceRecoveryStatus(s.workspace.id, job.recovery_id)).toMatchObject({
    state: "blocked", code: "RECONCILIATION_SNAPSHOT_UNSTABLE",
    processes: { snapshot_diagnostics: unstable.snapshot_diagnostics },
    quarantine: { old_outcome: "UNKNOWN", context: "NON_RESUMABLE", replay: "PROHIBITED", new_unrelated_writer_admission: "BLOCKED" },
  });
  expect(() => reopened.checkStart(s.workspace.id, "new", 1, "new work")).toThrow("WORKSPACE RECOVERY REQUIRED");
  expect(s.approve).toHaveBeenCalledTimes(1);
});
