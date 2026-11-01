import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { executeFolderScript, CHOOSE_PROJECT_SCRIPT, APPROVE_PROJECT_SCRIPT, LOCAL_GIT_APPROVAL_SCRIPT, LOCAL_NETWORK_APPROVAL_SCRIPT } from "../src/workspace/registration-native.js";

function fixture(output = '{"status":"approved"}', mode = APPROVE_PROJECT_SCRIPT) {
  let dir = "";
  let calls = 0;
  const invoke = vi.fn(async (file: string, args: string[], timeout: number) => {
    const stage = calls++;
    if (stage === 0) {
      expect(file).toBe("/usr/bin/xcrun");
      dir = path.dirname(args[3]!);
      expect(path.dirname(dir)).toBe(os.tmpdir());
      expect(path.basename(dir)).toMatch(/^c2c-folder-owner-[^/]+$/);
      expect(args).toEqual(["swiftc", "-framework", "AppKit", path.join(dir, "main.swift"), "-o", path.join(dir, "C2C Project Access.app", "Contents", "MacOS", "C2CProjectAccess")]);
      expect(timeout).toBe(15_000);
      for (const [name, permissions] of [["", 0o700], ["main.swift", 0o600], ["message.txt", 0o600]] as const)
        expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(permissions);
      expect(fs.readFileSync(path.join(dir, "main.swift"), "utf8")).not.toContain("CALLER DATA");
      const plist = fs.readFileSync(path.join(dir, "C2C Project Access.app", "Contents", "Info.plist"), "utf8");
      for (const [key, value] of Object.entries({ CFBundleIdentifier: "tech.opp-studio.c2c.project-access", CFBundleName: "C2C Project Access", CFBundleExecutable: "C2CProjectAccess", CFBundlePackageType: "APPL" }))
        expect(plist).toContain(`<key>${key}</key><string>${value}</string>`);
      for (const key of ["LSUIElement", "NSHighResolutionCapable"]) expect(plist).toContain(`<key>${key}</key><true/>`);
      expect(plist).not.toContain("CALLER DATA");
      expect(fs.readFileSync(path.join(dir, "message.txt"), "utf8")).toBe("CALLER DATA");
      return "";
    }
    if (stage === 1) {
      expect(file).toBe("/usr/bin/codesign");
      expect(args).toEqual(["--force", "--sign", "-", "--identifier", "tech.opp-studio.c2c.project-access", path.join(dir, "C2C Project Access.app")]);
      expect(timeout).toBe(15_000);
      return "";
    }
    expect(stage).toBe(2);
    expect(file).toBe(path.join(dir, "C2C Project Access.app", "Contents", "MacOS", "C2CProjectAccess"));
    expect(args).toEqual([mode]);
    expect(timeout).toBe(1000);
    expect(fs.existsSync(dir)).toBe(true);
    return output;
  });
  return { invoke, dir: () => dir };
}
it("uses fixed Swift source and exact direct child argv, then cleans up", async () => {
  const f = fixture();
  expect(await executeFolderScript(APPROVE_PROJECT_SCRIPT, ["CALLER DATA", "ignored"], 1000, new AbortController().signal, f.invoke)).toBe("approved");
  expect(f.invoke).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(f.dir())).toBe(false);
  const production = fs.readFileSync("src/workspace/registration-native.ts", "utf8");
  for (const removed of ["/usr/bin/open", "osacompile", "osascript", "LaunchServices", "active.txt", "result.txt"])
    expect(production).not.toContain(removed);
});
it.each([
  [CHOOSE_PROJECT_SCRIPT, '{"status":"selected","path":"/safe/project/"}', "/safe/project/"],
  [CHOOSE_PROJECT_SCRIPT, '{"status":"cancelled"}', "cancelled"],
  [CHOOSE_PROJECT_SCRIPT, '{"status":"timed_out"}', "timed_out"],
  [APPROVE_PROJECT_SCRIPT, '{"status":"denied"}', "denied"],
  [APPROVE_PROJECT_SCRIPT, '{"status":"timed_out"}', "timed_out"],
  [LOCAL_GIT_APPROVAL_SCRIPT, '{"status":"approved"}', "approved"],
  [LOCAL_GIT_APPROVAL_SCRIPT, '{"status":"denied"}', "denied"],
  [LOCAL_GIT_APPROVAL_SCRIPT, '{"status":"timed_out"}', "timed_out"],
  [LOCAL_NETWORK_APPROVAL_SCRIPT, '{"status":"approved"}', "approved"],
  [LOCAL_NETWORK_APPROVAL_SCRIPT, '{"status":"denied"}', "denied"],
  [LOCAL_NETWORK_APPROVAL_SCRIPT, '{"status":"timed_out"}', "timed_out"],
])("preserves external semantics for %s / %s", async (mode, output, expected) => {
  const f = fixture(output, mode);
  expect(await executeFolderScript(mode, ["CALLER DATA"], 1000, new AbortController().signal, f.invoke)).toBe(expected);
  expect(f.invoke).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(f.dir())).toBe(false);
});
it.each(["", "approved", "null", "[]", '{"status":"approved","extra":true}', '{"status":"selected","path":"/safe"}', '{"status":"cancelled"}', "x".repeat(16385)])("rejects malformed or oversized approval output %#", async output => {
  const f = fixture(output);
  await expect(executeFolderScript(APPROVE_PROJECT_SCRIPT, ["CALLER DATA"], 1000, new AbortController().signal, f.invoke)).rejects.toMatchObject({ code: "NATIVE_HELPER_PROTOCOL_INVALID" });
  expect(fs.existsSync(f.dir())).toBe(false);
});
it.each(['{"status":"selected","path":"relative"}', '{"status":"approved"}', '{"status":"selected","path":"/bad\\npath"}'])("rejects invalid selection %s", async output => {
  const f = fixture(output, CHOOSE_PROJECT_SCRIPT);
  await expect(executeFolderScript(CHOOSE_PROJECT_SCRIPT, ["CALLER DATA"], 1000, new AbortController().signal, f.invoke)).rejects.toMatchObject({code:"NATIVE_HELPER_PROTOCOL_INVALID"});
  expect(fs.existsSync(f.dir())).toBe(false);
});
it("rejects unknown mode and pre-abort without invoking", async () => {
  const invoke = vi.fn(async () => "");
  const controller = new AbortController();
  await expect(executeFolderScript("untrusted", [], 1000, controller.signal, invoke)).rejects.toMatchObject({code:"NATIVE_HELPER_SOURCE_INVALID"});
  controller.abort();
  expect(await executeFolderScript(APPROVE_PROJECT_SCRIPT, [], 1000, controller.signal, invoke)).toBe("cancelled");
  expect(invoke).not.toHaveBeenCalled();
});
it.each(["compile", "sign", "run"] as const)("cleans up after %s failure/timeout", async stage => {
  for (const timed of [false, true]) {
    const f = fixture();
    const invoke = async (file: string, args: string[], timeout: number, signal: AbortSignal) => {
      const output = await f.invoke(file, args, timeout);
      if (f.invoke.mock.calls.length === ["compile", "sign", "run"].indexOf(stage) + 1) throw Object.assign(new Error("fixture"), { killed: timed });
      return output;
    };
    await expect(executeFolderScript(APPROVE_PROJECT_SCRIPT, ["CALLER DATA"], 1000, new AbortController().signal, invoke)).rejects.toMatchObject({code:`NATIVE_HELPER_${stage.toUpperCase()}_${timed ? "TIMEOUT" : "FAILED"}`});
    expect(f.invoke).toHaveBeenCalledTimes(["compile", "sign", "run"].indexOf(stage) + 1);
    expect(fs.existsSync(f.dir())).toBe(false);
  }
});
it.each([APPROVE_PROJECT_SCRIPT, LOCAL_NETWORK_APPROVAL_SCRIPT].flatMap(mode =>
  ["compile", "sign", "run"].map(stage => ({ mode, stage }))
))("$mode abort during $stage cannot approve; cleanup waits for completion", async ({ mode, stage }) => {
  const f = fixture('{"status":"approved"}', mode), controller = new AbortController();
  const target = ["compile", "sign", "run"].indexOf(stage) + 1;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const invoke = async (file: string, args: string[], timeout: number, signal: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    const output = await f.invoke(file, args, timeout);
    if (f.invoke.mock.calls.length === target) {
      return new Promise<string>(resolve => {
        release = () => resolve(output);
        entered();
      });
    }
    return output;
  };
  let settled = false;
  const result = executeFolderScript(mode, ["CALLER DATA"], 1000, controller.signal, invoke);
  void result.then(() => { settled = true; }, () => { settled = true; });
  await waiting;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(fs.existsSync(f.dir())).toBe(true);
  expect(f.invoke).toHaveBeenCalledTimes(target);
  release();
  expect(await result).toBe("cancelled");
  expect(f.invoke).toHaveBeenCalledTimes(target);
  expect(fs.existsSync(f.dir())).toBe(false);
});
