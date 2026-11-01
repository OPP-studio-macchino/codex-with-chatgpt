# Phase 05 / RC2 — プロジェクトの追加と登録解除

## 通常の使い方

接続済みの対応環境では「新しいローカルプロジェクトを追加して」と依頼する。
ChatGPTが `workspace_register_start` を呼び、Mac上で本人がフォルダを1つ選ぶ。
対象の正規化済みパスと、読取・編集・Codex実装/テストの利用範囲を確認し、許可する。
登録後は `workspace_register_status` のworkspaceIdをChatGPTが引き継ぐ。
JSON編集・絶対パスや内部IDの手入力・再接続・「接続した」報告・毎回の@c2c指定は通常手順にしない。

## 追加と実行は別

この登録だけでファイルを編集したりCodexを起動したりしない。選択中のプロジェクトも変えない。
ネットワークhostとDesktop Agentのroot/writable設定は追加・変更しない。
新しいprofileのnetwork allowlistは空。既存のprofile・default・選択・実行clientは維持する。
同じフォルダが登録済みなら、再承認や設定書込をせず既存のworkspaceIdを返す。

## 登録解除（プロジェクト本体は削除しない）

登録済みプロジェクトの一覧は workspace_profiles で確認する。100件を超える場合は after_profile_id で次ページへ進む。
本人が明示的に解除を求めた場合のみ、一覧で得た profile.id を workspace_unregister_start の profile_id に渡す。workspace_unregister_status は registration_id によって結果を取得するだけで、承認や解除は行わない。
Macの専用「C2C — プロジェクトの登録解除」ダイアログで本人が対象名・登録IDを確認し、別個のnative承認を行う。既定ボタンは拒否。無応答や拒否で設定は変わらない。
解除で変更するのはC2Cのowner-onlyプロファイル登録のみ。**フォルダ・ソース・Journal・履歴は削除しない**。
default/anchor、選択中、実行中・承認待ち・状態不明・未消費の承認checkpointがあるworkspaceは解除不可。承認後にも設定とJournal状態を再検証し、競合時は拒否する。保留中の同一profileへの要求だけが同じjobを返し、別IDは拒否する。
解除されたプロジェクトを再利用するには新たなフォルダ選択と本人承認が必要になる。MCPから生パス、remote承認フラグ、任意の操作コマンドは受け付けない。

## 実装範囲

- Mac nativeフォルダ選択（単一フォルダ）と別の承認ダイアログを使用。各Swift/AppKit本人ダイアログは最長45分でタイムアウトし、helper上限は45分5秒。
- 承認は既定「拒否」。許可ボタンは最初の1秒間無効。本人無応答では各ダイアログが45分で拒否される。2段階処理の登録jobには総上限5,590,000ms（約93分10秒）を設ける。
- startは受付IDを返す。選択・承認を応答内で待たず、statusは状態を読むだけ。
- 同時の追加要求は進行中jobに集約し、余分なダイアログを出さない。
- 必要な既存scopeとtrusted-tunnel identityを確認する。MCPにpathやapprovedフラグはない。
- 正規化パス・directory identity・承認前config bytesを保持し、承認後に再確認。
- profileファイルへowner-onlyの排他lock、temp+fsync+renameで追記相当の更新。
- 永続化成功後に同じWorkspaceProfilesインスタンスへ追加し、bridge再起動なしで使える。
- 既存設定の手編集、フォルダの差替え、設定の置換、symlinkや非private保存先は拒否する。
- 保存結果が不明な場合は成功とせず追加操作を止める。旧entryや選択状態を黙って上書きしない。
- サービス停止と権限取消で進行中jobを取り消し、遅れて返った承認は使わない。

## 検査の境界

filesystem/homeルート、認証・機密用ディレクトリ、state内/包含、profile設定を包含するフォルダ、
既存rootとの親子重複は許可しない。重複scopeによる並行書込の取り違えを避ける。
旧固定登録上限16件は撤廃した。ただしowner profile設定ファイルの64KiB上限・原子的保存・owner-only権限は維持し、無制限の容量を保証するものではない。本機能は既存のowner profile設定があり、Codex実行が有効なbridge向け。
空の新規インストールを完成させるsetup wizard、network承認UI、プロジェクトの物理的なフォルダ削除/改名、
Windows/Linux native picker、任意の外部エディターとの協調hot reloadは今回の対象外。

## 検証を混同しない

隔離HTTP bridgeと偽Codexプロセス、本人選択/承認のテスト用providerで確認する。
実際に動くbridgeへ追加し、既存作業の結果を失わず新しいworkspaceで実行でき、
bridge close/reopen後にも登録が残ることをテストする。
Macの承認UIはAppleScriptではなくSwift/AppKitのNSAlert。2026-11-01の先行隔離候補では実際のnative承認を経由した使い捨てdisposableの登録解除がPASSし、anchorとプロジェクトファイルの保持を検証した。RC2の本番接続/公開は別途検収が必要。
新規ChatGPTで@なしの依頼からこの操作が選ばれることもNOT_RUN。

## 稼働・監査の扱い

開発履歴のPhase 05記録をRC2候補向けに更新した。現行RC2検証物は0.4.0-dev.6を元に作成し、ライブサービス・ownerの登録設定は未変更。
P1-03の追加操作を候補実装と隔離テストで扱ったが、配布・native実機受入まで閉じたとはしない。
P1-01/P1-02の配布版・稼働切替、P1-04の新規チャット並行試験、P1-05の復旧実機試験は引き続き別ゲート。
古いdev.3起動bundleはコードと不一致になるため、そのまま適用しない。

参考: Apple公式のchoose folder/display dialog（Standard Additions）の仕様に沿う。
- https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_cmds.html

## RC2の受入境界

RC1の依存監査で指摘された脆弱性に対し、RC2は固定lock更新・互換性試験と公開文書の整合を必要とする。RC2のソースが合格しても、稼働C2C側へツールが公開されるには別途正式リリース・接続更新・実機受入が必要。2026-11-01時点で既存16件の登録と稼働Bridgeは保全する。
