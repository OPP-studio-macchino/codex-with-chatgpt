import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createNativeFolderOwner, executeFolderScript, CHOOSE_PROJECT_SCRIPT, APPROVE_PROJECT_SCRIPT, APPROVE_UNREGISTER_PROJECT_SCRIPT, LOCAL_GIT_APPROVAL_SCRIPT, LOCAL_COMMAND_APPROVAL_SCRIPT, LOCAL_NETWORK_APPROVAL_SCRIPT, projectApprovalMessage, projectUnregistrationMessage, type NativeHelperCommand } from "../src/workspace/registration-native.js";
const prompt = { workspaceName: "project", workspaceRoot: "/safe/project", profileId: "project-123456" };
it("separates native folder selection from a default-deny timed approval", async () => {
  const executor = vi.fn(async (script: string) => script === CHOOSE_PROJECT_SCRIPT ? "/safe/project/" : "approved");
  const owner = createNativeFolderOwner("darwin", executor), controller = new AbortController();
  expect(await owner.choose(controller.signal)).toBe("/safe/project/");
  expect(executor).toHaveBeenNthCalledWith(1, CHOOSE_PROJECT_SCRIPT, [], 2_705_000, controller.signal);
  expect(await owner.approve(prompt, controller.signal)).toBe("approved");
  expect(executor).toHaveBeenNthCalledWith(2, APPROVE_PROJECT_SCRIPT, [projectApprovalMessage(prompt)], 2_705_000, controller.signal);
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
it("uses a distinct default-deny native mode for registration removal", async () => {
  const executor = vi.fn(async () => "approved");
  const owner = createNativeFolderOwner("darwin", executor);
  await owner.approve({ workspaceName: "project", profileId: "project-123456" }, new AbortController().signal);
  expect(executor).toHaveBeenCalledWith(APPROVE_UNREGISTER_PROJECT_SCRIPT,
    [projectUnregistrationMessage({ workspaceName: "project", profileId: "project-123456" })], 2_705_000, expect.any(AbortSignal));
  const message = projectUnregistrationMessage({ workspaceName: "project", profileId: "project-123456" });
  expect(message).toContain("ファイル、過去のJournal、実行履歴は削除しません");
  expect(() => projectUnregistrationMessage({ workspaceName: "bad\nname", profileId: "safe" })).toThrow();
});
it.each([CHOOSE_PROJECT_SCRIPT, APPROVE_PROJECT_SCRIPT, APPROVE_UNREGISTER_PROJECT_SCRIPT, LOCAL_GIT_APPROVAL_SCRIPT, LOCAL_COMMAND_APPROVAL_SCRIPT, LOCAL_NETWORK_APPROVAL_SCRIPT])("builds and directly runs the fixed bundle for %s", async (mode) => {
  const message = 'caller " $(do-not-execute) /private/example';
  let root = "";
  const invoke = vi.fn<NativeHelperCommand>(async (file, args, timeout, signal) => {
    expect(signal.aborted).toBe(false);
    if (file === "/usr/bin/xcrun") {
      root = path.dirname(args[3]);
      const bundle = path.join(root, "C2C Project Access.app");
      const helper = path.join(bundle, "Contents/MacOS/C2CProjectAccess");
      expect(args).toEqual(["swiftc", "-framework", "AppKit", path.join(root, "main.swift"), "-o", helper]);
      expect(timeout).toBe(15_000);
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      for (const name of ["main.swift", "message.txt"]) expect(fs.statSync(path.join(root, name)).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(root, "message.txt"), "utf8")).toBe(message);
      const swift = fs.readFileSync(args[3], "utf8");
      expect(swift).not.toContain(message);
      for (const token of ["app.finishLaunching()", ".moveToActiveSpace", "window.center()", ".activateAllWindows", "window.level = .modalPanel", "timeInterval: 2700", "RunLoop.main.add(timer, forMode: .modalPanel)", 'deny.keyEquivalent = "\\r"', 'approve.keyEquivalent = ""', "Bundle.main.bundleURL.deletingLastPathComponent()", "C2C — コマンド実行の一回承認", "このコマンドを一回許可"]) expect(swift).toContain(token);
      expect(swift).not.toContain("setActivationPolicy");
      const approval = swift.slice(swift.indexOf('} else if mode == "approve-project"'));
      expect(approval).toContain('mode == "approve-project" || mode == "approve-unregister-project" || mode == "approve-git" || mode == "approve-command"');
      expect(approval).toContain('deny.isEnabled = true\n            deny.keyEquivalent = "\\r"');
      expect(approval).toContain('approve.isEnabled = false\n            approve.keyEquivalent = ""');
      expect(approval).toContain("alert.window.defaultButtonCell = deny.cell as? NSButtonCell");
      expect(approval).toContain("DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {\n                guard !expired && !finished else { return }\n                approve.isEnabled = true\n            }");
      expect(approval.indexOf("approve.isEnabled = false")).toBeLessThan(approval.indexOf("front(alert.window)"));
      expect(approval.indexOf("DispatchQueue.main.asyncAfter")).toBeLessThan(approval.indexOf("alert.runModal()"));
      expect(approval).toContain("let response = alert.runModal()\n            finished = true\n            timer.invalidate()");
      expect(approval).toContain('expired ? "timed_out" : response == .alertSecondButtonReturn && approve.isEnabled ? "approved" : "denied"');
      expect(approval).toContain("timeInterval: 2700, repeats: false");
      expect(approval.match(/approve\.isEnabled = true/g)).toHaveLength(1);
      const plist = fs.readFileSync(path.join(bundle, "Contents/Info.plist"), "utf8");
      for (const [key, value] of Object.entries({ CFBundleIdentifier: "tech.opp-studio.c2c.project-access", CFBundleName: "C2C Project Access", CFBundleExecutable: "C2CProjectAccess", CFBundlePackageType: "APPL" })) expect(plist).toContain(`<key>${key}</key><string>${value}</string>`);
      for (const key of ["LSUIElement", "NSHighResolutionCapable"]) expect(plist).toContain(`<key>${key}</key><true/>`);
      expect(plist).not.toContain(message);
    } else if (file === "/usr/bin/codesign") {
      expect(args).toEqual(["--force", "--sign", "-", "--identifier", "tech.opp-studio.c2c.project-access", path.join(root, "C2C Project Access.app")]);
      expect(timeout).toBe(15_000);
    } else {
      expect(file).toBe(path.join(root, "C2C Project Access.app/Contents/MacOS/C2CProjectAccess"));
      expect(args).toEqual([mode]);
      expect(timeout).toBe(2_705_000);
      return JSON.stringify({ status: mode === CHOOSE_PROJECT_SCRIPT ? "cancelled" : "approved" });
    }
    return "";
  });
  expect(await executeFolderScript(mode, [message], 2_705_000, new AbortController().signal, invoke)).toBe(mode === CHOOSE_PROJECT_SCRIPT ? "cancelled" : "approved");
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(root)).toBe(false);
});

it("keeps the directory chooser on the standard modal lifecycle with fail-closed replies", () => {
  const source = fs.readFileSync(new URL("../src/workspace/registration-native.ts", import.meta.url), "utf8");
  const chooser = source.slice(source.indexOf('if mode == "choose-project"'), source.indexOf('} else if mode == "approve-project"'));
  expect(chooser).toContain("panel.canChooseDirectories = true\n    panel.canChooseFiles = false\n    panel.allowsMultipleSelection = false");
  expect(chooser).not.toMatch(/front\s*\(\s*panel\s*\)/);
  expect(chooser).toContain("RunLoop.main.add(timer, forMode: .modalPanel)\n    app.activate(ignoringOtherApps: true)\n    let response = panel.runModal()\n    timer.invalidate()");
  expect(chooser).toContain("expired = true\n        panel.cancel(nil)\n        app.abortModal()");
  expect(chooser).toContain('if expired { reply(["status": "timed_out"]) }\n    else if response == .OK, let url = panel.url { reply(["status": "selected", "path": url.path]) }\n    else { reply(["status": "cancelled"]) }');
  const approval = source.slice(source.indexOf('} else if mode == "approve-project"'));
  expect(approval).toContain('front(alert.window)\n            FileHandle.standardError.write(Data("C2C_NATIVE_READY_V1\\n".utf8))\n            let response = alert.runModal()');
  expect(chooser).not.toContain("C2C_NATIVE_READY_V1");
});

it("keeps production transport free of indirect launch and side-channel files", () => {
  const source = fs.readFileSync(new URL("../src/workspace/registration-native.ts", import.meta.url), "utf8");
  for (const token of ["/usr/bin/open", "osacompile", "osascript", "LaunchServices", "active.txt", "result.txt"]) expect(source).not.toContain(token);
});

it.each([APPROVE_PROJECT_SCRIPT, APPROVE_UNREGISTER_PROJECT_SCRIPT, LOCAL_GIT_APPROVAL_SCRIPT, LOCAL_COMMAND_APPROVAL_SCRIPT, LOCAL_NETWORK_APPROVAL_SCRIPT])("preserves denial, timeout and cancellation for %s", async (mode) => {
  for (const status of ["denied", "timed_out"]) {
    const invoke: NativeHelperCommand = async (file) => file.endsWith("C2CProjectAccess") ? JSON.stringify({ status }) : "";
    expect(await executeFolderScript(mode, ["message"], 2_705_000, new AbortController().signal, invoke)).toBe(status);
  }
  const controller = new AbortController();
  const invoke = vi.fn<NativeHelperCommand>(async (file) => {
    if (file.endsWith("C2CProjectAccess")) {
      controller.abort();
      return '{"status":"approved"}';
    }
    return "";
  });
  expect(await executeFolderScript(mode, ["message"], 2_705_000, controller.signal, invoke)).toBe("cancelled");
});

it.each([0, 1, 2])("waits for aborted stage %s to settle before cleanup and never approves", async (stage) => {
  const controller = new AbortController();
  let root = "", calls = 0;
  let release!: (value: string) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const invoke: NativeHelperCommand = async (_file, args) => {
    if (!root) root = path.dirname(args[3]);
    if (calls++ === stage) {
      entered();
      return new Promise<string>((resolve) => { release = resolve; });
    }
    return "";
  };
  const result = executeFolderScript(APPROVE_PROJECT_SCRIPT, ["message"], 2_705_000, controller.signal, invoke);
  await waiting;
  controller.abort();
  expect(fs.existsSync(root)).toBe(true);
  release('{"status":"approved"}');
  expect(await result).toBe("cancelled");
  expect(calls).toBe(stage + 1);
  expect(fs.existsSync(root)).toBe(false);
});

it.each(["COMPILE", "SIGN", "RUN"])("distinguishes %s failure and timeout", async (stage) => {
  for (const timedOut of [false, true]) {
    let calls = 0, root = "";
    const target = ["COMPILE", "SIGN", "RUN"].indexOf(stage);
    const invoke: NativeHelperCommand = async (_file, args) => {
      if (!root) root = path.dirname(args[3]);
      if (calls++ === target) throw Object.assign(new Error("command failed"), timedOut ? { code: "ETIMEDOUT" } : {});
      return "";
    };
    await expect(executeFolderScript(APPROVE_PROJECT_SCRIPT, [], 2_705_000, new AbortController().signal, invoke)).rejects.toMatchObject({ code: `NATIVE_HELPER_${stage}_${timedOut ? "TIMEOUT" : "FAILED"}` });
    expect(fs.existsSync(root)).toBe(false);
  }
});

it.each(["", "not-json", "[]", '{"status":"approved","extra":true}', '{"status":"selected","path":"relative"}', "x".repeat(16385)])("rejects malformed or oversized helper output %#", async (output) => {
  let calls = 0;
  const invoke: NativeHelperCommand = async () => ++calls === 3 ? output : "";
  await expect(executeFolderScript(APPROVE_PROJECT_SCRIPT, [], 2_705_000, new AbortController().signal, invoke)).rejects.toMatchObject({ code: "NATIVE_HELPER_PROTOCOL_INVALID" });
});
