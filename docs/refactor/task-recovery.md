# Phase 03 — 中断後の状況確認と再開用引継ぎ

## ユーザー体験

接続済みの対応環境では「さっきの作業はどうなった？」「続けて」と依頼する。
ChatGPTが承認済みworkspaceの `task_status` から作業を探し、`task_resume_context` で
引継ぎと確認事項を取得する。ユーザーに@c2c・内部task/run IDの記憶や入力を要求しない。
対象が複数あって曖昧な場合だけ、どのプロジェクト・作業かを確認する。

## 実装した契約

- Codex childを開始する前に、task/workspace/iteration/runと指示のSHA-256を同期保存する。
- 完了・失敗・承認停止は `codex_turn_wait` を呼ばなくても保存する。
- 同じtask/iterationと同一指示で結果を再取得しても再実行しない。指示が異なれば拒否する。
- 以前のruntimeの未完了実行は `interrupted` / `outcome_known:false`。失敗と断定しない。
- 強制停止・timeout・child消失等も、再起動後に部分的な影響が不明なら確認対象にする。
- 不明な実行があるworkspaceでは、元のtaskだけでなく新しいtaskによる迂回再実行も拒否する。
- 完了済みでも、失われたCodex会話に次のiterationを送ることは拒否する。
- `task_status` と `task_resume_context` は `execution.read`。child起動・新規承認・grant再利用はしない。
- 複数workspace構成では、既存の明示workspace IDとtrusted-tunnel境界を維持する。

## 保存するもの・しないもの

owner-onlyの状態ディレクトリへ、指示のredacted excerpt（最大2048 bytes）、その省略有無、
元の指示のSHA-256、task/workspace/runの識別子、状態、時刻、redacted summary（最大8192 bytes）を保存する。
指示全文、ソース全文、画像、stdout全文、資格情報、Codex thread IDは保存しない。
保存した文章は過去の未信頼データであり、改めて実行する指示や本人の許可にはしない。

実行終了と依頼達成を分けるため、現段階のjournalでは `tests:null`、`review:not_recorded`、
`goal_status:unverified` を返す。Codexが自己申告した「テストPASS」を自動で認定しない。
既存execution_summary/test_statusは従来の確認口として残す。

## 保全と排他

1 target workspaceにつき1つのjournal、最大1000 tasks / 4000 runs / 4MiB。容量超過で古いtaskを黙って捨てず停止する。
tempの排他的作成・fsync・renameで更新し、同一targetの二重writerをlockで拒否する。
以前のwriterが確実に終了している場合のみstale lockを回収し、存命・PID再利用・権限不明はbusyとする。
壊れた記録・oversize・symlink・非owner-only設定を空の履歴として扱わない。
保存失敗後は成功を報告せず、追加実行を停止する。

## 検証の範囲

テスト用Codexプロセスと隔離HTTP bridgeを使用。waitしない完了保存、bridge close/reopen後の
結果再取得、保存してからcleanupなしで終了した別プロセスの記録復旧、再実行拒否、
scope制限、redaction、壊れた記録、lock競合、書込障害を検証する。
これは本物のChatGPTのstream障害注入・Mac再起動・実モデルの新規チャット選択テストではない。

## 未実装・次のゲート

- 不明な実行の照合は [Phase 04](task-reconciliation.md) に追加。稼働反映と実際の本人承認E2Eは未実施。
- 現在のrevision/diffとテスト・独立レビューの証拠を結び付ける仕組み。
- 容量に達した履歴を安全に整理するowner向け導線。
- 既にnext.18で終わったrunの過去履歴を、後から完全なjournalとして復元する移行。
- 本番service切替と新規ChatGPTチャットでの@なし実機試験。

今回の復旧は「保存済み結果の再取得」と「状況確認用引継ぎ」。不明な処理を勝手に再実行する
resumeボタンではない。途中のCodex会話の完全復元、レビューまでの自動継続も保証しない。
前段で生成したdev.1起動bundleはコード変更により古くなるため、そのまま適用しない。

現在の統合状態と旧anchor形式の扱いは [統合候補](integration-candidate.md) を参照。
