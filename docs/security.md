# Security model

This document describes implemented controls and known limits. It is not a
security certification. The project has not received an independent third-party
audit or formal verification.

## Trust boundaries

1. **The selected workspace is the file boundary.** One bridge instance serves
   one canonical workspace root. Workspace identifiers are keyed HMAC values,
   not hashes that directly reveal local paths.
2. **Workspace content is untrusted.** Source files, README text, comments,
   diffs, fixtures, generated output, branch names, and package metadata may
   contain prompt injection or misleading claims.
3. **The local OS account is trusted.** A process running as the same user can
   ordinarily read C2C's owner-only state and the workspace itself. C2C does not
   defend against full compromise of that account or host.
4. **ChatGPT/OpenAI is an external data processor.** Content returned by an MCP
   tool leaves the machine. OpenAI Secure MCP Tunnel keeps the local server
   private; it does not keep returned source content on the machine.
5. **Cloudflare is an additional external boundary when explicitly selected.**
   Quick Tunnel creates a temporary public HTTPS route and Cloudflare carries
   the transport.
6. **Dependencies and local binaries are trusted code.** Node.js, Git,
   `tunnel-client`, optional `cloudflared`, and installed npm dependencies are
   outside C2C's enforcement boundary.

## Exposed capabilities

The MCP server registers only eight read-oriented tools: workspace information,
directory listing, file reading, search, Git status, Git diff, test status, and
execution summaries. There is no MCP tool for writing or deleting files,
executing commands, installing packages, committing, pushing, deploying, or
sending messages.

This removes those direct capabilities from the bridge. It does not prevent
workspace text from influencing ChatGPT's advice, and it does not constrain a
separate Codex process beyond Codex's own approvals, sandbox, and repository
instructions.

## Path and content controls

| Risk | Implemented control |
| --- | --- |
| `..` / absolute-path escape | Paths are resolved against the workspace and checked after canonicalization. |
| Symlink escape | The deepest existing ancestor is realpathed before containment is checked. |
| Parent Git repository bleed | Git is used only when `.git` exists at the selected workspace root. |
| Sensitive path exposure | A non-configurable denylist and `.c2cignore` apply to reads, listings, search, status, and diff. If `.c2cignore` exists but cannot be read, workspace access fails closed. |
| Binary or huge source reads | Binary files are rejected; individual source files and each response are bounded. |
| Search exhaustion | Query, glob, result count, file count, file size, and runtime are bounded. Regex search requires ripgrep. |
| Malicious Git configuration | Git runs without global/system config or optional locks; hooks, fsmonitor, pagers, external diff, and textconv are disabled. Pathspecs are literal. |
| Secrets embedded in otherwise allowed text | Outbound content is scanned for common private-key, bearer-token, provider-key, cookie, URL-credential, and assignment patterns and matching values are replaced. |

The denylist and scanner are defense in depth. They cannot recognize every
secret, arbitrary PII, customer data, proprietary algorithm, or encoded value.
False negatives and false positives are both possible. `.env.example` and
similar templates are readable by design and can still contain accidentally
real credentials; redaction is the remaining guard, not a guarantee.

## Authentication modes

### OpenAI Secure MCP Tunnel mode

`c2c setup --openai-secure-tunnel` creates a random, per-workspace token in an
owner-only file and starts the bridge on loopback. The official `tunnel-client`
must attach `X-C2C-Tunnel-Token` from that file to both MCP and discovery/probe
requests. The bridge rereads the file on every request, compares values in
constant time, and grants only the four read scopes. `c2c unpair` removes the
file, so subsequent requests fail immediately.

This mode is intended to complement OpenAI's tunnel ID, runtime-key, and
organization/workspace permission controls. C2C never prints the token value.
The file path is returned so `tunnel-client` can use a `file:` reference.

OpenAI documents Secure MCP Tunnel as outbound-only. It also documents that an
upstream browser-facing OAuth authorization server is not automatically
tunneled. For that reason, C2C's official-tunnel mode uses the private fixed
header instead of relying on C2C's loopback OAuth authorization page.

The local implementation and request authentication are covered by automated
tests. Live `tunnel-client` + account permissions + ChatGPT end-to-end behavior
is **UNVERIFIED** in this fork.

### OAuth mode for an explicit external HTTPS route

Cloudflare Quick Tunnel or a caller-managed HTTPS origin uses C2C's OAuth flow:

- dynamic clients are provisional until successful pairing;
- provisional registrations expire after five minutes and are capped;
- persisted authorized clients are capped;
- redirect URIs must be credential-free HTTPS URLs, except loopback HTTP for
  development; fragments, control characters, duplicates, and oversized lists
  are rejected;
- authorization code flow requires PKCE S256;
- codes are short-lived and one-time;
- access tokens expire after one hour;
- refresh tokens expire after 30 days and rotate on use;
- stored OAuth tokens are SHA-256 hashes, not reusable bearer values;
- requested scopes are allowlisted and enforced per tool;
- pairing pages show the requesting client, workspace, callback origin, and
  scopes, and include no-store, CSP, anti-framing, and referrer protections;
- pairing attempts, pending authorization requests, registrations, request
  bodies, and concurrent MCP work are bounded;
- `c2c unpair` revokes clients and stored token hashes.

A user must still inspect the pairing page. OAuth does not make a mistakenly
approved malicious redirect safe.

## Network surfaces

The bridge always binds to `127.0.0.1`. It never binds directly to `0.0.0.0`.

Public routes reachable through an explicitly configured proxy/tunnel include:

- `/health`, which returns only service and status;
- OAuth discovery and OAuth endpoints in OAuth mode;
- `/mcp`, which requires a valid OAuth bearer token or trusted-tunnel header.

The `/admin/*` routes require a loopback socket origin, absence of common proxy
forwarding headers, and a random admin token. Unauthorized requests receive
404 so the surface is not advertised. The CLI validates a live bridge by
calling authenticated `/admin/info` and matching both workspace ID and PID; it
does not trust a public health response as identity proof.

An operator-supplied `--external-base-url` is accepted only as a credential-free
HTTPS origin with no query or fragment. C2C does not configure or audit that
external proxy.

## Local state

State is stored outside the connected workspace using the host OS convention:

- macOS: `~/Library/Application Support/codex-with-chatgpt`;
- Windows: `%LOCALAPPDATA%\codex-with-chatgpt`;
- Linux: `$XDG_STATE_HOME/codex-with-chatgpt` or
  `~/.local/state/codex-with-chatgpt`.

Directories are set to `0700` and files to `0600` where POSIX permissions are
available. Writes use a private temporary file followed by atomic rename.
Windows and filesystems without POSIX mode semantics rely on host ACLs.

Persisted material includes:

- authorized OAuth client metadata and hashed OAuth tokens;
- a plaintext random admin token in each running bridge's `0600` runtime file;
- a plaintext trusted-tunnel token in its dedicated `0600` file when enabled;
- a per-install random workspace-identity HMAC key;
- bounded endpoint, session, log, and execution-summary metadata.

Anyone who can read the admin or trusted-tunnel token can use its local
authority. Protect backups and diagnostic bundles that include the state
directory. Do not sync it to a repository or shared cloud folder.

## Logging and error handling

The logger applies the outbound secret scanner and masks pairing-code-shaped
values. CLI log output reads only a bounded tail and redacts again. MCP clients
receive generic internal errors; exact internal details stay in local logs.

Redaction is pattern-based and incomplete. Never intentionally put raw secrets,
provider payloads, personal data, or customer content into execution notes or
diagnostic logs.

## Operational consent controls

- `setup` and `start` are local-only unless a remote transport flag is present.
- `--openai-secure-tunnel`, `--cloudflare-quick-tunnel`, and
  `--external-base-url` are mutually exclusive.
- `doctor` is diagnostic; `doctor --fix` may start only a missing local bridge.
- `update-check` queries a fixed GitHub API endpoint and never installs.
- `sandbox-allow --check` is non-mutating. The modifying `sandbox-allow` is the
  only command that edits global Codex configuration and preserves an existing
  config in an owner-only recovery backup.
- Daemon shutdown uses the authenticated admin endpoint. C2C never kills a PID
  solely because it appeared in a stale state file.
- `unpair` verifies that OAuth token state and the trusted-tunnel token are gone.

## Residual risks

- A prompt injection in repository content can still influence ChatGPT's plan.
- Legitimate source content may contain unrecognized secrets or PII.
- A same-user local attacker can bypass most local file-permission boundaries.
- Concurrent local mutation can create time-of-check/time-of-use races.
- A compromised dependency, Node.js, Git, tunnel client, proxy, browser, or
  OpenAI/Cloudflare account is outside the bridge's protection.
- Read-only access can still disclose valuable source and metadata.
- Rate and size limits reduce resource exhaustion; they do not prove denial of
  service is impossible.
- Cloudflare Quick Tunnel is temporary and public, even though application
  routes are authenticated.
- No independent audit or live official-tunnel E2E has been completed.

Use the smallest workspace possible, add project-specific exclusions, prefer
the official outbound-only tunnel, revoke access when finished, and keep Codex's
normal approval and sandbox controls enabled.
