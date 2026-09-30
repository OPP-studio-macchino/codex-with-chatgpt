# Manifestから起動設定を生成する（Phase 02）

`scripts/prepare-startup-bundle.py` は、稼働中の設定を直接変更せず、版をそろえたbridge/Tunnelの設定候補を生成する。
単にversion検査を外す修正ではない。package・src・distの版が一致することを要求し、実行コードとソースのSHA-256を一つのrelease manifestへ記録する。

## 生成と確認

```sh
python3 -B scripts/prepare-startup-bundle.py \
  --release-root /absolute/path/to/release \
  --bridge-plist /absolute/path/to/current-bridge.plist \
  --tunnel-plist /absolute/path/to/current-tunnel.plist \
  --output-dir /absolute/path/to/new-private-bundle
python3 -B scripts/prepare-startup-bundle.py \
  --verify-bundle /absolute/path/to/new-private-bundle
```

生成するもの: `release-manifest.json`、`bridge.plist`、`tunnel.plist`、元設定を保持する`before/`、各ファイルのハッシュを記録した`bundle.json`。
bridgeとTunnelは同じmanifestのreleaseRoot/versionから生成する。workspace・port・state・token参照が不一致なら止める。
未知・重複flag、既存出力先、symlink、不一致build、改変済みbundleを拒否する。LaunchAgents/LaunchDaemonsへ直接出力しない。
出力はowner専用とし、認証情報の値やargv全体をログへ出さない。token等の参照先ファイルを開くことも、設定内のprogramを実行することもない。

## 完了条件と限界

`verified_not_applied` は「候補の整合性を確認した」であり、インストール・起動・再起動・rollback実行の成功ではない。
元設定の保存はrollback準備であり、自動rollback機能そのものではない。releaseIdは内容識別子であって、署名や配布元の信頼証明ではない。
source/distの版一致とハッシュ照合だけで、任意のdistが必ずsourceから再現できるとは証明できない。build/testsと別に評価する。
稼働切替前に再度verifyし、進行中の作業を確認する。Mac再起動・ChatGPT接続維持・service復旧の実機試験は後続の許可済み切替工程で実施する。

## 任意の完了音声

個人用録音は配布しない。既存の`C2C_COMPLETION_SOUND_PATH`は絶対パスかを確認し、そのまま維持する。
この設定生成は音声の読取・コピー・再生を行わない。ファイルの存在・利用権限は所有者が確認する。
