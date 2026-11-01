import { OWNER_DIALOG_HELPER_TIMEOUT_MS } from "../security/owner-dialog-timeouts.js";
import type { OwnerDecision, OwnerRecoveryPrompt } from "./task-reconciler.js";
import { executeFolderScript, WORKSPACE_RECOVERY_APPROVAL_SCRIPT } from "../workspace/registration-native.js";

export const RECOVERY_APPROVAL_SCRIPT = WORKSPACE_RECOVERY_APPROVAL_SCRIPT;
function display(value: string, limit: number): string {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error("Invalid approval display data");
  }
  return value;
}
export function approvalMessage(prompt: OwnerRecoveryPrompt): string {
  if (prompt.workspaceRecovery) {
    return ["現在のワークスペースを再確認して、新しい作業のみ許可します。",
      `対象: ${display(prompt.workspaceName, 255)}`,
      `同じworkspace_id: ${display(prompt.workspaceRecovery.workspaceId, 24)}`,
      `branch: ${display(prompt.evidence.branch ?? "unavailable", 200)}／HEAD: ${display(prompt.evidence.head, 64).slice(0, 12)}`,
      `状態: ${prompt.evidence.changedCount ? "dirty" : "clean"}／変更: ${prompt.evidence.changedCount}件／staged: ${prompt.evidence.staged ? "yes" : "no"}`,
      `不明な過去の記録: ${prompt.workspaceRecovery.records.length}件`,
      ...prompt.workspaceRecovery.records.map(r => `${display(r.task_id, 128)}／${display(r.run_id, 32)}`),
      `現在identity SHA-256: ${display(prompt.workspaceRecovery.identitySha256, 64)}`,
      "過去の結果は不明のまま保持します。元の作業は再実行・再開しません。",
      "filesystem・network・Git・desktopの権限とcapabilitiesは増えません。新しい権限の付与ではありません。",
      "45分で自動拒否。承認は1回限り、変更後は無効です。承認後にroot・repository・profile・branch・HEAD・dirty・staged・pathsを再検証します。",
    ].join("\n\n");
  }
  if (prompt.checkpoint) {
    const c = prompt.checkpoint;
    const excerpt = display(c.instruction_excerpt.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " "), 2048);
    if (excerpt.startsWith("C2C Git push recovery v1:")) {
      return ["C2CのGit push recoveryを1回だけ許可します。現在の検証済みローカルcommitだけをnon-force HTTPS pushします。",
        `対象: ${display(prompt.workspaceName, 255)}\n${display(prompt.workspaceRoot, 4096)}`,
        `作業ID: ${display(prompt.taskId, 128)}／承認スロット: ${c.next_iteration}`,
        `Git push recovery指示: ${excerpt}`,
        `指示のSHA-256: ${display(c.request_sha256, 64)}`,
        `現在の状態の確認値: ${display(prompt.evidence.digest, 64)}`,
        "stage・commit・reset・clean・shellは実行しません。この承認ダイアログは45分で自動的に拒否します。承認ボタンを押した後の実行権限は60秒以内・1回限りです。実行直前にcommit・親・ファイル・index・設定・remoteを再確認します。承認はpush前に消費され、失敗後は新しい承認が必要です。自動再試行はしません。",
      ].join("\n\n");
    }
    if (excerpt.startsWith("C2C Git publish v1:")) {
      return ["C2Cの構造化Git publishを1回だけ許可します。Codex会話や汎用shellは実行しません。",
        `対象: ${display(prompt.workspaceName, 255)}\n${display(prompt.workspaceRoot, 4096)}`,
        `作業ID: ${display(prompt.taskId, 128)}／承認スロット: ${c.next_iteration}`,
        `Git publish指示: ${excerpt}`,
        `指示のSHA-256: ${display(c.request_sha256, 64)}`,
        `現在のファイル・HEAD・index等の確認値: ${display(prompt.evidence.digest, 64)}`,
        "この承認ダイアログは45分で自動的に拒否します。承認ボタンを押した後の実行権限は60秒以内・1回限りです。実行直前に状態とpublish計画を再確認し、承認後に対象ファイル・HEAD・index・設定等が変わっていれば拒否します。指定ファイルだけを100644でstageし、そのindexだけをcommitし、指定remote/branchへnon-force HTTPS pushします。force push・reset/clean・汎用shell・任意コマンドは許可しません。承認は最初のGit書き込み前に消費され、途中失敗時も自動再試行せず新しい承認が必要です。",
      ].join("\n\n");
    }
    return ["チェックポイントから同じ作業を継続します。元の会話は復元しません。",
      `対象: ${display(prompt.workspaceName, 255)}\n${display(prompt.workspaceRoot, 4096)}`,
      `同じ作業ID: ${display(prompt.taskId, 128)}／次の反復: ${c.next_iteration}`,
      `記録がある反復: ${c.known_records.map(r => r.iteration).join(", ")}`,
      c.reported_missing_run ? `申告された反復${c.reported_missing_run.iteration}・run ${display(c.reported_missing_run.run_id, 32)}: 結果不明（UNKNOWN）。本人申告であり実行の証明ではありません。` : "過去の結果は変更しません。",
      `今回の新しい指示のSHA-256: ${display(c.request_sha256, 64)}`,
      `指示の抜粋（秘匿・省略あり）: ${excerpt}`,
      `現在のファイル・プロセスの確認値: ${display(prompt.evidence.digest, 64)}`,
      "この承認ダイアログは45分で自動的に拒否します。承認ボタンを押した後の実行権限は60秒以内の1回限りです。実行前に状態を再確認します。新しい一時的な会話で同じ作業を継続し、元の会話の復元・過去の命令の再実行・古い権限の復活は行いません。サンドボックスと権限範囲は変えません。外部サービス・無視ファイル・DBの影響は未確認です。",
    ].join("\n\n");
  }
  return [
    `対象: ${display(prompt.workspaceName, 255)}`,
    display(prompt.workspaceRoot, 4096),
    `作業: ${display(prompt.taskId, 128)}`,
    `run: ${display(prompt.runId!, 32)}`,
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
const execute: NativeApprovalExecutor = (message, signal) => executeFolderScript(WORKSPACE_RECOVERY_APPROVAL_SCRIPT, [message], OWNER_DIALOG_HELPER_TIMEOUT_MS, signal);
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
