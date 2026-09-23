# C2C Auto-loop submission tool inventory

Candidate source: `opp-desktop-agent@0cf1f652a06f2d0b5ef38ee07c12bf9956ecc8bd` → `packages/c2c/`.
Candidate version: `0.3.0-next.12`.

This inventory is generated from the synchronized submission candidate. Desktop tools are
registered only when a Desktop Agent is configured. Codex execution tools are registered
only when the Codex execution lane is configured. Scope grants remain a separate runtime gate.

| Tool | Scope | readOnly | destructive | idempotent | openWorld |
| --- | --- | --- | --- | --- | --- | --- |
| `workspace_info` | `workspace.read` | true | false | — | false |
| `list_directory` | `workspace.read` | true | false | — | false |
| `read_file` | `workspace.read` | true | false | — | false |
| `search_workspace` | `workspace.search` | true | false | — | false |
| `git_status` | `git.read` | true | false | — | false |
| `git_diff` | `git.read` | true | false | — | false |
| `test_status` | `execution.read` | true | false | — | false |
| `execution_summary` | `execution.read` | true | false | — | false |
| `desktop_roots` | `desktop.read` | true | false | — | false |
| `desktop_list` | `desktop.read` | true | false | — | false |
| `desktop_read` | `desktop.read` | true | false | — | false |
| `desktop_git_status` | `desktop.read` | true | false | — | false |
| `desktop_inspect` | `desktop.read` | true | false | — | false |
| `desktop_mkdir` | `desktop.write` | false | false | true | false |
| `desktop_write` | `desktop.write` | false | true | false | false |
| `desktop_remove` | `desktop.write` | false | true | false | false |
| `desktop_accessibility_status` | `desktop.accessibility.read` | true | false | — | false |
| `desktop_accessibility_apps` | `desktop.accessibility.read` | true | false | — | false |
| `desktop_accessibility_tree` | `desktop.accessibility.read` | true | false | — | false |
| `desktop_accessibility_find` | `desktop.accessibility.read` | true | false | — | false |
| `desktop_accessibility_confirm` | `desktop.accessibility.read` | true | false | — | false |
| `desktop_accessibility_action_profiles` | `desktop.accessibility.action` | true | false | — | false |
| `desktop_accessibility_press` | `desktop.accessibility.action` | false | true | false | false |
| `desktop_accessibility_request_grant` | `desktop.accessibility.action` | false | false | false | false |
| `desktop_accessibility_grants` | `desktop.accessibility.action` | true | false | — | false |
| `desktop_accessibility_grant_press` | `desktop.accessibility.action` | false | true | false | false |
| `desktop_app_profiles` | `desktop.app` | true | false | — | false |
| `desktop_app_launch` | `desktop.app` | false | false | false | false |
| `desktop_screenshot_capture` | `desktop.screen` | false | false | false | false |
| `desktop_screenshot_list` | `desktop.screen` | true | false | — | false |
| `desktop_screenshot_remove` | `desktop.screen` | false | true | true | false |
| `desktop_process_profiles` | `desktop.process` | true | false | — | false |
| `desktop_process_run` | `desktop.process` | false | true | false | false |
| `desktop_process_start` | `desktop.process` | false | true | false | false |
| `desktop_process_status` | `desktop.process` | true | false | — | false |
| `desktop_process_output` | `desktop.process` | true | false | — | false |
| `desktop_process_stop` | `desktop.process` | false | true | true | false |
| `codex_turn_start` | `codex.execute` | false | true | false | false |
| `codex_turn_wait` | `codex.execute` | false | false | true | false |
| `completion_notify` | `codex.execute` | false | false | false | false |

Total tools represented in the fully configured candidate: **40**.

All tools explicitly declare `readOnlyHint`, `destructiveHint`, and `openWorldHint` in this submission candidate.
