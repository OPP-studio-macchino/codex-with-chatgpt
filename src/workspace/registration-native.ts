import { OWNER_DIALOG_TIMEOUT_SECONDS, OWNER_DIALOG_HELPER_TIMEOUT_MS } from "../security/owner-dialog-timeouts.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceProfilesError } from "./profiles.js";
import type { FolderOwner, FolderApprovalPrompt, WorkspaceRemovalPrompt } from "./registration.js";

export const CHOOSE_PROJECT_SCRIPT = "choose-project";
export const APPROVE_PROJECT_SCRIPT = "approve-project";
export const APPROVE_UNREGISTER_PROJECT_SCRIPT = "approve-unregister-project";
export const LOCAL_GIT_APPROVAL_SCRIPT = "approve-git";
export const LOCAL_NETWORK_APPROVAL_SCRIPT = "approve-network";
export const LOCAL_COMMAND_APPROVAL_SCRIPT = "approve-command";
export const WORKSPACE_RECOVERY_APPROVAL_SCRIPT = "approve-recovery";

// Fixed source: caller data is read only from the bounded message file.
const SWIFT_SOURCE = String.raw`import AppKit
import Foundation
func reply(_ value: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), data.count <= 16384 else { return }
    FileHandle.standardOutput.write(data)
}
let app = NSApplication.shared
app.finishLaunching()
let mode = CommandLine.arguments.count == 2 ? CommandLine.arguments[1] : ""
func front(_ window: NSWindow) {
    window.level = .modalPanel
    window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
    window.center()
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    app.activate(ignoringOtherApps: true)
    NSRunningApplication.current.activate(options: [.activateAllWindows])
}
if mode == "choose-project" {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.message = "C2Cで使用するプロジェクトのフォルダを選んでください。選択だけでは利用を許可しません。"
    var expired = false
    let timer = Timer(timeInterval: ${OWNER_DIALOG_TIMEOUT_SECONDS}, repeats: false) { _ in
        expired = true
        panel.cancel(nil)
        app.abortModal()
    }
    RunLoop.main.add(timer, forMode: .modalPanel)
    app.activate(ignoringOtherApps: true)
    let response = panel.runModal()
    timer.invalidate()
    if expired { reply(["status": "timed_out"]) }
    else if response == .OK, let url = panel.url { reply(["status": "selected", "path": url.path]) }
    else { reply(["status": "cancelled"]) }
} else if mode == "approve-project" || mode == "approve-unregister-project" || mode == "approve-git" || mode == "approve-command" || mode == "approve-recovery" || mode == "approve-network" {
    let url = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("message.txt")
    if let file = try? FileHandle(forReadingFrom: url) {
        let data = try? file.read(upToCount: 16385)
        try? file.close()
        if let data = data, data.count <= 16384, let message = String(data: data, encoding: .utf8) {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = mode == "approve-network" ? "C2C — HTTPS 宛先要求の一回承認" : mode == "approve-recovery" ? "C2C — ワークスペースの再確認" : mode == "approve-git" ? "C2C — Git 操作の一回承認" : mode == "approve-command" ? "C2C — コマンド実行の一回承認" : mode == "approve-unregister-project" ? "C2C — プロジェクトの登録解除" : "C2C — プロジェクトの利用許可"
            alert.informativeText = message
            let deny = alert.addButton(withTitle: "拒否")
            deny.isEnabled = true
            deny.keyEquivalent = "\r"
            let approve = alert.addButton(withTitle: mode == "approve-network" ? "この宛先要求を一回許可" : mode == "approve-recovery" ? "確認して新しい作業を許可" : mode == "approve-git" ? "この Git 操作を一回許可" : mode == "approve-command" ? "このコマンドを一回許可" : mode == "approve-unregister-project" ? "この登録を解除" : "このプロジェクトを許可")
            approve.isEnabled = false
            approve.keyEquivalent = ""
            alert.window.defaultButtonCell = deny.cell as? NSButtonCell
            var expired = false
            var finished = false
            let timer = Timer(timeInterval: ${OWNER_DIALOG_TIMEOUT_SECONDS}, repeats: false) { _ in
                expired = true
                app.abortModal()
                alert.window.orderOut(nil)
            }
            RunLoop.main.add(timer, forMode: .modalPanel)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                guard !expired && !finished else { return }
                approve.isEnabled = true
            }
            front(alert.window)
            FileHandle.standardError.write(Data("C2C_NATIVE_READY_V1\n".utf8))
            let response = alert.runModal()
            finished = true
            timer.invalidate()
            reply(["status": expired ? "timed_out" : response == .alertSecondButtonReturn && approve.isEnabled ? "approved" : "denied"])
        } else { reply(["status": "failed"]) }
    } else { reply(["status": "failed"]) }
} else { reply(["status": "failed"]) }
`;

// Fixed bundle identity; no caller data belongs in this manifest.
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>tech.opp-studio.c2c.project-access</string>
<key>CFBundleName</key><string>C2C Project Access</string>
<key>CFBundleExecutable</key><string>C2CProjectAccess</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;

function display(value: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error("Invalid folder approval display");
  return value;
}
export function projectApprovalMessage(prompt: FolderApprovalPrompt): string {
  return [
    `プロジェクト: ${display(prompt.workspaceName, 255)}`,
    display(prompt.workspaceRoot, 4096),
    "このフォルダと配下の読取・編集、およびCodexによる実装・テストを、接続中のC2Cから利用可能にします。",
    "許可は設定に保存され、次回も使用できます。作業のたびの再登録は不要です。",
    "Mac全体の許可ではありません。Desktop Agentの別フォルダ・追加の通信先・公開やdeployを承認するものではありません。",
    "今回の登録だけではファイルの編集・Codex実行・選択中プロジェクトの切替は行いません。",
    "確認中に対象フォルダや承認設定が変わった場合は登録を中止します。",
  ].join("\n\n");
}
export function projectUnregistrationMessage(prompt: WorkspaceRemovalPrompt): string {
  return [
    `プロジェクト: ${display(prompt.workspaceName, 255)}`,
    `登録ID: ${display(prompt.profileId, 64)}`,
    "このプロジェクトのC2C利用登録を解除します。設定からの解除は取り消せません。再利用には、フォルダ選択と本人の新しい承認が必要です。",
    "プロジェクトディレクトリ、ファイル、過去のJournal、実行履歴は削除しません。",
    "実行中、結果不明、または待機中のタスクがある場合は解除されません。",
    "確認中に登録設定や対象状態が変わった場合は解除を中止します。",
  ].join("\n\n");
}
export type FolderScriptExecutor = (script: string, args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;
export type NativeHelperPhase = "prepare" | "compile" | "sign" | "launch" | "pending_owner";
export const NATIVE_HELPER_STARTUP_TIMEOUT_MS = 45_000;
// The promise settles on close, including after an abort or forced kill.
export type NativeHelperCommand = (file: string, args: string[], timeoutMs: number, signal: AbortSignal, onReady?: () => void) => Promise<string>;
export const nativeHelperCommand: NativeHelperCommand = (file, args, timeoutMs, signal, onReady) => new Promise((resolve, reject) => {
  let failure: Error | null = null;
  let output = "";
  let callbackDone = false;
  let closeDone = false;
  let settled = false;
  const settle = () => {
    if (settled || !callbackDone || !closeDone) return;
    settled = true;
    failure ? reject(failure) : resolve(output);
  };
  const child = execFile(file, args, {
    cwd: "/", encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024, signal, killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", LANG: "ja_JP.UTF-8", HOME: process.env.HOME },
  }, (error, stdout) => {
    failure = error;
    output = stdout;
    callbackDone = true;
    settle();
  });
  // Fixed helper signal only. Neither window visibility nor owner receipt is proven.
  let stderr = "";
  let reported = false;
  child.stderr?.on("data", (chunk: Buffer | string) => {
    if (!onReady || reported || callbackDone || closeDone || settled || signal.aborted) return;
    stderr = (stderr + chunk.toString()).slice(-16 * 1024);
    if (/(?:^|\n)C2C_NATIVE_READY_V1\n/.test(stderr)) {
      reported = true;
      onReady();
    }
  });
  child.once("close", () => {
    closeDone = true;
    settle();
  });
});
function nativeFailure(code: string): never {
  throw new WorkspaceProfilesError(code, "Native project registration could not complete. No approval was applied.");
}
function parseReply(output: string, mode: string): string {
  if (!output || Buffer.byteLength(output, "utf8") > 16 * 1024) nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID");
  let reply: unknown;
  try { reply = JSON.parse(output); } catch { nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID"); }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID");
  const value = reply as Record<string, unknown>;
  if (mode === CHOOSE_PROJECT_SCRIPT && value.status === "selected" && Object.keys(value).length === 2 && typeof value.path === "string" && value.path.startsWith("/")) {
    try { return display(value.path, 4096); } catch { nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID"); }
  }
  if (Object.keys(value).length !== 1) nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID");
  if (value.status === "failed") nativeFailure("NATIVE_HELPER_RUN_FAILED");
  const allowed = mode === CHOOSE_PROJECT_SCRIPT ? ["cancelled", "timed_out"] : ["approved", "denied", "timed_out"];
  if (typeof value.status !== "string" || !allowed.includes(value.status)) nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID");
  return value.status;
}

export async function executeFolderScript(script: string, args: string[], timeoutMs: number, signal: AbortSignal,
  invoke: NativeHelperCommand = nativeHelperCommand, onPhase?: (phase: NativeHelperPhase) => void): Promise<string> {
  if (script !== LOCAL_NETWORK_APPROVAL_SCRIPT && script !== CHOOSE_PROJECT_SCRIPT && script !== APPROVE_PROJECT_SCRIPT && script !== APPROVE_UNREGISTER_PROJECT_SCRIPT && script !== LOCAL_GIT_APPROVAL_SCRIPT && script !== LOCAL_COMMAND_APPROVAL_SCRIPT && script !== WORKSPACE_RECOVERY_APPROVAL_SCRIPT) nativeFailure("NATIVE_HELPER_SOURCE_INVALID");
  if (signal.aborted) return "cancelled";
  let dir: string | undefined;
  let stage = "NATIVE_HELPER_PREPARE_FAILED";
  try {
    onPhase?.("prepare");
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-folder-owner-"));
    await fs.chmod(dir, 0o700);
    const source = path.join(dir, "main.swift");
    const bundle = path.join(dir, "C2C Project Access.app");
    const contents = path.join(bundle, "Contents");
    const helper = path.join(contents, "MacOS", "C2CProjectAccess");
    await fs.writeFile(source, SWIFT_SOURCE, { mode: 0o600, flag: "wx" });
    const message = args[0] ?? "";
    if (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 16 * 1024) nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID");
    await fs.writeFile(path.join(dir, "message.txt"), message, { mode: 0o600, flag: "wx" });
    await fs.mkdir(path.dirname(helper), { recursive: true });
    await fs.writeFile(path.join(contents, "Info.plist"), INFO_PLIST, { mode: 0o600, flag: "wx" });
    try {
      const directory = await fs.lstat(dir);
      if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) nativeFailure("NATIVE_HELPER_PREPARE_FAILED");
      for (const file of [source, path.join(dir, "message.txt"), path.join(contents, "Info.plist")]) {
        const info = await fs.lstat(file);
        if (!info.isFile() || (info.mode & 0o777) !== 0o600) nativeFailure("NATIVE_HELPER_PREPARE_FAILED");
      }
    } catch {
      nativeFailure("NATIVE_HELPER_PREPARE_FAILED");
    }
    if (signal.aborted) return "cancelled";
    stage = "NATIVE_HELPER_COMPILE_FAILED";
    onPhase?.("compile");
    await invoke("/usr/bin/xcrun", ["swiftc", "-framework", "AppKit", source, "-o", helper], 15_000, signal);
    if (signal.aborted) return "cancelled";
    stage = "NATIVE_HELPER_SIGN_FAILED";
    onPhase?.("sign");
    await invoke("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "tech.opp-studio.c2c.project-access", bundle], 15_000, signal);
    if (signal.aborted) return "cancelled";
    stage = onPhase ? "NATIVE_HELPER_LAUNCH_FAILED" : "NATIVE_HELPER_RUN_FAILED";
    onPhase?.("launch");
    let ready = false;
    const output = await invoke(helper, [script], timeoutMs, signal, onPhase ? () => {
      if (ready || signal.aborted) return;
      ready = true;
      stage = "NATIVE_HELPER_RUN_FAILED";
      onPhase("pending_owner");
    } : undefined);
    if (signal.aborted) return "cancelled";
    if (onPhase && !ready) nativeFailure("NATIVE_HELPER_NOT_READY");
    return parseReply(output, script);
  } catch (error) {
    if (signal.aborted) return "cancelled";
    if (error instanceof WorkspaceProfilesError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") nativeFailure("NATIVE_HELPER_PROTOCOL_INVALID");
    if ((error as NodeJS.ErrnoException)?.code === "ETIMEDOUT" || (error as { killed?: boolean })?.killed) {
      nativeFailure(stage.replace(/_FAILED$/, "_TIMEOUT"));
    }
    nativeFailure(stage);
  } finally {
    if (dir) {
      try { await fs.rm(dir, { recursive: true, force: true }); }
      catch { nativeFailure("NATIVE_HELPER_CLEANUP_FAILED"); }
    }
  }
  nativeFailure("NATIVE_HELPER_RUN_FAILED");
}

export function createNativeFolderOwner(platform: NodeJS.Platform = process.platform, executor: FolderScriptExecutor = executeFolderScript): FolderOwner {
  return {
    supported: platform === "darwin",
    choose: async (signal) => {
      if (platform !== "darwin") return null;
      if (signal.aborted) return null;
      const selected = await executor(CHOOSE_PROJECT_SCRIPT, [], OWNER_DIALOG_HELPER_TIMEOUT_MS, signal);
      if (signal.aborted || selected === "cancelled") return null;
      if (selected === "timed_out") nativeFailure("NATIVE_FOLDER_TIMEOUT");
      if (selected === "native_error") nativeFailure("NATIVE_FOLDER_UI_FAILED");
      if (!selected.startsWith("/")) nativeFailure("NATIVE_HELPER_RESPONSE_INVALID");
      try { return display(selected, 4096); }
      catch { nativeFailure("NATIVE_HELPER_RESPONSE_INVALID"); }
    },
    approve: async (prompt, signal) => {
      if (platform !== "darwin") return "unavailable";
      if (signal.aborted) return "denied";
      const unregistering = !("workspaceRoot" in prompt);
      const answer = await executor(unregistering ? APPROVE_UNREGISTER_PROJECT_SCRIPT : APPROVE_PROJECT_SCRIPT,
        [unregistering ? projectUnregistrationMessage(prompt) : projectApprovalMessage(prompt)], OWNER_DIALOG_HELPER_TIMEOUT_MS, signal);
      if (signal.aborted || answer === "cancelled") return "denied";
      if (answer === "native_error") nativeFailure("NATIVE_APPROVAL_UI_FAILED");
      if (answer === "approved" || answer === "timed_out" || answer === "denied") return answer;
      nativeFailure("NATIVE_HELPER_RESPONSE_INVALID");
    },
  };
}
