# Phase 04 — 本人確認による中断記録の照合

## 操作体験

接続済みの対応環境では、ユーザーは「中断した作業を確認して、続けて」と依頼する。
ChatGPTが既存のtask_status/task_resume_contextと差分を確認し、IDを自分で取得する。
毎回の@c2c、ID入力、JSONの手編集、「接続した」という中継は通常手順にしない。
初回接続と本人の承認は省略しない。新規ChatGPTでの呼び出し実機評価は未実施。

## 非同期の確認フロー

1. task_reconcile_startがworkspace/task/runを固定して、短い受付結果とrequest IDを返す。
2. 別workerで現在のGit・ファイル状態と残存processの観測を行う。bridgeのイベントループをGit待機で塞がない。
3. Macの固定ダイアログで対象・run・検査範囲・確認hash・解除の意味を表示する。
4. 既定は拒否、30秒無応答も拒否。モデルがapproved=trueを渡す入力は存在しない。
5. 本人承認を一回分として消費し、再検査する。承認から60秒超過、hash変化、実行中process、journal改変等は拒否。
6. 変更がなければ、対象runにallow_new_task_onlyの照合記録をdurable保存する。
7. 元のtaskは再実行せず、不明な結果も成功扱いしない。別の未確認runが残ればそのworkspaceは引き続き停止する。

task_reconcile_statusは短い状態取得のみ。承認や解除を行わない。
解除後も新しいCodex実行は別の通常実行要求として扱い、sandbox・scope・既存の本人承認境界を維持する。
サービス停止・権限revokeでは進行中の照合要求を無効にし、遅れて返る承認を適用しない。
同じworkspaceでの重複要求は既存jobを返し、別runの照合要求は同時に開かない。

## 検査の範囲と限界

- Git HEAD/indexと、tracked＋nonignored untrackedのファイルbytes/modeをhash化する。
- 4000ファイル、各8MiB、合計64MiB、worker20秒を上限とする。保護されたpath・切詰め・submodule・symlink等の不完全な観測は拒否する。
- ignoredファイル、依存ディレクトリ、DB、外部サービス、既に送信済みの処理結果は検査しない。
- process検査はmacOSのps/lsofによる、同じOSユーザーのcwdのスナップショット。
- 対象rootまたは配下をcwdにする残存processがあれば拒否する。情報欠落・権限不明・timeoutでも拒否する。
- lsofに出ないがpsに残るprocessは再確認し、カーネルが終了済み(Z)と示すものだけを終了扱いにする。
- 任意processが保持する全ての書込可能FDや、cwd変更後の派生processまで停止を証明するものではない。
- C2C内の実行中作業は追加のbusy検査で拒否するが、外部の編集者をOS全体でロックする仕組みではない。
- 検査外の影響は、本人とレビュー側が別途確認する。scopeを広く説明して安全保証に置き換えない。

## 記録・権限

元のstate/reason/summary/runtime/task/runは変更しない。source-record hash・evidence hash・承認時刻・照合時刻だけを追加する。
旧runはinterrupted/outcome_known=falseのまま。tests:null/review:not_recorded/goal_status:unverifiedも維持する。
新規要求はcodex.execute、照合状態はexecution.readに加え、既存trusted-tunnel identityが必要。
owner承認は固定したローカル実装でのみ受け取り、HTTP/MCPのcallerには承認結果や検査providerを注入させない。
Mac以外では既定のネイティブ承認はunavailableで止める。証拠や承認のinjectはテスト用のtrusted in-process seamだけ。
資格情報・画像・生のファイル内容・process引数一覧をjournalへ保存しない。

## 互換性

照合metadataのないversion1 journalは読み込める。metadataを書いた後は、古いstrict readerは拒否する。
これは古い版へ無条件rollbackできるという意味ではない。解除履歴を消すdowngradeやjournal削除は行わない。
dev.2の起動bundleは、このコード変更後には無効。新しいbundleを生成し直し、稼働反映前に再検証する。

## 検証と未実施

自動テストでは本物のjournal・隔離HTTP bridgeを使い、承認応答と検査を模擬して、
拒否/timeout/変化/取り違え/取消/旧task再実行拒否/承認後の新task/再起動後保持を確認する。
Mac実機では検査workerの空repo/残存process拒否と、AppleScriptコンパイルを別途確認する。
実際の承認ダイアログで本人がボタンを押すE2Eは未実施。検査・承認結果を模擬したテストと混同しない。
稼働service切替、Mac再起動、新規ChatGPTでの@なし試験、commit/push/deployはこの工程では行わない。
