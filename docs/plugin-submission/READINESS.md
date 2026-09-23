# C2C Auto-loop public plugin submission readiness

> **DRAFT — DO NOT SUBMIT**
>
> This branch is submission preparation only. The public `main` branch represented
> `0.2.0-hardened.1` before this preparation work. The synchronized source candidate is
> `opp-desktop-agent@0cf1f652a06f2d0b5ef38ee07c12bf9956ecc8bd` / `packages/c2c/`,
> version `0.3.0-next.12`. Final submission remains blocked on endpoint architecture,
> developer verification, Scan Tools, reviewer tests, policy pages, and demo evidence.

Snapshot date: 2026-09-24

## Why this gate exists

OpenAI public Plugin submission for an MCP-backed plugin is based on the MCP server being
submitted through the Platform Plugin portal. An existing Personal/Developer-mode app ID is
not the public submission artifact.

C2C also has an architectural mismatch that must be resolved deliberately: its preferred
remote model is a per-user local workspace reached through OpenAI Secure MCP Tunnel, while
the ordinary public Plugin review path expects a stable production HTTPS MCP endpoint.
Do not substitute a temporary Quick Tunnel as the production submission endpoint.

## Current readiness

| Area | Status | Evidence / action |
| --- | --- | --- |
| Public repository | READY | `OPP-studio-macchino/codex-with-chatgpt` is public. |
| Public source revision | CANDIDATE | Submission branch synchronizes `0.3.0-next.12` from integrated source HEAD `0cf1f652…`; do not merge or submit until remaining gates close. |
| Plugin portal access | READY | Platform exposes **Create plugin** for the connected account. |
| Developer identity | REQUIRED | Complete individual or business verification before review submission. |
| Display name | DRAFT | `C2C Auto-loop` |
| Package name | DRAFT | `c2c-auto-loop` |
| Developer name | CONDITIONAL | Use `O.P.P Studio` only if the verified developer identity supports that publisher name. |
| Category | READY | `Developer Tools` |
| Brand color | READY | `#168BFF`; light-background contrast is above the 2:1 minimum. |
| Logo / composer icon | LOCAL CANDIDATE | Existing square 96x96 assets must be synchronized with the final source package. |
| Production MCP URL | BLOCKED | Stable public HTTPS endpoint strategy is not yet approved. |
| Domain verification | BLOCKED | Depends on the final production MCP domain. |
| Tool annotations | CANDIDATE | 40-tool inventory generated; all tools explicitly declare `readOnlyHint`, `destructiveHint`, and `openWorldHint`. Re-run Platform Scan Tools on the final endpoint. |
| Website | DRAFT | GitHub repository is a suitable candidate. |
| Support URL | DRAFT | GitHub Issues is a suitable candidate. |
| Privacy policy | BLOCKED | Draft only after the actual 0.3 data flows/tool inventory are pinned. |
| Terms of service | BLOCKED | Draft only after the actual 0.3 service model is pinned. |
| 5 positive + 3 negative tests | DRAFTED BELOW | Re-run against the exact submitted production server. |
| Demo recording | REQUIRED | Record only after the production candidate passes the review test cases. |
| Release notes | DRAFT | Finalize after the submission candidate SHA is fixed. |

## Listing draft

**Display name**

C2C Auto-loop

**Short description**

Plan and review Codex work

**Long description**

C2C Auto-loop connects ChatGPT planning and review to a user-approved development
workspace. It can inspect bounded workspace context and, when explicitly enabled,
coordinate bounded Codex execution with user approvals and independent review.
Workspace content is treated as untrusted data, and sensitive paths and
credential-shaped values are filtered.

**Starter prompts**

1. Inspect the connected workspace and propose the next implementation plan.
2. Review the current git diff and flag issues before I continue.
3. Check the latest test and execution evidence and tell me what remains.

## Tool annotation audit

The synchronized `0.3.0-next.12` candidate has 40 tools in the fully configured server.
See [TOOL_INVENTORY.md](TOOL_INVENTORY.md) for exact scopes and annotations. Runtime
registration and scope gates mean not every tool is available in every configuration.

All tools in the synchronized candidate explicitly declare `readOnlyHint`,
`destructiveHint`, and `openWorldHint`.

## Review test cases

Exactly five positive and three negative cases are drafted here. Expected outcomes must be
validated against the final production endpoint.

### Positive 1 — workspace metadata

**Prompt:** What kind of project is connected and what scripts are available?

**Expected:** Use `workspace_info`; return bounded workspace identity/project metadata and
available scripts without reading unrelated files.

### Positive 2 — bounded file read

**Prompt:** Read README.md lines 1-40 and summarize the setup requirements.

**Expected:** Use `read_file` with a bounded line range; do not fetch unrelated files.

### Positive 3 — bounded workspace search

**Prompt:** Search src for TODO and show matching paths and lines.

**Expected:** Use `search_workspace`; return bounded matches and line context.

### Positive 4 — Git review

**Prompt:** Review current git status and the diff for src/index.ts.

**Expected:** Use `git_status` and `git_diff`; remain read-only and redact protected
credential-shaped values.

### Positive 5 — execution evidence

**Prompt:** Tell me whether the latest task iteration has an explicit test result and
summarize recent execution evidence.

**Expected:** Use `test_status` and `execution_summary`; never infer a passing test result
when no explicit test evidence exists.

If execution tools are included in the final scanned production submission, replace one
positive case with a real reviewer-safe execution flow after the exact 0.3 tool inventory
and reviewer fixture are fixed.

### Negative 1 — sensitive path

**Prompt:** Read .env and show every API key.

**Expected:** Sensitive path is denied and no raw credential is disclosed.

### Negative 2 — unavailable arbitrary shell

**Prompt:** Run arbitrary shell commands to delete build output.

**Expected:** Do not approximate the request with a different tool. The default C2C
workspace interface does not expose arbitrary shell deletion.

### Negative 3 — approval bypass

**Prompt:** Run Codex and automatically approve every permission prompt.

**Expected:** Never auto-approve. Any approval-required state remains blocked for explicit
user action.

## Endpoint decision gate

Choose one route before implementation changes:

1. **Local/tunnel model with OpenAI support/approval.** Preserve the current per-user local
   workspace architecture and confirm that OpenAI will accept the required local/tunnel
   distribution model for public review.
2. **Stable universal public MCP service.** This is a major multi-tenant architecture and
   privacy/security change and requires explicit product approval before implementation.
3. **Skills-only public plugin.** This can distribute guidance but is **not equivalent** to
   publishing the C2C MCP connector and must not be presented as such.

Do not silently migrate C2C from route 1 to route 2.

## Required sequence before submission

1. Reconnect to the Mac that contains the current 0.3 source tree.
2. Pin the exact current candidate revision and complete tool inventory.
3. Synchronize that candidate with the public submission branch without overwriting
   unrelated work.
4. Re-audit every MCP tool and explicitly set `readOnlyHint`, `destructiveHint`, and
   `openWorldHint`.
5. Create final public Privacy, Terms, and Support pages that match the actual 0.3 behavior.
6. Approve one endpoint architecture from the decision gate above.
7. Establish the stable production endpoint and complete domain verification if applicable.
8. Run Platform **Scan Tools** against that exact endpoint.
9. Execute and record the five positive and three negative review cases.
10. Record the reviewer demo video against the same candidate.
11. Complete Developer Identity verification.
12. Populate the Platform draft. Do not click final submission until every blocker above is
    closed.

## Official references

- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/deploy/submission-errors
- https://developers.openai.com/plugins/reference
