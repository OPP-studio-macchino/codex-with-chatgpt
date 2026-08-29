# Codex with ChatGPT — hardened fork

ChatGPT に、選択したローカル作業領域を読み取り専用 MCP 経由で参照させ、
計画やレビューを補助させるためのブリッジです。編集・コマンド実行・テスト・
最終判断は Codex 側に残ります。

これは [`XiaoDuoYa/codex-with-chatgpt`](https://github.com/XiaoDuoYa/codex-with-chatgpt)
の commit `2165dea39017d29fef95b85e8054669ad68541e1` を起点にした、
セキュリティ重視の非公式フォークです。OpenAI や Cloudflare の公式製品では
ありません。

English: [README.md](README.md) · 中文: [README.zh-CN.md](README.zh-CN.md)

## 先に知っておくべきこと

ChatGPT が MCP ツールを呼ぶと、要求されたソース抜粋、検索結果、diff、パス、
実行サマリーは端末外へ送られ、ChatGPT/OpenAI で処理されます。リポジトリ全体を
一括アップロードする仕組みではありませんが、「端末から一切出ない」わけでは
ありません。Cloudflare Quick Tunnel を使う場合は Cloudflare も通信経路に
入ります。

よくある秘密ファイルの拒否、`.c2cignore`、サイズ制限、資格情報らしい文字列の
マスキングを実装しています。ただし、任意の個人情報・社外秘・未知の秘密形式を
完全に検出できる保証はありません。接続前に対象ワークスペースと
`.c2cignore` を確認してください。

## このフォークで強化した点

- 初期状態はローカル限定。外部接続はすべて明示オプションです。
- 推奨経路として OpenAI Secure MCP Tunnel 用の固定ヘッダー認証を追加。
- Cloudflare Quick Tunnel は明示承認が必要なフォールバックに変更。
- OAuth の redirect URI、PKCE、登録数、レート、本文サイズを制限。
- symlink、`..`、絶対パスを含むワークスペース外参照を realpath で拒否。
- 読み取り・検索・Git status/diff・実行記録に秘密パス除外と出力マスキングを適用。
- Git のグローバル設定、hook、外部 diff、textconv、pager を無効化して読み取り。
- 管理 API は loopback と所有者専用トークンの両方を要求。
- `doctor` は公開トンネルを勝手に開かず、`update-check` は更新を適用しません。
- Skill から無断インストール、自動 pull/stash、グローバル設定変更を除去。

詳細は [セキュリティモデル](docs/security.md) と
[ハードニング記録](docs/hardening.md) を参照してください。

## インストール

必要環境は Node.js 20 以上、Git、Corepack 経由の pnpm です。内容と lockfile を
確認したうえで実行します。

```bash
git clone https://github.com/OPP-studio-macchino/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js --help
```

依存関係の導入は第三者コードを取得・実行し得る操作です。本プロジェクトは
システムパッケージの導入や自身の更新を無断では行いません。

以下の `c2c` は、必要なら `node /path/to/bin/c2c.js` に置き換えてください。

## 接続方式

### 1. ローカル限定（既定）

```bash
c2c setup -w /absolute/path/to/workspace --json
```

loopback 上でブリッジを起動します。外部接続は作りません。この成功だけでは
ChatGPT から到達できることを意味しません。

### 2. OpenAI Secure MCP Tunnel（推奨）

この公式方式は、ローカル MCP を公開待受にせず、端末側から OpenAI へ
outbound HTTPS 接続します。利用には `tunnel_id`、runtime API key、Platform の
Tunnels Read + Use、ChatGPT developer mode、および対象 workspace との関連付けが
必要です。Platform 権限と ChatGPT 権限は別です。

まずローカル固定ヘッダー認証を準備します。

```bash
c2c setup -w /absolute/path/to/workspace --openai-secure-tunnel --json
```

JSON の `localMcpUrl`、`trustedTunnelHeader`、`trustedTunnelTokenFile` を使い、
公式 `tunnel-client` の通常 MCP と discovery の両方へ同じ `file:` 参照を設定します。
トークン値自体は表示・コピーしません。

```bash
tunnel-client run \
  --control-plane.tunnel-id='<承認済み tunnel_id>' \
  --control-plane.api-key=file:/absolute/protected/path/to/openai-tunnel-runtime-api-key \
  --mcp.server-url='<localMcpUrl>' \
  --mcp.extra-headers '<trustedTunnelHeader>: file:<trustedTunnelTokenFile>' \
  --mcp.discovery-extra-headers '<trustedTunnelHeader>: file:<trustedTunnelTokenFile>'
```

API key はチャットや設定ファイルへ貼らず、保護された環境変数または secret file
から渡してください。ChatGPT の developer-mode app では **Tunnel** を選び、対象の
`tunnel_id` だけを指定します。

確認は次の3段階を分けます。

1. ローカル bridge が正常。
2. `tunnel-client` が ready かつ polling 中。
3. ChatGPT から対象 workspace の `workspace_info` を実際に呼べる。

このフォークでは実装とローカル認証をテスト済みですが、アカウント固有の権限と
資格情報が必要な公式トンネル実 E2E は現在 **UNVERIFIED** です。

### 3. Cloudflare Quick Tunnel（明示的な代替手段）

```bash
c2c setup -w /absolute/path/to/workspace --cloudflare-quick-tunnel --json
```

ランダムな一時公開 HTTPS URL を作り、Cloudflare が通信経路に入ります。MCP は
OAuth、PKCE、一回限りのペアリングコードで保護されますが、公開面が増える事実は
変わりません。`cloudflared` は自動導入されません。

### 4. 管理済み HTTPS 経路

```bash
c2c setup -w /absolute/path/to/workspace \
  --external-base-url https://reviewed-origin.example --json
```

proxy/tunnel、DNS、TLS、ログ、運用上の安全性は利用者側の責任です。C2C は URL を
検証しますが、その外部経路を構築・監査しません。

## プロジェクト固有の除外

接続対象のルートに `.c2cignore` を置き、gitignore 形式で指定します。

```gitignore
internal-notes/
customer-data/
fixtures/private-*
```

`.c2cignore` 自体は MCP に返しません。顧客情報や独自の機密パスはプロジェクトごとに
追加してください。

## 主なコマンド

```bash
c2c status -w <workspace> --json
c2c doctor -w <workspace> --json
c2c doctor -w <workspace> --fix --json  # 不在のローカル bridge だけ起動
c2c logs -w <workspace> -n 100
c2c pair -w <workspace>                 # OAuth 方式用
c2c unpair -w <workspace>               # ローカル認証を失効
c2c stop -w <workspace>
c2c update-check --json                 # 通知だけ。更新は適用しない
```

まず `c2c sandbox-allow --check --json` で変更先を読み取り確認できます。
`c2c sandbox-allow --json` は利用者のグローバル Codex 設定を書き換え、既存設定が
あれば所有者専用バックアップを作るため、明示承認を得た場合だけ実行してください。

## 現在の保証範囲

このフォークはハードニングと自動テストを実施していますが、形式検証や第三者監査は
未実施です。「読み取り専用」は MCP が編集・実行ツールを提供しないという意味であり、
ソース開示、prompt injection、依存関係、外部サービスのリスクをゼロにはしません。

脆弱性報告は [SECURITY.md](SECURITY.md) に従い、資格情報・非公開ソース・個人情報を
issue へ貼らないでください。

License: [MIT](LICENSE).
