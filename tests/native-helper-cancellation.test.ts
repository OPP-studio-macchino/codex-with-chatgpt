import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeFolderScript, CHOOSE_PROJECT_SCRIPT, APPROVE_PROJECT_SCRIPT } from "../src/workspace/registration-native.js";
const retained: string[] = [];
afterEach(() => { for (const dir of retained.splice(0)) fs.rmSync(dir, { recursive:true, force:true }); });
function fixture() {
  let dir = "";
  const invoke = vi.fn(async (file:string,args:string[]) => {
    if (file === "/usr/bin/osacompile") {
      dir = path.dirname(args[1]!); retained.push(dir);
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
      expect(fs.readFileSync(path.join(dir,"active.txt"),"utf8")).toBe("active");
    } else {
      expect(file).toBe("/usr/bin/osascript");
      fs.writeFileSync(path.join(dir,"result.txt"),"/safe/project/",{mode:0o600});
    }
  });
  return {invoke, dir:()=>dir};
}
it("disarms and verifies cleanup even after a successful Apple Event reply",async()=>{
  const f=fixture();
  const stop=vi.fn(async()=>{
    expect(fs.existsSync(path.join(f.dir(),"active.txt"))).toBe(false);
    return true;
  });
  expect(await executeFolderScript(CHOOSE_PROJECT_SCRIPT,[],1000,new AbortController().signal,f.invoke,stop)).toBe("/safe/project/");
  expect(stop).toHaveBeenCalledOnce();
  expect(fs.existsSync(f.dir())).toBe(false);
});
it("cancellation cannot return an approval and still cleans up the invoked helper",async()=>{
  const f=fixture(),controller=new AbortController();
  const invoke=async(file:string,args:string[])=>{
    await f.invoke(file,args);
    if(file==="/usr/bin/osascript"){controller.abort();throw Object.assign(new Error("cancel"),{name:"AbortError"});}
  };
  const stop=vi.fn(async()=>{
    expect(fs.existsSync(path.join(f.dir(),"active.txt"))).toBe(false);return true;
  });
  expect(await executeFolderScript(APPROVE_PROJECT_SCRIPT,["test"],1000,controller.signal,invoke,stop)).toBe("cancelled");
  expect(stop).toHaveBeenCalledOnce();expect(fs.existsSync(f.dir())).toBe(false);
});
it("unverified termination is an error, not a successful cancellation or deleted evidence",async()=>{
  const f=fixture(),stop=vi.fn(async()=>false);
  await expect(executeFolderScript(CHOOSE_PROJECT_SCRIPT,[],1000,new AbortController().signal,f.invoke,stop))
    .rejects.toMatchObject({code:"NATIVE_HELPER_TERMINATION_FAILED"});
  expect(fs.existsSync(f.dir())).toBe(true);
  expect(fs.existsSync(path.join(f.dir(),"active.txt"))).toBe(false);
});
it("rejects unapproved script source and does not launch on a pre-aborted request",async()=>{
  const invoke=vi.fn(async()=>undefined),stop=vi.fn(async()=>true),controller=new AbortController();
  await expect(executeFolderScript("malicious",[],1000,controller.signal,invoke,stop)).rejects.toMatchObject({code:"NATIVE_HELPER_SOURCE_INVALID"});
  controller.abort();
  expect(await executeFolderScript(CHOOSE_PROJECT_SCRIPT,[],1000,controller.signal,invoke,stop)).toBe("cancelled");
  expect(invoke).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();
  for(const script of [CHOOSE_PROJECT_SCRIPT,APPROVE_PROJECT_SCRIPT]) expect(script).toContain("if not (my sessionActive()) then return");
});
