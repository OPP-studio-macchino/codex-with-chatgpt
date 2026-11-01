import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeRunNotice } from "../src/notifications/notification-native.js";
import type { NativeHelperCommand } from "../src/workspace/registration-native.js";
import { cleanup, makeTmpDir, isolateStateDir } from "./helpers.js";

const notice = { notification_id: "c".repeat(64), category: "blocked" as const, workspace_id: "a".repeat(24), task_id: "native-notice-fixture", run_id: "b".repeat(32), state: "blocked" as const };
const dirs: string[] = [];
beforeEach(() => { const state = isolateStateDir(); dirs.push(state); vi.stubEnv("C2C_STATE_DIR", state); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) cleanup(dir); });
function tempRoot() {
  const dir = makeTmpDir("native-run-notice"); dirs.push(dir); vi.spyOn(os, "tmpdir").mockReturnValue(dir);
}

function receipt() {
  const file = path.join(process.env.C2C_STATE_DIR!, "notification-delivery", notice.notification_id + ".native.ack");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, "acknowledged:" + notice.notification_id, { mode: 0o600 });
}

it.each(["completed", "blocked", "failed"] as const)("uses a fixed private C2C bundle and bounded presentation for %s", async state => {
  tempRoot();
  let root = "", swift = "", plist = "", payload = "", rootMode = 0;
  let fileModes: number[] = [];
  const invoke = vi.fn<NativeHelperCommand>(async (file, args) => {
    if (file === "/usr/bin/xcrun") {
      root = path.dirname(args[3]);
      rootMode = fs.statSync(root).mode & 0o777;
      fileModes = ["main.swift", "notice.json"].map(name => fs.statSync(path.join(root, name)).mode & 0o077);
      payload = fs.readFileSync(path.join(root, "notice.json"), "utf8");
      swift = fs.readFileSync(args[3], "utf8");
      plist = fs.readFileSync(path.join(root, "C2C Run Notice.app/Contents/Info.plist"), "utf8");
    }
    if (file.endsWith("C2CRunNotice")) receipt();
    return file.endsWith("C2CRunNotice") ? JSON.stringify({ status: "acknowledged" }) : "";
  });
  expect(await executeRunNotice({ ...notice, state }, invoke)).toEqual({ outcome: "notice_acknowledged" });
  const bundle = path.join(root, "C2C Run Notice.app"), helper = path.join(bundle, "Contents/MacOS/C2CRunNotice");
  expect(invoke.mock.calls.map(([file, args, timeout]) => [file, args, timeout])).toEqual([
    ["/usr/bin/xcrun", ["swiftc", "-framework", "AppKit", path.join(root, "main.swift"), "-o", helper], 15_000],
    ["/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "tech.opp-studio.c2c.run-notice", bundle], 15_000],
    [helper, [path.join(process.env.C2C_STATE_DIR!, "notification-delivery", notice.notification_id + ".native")], 0],
  ]);
  expect(rootMode).toBe(0o700); expect(fileModes).toEqual([0, 0]);
  expect(JSON.parse(payload)).toEqual({ ...notice, state });
  for (const value of [notice.workspace_id, notice.task_id, notice.run_id, notice.notification_id]) expect(swift).not.toContain(value);
  expect(swift).toContain('let attention = notice.state != "completed"');
  for (const token of [".nonactivatingPanel", "canBecomeKey: Bool { false }", "canBecomeMain: Bool { false }",
    "panel.level = .statusBar", ".canJoinAllSpaces", ".fullScreenAuxiliary", "hidesOnDeactivate = false",
    "panel.orderFrontRegardless()", 'button.keyEquivalent = ""', 'NSButton(title: "確認した"',
    "app.requestUserAttention(.informationalRequest)", 'reply("acknowledged")', "NSApplication.shared.terminate(nil)"])
    expect(swift).toContain(token);
  expect(swift).not.toContain("withTimeInterval: 10");
  for (const token of ["flock(receiptFD, LOCK_EX | LOCK_NB)", "getppid() != bridgePID", "fsync(fd)",
    "previous == acknowledgedReceipt", "O_NOFOLLOW", "st_nlink == 1", "button.isEnabled = false",
    "withTimeInterval: 0.75", "withTimeInterval: 0.25"]) expect(swift).toContain(token);
  for (const token of [".activate(", "runModal", ".closable", ".resizable", ".miniaturizable", "NSSound", "keyDown(", "approved", "osascript"])
    expect(swift).not.toContain(token);
  expect(plist).toContain("tech.opp-studio.c2c.run-notice"); expect(plist).not.toContain(notice.task_id);
  expect(fs.existsSync(root)).toBe(false);
});

it("keeps attention pending and private files present until explicit acknowledgement", async () => {
  tempRoot(); let root = "";
  let release!: (value: string) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const invoke: NativeHelperCommand = async (file, args, timeout) => {
    if (file === "/usr/bin/xcrun") root = path.dirname(args[3]);
    if (!file.endsWith("C2CRunNotice")) return "";
    expect(timeout).toBe(0); entered();
    return new Promise(resolve => { release = resolve; });
  };
  let settled = false;
  const result = executeRunNotice(notice, invoke).then(outcome => { settled = true; return outcome; });
  await waiting; expect(settled).toBe(false); expect(fs.existsSync(root)).toBe(true);
  receipt(); release('{"status":"acknowledged"}');
  expect(await result).toEqual({ outcome: "notice_acknowledged" }); expect(fs.existsSync(root)).toBe(false);
});

it.each(["", "not-json", '{"status":"expired"}', '{"status":"approved"}', '{"status":"acknowledged","approved":true}',
  '{"status":"acknowledged","proof":"secret"}', "x".repeat(1025)])("does not infer acknowledgement from exit zero or invalid reply %#", async output => {
  tempRoot();
  expect(await executeRunNotice(notice, async file => file.endsWith("C2CRunNotice") ? output : ""))
    .toEqual({ outcome: "process_exit", exit_code: 0 });
});

it("allows explicit notice acknowledgement for completion without granting authority", async () => {
  tempRoot();
  expect(await executeRunNotice({ ...notice, state: "completed" }, async file => {
    if (!file.endsWith("C2CRunNotice")) return "";
    receipt(); return '{"status":"acknowledged"}';
  })).toEqual({ outcome: "notice_acknowledged" });
});

it("drops all caller fields beyond bounded IDs/state", async () => {
  tempRoot();
  const injected = { ...notice, reason: "raw-error token=secret", summary: "private prompt", questions: ["private answer"],
    approval: "payload", nonce: "private nonce", proof: "private proof", path: "/private/path", credentials: "private credentials", resumable: true };
  const invoke: NativeHelperCommand = async (file, args) => {
    if (file === "/usr/bin/xcrun") {
      const root = path.dirname(args[3]);
      expect(JSON.parse(fs.readFileSync(path.join(root, "notice.json"), "utf8"))).toEqual(notice);
      expect(fs.readFileSync(args[3], "utf8")).not.toMatch(/raw-error|token=secret|private prompt|private answer|private nonce|private proof|private credentials/);
    }
    return "";
  };
  await executeRunNotice(injected, invoke);
});

it.each([
  { task_id: "bad\nprivate" }, { task_id: "x".repeat(129) }, { task_id: "/private/path" },
  { task_id: "task\n" }, { workspace_id: "a".repeat(24) + "\n" }, { run_id: "b".repeat(32) + "\n" },
  { notification_id: "../unsafe" }, { category: "secret" }, { workspace_id: "credential=secret" }, { run_id: "$(execute)" }, { state: "approval_required" },
])("rejects invalid IDs/state before preparation or dispatch %#", async invalid => {
  tempRoot(); const invoke = vi.fn<NativeHelperCommand>();
  expect(await executeRunNotice({ ...notice, ...invalid } as typeof notice, invoke)).toEqual({ outcome: "process_error" });
  expect(invoke).not.toHaveBeenCalled();
});

it.each([
  [{ code: 7 }, { outcome: "process_exit", exit_code: 7 }],
  [{ code: "ETIMEDOUT", killed: true }, { outcome: "timeout" }],
  [{ code: "ENOENT" }, { outcome: "process_error" }],
])("contains native process failure %# without retry", async (error, expected) => {
  tempRoot(); let root = "";
  const invoke = vi.fn<NativeHelperCommand>(async (file, args) => {
    if (file === "/usr/bin/xcrun") root = path.dirname(args[3]);
    if (file.endsWith("C2CRunNotice")) throw Object.assign(new Error("raw credential=private"), error);
    return "";
  });
  expect(await executeRunNotice(notice, invoke)).toEqual(expected); expect(invoke).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(root)).toBe(false);
});

it("propagates cancellation through compile/sign/run and waits for helper closure", async () => {
  tempRoot();
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const invoke: NativeHelperCommand = async (file, _args, _timeout, signal) => {
    expect(signal).toBe(controller.signal);
    if (!file.endsWith("C2CRunNotice")) return "";
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("fixture closed")), { once: true }));
  };
  const work = executeRunNotice(notice, invoke, controller.signal);
  await ready; controller.abort();
  expect(await work).toEqual({ outcome: "process_error" });
});

it.each(["corrupt", "symlink", "permissive"])("refuses unsafe native receipt %s before invocation", async fault => {
  tempRoot();
  const file = path.join(process.env.C2C_STATE_DIR!, "notification-delivery", notice.notification_id + ".native");
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  fs.writeFileSync(file, fault === "corrupt" ? "invalid" : "", { mode: 0o600 });
  if (fault === "symlink") { fs.renameSync(file, file + ".outside"); fs.symlinkSync(file + ".outside", file); }
  if (fault === "permissive") {
    fs.chmodSync(file, 0o644);
    // Some fixture volumes ignore chmod. Exercise the same descriptor validation there.
    if ((fs.statSync(file).mode & 0o077) === 0) {
      const inode = fs.statSync(file).ino, lstat = fs.lstatSync, fstat = fs.fstatSync;
      const mode = (s: fs.Stats) => { if (s.ino === inode) s.mode |= 0o044; return s; };
      vi.spyOn(fs, "lstatSync").mockImplementation((...args: any[]) => mode((lstat as any)(...args)) as any);
      vi.spyOn(fs, "fstatSync").mockImplementation((...args: any[]) => mode((fstat as any)(...args)) as any);
    }
  }
  const invoke = vi.fn<NativeHelperCommand>();
  expect(await executeRunNotice(notice, invoke)).toEqual({ outcome: "process_error" });
  expect(invoke).not.toHaveBeenCalled();
});


it("requires durable helper click evidence even when stdout claims acknowledgement", async () => {
  tempRoot();
  expect(await executeRunNotice(notice, async file => file.endsWith("C2CRunNotice") ? '{"status":"acknowledged"}' : ""))
    .toEqual({ outcome: "process_exit", exit_code: 0 });
});

it("recovers the helper click receipt after bridge death without opening another window", async () => {
  tempRoot(); receipt();
  const invoke = vi.fn<NativeHelperCommand>();
  expect(await executeRunNotice(notice, invoke)).toEqual({ outcome: "notice_acknowledged" });
  expect(invoke).not.toHaveBeenCalled();
});
