# Codex with ChatGPT — hardened fork

A consent-driven, read-only MCP bridge that lets ChatGPT inspect a selected
local workspace for optional planning and review while Codex remains the
execution authority.

This repository is a security-focused fork of
[`XiaoDuoYa/codex-with-chatgpt`](https://github.com/XiaoDuoYa/codex-with-chatgpt),
refactored from upstream commit `2165dea39017d29fef95b85e8054669ad68541e1`.
It is an independent community project and is not affiliated with or endorsed
by OpenAI or Cloudflare.

日本語: [README.ja.md](README.ja.md) · 中文: [README.zh-CN.md](README.zh-CN.md)

## What it does

The bridge exposes eight bounded, read-only MCP tools:

- workspace metadata;
- directory listing;
- paginated text-file reads;
- bounded workspace search;
- Git status and diff;
- test and execution summaries recorded by Codex.

It does not expose file-write, delete, shell, package-install, commit, push, or
deployment tools. ChatGPT's suggestions remain advisory; Codex must validate
them against the user's request, repository instructions, and actual test
results before acting.

## The data boundary, plainly stated

When ChatGPT calls a tool, the selected source excerpts, search results, diffs,
paths, and summaries are sent from the local machine to ChatGPT/OpenAI. The
repository is not uploaded wholesale, but requested content does leave the
machine. With the optional Cloudflare fallback, Cloudflare is also in the
transport path.

The bridge blocks common credential paths, applies `.c2cignore`, bounds output,
and redacts many credential-shaped values. Those controls reduce risk; they
cannot prove that arbitrary personal data, proprietary material, or every
possible secret format will be removed. Review the workspace and
`.c2cignore` before connecting it.

## Hardening in this fork

- Local-only operation is the default; every remote transport is explicit.
- OpenAI Secure MCP Tunnel support keeps the MCP listener on loopback and uses
  a per-workspace, owner-only fixed-header token.
- Cloudflare Quick Tunnel is an explicit fallback, never an automatic setup.
- OAuth redirect validation, PKCE, request/body limits, route concurrency,
  per-window registration budgets, bounded state maps, request-bound pairing
  attempts, security headers, and immediate revocation are enforced. Dynamic
  registration requires an active owner pairing window; accepted provisional
  clients are never evicted to admit later untrusted registrations.
- Canonical realpath containment blocks `..`, absolute-path, and symlink escape.
  File reads, project manifests, and `.c2cignore` stay on verified descriptors;
  directory reads are rejected when their path identity changes during traversal.
- Sensitive paths are filtered from reads, listings, search, Git status, and
  Git diff. File reads and literal search use a stateful line-stream redactor so
  multiline private-key blocks stay hidden across page and line boundaries.
- `read_file` parses incrementally from the same verified descriptor and retains
  only the requested page instead of buffering and splitting the entire source.
- Workspace search is literal-only and uses the verified in-process reader;
  regex subprocess search is disabled at this containment boundary.
- Git inspection ignores global/system config, disables hooks, external diff
  programs, text conversion, pagers, optional locks, lazy object fetching, and
  parent-repository bleed. Repositories with executable filters, config includes,
  partial-clone promises, credential helpers, or SSH commands fail closed before
  status/diff reads index or object data. Git executes from an owner-only,
  sanitized temporary control-metadata snapshot; all status paths ignore
  submodules. `workspace_info` never invokes Git and remains a separate
  `workspace.read` operation.
- Runtime/state files use private directories and owner-only atomic writes where
  the platform supports POSIX permissions.
- Health responses disclose only service and status. Admin routes require both
  loopback origin and a private admin token.
- `doctor` does not create public exposure. `update-check` never installs an
  update. Global Codex config changes require the separate `sandbox-allow`
  command.
- Dependencies are exact-version pinned and CI checks types, tests, build, and
  production dependency audit.

See [Security Model](docs/security.md) and [Hardening Notes](docs/hardening.md)
for limitations and residual risks.

## Requirements

- Node.js 20 or newer
- Git
- pnpm via Corepack
- For OpenAI Secure MCP Tunnel: an official `tunnel-client` binary, a
  `tunnel_id`, a runtime API key, and the required Platform/ChatGPT permissions
- For the fallback only: `cloudflared`

Do not paste runtime API keys, OAuth tokens, cookies, or generated tunnel-token
contents into chat, shell history, issue reports, or config files.

## Install from this fork

Review the repository and lockfile first, then:

```bash
git clone https://github.com/OPP-studio-macchino/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js --help
```

The committed project policy blocks dependency lifecycle scripts by default and
allows only the exact `esbuild@0.28.2` build required by the pinned test/build
toolchain. Review any future allowlist change. The project does not silently
install system packages or update itself.

In the examples below, replace `c2c` with `node /path/to/bin/c2c.js` unless you
have deliberately linked the command onto `PATH`.

## Connection modes

### 1. Local-only (default)

```bash
c2c setup -w /absolute/path/to/workspace --json
```

This starts a loopback bridge and creates no remote transport. It is suitable
for local validation or a separately managed connection. A healthy local
bridge does not prove that ChatGPT can reach it.

### 2. OpenAI Secure MCP Tunnel (preferred remote mode)

OpenAI documents this as an outbound-only connection that lets supported
products reach a private MCP server without a public inbound listener. Tunnel
permissions and ChatGPT developer-mode access are separate.

First prepare per-workspace local authentication:

```bash
c2c setup -w /absolute/path/to/workspace --openai-secure-tunnel --json
```

The JSON response returns `localMcpUrl`, `trustedTunnelHeader`, and
`trustedTunnelTokenFile`; it never returns the token value. Pass the token to
the official client by file reference for both MCP and discovery requests:

```bash
tunnel-client run \
  --control-plane.tunnel-id='<approved tunnel_id>' \
  --control-plane.api-key=file:/absolute/protected/path/to/openai-tunnel-runtime-api-key \
  --mcp.server-url='<localMcpUrl>' \
  --mcp.extra-headers '<trustedTunnelHeader>: file:<trustedTunnelTokenFile>' \
  --mcp.discovery-extra-headers '<trustedTunnelHeader>: file:<trustedTunnelTokenFile>'
```

Create that API-key file outside the workspace with owner-only permissions, or
use your organization's secret injection method. In ChatGPT, create a developer-mode app,
choose **Tunnel**, and select only the intended tunnel. Verify the local bridge,
`tunnel-client` readiness, and an actual ChatGPT `workspace_info` call as three
separate checks.

The implementation and local authentication path are tested, but this fork's
official-tunnel live end-to-end path is currently **UNVERIFIED** because it
requires account-specific tunnel credentials and permissions.

### 3. Cloudflare Quick Tunnel (explicit fallback)

```bash
c2c setup -w /absolute/path/to/workspace --cloudflare-quick-tunnel --json
```

This creates a temporary public HTTPS URL through Cloudflare. The MCP endpoint
still requires OAuth, PKCE, and a one-time pairing code, but the public route
adds attack surface and Cloudflare handles the transport. Use it only after
accepting that boundary. The command does not install `cloudflared` for you.

### 4. Managed HTTPS origin

```bash
c2c setup -w /absolute/path/to/workspace \
  --external-base-url https://your-reviewed-origin.example --json
```

The caller owns the proxy/tunnel configuration, authentication assumptions,
DNS, TLS, logging, and operational security. C2C validates the declared origin
but does not establish or audit that external path.

## Privacy controls

Create `.c2cignore` in the connected workspace using gitignore syntax:

```gitignore
internal-notes/
customer-data/
fixtures/private-*
```

`.c2cignore` itself is never returned through MCP. Built-in exclusions cover
common environment files, private keys, cloud credentials, token stores,
browser cookies, Terraform state, and related material. Add project-specific
PII and proprietary paths yourself.

## Useful commands

```bash
c2c status -w <workspace> --json
c2c doctor -w <workspace> --json
c2c doctor -w <workspace> --fix --json  # starts only a missing local bridge
c2c logs -w <workspace> -n 100
c2c pair -w <workspace>                 # OAuth/Cloudflare mode only
c2c unpair -w <workspace>               # revoke local OAuth + tunnel header
c2c stop -w <workspace>
c2c update-check --json                 # advisory; never installs
```

`c2c sandbox-allow --check --json` reports the target paths without mutation.
`c2c sandbox-allow --json` changes the user's global Codex config and creates a
private recovery backup when a config already exists. Run the modifying form
only with informed approval.

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit --prod
```

Project layout:

```text
src/auth/       OAuth, fixed-header tunnel auth, token storage
src/bridge/     loopback server, public/admin boundaries, runtime state
src/mcp/        eight bounded read-only MCP tools
src/workspace/  containment, ignore policy, search, safe Git inspection
src/security/   outbound credential-shaped value redaction
src/process/    authenticated daemon discovery and shutdown
src/tunnel/     explicit Cloudflare Quick Tunnel fallback
src/cli/        consent-oriented CLI surfaces
skill/          reviewable Codex Skill instructions
tests/          unit and integration coverage
```

## Security reports

Please follow [SECURITY.md](SECURITY.md). Do not include live credentials,
private source, personal data, or raw production evidence in a report.

## Status and disclaimer

This fork is hardened and tested, not formally verified. It has not received an
independent third-party security audit. “Read-only” limits available MCP tools;
it does not make source disclosure risk zero and does not neutralize every
prompt-injection or supply-chain risk.

License: [MIT](LICENSE).
