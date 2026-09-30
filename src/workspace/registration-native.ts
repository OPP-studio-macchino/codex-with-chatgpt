import { execFile } from "node:child_process";
import { terminateNativeHelper } from "./native-helper-lifecycle.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceProfilesError } from "./profiles.js";
import type { FolderOwner, FolderApprovalPrompt } from "./registration.js";

// Fixed applet sources only. Display text is a data file beside the private bundle.
// A compiled applet owns the UI; the caller does not claim that starting a process
// proves visibility. The session marker blocks late results after cancellation.
const RESULT_HANDLER = `on sessionActive()
  try
    return (read (POSIX file ((POSIX path of (path to me)) & "../active.txt")) as «class utf8») is "active"
  on error
    return false
  end try
end sessionActive
on saveResult(answer)
  if not (my sessionActive()) then return
  set resultFile to open for access (POSIX file ((POSIX path of (path to me)) & "../result.txt")) with write permission
  try
    set eof resultFile to 0
    write answer to resultFile as «class utf8»
    close access resultFile
  on error
    try
      close access resultFile
    end try
  end try
end saveResult`;

export const CHOOSE_PROJECT_SCRIPT = `use scripting additions\non run
  if not (my sessionActive()) then return
  try
    activate
    with timeout of 120 seconds
      set selectedFolder to choose folder with prompt "C2Cで使用するプロジェクトのフォルダを選んでください。選択だけでは利用を許可しません。" multiple selections allowed false showing package contents false
      set answer to POSIX path of selectedFolder
    end timeout
  on error number errorNumber
    if errorNumber is -128 then
      set answer to "cancelled"
    else if errorNumber is -1712 then
      set answer to "timed_out"
    else
      set answer to "native_error"
    end if
  end try
  saveResult(answer)
end run
` + RESULT_HANDLER;

export const APPROVE_PROJECT_SCRIPT = `use scripting additions\non run
  if not (my sessionActive()) then return
  try
    set messageText to read (POSIX file ((POSIX path of (path to me)) & "../message.txt")) as «class utf8»
    activate
    set response to display dialog messageText with title "C2C — プロジェクトの利用許可" buttons {"拒否", "このプロジェクトを許可"} default button "拒否" cancel button "拒否" giving up after 30
    if gave up of response then
      set answer to "timed_out"
    else if button returned of response is "このプロジェクトを許可" then
      set answer to "approved"
    else
      set answer to "denied"
    end if
  on error number errorNumber
    if errorNumber is -128 then
      set answer to "denied"
    else if errorNumber is -1712 then
      set answer to "timed_out"
    else
      set answer to "native_error"
    end if
  end try
  saveResult(answer)
end run
` + RESULT_HANDLER;

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
export type FolderScriptExecutor = (script: string, args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;
export type NativeHelperCommand = (file: string, args: string[], timeoutMs: number, signal: AbortSignal) => Promise<void>;
const command: NativeHelperCommand = (file, args, timeoutMs, signal) => new Promise((resolve, reject) => {
  execFile(file, args, {
    cwd: "/", encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024, signal, killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", LANG: "ja_JP.UTF-8", HOME: process.env.HOME },
  }, error => error ? reject(error) : resolve());
});
function nativeFailure(code: string): never {
  throw new WorkspaceProfilesError(code, "Native project registration could not complete. No approval was applied.");
}

function appleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function executeFolderScript(script: string, args: string[], timeoutMs: number, signal: AbortSignal,
  invoke: NativeHelperCommand = command, stopHelper: (app: string) => Promise<boolean> = terminateNativeHelper): Promise<string> {
  if (script !== CHOOSE_PROJECT_SCRIPT && script !== APPROVE_PROJECT_SCRIPT) nativeFailure("NATIVE_HELPER_SOURCE_INVALID");
  if (signal.aborted) return "cancelled";
  let dir: string | undefined;
  let app: string | undefined;
  let helperMayBeRunning = false;
  let stage = "NATIVE_HELPER_PREPARE_FAILED";
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-folder-owner-"));
    await fs.chmod(dir, 0o700);
    await fs.writeFile(path.join(dir, "active.txt"), "active", { mode: 0o600, flag: "wx" });
    const source = path.join(dir, "owner.applescript");
    app = path.join(dir, "C2C Project Access.app");
    await fs.writeFile(source, script, { mode: 0o600, flag: "wx" });
    await fs.writeFile(path.join(dir, "message.txt"), args[0] ?? "", { mode: 0o600, flag: "wx" });
    stage = "NATIVE_HELPER_COMPILE_FAILED";
    await invoke("/usr/bin/osacompile", ["-o", app, source], 5_000, signal);
    if (signal.aborted) return "cancelled";
    stage = "NATIVE_HELPER_INVOKE_FAILED";
    // Sending run to the compiled app through Apple Events gives the dialog a real
    // foreground application identity. Invoking Contents/MacOS/applet directly
    // reproduces the hidden-behind-Finder failure we observed on macOS.
    const quotedApp = appleQuoted(app);
    helperMayBeRunning = true;
    // Launch without an implicit run. Activation belongs INSIDE the helper run handler;
    // a pre-run external activate returned before its handler executed in the native probe.
    await invoke("/usr/bin/osascript", ["-e", `tell application "${quotedApp}"`, "-e", "launch", "-e", "with timeout of 125 seconds", "-e", "run", "-e", "end timeout", "-e", "end tell"], timeoutMs, signal);
    if (signal.aborted) return "cancelled";
    // Apple Events can acknowledge app launch before the applet writes its reply.
    // Await the bounded reply, not merely the launcher process exit.
    stage = "NATIVE_HELPER_RESPONSE_TIMEOUT";
    const responseDeadline = Date.now() + timeoutMs;
    while (true) {
      if (signal.aborted) return "cancelled";
      try {
        const stat = await fs.lstat(path.join(dir, "result.txt"));
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) nativeFailure("NATIVE_HELPER_RESPONSE_INVALID");
        if (stat.size > 0) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= responseDeadline) nativeFailure("NATIVE_HELPER_RESPONSE_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    stage = "NATIVE_HELPER_RESPONSE_INVALID";
    const file = await fs.open(path.join(dir, "result.txt"), "r");
    try {
      const buffer = Buffer.alloc(16 * 1024 + 1);
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead || bytesRead > 16 * 1024) nativeFailure(stage);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
  } catch (error) {
    if (signal.aborted) return "cancelled";
    if ((error as NodeJS.ErrnoException)?.code === "ETIMEDOUT" || (error as { killed?: boolean })?.killed) {
      nativeFailure(stage === "NATIVE_HELPER_COMPILE_FAILED" ? "NATIVE_HELPER_COMPILE_TIMEOUT" : "NATIVE_HELPER_TIMEOUT");
    }
    nativeFailure(stage);
  } finally {
    // Disarm before process inspection. A late helper cannot issue an accepted result.
    let disarmed = true;
    if (dir) {
      try { await fs.unlink(path.join(dir, "active.txt")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") disarmed = false; }
    }
    if (helperMayBeRunning && app && !(await stopHelper(app))) nativeFailure("NATIVE_HELPER_TERMINATION_FAILED");
    if (!disarmed) nativeFailure("NATIVE_HELPER_CLEANUP_FAILED");
    if (dir) {
      try { await fs.rm(dir, { recursive: true, force: true }); }
      catch { nativeFailure("NATIVE_HELPER_CLEANUP_FAILED"); }
    }
  }
  nativeFailure("NATIVE_HELPER_FAILED");
}

export function createNativeFolderOwner(platform: NodeJS.Platform = process.platform, executor: FolderScriptExecutor = executeFolderScript): FolderOwner {
  return {
    supported: platform === "darwin",
    choose: async (signal) => {
      if (platform !== "darwin") return null;
      if (signal.aborted) return null;
      const selected = await executor(CHOOSE_PROJECT_SCRIPT, [], 122_000, signal);
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
      const answer = await executor(APPROVE_PROJECT_SCRIPT, [projectApprovalMessage(prompt)], 32_000, signal);
      if (signal.aborted || answer === "cancelled") return "denied";
      if (answer === "native_error") nativeFailure("NATIVE_APPROVAL_UI_FAILED");
      if (answer === "approved" || answer === "timed_out" || answer === "denied") return answer;
      nativeFailure("NATIVE_HELPER_RESPONSE_INVALID");
    },
  };
}
