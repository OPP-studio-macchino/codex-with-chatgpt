import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { approvalDiagnostic, approvalDiagnosticSchema } from "../src/codex/approval-diagnostic.js";
import { validateLocalApproval } from "../src/codex/local-approval.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
const actions: Array<()=>void>=[];
afterEach(()=>{for(const a of actions.splice(0).reverse())a();});
function setup(){
  const old=process.env.C2C_STATE_DIR,state=isolateStateDir(),root=makeTmpDir("diagnostic");
  actions.push(()=>{cleanup(state);cleanup(root);if(old===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=old;});
  return {state,root};
}
it("records the actual rejection stage without retaining command, cwd, paths or unknown keys",()=>{
  const {root}=setup();
  const secret="sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
  const request={threadId:"thread",turnId:"turn",itemId:"item",command:`echo ${secret}`,cwd:root,
    additionalPermissions:{fileSystem:{write:[`${root}/secret-name`]}},[secret]:secret};
  let stage:string|undefined;
  expect(validateLocalApproval(request,root,s=>{stage=s;})).toBeNull();expect(stage).toBe("schema");
  const diagnostic=approvalDiagnostic(request,"schema"),serialized=JSON.stringify(diagnostic);
  expect(serialized).not.toContain(secret);expect(serialized).not.toContain(root);expect(serialized).not.toContain("secret-name");
  expect(diagnostic).toMatchObject({stage:"schema",command_present:true,write_count:1,network_requested:false});
  expect(approvalDiagnosticSchema.safeParse({...diagnostic,raw:secret}).success).toBe(false);
});
it.each([[{network:{enabled:true}},"network"],[null,"cwd"]] as const)("captures the validator exit %s",(permissions,expected)=>{
  const {root}=setup();let stage:string|undefined;
  const value={threadId:"thread",turnId:"turn",itemId:"item",command:"echo okay",cwd:expected==="cwd"?"/wrong":root,additionalPermissions:permissions,availableDecisions:["accept"]};
  expect(validateLocalApproval(value,root,s=>{stage=s;})).toBeNull();expect(stage).toBe(expected);
});
it("persists strict diagnostic through restart and public legacy history; old records remain unavailable",()=>{
  const {state}=setup(),workspace="a".repeat(24);
  const run={task_id:"diagnostic",iteration:1,run_id:"b".repeat(32),state:"running" as const};
  const diagnostic=approvalDiagnostic({command:"secret fixture",cwd:"/secret-path",availableDecisions:["accept","acceptForSession",{},"decline"]},"request");
  const first=new TaskJournal(workspace);first.begin(workspace,run,"request");
  const terminal={...run,state:"blocked" as const,reason:"approval_required",approval_diagnostic:diagnostic};
  first.complete(workspace,terminal);first.complete(workspace,terminal);first.close();
  const second=new TaskJournal(workspace);actions.push(()=>second.close());
  expect(second.recoveredRun(workspace,run.task_id,run.run_id)).toMatchObject({approval_diagnostic:diagnostic,approval_diagnostic_available:true,resumable:false});
  appendExecutionRecord(workspace,{taskId:"diagnostic",iteration:1,exitStatus:"blocked",changedFiles:null,tests:null,timestamp:new Date().toISOString(),approval_diagnostic:diagnostic});
  appendExecutionRecord(workspace,{taskId:"old",iteration:1,exitStatus:"blocked",changedFiles:null,tests:null,timestamp:new Date().toISOString()});
  expect(readExecutionRecords(workspace)).toMatchObject([{approval_diagnostic:diagnostic,approval_diagnostic_available:true},{approval_diagnostic_available:false}]);
  expect(fs.readFileSync(path.join(state,"task-journal",`${workspace}.json`),"utf8")).not.toContain("secret fixture");
});
it("bounds permission counts and classifies unsupported decisions without storing values",()=>{
  const d=approvalDiagnostic({additionalPermissions:{fileSystem:{read:Array(1000).fill("secret")}},availableDecisions:[{secret:"secret"},"acceptForSession"]},"schema");
  expect(d.read_count).toBe(17);expect(d.decisions).toEqual(["other","session"]);expect(JSON.stringify(d)).not.toContain("secret");
});

it("recovers mocked native delivery failure through the existing journal and execution evidence", () => {
  setup(); const workspace = "a".repeat(24);
  const run = { task_id: "native-delivery", iteration: 1, run_id: "c".repeat(32), state: "running" as const };
  const diagnostic = approvalDiagnostic({ command: "sample-secret", cwd: "/sample-secret" }, "decision");
  diagnostic.reason = "native_delivery";
  diagnostic.native_delivery = { phase: "failed", readiness: "unobserved", user_receipt: "unknown", failure_code: "NATIVE_HELPER_PREPARE_FAILED" };
  const first = new TaskJournal(workspace); first.begin(workspace, run, "request");
  first.complete(workspace, { ...run, state: "failed", reason: "local_approval_unavailable", approval_diagnostic: diagnostic }); first.close();
  const second = new TaskJournal(workspace); actions.push(() => second.close());
  expect(second.recoveredRun(workspace, run.task_id, run.run_id)).toMatchObject({ state: "failed", reason: "local_approval_unavailable", approval_diagnostic: diagnostic });
  appendExecutionRecord(workspace, { taskId: run.task_id, iteration: 1, exitStatus: "failed", changedFiles: null, tests: null, timestamp: new Date().toISOString(), approval_diagnostic: diagnostic });
  expect(readExecutionRecords(workspace)).toMatchObject([{ approval_diagnostic: diagnostic }]);
  expect(JSON.stringify(second.recoveredRun(workspace, run.task_id, run.run_id))).not.toContain("sample-secret");
  expect(approvalDiagnosticSchema.safeParse({ ...diagnostic, native_delivery: { ...diagnostic.native_delivery, failure_code: "sample-secret" } }).success).toBe(false);
  expect(approvalDiagnosticSchema.safeParse({ ...diagnostic, native_delivery: { ...diagnostic.native_delivery, user_receipt: "confirmed" } }).success).toBe(false);
  expect(approvalDiagnosticSchema.safeParse({ ...diagnostic, native_delivery: { ...diagnostic.native_delivery, raw: "sample-secret" } }).success).toBe(false);
});
