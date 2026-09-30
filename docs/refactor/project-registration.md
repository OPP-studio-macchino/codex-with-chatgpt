# Phase 05 — フォルダ選択でプロジェクトを追加する

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

## 実装範囲

- Mac nativeフォルダ選択（単一フォルダ、外側timeout 122秒）と別の承認ダイアログ。
- 承認は既定「拒否」、30秒無応答で拒否。外側jobは160秒で失効。
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
従来の登録上限16件は維持する。本機能は既存のowner profile設定があり、Codex実行が有効なbridge向け。
空の新規インストールを完成させるsetup wizard、network承認UI、workspace削除/改名、
Windows/Linux native picker、任意の外部エディターとの協調hot reloadは今回の対象外。

## 検証を混同しない

隔離HTTP bridgeと偽Codexプロセス、本人選択/承認のテスト用providerで確認する。
実際に動くbridgeへ追加し、既存作業の結果を失わず新しいworkspaceで実行でき、
bridge close/reopen後にも登録が残ることをテストする。
MacのAppleScriptはコンパイル確認のみ。本人がフォルダを選び許可するnativeクリックE2EはNOT_RUN。
新規ChatGPTで@なしの依頼からこの操作が選ばれることもNOT_RUN。

## 稼働・監査の扱い

候補版0.4.0-dev.4への実装であり、liveサービス・ownerの登録設定は未変更。
P1-03の追加操作を候補実装と隔離テストで扱ったが、配布・native実機受入まで閉じたとはしない。
P1-01/P1-02の配布版・稼働切替、P1-04の新規チャット並行試験、P1-05の復旧実機試験は引き続き別ゲート。
古いdev.3起動bundleはコードと不一致になるため、そのまま適用しない。

参考: Apple公式のchoose folder/display dialog（Standard Additions）の仕様に沿う。
- https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_cmds.html
