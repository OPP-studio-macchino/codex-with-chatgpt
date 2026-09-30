# C2C 監査対応の統合候補 — 0.4.0-dev.6

## この候補の目的と境界

利用者は「調べて」「直して」「続けて」と依頼する。接続済みでツールが提供される場面で、
@c2c、内部ID、JSON編集、再接続の報告を通常手順にしない。本人承認は省略しない。

この文書はPhase 01〜08の記録を統合する現在地。過去のログや失敗を削除・上書きしない。
C2C本体の基盤リファクタリングと、別チャットのanpi-watchの登録・ブランチ作業を混ぜない。
user_input_requiredへのreply、temporary read-only rootは別の要望として残し、この候補で完了扱いしない。

## 統合した機能

- 目的を基準にしたMCP説明・呼出契約。@入力と「接続した」の中継を通常経路に要求しない。
- 共通release manifestからbridge/Tunnelの起動設定候補を生成・照合する。
- 作業のworkspace ID固定、OAuthの読取先固定、新規project追加後の既存waitを維持する。
- 実行前と終端時に記録を保存し、問い合わせがなくても結果を残す。
- 中断結果は不明のまま保持し、照合と本人承認後も元taskを再実行しない。
- nativeフォルダ選択・承認によりprofileを追加。同じ接続から利用でき、既存選択を変えない。
- journalとwriterはbridgeのanchorでなく対象workspace単位。別anchorから同じtargetを開いても同じ記録・lockを使う。

## 実機で完了したもの

2026-09-30 11:59 JST、隔離したC2C登録テストで以下を確認した。
本物のフォルダ選択 → 本人承認 → 登録 → 実Codexでmarker読取 → bridge close/reopen後の結果取得。
証跡: `.local/phase08-reopen-1790737049678184000.json`。
実機試験のregistration-native.tsのコードはPhase 09では変更しない。
これは新規ChatGPTチャットでの自動選択、Mac全体の再起動、稼働版への反映の証明ではない。

## 古い作業記録の扱い

初期候補のanchor別journalには、ファイル名と異なるworkspaceの記録が入る場合があった。
新しいtarget別記録だけを探して、それを空の履歴だと扱ってはいけない。
`inspectTaskJournalLayout`を実行有効bridgeの起動前に実行し、混在した旧記録を検出したら
`TASK_JOURNAL_MIGRATION_REQUIRED`で停止する。停止はidentity/token/listener/childの作成前。
既存記録の削除、空への置換、自動移行、自動再実行はしない。
不正形式、読み取れない記録、検査中の変更も成功扱いしない。
検査は最大256 directory entries・合計64MiB・1ファイル4MiB。検査結果に本文・資格情報を出さない。

これは自動移行機能ではない。旧候補の記録がある利用者は停止した状態で保全・移行を別途行う。
新旧サービスを同じstateで同時稼働させる保証ではなく、切替前の作業停止確認が必要。
現在のlive next.18のstateにはtask-journalディレクトリ自体がないことをread-onlyで確認した。
next.18の既存execution recordsは削除せず、完全なCodex会話へ復元できるとも扱わない。

## 監査項目の現在地（製品全体のPASS宣言ではない）

| 項目 | 候補での対応 | まだ必要な確認 |
|---|---|---|
| P1-01 配布物と稼働版の不一致 | 対応ソース・build・manifestを固定 | このタグのソース公開・配布物を照合。main統合と第三者導入は別途 |
| P1-02 起動gateの版不一致 | 同一manifestの設定候補を生成・検証 | 稼働設定への適用と起動復旧、rollback実行 |
| P1-03 workspace追加の手作業 | native登録と同接続利用、本人操作E2E PASS | 初回installer/setup、稼働接続での受入 |
| P1-04 チャット間の対象取り違え | 明示対象の束縛と隔離2接続回帰 | 実ChatGPTの2チャットでの受入 |
| P1-05 再起動後の作業状態 | target別永続化、再取得、承認付き照合 | 実際の中断確認ダイアログ操作・稼働復旧 |
| 通常依頼で@不要 | この会話からの呼出を観測、metadata契約 | 修正版を提供した新規チャットE2E |

## 切替前の順序

1. 全体テスト・型チェック・build・Skill検証をこの候補で再実行。
2. 現在の設定から新しいbundleを生成し、同じコードのmanifestでverify。古いbundleは適用しない。
3. C2C本体への切替について本人の明示許可を得て、実行中の作業を再確認する。
4. credential/Tunnel設定値/既存profiles/selectedを変えず、対応するbridgeと起動gateを揃える。
5. health、全既存profileとread-only evidence root、new-chatの@なし呼出、障害時rollbackを確認する。

別チャットのprofile追加に対する再起動許可を、このC2C本体切替の許可へ流用しない。
この技術プレビューはcommit/push/releaseの対象。稼働切替・deployは別の許可と確認が必要。初回setupやnetwork診断等の残件も別途管理する。

## 公開物の範囲

`.local/`内の証跡、ホスト固有の設定・資格情報、個人用の完了音声は公開物に含めない。
本文中の`.local/`参照は非公開の作者検証記録であり、同梱ファイルへのリンクではない。
公開可能な検証要約は [リリースノート](../releases/v0.4.0-dev.6.md) に記載する。
