# Hardening record

## Provenance

- Upstream repository: `https://github.com/XiaoDuoYa/codex-with-chatgpt`
- Fork: `https://github.com/OPP-studio-macchino/codex-with-chatgpt`
- Audited upstream base: `2165dea39017d29fef95b85e8054669ad68541e1`
- Hardening branch: `hardening/trusted-v1`
- Review date: 2026-08-29

This is a bounded source review and refactor, not a formal penetration test or
independent audit. No production workspace, real account credential, or private
provider payload was used during validation.

## Security objectives

1. Default to no remote exposure.
2. Make every external transport and global configuration change explicit.
3. Prefer an outbound-only official tunnel over a public random URL.
4. Keep the MCP capability set read-only and bounded.
5. Fail closed on workspace escape and sensitive-path policy failures.
6. Prevent repository-controlled Git configuration from executing helpers.
7. Bound OAuth state, request bodies, concurrency, logs, and execution records.
8. State the real data boundary and remaining uncertainty without marketing
   language.

## Findings and changes

| Finding in upstream base | Risk | Change in this fork |
| --- | --- | --- |
| Setup/doctor/Skill could automatically create or restore a public Quick Tunnel | Unannounced external exposure and third-party transport | Local-only default; explicit, mutually exclusive transport flags; doctor never opens a tunnel |
| Documentation claimed the repository never leaves the machine | Incorrect consent boundary | README, Skill, architecture, and threat model now state that requested MCP output is processed externally |
| No private official-tunnel authentication mode | Public ingress was the primary path | Added per-workspace fixed-header auth for OpenAI Secure MCP Tunnel, read from a `0600` file on every request |
| Git inspection inherited user/system/repository behavior | A hostile repo configuration could invoke helpers or leak extra content | Sanitized environment/config, disabled hooks/fsmonitor/external diff/textconv/pager, literal pathspecs, root `.git` requirement, prefiltered diff paths |
| Helper discovery trusted arbitrary `PATH` entries | A selected workspace could shadow `git`, `rg`, or `cloudflared` with executable content | Git, ripgrep, and Quick Tunnel execution now resolve canonical executables only from fixed system locations; repository-local shims are rejected |
| Arbitrary `.git` files, symlinks, or object alternates could point outside the selected workspace | Git diff could read blobs from unrelated repository metadata | Reject `.git` symlinks, arbitrary control files, and alternate object stores; allow only embedded metadata or validated Git worktree back-pointers |
| Sensitive-path protection did not consistently cover Git output | Secret filenames or contents could appear in status/diff | Unified built-in policy and `.c2cignore` across status, diff, reads, listing, and search |
| Allowed files and summaries could contain credential values | Secret disclosure | Central outbound scanner/redactor applied to MCP content, Git output, logs, and execution records |
| State directory could be placed inside the connected workspace | C2C credentials could enter its own readable boundary | Workspace creation refuses a state directory inside the workspace |
| Workspace IDs were derived without an install secret | Local paths could be guessed/correlated | Per-install HMAC key and 24-hex workspace aliases |
| Pairing HTML embedded untrusted names without complete escaping | Markup/script injection in the authorization page | Escaping/control-character removal plus CSP, anti-framing, referrer, no-store, and MIME headers |
| OAuth registrations and pending authorization state were insufficiently bounded | Memory/disk exhaustion and stale clients | Provisional TTL/cap, authorized cap, pending cap, rate limits, 16 KiB bodies, strict redirect/PKCE/scope/resource validation |
| Public base URL could depend on request headers | Host/proxy-header confusion | Fixed validated base URL; Express proxy trust disabled |
| `/mcp` parsed arbitrary bodies before authentication | Unauthenticated resource consumption | Authentication precedes strict 1 MiB parsing; method and concurrency limits added |
| Public health included workspace-correlating metadata | Privacy leakage and weak identity assumptions | Public health now returns only service/status; bridge reuse requires authenticated admin identity and PID match |
| Stale runtime PID could be killed | PID reuse could terminate an unrelated process | Shutdown only through authenticated admin API; stale state is cleared without signaling |
| Execution records and log reads were effectively unbounded and could preserve secrets | Local resource pressure and later MCP disclosure | Bounded tails/fields/counts plus path and value redaction |
| Mutable state files could follow symlinks and machine-readable diagnostics could exit successfully with failed checks | Confused-deputy writes and false automation signals | Regular-file/no-follow checks for credentials, logs, and execution records; strict state parsing; failed JSON doctor checks now return nonzero |
| Local setup generated an OAuth pairing code despite having no ChatGPT-reachable route | Misleading readiness signal and unnecessary authorization state | Local-only and official-tunnel setup return `mcpUrl: null`, an explicit `localMcpUrl`, and no OAuth pairing code |
| Skill directed automatic installs, config mutation, stash/pull, hidden browser behavior, and self-update | Supply-chain, user-work, and consent risk | Skill rewritten around separate approvals, visible actions, exact scope, manual review, and no automatic update |
| Dependencies used ranges and no CI security gate existed | Unreviewed dependency drift | Exact versions, lockfile policy, dependency scripts denied except pinned `esbuild@0.28.2`, reproducible CI, build/test/typecheck/audit gates, and Dependabot configuration |

## Verification strategy

The test suite includes targeted cases for:

- canonical path and symlink escape;
- state-directory isolation;
- sensitive path and `.c2cignore` enforcement;
- output redaction;
- bounded reads, search, records, and schemas;
- Git status/diff filtering and hostile external diff configuration;
- OAuth redirect, PKCE, rate, registration, pairing, scope, and HTML handling;
- trusted-tunnel header acceptance and immediate revocation;
- public health minimization and admin-route isolation;
- endpoint and ChatGPT session URL validation;
- MCP end-to-end read-only behavior.

Release validation commands:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit --prod
python3 <skill-creator>/scripts/quick_validate.py skill
git diff --check
git fsck --full
```

The exact pass counts and commit are recorded in the fork's pull request and CI
run so this document does not become a stale numeric claim.

## Residual and unverified items

- **UNVERIFIED:** live OpenAI `tunnel-client` + Platform tunnel permissions +
  ChatGPT developer-mode app end-to-end. Account-specific credentials and
  permissions were intentionally not requested or used.
- **UNVERIFIED:** independent third-party security review.
- Pattern-based redaction cannot classify arbitrary PII, proprietary data, or
  every secret representation.
- Prompt injection can influence advisory reasoning even though it cannot add
  MCP capabilities.
- Same-user host compromise, dependency compromise, external tunnel/provider
  compromise, and concurrent local file races remain outside or partly outside
  the bridge boundary.
- Managed `--external-base-url` paths are caller-owned and are not audited by
  C2C.

Do not describe this fork as “secure,” “trusted,” or “production-ready” without
qualifying the exact controls and the unverified items above. “Hardened” means
the listed risks were reduced and regression-tested; it is not a guarantee.
