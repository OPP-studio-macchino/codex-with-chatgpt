# Workspace targets (phase02 binding slice)

The assistant discovers `workspaceId` through `workspace_profiles` or
`workspace_info`, clarifies the project if ambiguous, and supplies that ID as
`workspace_id`. Users need not type IDs, mention C2C, or add `@c2c`.

Exactly these tools gain optional `workspace_id`, a string of 24 lowercase hex
characters: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
`git_status`, `git_diff`, `test_status`, `execution_summary`,
`network_fetch_image`, `codex_turn_start`, and `codex_turn_wait`.
The next18 schema fixture remains frozen. The contract test permits only this
optional property and the SDK's `additionalProperties: false` field on the three
formerly empty schemas; all other schema fields, annotations, tool names and
execution metadata retain their baseline hashes.

Each call checks its existing scope, then synchronously resolves its target once
from the owner's approved Workspace objects. Unknown IDs fail with
`WORKSPACE_ID_UNKNOWN`; filesystem paths are not IDs. Bound operations never
select a profile or persist selection. Their asynchronous work, execution-record
writes and network host allowlists use the captured target. This parameter grants
no owner approval and changes no read-only, sandbox, network or Desktop boundary.
In multi-profile mode (more than one approved profile), explicit targets require
the existing trusted-tunnel identity. OAuth cannot use IDs to cross targets.
Trusted in-process clients retain the existing no-auth transport convention.

Reads without an ID retain legacy shared selected-workspace behavior, which is
not chat isolation. `workspace_select` remains a legacy shared selection tool.
In multi-profile mode, Codex start **and** wait reject an omitted ID with
`WORKSPACE_ID_REQUIRED` before acquiring a target Codex client or starting/polling
it. Single-root mode remains compatible with omitted IDs.

The bridge shares one task-to-workspace map across MCP requests and clients.
Start reserves the binding synchronously before execution, including concurrent
starts. Reusing that task ID on another target fails with
`TASK_WORKSPACE_MISMATCH`; wait must match the binding before polling. An unknown
task cannot be polled. A failed start retains its reservation. The map holds at
most 10,000 distinct task IDs, rejects new ones with `TASK_BINDING_LIMIT` when
full, and never evicts or rebinds an existing entry. Existing tasks remain usable.
Each profile reuses its own CodexAppServer and its existing one-active-turn guard;
different profiles can run concurrently.

These are runtime-only bindings for one bridge lifetime. Restart recovery,
automatic ChatGPT host routing, tool exposure/refresh, and host-routing E2E are
not solved here. Read-only bridge configurations gain bound reads, not execution.
Startup bundles and service deployment are outside this slice.

Validation includes in-memory MCP clients with fake Codex and mocked image fetch,
plus a two-client HTTP integration case with a fake Codex child. Tests cover
selection independence, scope/identity denials, missing/unknown IDs, task-map
capacity and cross-target reuse, profile-specific execution, concurrent profiles,
and same-profile collision. HTTP tests require a permitted loopback listener.

## 日本語での受入条件と開発候補

ユーザーは作業の目的だけを伝える。workspace_idの取得・引継ぎはChatGPT側の仕事であり、IDや@c2cを入力させない。
対象別の実行器がない場合は `WORKSPACE_EXECUTOR_UNAVAILABLE` で止め、別repoへfallbackしない。start/waitの応答に対象IDを返す。
開発候補は `0.4.0-dev.1`。稼働中のnext.18と区別するための番号で、公開releaseではない。
実際のChatGPTの2チャットでの受入、新規チャットの@なし自動選択、サービス再起動後の復旧は未実施・未完成。
起動構成の候補生成は [startup-bundles.md](startup-bundles.md) を参照。稼働反映・commit/push・プラグイン登録変更はしていない。

## Phase 03 update

The bridge-lifetime map above remains an in-memory routing guard. The added task journal now preserves
workspaces and run results across restart, without restoring Codex threads or permitting uncertain replay.
See [task recovery](task-recovery.md) for the precise added guarantees and remaining reconciliation work.
