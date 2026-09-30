import { execFile } from "node:child_process";
import type { OwnerDecision, OwnerRecoveryPrompt } from "./task-reconciler.js";

// The script and buttons are fixed; all display data is passed as argv, never interpolated into code.
export const RECOVERY_APPROVAL_SCRIPT = `on run argv
  try
    set answer to display dialog (item 1 of argv) with title "C2C — 中断作業の確認" buttons {"拒否", "確認して次の作業を許可"} default button "拒否" cancel button "拒否" giving up after 30
    if gave up of answer then return "timed_out"
    if button returned of answer is "確認して次の作業を許可" then return "approved"
    return "denied"
  on error
    return "denied"
  end try
end run`;
function display(value: string, limit: number): string {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error("Invalid approval display data");
  }
  return value;
}
export function approvalMessage(prompt: OwnerRecoveryPrompt): string {
  return [
    `対象: ${display(prompt.workspaceName, 255)}`,
    display(prompt.workspaceRoot, 4096),
    `作業: ${display(prompt.taskId, 128)}`,
    `run: ${display(prompt.runId, 32)}`,
    `Git管理対象＋未無視ファイル: ${prompt.evidence.fileCount}件／変更: ${prompt.evidence.changedCount}件`,
    `確認対象: ${display(prompt.evidence.digest, 64)}`,
    "この場所を作業ディレクトリとする同一ユーザーの残存プロセスは検出されませんでした。",
    "差分と中断前の依頼内容を確認してください。無視ファイル・DB・外部サービスの結果は未確認です。",
    "元の実行結果は「不明」のまま保存します。再実行・元の会話の再開はしません。",
    "承認するのは、この記録による停止を解除し、新しい依頼を始められるようにすることだけです。",
    "承認後にファイルや処理状態が変わっていれば解除しません。",
  ].join("\n\n");
}
export type NativeApprovalExecutor = (message: string, signal: AbortSignal) => Promise<string>;
const execute: NativeApprovalExecutor = (message, signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve("denied"); return; }
  execFile("/usr/bin/osascript", ["-e", RECOVERY_APPROVAL_SCRIPT, "--", message], {
    cwd: "/", encoding: "utf8", timeout: 32_000, maxBuffer: 2048, signal,
    env: { PATH: "/usr/bin:/bin", LANG: "ja_JP.UTF-8" },
  }, (error, stdout) => resolve(error ? "denied" : stdout.trim()));
});
export function createNativeRecoveryApproval(
  platform: NodeJS.Platform = process.platform,
  executor: NativeApprovalExecutor = execute,
): (prompt: OwnerRecoveryPrompt, signal: AbortSignal) => Promise<OwnerDecision> {
  return async (prompt, signal) => {
    if (platform !== "darwin") return "unavailable";
    if (signal.aborted) return "denied";
    try {
      const answer = await executor(approvalMessage(prompt), signal);
      if (signal.aborted) return "denied";
      return answer === "approved" ? "approved" : answer === "timed_out" ? "timed_out" : "denied";
    } catch { return "denied"; }
  };
}
