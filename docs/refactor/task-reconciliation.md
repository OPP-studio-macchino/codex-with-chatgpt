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

## Additive process attribution contract (2026-10-08)

Historical ownership and present workspace quiescence are independent. Each bounded
candidate has `PROVEN_HISTORICAL`, `PROVEN_OTHER`, or `UNPROVEN` ownership; the scan
has `QUIESCENT`, `NON_QUIESCENT`, or `UNKNOWN` quiescence. Every observed live
same-user process whose canonical cwd is the root or a descendant can potentially
write, including node, cua, Codex, Desktop and the bridge host itself. Ownership
does not exempt it. Only the synchronously created ps observation child is omitted.
No signal, including signal zero, is used by the scanner.

The canonical journal supplies only descriptive workspace/run/runtime IDs and
start/logical-terminal timestamps. It does **not** record an OS process birth
receipt or a session handshake. Production therefore supplies no trusted process
bindings and emits `UNPROVEN`; neither filenames, roles, prompts, PID, cwd,
executable name, nor a timestamp after run start establishes ownership. A process
starting clearly after the logical end may have `physical_original: FALSE` while
its logical ownership remains `UNPROVEN`. This is relative to the supplied history,
not proof that the old run's effects ended at its timeout.

The pure comparison function has a trusted in-process observation seam for tests
and a future independently reviewed host reader. Positive classification requires
matching, independently recorded spawn and session observations: exact
workspace/root, runtime, run and session, PID/start/executable and the observed
parent identity, stable kernel-birth identity hashes for both child and parent,
consistent recording times, and two distinct source hashes.
`PROVEN_OTHER` additionally requires a clearly post-end start and a different
recorded runtime/run/session. A hash authenticates neither a source nor its author.
The host must authenticate the two sources **before** using that seam; shape
validation alone is insufficient. No such reader or receipt writer is added here.
HTTP, MCP, worker data and the standalone scan cannot inject these observations
or an allowlist. Positive fixture tests validate comparison rules, not the existence
of a production provenance source. Existing unbound history cannot be upgraded by
this change, and no Agent Fabric database is accessed.

Two ps/lsof snapshots, each bracketed by process identity observations, are compared.
PID reuse with changed start identity, reparenting, cwd drift, missing coverage,
unreadable cwd, limits and unstable observations fail closed as `UNKNOWN`.
Disappeared processes are omitted from live candidate evidence. Executable identity
is a canonical path when resolvable, **not** a binary-content fingerprint. `ps lstart`
has second precision; subsecond PID reuse and between-snapshot changes cannot be
excluded by this adapter. Its `birth_identity` is null, which structurally prevents
positive ownership even if a receipt pair is supplied to the comparator. A future
positive production reader must provide and verify finer stable birth/session
identity, rather than treat this adapter's second-resolution match as proof.
The scope remains same-user cwd snapshots: it does not cover every file descriptor,
other users, cwd changes between observations, remote effects or future processes.

Evidence contains bounded PID/PPID/start/executable/canonical-cwd metadata, up to
four ancestor identities, timestamp, classifications/counts and SHA-256 hashes of
schema-normalized safe metadata. It never requests argv or process environments.
Paths containing controls, recognizable credentials or exceeding 512 bytes cannot
enter persisted metadata. There are at most 32 inline candidates and 64 KiB per
observation; truncation preserves observed total/counts and blocks as `UNKNOWN`.
The evidence hash covers the retained bounded observation, not omitted inventory.
Missing coverage can hide additional candidates; `candidate_count` is an observed
count, not a claim of complete coverage when `coverage` is `INCOMPLETE`.

Worker progress/catch messages and reconciler errors validate that same schema.
Late timeout/crash/cancellation retains the last bounded observation and marks it
`UNKNOWN`; `observed_at` is not refreshed to imply a newer process observation.
Known reconciliation codes survive the closed error vocabulary through durable
reload. Unknown strings become `RECONCILIATION_FAILED`; raw exception text is never
stored. Workspace and single-run failed reconciliation attempts use the existing
recovery extension, once per job. For a single-run failure its reconciliation ID is
also the durable recovery ID, inspectable through workspace recovery status.
Scans/status polls do not append inventories. Existing limits remain 128 recovery
entries and 4 MiB per ledger, with fail-closed capacity and no eviction/migration.
Canonical r32 journal bytes and source-record hashes remain unchanged by a failed
attempt. Older extension readers may reject the additive field/code safely; this
is not a promise of old extension-writer compatibility.

The additive `quarantine` projection always reports old outcome `UNKNOWN`, original
context `NON_RESUMABLE`, and replay `PROHIBITED`, with ownership, counts, quiescence,
and new-unrelated-writer admission `ALLOWED`/`BLOCKED`. Mixed or absent ownership is
aggregated as `UNPROVEN`; inspect candidate counts for detail. `QUIESCENT` alone
does not admit a writer. `ALLOWED` describes a completed reconciliation with no
remaining historical blocker, after current-workspace verification, fresh native
approval, burn-before-reinspection and the existing durable commit. It is not a
grant for a later action: normal scope, current identity/busy checks and all A-01
execution_mode checks still apply. No outcome resolution, historical replay,
approval/grant/answer reuse or native approval generation is performed by a scan.

### Isolated read-only diagnostic invocation

Compile with the installed toolchain into this task's evidence directory only:

```sh
node_modules/.bin/tsc -p tsconfig.json --outDir .local/c2c-reconciliation-attribution-20261008/compiled --sourceMap false
```

After independent review, the host may run the following from `/` (so the diagnostic
host does not itself hold the target cwd). Replace `C2C_REPO` and the explicit
diagnostic JSON with host-confirmed values. This invocation only imports the
process scanner and redaction/schema dependencies, never constructs a Workspace,
opens a journal, fingerprints business files, reconciles, resolves, approves or
starts a business command. It reads directory/process metadata and prints evidence.
Historical context is descriptive and cannot supply bindings/authority. No real
incident workspace scan was performed during source implementation.

```sh
C2C_REPO='/absolute/path/to/approved/C2C/repository'
cd /
node --input-type=module -e '
  const { scanReconciliationProcesses, quarantine } = await import(process.argv[1]);
  const processes = scanReconciliationProcesses(JSON.parse(process.argv[2]));
  process.stdout.write(JSON.stringify({ processes, quarantine: quarantine(processes) }, null, 2) + "\n");
' "${C2C_REPO}/.local/c2c-reconciliation-attribution-20261008/compiled/execution/reconciliation-processes.js" \
  '{"root":"/host-confirmed/canonical/workspace","historical":{"workspace_id":"000000000000000000000000","run_id":"00000000000000000000000000000000","runtime_id":"00000000000000000000000000000000","started_at":"2026-10-04T10:47:35.131Z","ended_at":"2026-10-04T11:07:35.199Z"}}'
```

The placeholders are not authority and must not be copied as real provenance.
Compile output is source-ready evidence; it does not activate or repair an active
runtime. The owner-attention release remains untouched.
