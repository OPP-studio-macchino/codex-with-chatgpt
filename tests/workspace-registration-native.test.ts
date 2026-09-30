import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createNativeFolderOwner, executeFolderScript, CHOOSE_PROJECT_SCRIPT, APPROVE_PROJECT_SCRIPT, projectApprovalMessage } from "../src/workspace/registration-native.js";
const prompt = { workspaceName: "project", workspaceRoot: "/safe/project", profileId: "project-123456" };
it("separates native folder selection from a default-deny timed approval", async () => {
  const executor = vi.fn(async (script: string) => script === CHOOSE_PROJECT_SCRIPT ? "/safe/project/" : "approved");
  const owner = createNativeFolderOwner("darwin", executor), controller = new AbortController();
  expect(await owner.choose(controller.signal)).toBe("/safe/project/");
  expect(await owner.approve(prompt, controller.signal)).toBe("approved");
  expect(CHOOSE_PROJECT_SCRIPT).toContain("use scripting additions");
  expect(CHOOSE_PROJECT_SCRIPT).toContain("multiple selections allowed false");
  expect(APPROVE_PROJECT_SCRIPT).toContain('default button "拒否"');
  expect(APPROVE_PROJECT_SCRIPT).toContain("giving up after 30");
  expect(projectApprovalMessage(prompt)).toContain("Desktop Agent");
  expect(projectApprovalMessage(prompt)).toContain("次回も使用できます");
});
it("rejects missing platform, cancellation, malformed output and display injection", async () => {
  const executor = vi.fn(async () => "approved=true"), controller = new AbortController();
  const other = createNativeFolderOwner("linux", executor);
  expect(other.supported).toBe(false); expect(await other.choose(controller.signal)).toBeNull();
  expect(await other.approve(prompt, controller.signal)).toBe("unavailable");
  const owner = createNativeFolderOwner("darwin", executor);
  await expect(owner.choose(controller.signal)).rejects.toMatchObject({ code: "NATIVE_HELPER_RESPONSE_INVALID" });
  await expect(owner.approve(prompt, controller.signal)).rejects.toMatchObject({ code: "NATIVE_HELPER_RESPONSE_INVALID" });
  expect(() => projectApprovalMessage({ ...prompt, workspaceName: "spoof\nname" })).toThrow();
  controller.abort(); expect(await owner.approve(prompt, controller.signal)).toBe("denied");
});
it("passes display data as arguments, never interpolates it into the script", async () => {
  const executor = vi.fn(async () => "approved");
  const p = { ...prompt, workspaceName: 'quote " & shell & "', workspaceRoot: '/safe/"quoted"/project' };
  await createNativeFolderOwner("darwin", executor).approve(p, new AbortController().signal);
  const args = executor.mock.calls[0] as unknown as [string, string[], number, AbortSignal];
  expect(args[0]).toBe(APPROVE_PROJECT_SCRIPT); expect(args[1][0]).toContain(p.workspaceRoot);
  expect(args[0]).not.toContain(p.workspaceRoot);
});


it("compiles a fixed applet and invokes it through Apple Events rather than a hidden applet executable", async () => {
  let helperDir = "";
  const invoke = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/osacompile") {
      const app = args[1]!;
      helperDir = path.dirname(app);
      fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
      fs.writeFileSync(path.join(app, "Contents", "MacOS", "applet"), "fixture");
      return;
    }
    expect(file).toBe("/usr/bin/osascript");
    expect(args).toContain("launch");
    expect(args.indexOf("launch")).toBeLessThan(args.indexOf("run"));
    expect(args.filter(arg => arg === "run")).toHaveLength(1);
    expect(args).toContain("with timeout of 125 seconds");
    expect(args).not.toContain("activate");
    expect(CHOOSE_PROJECT_SCRIPT).toContain("    activate");
    expect(args).toContain("run");
    expect(args[1]).toContain('tell application "');
    expect(args[1]).toContain("C2C Project Access.app");
    fs.writeFileSync(path.join(helperDir, "result.txt"), "/safe/project/");
  });
  const result = await executeFolderScript(CHOOSE_PROJECT_SCRIPT, [], 1000, new AbortController().signal, invoke, async () => true);
  expect(result).toBe("/safe/project/");
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[1]![0]).not.toContain("/Contents/MacOS/applet");
});
