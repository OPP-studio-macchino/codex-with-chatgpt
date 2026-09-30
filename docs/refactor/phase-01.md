# Phase 01 — C2Cを意識しない通常利用

## ユーザーの受入条件

「RDCは使用しているのを忘れる使用感。C2Cでも、チャットのたびに@c2cを入力する煩わしさをなくす。」

接続済みでC2Cツールが提供される対応環境では、ユーザーは作業の目的だけを伝える。
新規チャット、同じチャットの続き、作業状況の確認で、@c2c・Codexという単語、
依頼の再送、「接続した」という中継を通常手順にしない。初回接続と本人の承認は省略しない。

## この変更で実装した範囲

- MCPの説明と呼び出し契約を `src/mcp/usage-contract.ts` に集約。
- ローカルrepoの調査・修正・実装・テスト・レビューという目的を説明の入口にする。
- 利用可能なツールを先に確認し、対象が曖昧ならプロジェクトだけを確認する。
- 他ツールの明示指定、一般会話、メール・カレンダー、cloud-only GitHub作業を横取りしない。
- 既存のツール名、入力schema、annotation、認証scope、sandbox、承認処理は維持する。
- 起動設定の版・workspace root・port・state rootを比較するread-only診断を追加。

起動診断は実行や修復をしない。workspace IDを安全に照合できない場合は未確認と表示する。
共通release manifestを使う起動構成生成・更新・rollbackは後続工程であり、本変更で完了とはしない。

## ホスト側の境界

MCPサーバーの説明を書き換えても、ChatGPTがその会話に提供していないツールは呼び出せない。
インストール済みでもモデル・surface・workspaceにより利用可否が異なり得る。
登録済みツール説明の更新反映と、新しいチャットでの選択挙動は、別途実機確認する。
この制約を、@入力・再接続を延々繰り返す案内に置き換えない。
ブラウザーへの自動入力・非公開API操作・承認省略でツールを強制的に有効化しない。

参考（OpenAI公式、2026-09-30確認）:
- https://developers.openai.com/plugins/guides/optimize-metadata
- https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## 検証を混同しない

`tests/no-mention-mcp.test.ts` はMCP initialize/listToolsと認証の契約テスト。
`tests/fixtures/no-mention-prompts.json` は実際のChatGPTで実行する評価仕様であり、ルーターではない。
このfixtureの正しさや単体テストの成功を、モデルの自動選択成功率と呼んではいけない。

| 確認 | 状態 |
|---|---|
| この会話でユーザーが@を付けずに既存C2Cへ到達 | 観測済み。変更前の接続確認のみ |
| 修正版を登録・更新したChatGPTで、新規チャットから@なしで実作業 | NOT_RUN |
| 同一会話の続きで@・再送・接続報告なし | NOT_RUN |
| 無関係な依頼や他ツール指定を横取りしない実機評価 | NOT_RUN |
| 2チャット同時作業のworkspace分離 | 未実装。metadataでは解消しない |
| 稼働版への適用・公開 | 未実施 |

## ASTRA監査のP1を維持する

ユーザー提供の2026-09-29監査より。検出・準備だけで完了にしない。

| ID | 指摘 | この変更後の扱い |
|---|---|---|
| P1-01 | 配布される版が、現在評価している製品と一致しない | OPEN。liveソースを隔離worktreeへ保全した段階 |
| P1-02 | 現在の再起動用gateがlive bridgeを受け入れない | OPEN。診断を追加。起動構成の変更は未実施 |
| P1-03 | 新しいworkspaceを安全に追加するユーザー操作が製品化されていない | OPEN |
| P1-04 | workspace選択がチャット別に保持されない | OPEN。対象への作業固定が必要 |
| P1-05 | service再起動後の作業再開が、利用者の手作業に委ねられる | OPEN。永続記録と再開入口が必要 |

## 後続の順序

1. live/配布ソースの差分照合を完成させ、共通release情報から起動・更新・rollbackを生成する。
2. 作業をworkspace IDへ固定し、永続記録と非同期jobを整える。
3. JSON手編集不要の初回setup・workspace追加・network承認・統合診断を提供する。
4. ファイル・画像・processの一般操作を拡張し、RDCと同一タスクで比較する。
5. 新規チャットを含むno-mention評価を行い、失敗時のホスト条件を記録する。

C2Cの版番号はこの開発sliceでは上げない。commit/push/deploy、サービス切替、
owner設定・資格情報・他repoの変更は行わない。
