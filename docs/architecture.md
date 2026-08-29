# Architecture

## Responsibility split

```text
User intent and approvals
          |
          v
Codex -------------------------> local workspace
  |                               edit / shell / tests / git
  | bounded control messages
  v
ChatGPT
  |
  | read-only MCP calls
  v
OpenAI Secure MCP Tunnel  --preferred--> tunnel-client --> loopback C2C bridge
        or
explicit external HTTPS / Cloudflare --> loopback C2C bridge
                                                        |
                                                        v
                                                  local workspace
```

ChatGPT plans and reviews. Codex retains execution authority and independently
validates every recommendation. Repository content is untrusted in both layers.

## Components

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express assembly, loopback-only listener, bounded request handling, minimal public health, protected admin routes, runtime state |
| `mcp/` | Stateless Streamable HTTP handling and eight read-only tools with per-tool scopes |
| `auth/` | OAuth/PKCE flow for external HTTPS mode, hashed token store, and fixed-header auth for OpenAI Secure MCP Tunnel |
| `pairing/` | One-time code generation, TTL, attempt limits, and request-rate limits |
| `workspace/` | Canonical containment, deny policy, `.c2cignore`, bounded reads/listing/search, hardened Git inspection |
| `security/` | Outbound credential-shaped value detection and masking |
| `execution/` | Bounded, sanitized JSONL summaries explicitly recorded by Codex |
| `process/` | Daemon spawn/reuse, authenticated identity checks and shutdown |
| `tunnel/` | Explicit Cloudflare Quick Tunnel fallback only |
| `config/` | Validated endpoints/session URLs, private state paths, atomic owner-only writes |
| `cli/` | Consent-separated setup, status, diagnosis, revocation, and advisory update checks |

## Request lifecycle: OpenAI Secure MCP Tunnel

1. `c2c setup --openai-secure-tunnel` starts a loopback bridge and creates a
   per-workspace `0600` token file.
2. The user configures the official `tunnel-client` with the bridge's local MCP
   URL and `file:` references for both `mcp.extra_headers` and
   `mcp.discovery_extra_headers`.
3. `tunnel-client` opens an outbound HTTPS connection to OpenAI and polls for
   work associated with the approved tunnel ID.
4. ChatGPT sends an MCP request through the OpenAI-hosted tunnel endpoint.
5. `tunnel-client` forwards it to loopback and attaches the local fixed header.
6. C2C rereads the token file, authenticates the header, assigns four read
   scopes, then dispatches the bounded MCP tool.
7. The result returns through the same outbound tunnel path.

The local MCP address is not publicly routable. Source content returned by a
tool still travels to OpenAI. Deleting the token with `c2c unpair` causes new
local requests to fail even if tunnel-client is still running.

## Request lifecycle: OAuth over explicit HTTPS

1. An explicitly selected Cloudflare Quick Tunnel or caller-managed proxy
   forwards HTTPS to the loopback bridge.
2. An unauthenticated `/mcp` call receives 401 plus protected-resource metadata.
3. The client discovers C2C's authorization endpoints and dynamically registers
   bounded redirect URIs.
4. Authorization requires PKCE S256 and a one-time pairing code on a page that
   identifies workspace, client, callback origin, and requested scopes.
5. A one-time authorization code is exchanged for an access token and optional
   rotating refresh token.
6. `/mcp` verifies the token hash record, expiration, workspace binding, and
   tool scope before dispatch.

OAuth authorization routes must be browser-reachable in this mode. The official
OpenAI tunnel documents that an upstream authorization server is not
automatically made browser-public, which is why the preferred tunnel mode uses
the local fixed header instead.

## Workspace data path

```text
untrusted MCP arguments
        |
        v
schema / size validation
        |
        v
canonical workspace containment
        |
        v
built-in sensitive denylist + .c2cignore
        |
        v
bounded filesystem, search, Git, or execution-record operation
        |
        v
credential-shaped value redaction
        |
        v
bounded JSON MCP response
```

The redaction stage is not a data-classification system. Project owners must
exclude their own PII and proprietary paths.

## Git data path

Git commands run only when `.git` exists at the selected root. C2C removes
environment overrides, ignores global/system Git config, disables fsmonitor,
hooks, external diff and textconv, uses literal pathspecs, and prevents optional
locks and terminal prompts. Diff paths are enumerated and filtered before their
content is requested.

## Process and state lifecycle

- The default listener is `127.0.0.1:48765`; a free ephemeral port is used on
  collision.
- A public `/health` response proves only that some C2C service is healthy.
- Reuse requires authenticated `/admin/info` with matching workspace ID and PID.
- Runtime files hold a private admin token. Stale records are cleared, but their
  PIDs are never signaled without authenticated identity proof.
- Shutdown is requested through the loopback admin API.
- Remote transport choice is fixed for a running daemon. Switching modes
  requires an explicit stop/restart.

## Deliberately absent automation

C2C does not install Node.js, pnpm, `tunnel-client`, or `cloudflared`; create or
delete Platform tunnels; manipulate credentials; silently operate ChatGPT;
change Codex sandbox configuration during setup; update its checkout; or claim
that a connector is working based only on local state. The separate sandbox
command offers a non-mutating `--check` before any approved edit.
