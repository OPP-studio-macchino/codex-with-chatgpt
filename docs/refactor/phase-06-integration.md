# Phase 06 — 統合レビューと実機受入

## @なしの確認

ユーザーの依頼に@指定がない状態で、現在の会話からlive C2Cのworkspace_profilesを実際に呼び出した。
これは既存会話・既存接続での到達確認。dev.5を反映した新規ChatGPTチャットのルーティング試験とは別である。

## 再現して修正した統合上の問題

### I1 OAuth接続の省略時読取先

trusted接続がbetaを選択すると、OAuth側がworkspace_idを省略したread_fileでもbetaを読めた。
OAuthはbridgeのanchorへ認可されるため、省略時はdefaultProfileIdのworkspaceへ固定した。
explicitな別workspace指定は従来どおり拒否する。ツール名・入力schema・scopeは変更しない。
実在のWorkspaceProfilesとin-memory MCPを使う回帰テストで修正前の失敗と修正後の成功を確認。

### I2 登録済みprojectが1件から2件になると既存waitが失敗

1件時にworkspace_idなしで開始したtaskが、追加後の同じwaitでWORKSPACE_ID_REQUIREDとなった。
waitは既知のtaskに保存済みのworkspace bindingだけを参照して補完する。現在の共有selectionからは補完しない。
複数projectでの新規startや不明なtaskは従来どおり明示IDを要求する。IDはモデルが取得し、利用者には入力させない。
隔離HTTP bridgeとテスト用Codexによる回帰試験を追加した。

## 当時OPENだったI3：別anchorで同じworkspaceを使う場合の復旧ガード

Phase 06時点のjournalはanchor単位。anchor A配下のworkspace Bに未確認runが残っていても、
同じstateディレクトリからanchor Bとして別journalを開くとcheckStartがその未確認runを見ない。
実際のTaskJournalと隔離stateで再現。Codex実行・既存設定変更は行っていない。
この問題は未修正であり、インストール単位でのworkspace履歴の所在・writerを整合させる必要がある。
全体の稼働切替は、この復旧ガードの整合と本人実機試験の結果を確認するまで保留する。

## 検証の区別

- dev.4の全体回帰を再実行後、上記2件の再現テストを先に失敗させてから修正した。
- dev.5の全体回帰・typecheck・build・skill検証を実行。詳細は.local/phase06-green-validation.json。
- 独立Codexレビューは200秒でtimebox。完結した監査報告は得ていない。
  途中で得た指摘は、別の再現テストで検証し、上記のように分類した。
- native実機試験は.local/phase06-native-acceptance.jsonを正とする。fixtureのみを登録し、
  フォルダ選択と承認は実際のosascript providerを使用する。想定外のフォルダ選択はテスト側で拒否する。
- native試験の成功は、ChatGPTでの新規チャット自動選択やMacログイン後の自動起動の成功ではない。
- liveソース・LaunchAgents・本番profile config・他プロジェクトは変更しない。commit/push/deployなし。

## 稼働切替ゲート

1. I3の復旧ガードを同一workspaceに一貫して適用する。
2. nativeフォルダ選択・本人承認・実Codex fixture実行・再起動後の結果取得を確認する。
3. source/buildを固定し、起動bundleを再生成・照合する。古いdev.4 bundleは適用しない。
4. 稼働中の作業を確認したうえで切替を調整し、新規ChatGPTチャットで@なしの実機評価を行う。

## Phase 09での更新

I3はtarget別journal/lockとcross-anchor HTTP回帰で修正。旧anchor混在記録を起動前に検出し、
保全したまま停止する互換性ガードを追加。native実機受入も後続Phase 08でPASSした。
上記は当時の記録として残す。最新判定は [統合候補](integration-candidate.md) と.local/phase09-review.jsonを参照。
