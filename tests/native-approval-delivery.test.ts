// Mocked lifecycle tests: no GUI, native compiler, signing or real mode acceptance.
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import * as native from "../src/workspace/registration-native.js";
import { nativeLocalApproval, validateManagedNetworkApproval } from "../src/codex/local-approval.js";
import { safeNativeFailureCode } from "../src/codex/approval-diagnostic.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const secret = "sample-secret-do-not-export";
function mockedFiles() {
  vi.spyOn(fs, "mkdtemp").mockResolvedValue("/mocked/helper");
  vi.spyOn(fs, "chmod").mockResolvedValue();
  vi.spyOn(fs, "writeFile").mockResolvedValue();
  vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fs, "lstat").mockImplementation(async file => ({
    mode: file === "/mocked/helper" ? 0o40700 : 0o100600,
    isDirectory: () => file === "/mocked/helper",
    isFile: () => file !== "/mocked/helper",
  }) as Stats);
  return vi.spyOn(fs, "rm").mockResolvedValue();
}

it.each(["/mocked/helper", "/mocked/helper/main.swift", "/mocked/helper/message.txt",
  "/mocked/helper/C2C Project Access.app/Contents/Info.plist"].flatMap(file =>
  ["mode", "type", "EPERM", "ETIMEDOUT"].map(failure => ({ file, failure }))))(
  "mocked private metadata $failure at $file fails closed before compilation", async ({ file, failure }) => {
    const cleanup = mockedFiles(), phase = vi.fn();
    const metadata = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.mocked(fs.lstat).mockImplementation(async target => {
      if (target !== file) return metadata(target);
      if (failure === "EPERM" || failure === "ETIMEDOUT") throw Object.assign(new Error(secret), { code: failure });
      const info = await metadata(target);
      return { ...info, mode: failure === "mode" ? (file === "/mocked/helper" ? 0o755 : 0o700) : info.mode,
        isDirectory: () => failure !== "type" && info.isDirectory(),
        isFile: () => failure !== "type" && info.isFile() } as Stats;
    });
    const invoke = vi.fn<native.NativeHelperCommand>(async () => '{"status":"approved"}');
    await expect(native.executeFolderScript(native.LOCAL_NETWORK_APPROVAL_SCRIPT, [secret], 1000,
      new AbortController().signal, invoke, phase)).rejects.toMatchObject({ code: "NATIVE_HELPER_PREPARE_FAILED" });
    expect(invoke).not.toHaveBeenCalled();
    expect(phase.mock.calls).toEqual([["prepare"]]);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith("/mocked/helper", { recursive: true, force: true });
  });

it("mocked cancellation during metadata verification still cleans up without compiling", async () => {
  const cleanup = mockedFiles(), controller = new AbortController();
  vi.mocked(fs.lstat).mockImplementation(async () => {
    controller.abort();
    throw Object.assign(new Error(secret), { code: "EPERM" });
  });
  const invoke = vi.fn<native.NativeHelperCommand>();
  expect(await native.executeFolderScript(native.LOCAL_NETWORK_APPROVAL_SCRIPT, [], 1000,
    controller.signal, invoke)).toBe("cancelled");
  expect(invoke).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledExactlyOnceWith("/mocked/helper", { recursive: true, force: true });
});

it.each(["prepare", "compile", "sign", "launch"] as const)("mocked %s failure retains only a safe code and cleans up", async stage => {
  const cleanup = mockedFiles(), phases: string[] = [];
  const error = Object.assign(new Error(secret), { code: "EPERM", path: secret });
  if (stage === "prepare") vi.mocked(fs.mkdtemp).mockRejectedValue(error);
  let count = 0;
  const invoke: native.NativeHelperCommand = async () => {
    if (++count === ["compile", "sign", "launch"].indexOf(stage) + 1) throw error;
    return "";
  };
  await expect(native.executeFolderScript(native.LOCAL_NETWORK_APPROVAL_SCRIPT, [secret], 1000,
    new AbortController().signal, invoke, phase => phases.push(phase))).rejects.toMatchObject({ code: `NATIVE_HELPER_${stage.toUpperCase()}_FAILED` });
  expect(phases.at(-1)).toBe(stage);
  expect(cleanup).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1);
});

it("mocked exit without readiness cannot approve", async () => {
  mockedFiles();
  await expect(native.executeFolderScript(native.LOCAL_NETWORK_APPROVAL_SCRIPT, [], 1000,
    new AbortController().signal, async () => '{"status":"approved"}', vi.fn())).rejects.toMatchObject({ code: "NATIVE_HELPER_NOT_READY" });
});

it.each(["approved", "denied", "timed_out"])("mocked ready then %s preserves strict final reply", async decision => {
  const cleanup = mockedFiles(), phase = vi.fn();
  const invoke: native.NativeHelperCommand = async (_file, _args, _timeout, _signal, ready) => {
    ready?.(); ready?.(); return JSON.stringify({ status: decision });
  };
  expect(await native.executeFolderScript(native.LOCAL_NETWORK_APPROVAL_SCRIPT, [], 1000,
    new AbortController().signal, invoke, phase)).toBe(decision);
  expect(phase.mock.calls.map(call => call[0])).toEqual(["prepare", "compile", "sign", "launch", "pending_owner"]);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("mocked cancellation rejects late readiness and approval, and waits to clean up", async () => {
  const cleanup = mockedFiles(), controller = new AbortController(), phase = vi.fn();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const invoke: native.NativeHelperCommand = async (_file, _args, _timeout, _signal, ready) => {
    if (!ready) return "";
    return new Promise(resolve => { release = () => { ready(); resolve('{"status":"approved"}'); }; entered(); });
  };
  const result = native.executeFolderScript(native.LOCAL_NETWORK_APPROVAL_SCRIPT, [], 1000, controller.signal, invoke, phase);
  await waiting; controller.abort();
  expect(cleanup).not.toHaveBeenCalled(); release();
  expect(await result).toBe("cancelled");
  expect(phase).not.toHaveBeenCalledWith("pending_owner");
  expect(cleanup).toHaveBeenCalledOnce();
});

it("mocked direct process observes only the fixed stderr marker once; final JSON waits for callback AND close", async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
  let callback!: (error: Error | null, stdout: string) => void;
  vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: typeof callback) => { callback = cb; return child; }) as any);
  const ready = vi.fn(), settled = vi.fn();
  const result = native.nativeHelperCommand("/mocked/helper", [], 1000, new AbortController().signal, ready);
  void result.then(settled);
  child.stderr.write(`noise-${secret}\nC2C_NATIVE_`);
  expect(ready).not.toHaveBeenCalled();
  child.stderr.write("READY_V1\nC2C_NATIVE_READY_V1\n");
  expect(ready).toHaveBeenCalledExactlyOnceWith();
  callback(null, '{"status":"approved"}'); await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  child.emit("close", 0);
  expect(await result).toBe('{"status":"approved"}');
});

it("mocked native boundary exports allowlisted codes without error text, paths or stacks", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const scope = validateManagedNetworkApproval({ threadId: "t", turnId: "u", itemId: "i",
      networkApprovalContext: { host: "example.com", protocol: "https" } }, process.cwd())!;
    vi.spyOn(native, "executeFolderScript").mockRejectedValue(Object.assign(new Error(secret), { code: "NATIVE_HELPER_PREPARE_FAILED", path: secret }));
    const error = await nativeLocalApproval(scope, "task", "run", new AbortController().signal).catch(error => error);
    expect(error.code).toBe("NATIVE_HELPER_PREPARE_FAILED");
    expect(String(error) + JSON.stringify(error)).not.toContain(secret);
    expect(safeNativeFailureCode({ code: secret })).toBeUndefined();
    vi.mocked(native.executeFolderScript).mockRejectedValue(Object.assign(new Error(secret), { code: secret }));
    expect(await nativeLocalApproval(scope, "task", "run", new AbortController().signal)).toBe("unavailable");
  } finally { Object.defineProperty(process, "platform", platform); }
});

it("mocked spawn error waits for close, and late process readiness is ignored", async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
  let callback!: (error: Error | null, stdout: string) => void;
  vi.mocked(execFile).mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: typeof callback) => { callback = cb; return child; }) as any);
  const ready = vi.fn(), settled = vi.fn();
  const result = native.nativeHelperCommand("/mocked/helper", [], 1000, new AbortController().signal, ready);
  const rejected = result.catch(error => { settled(); return error; });
  callback(Object.assign(new Error(secret), { code: "ENOENT" }), "");
  child.stderr.write("C2C_NATIVE_READY_V1\n"); await Promise.resolve();
  expect(ready).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
  child.emit("close", -1);
  expect(await rejected).toMatchObject({ code: "ENOENT" });
});
