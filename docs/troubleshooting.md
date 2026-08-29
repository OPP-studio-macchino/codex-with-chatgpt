# Troubleshooting

Start with read-only diagnostics:

```bash
c2c status -w <workspace> --json
c2c doctor -w <workspace> --json
```

`doctor` does not start or restore a remote tunnel and does not modify global
Codex configuration. `doctor --fix` may start a missing **local** bridge only.

## Bridge is not running

```bash
c2c start -w <workspace>
c2c logs -w <workspace> -n 100
```

If a specific remote mode is intended, stop first and repeat `start` with the
explicit transport option. A running bridge cannot silently change its
authentication or external-origin mode.

## OpenAI Secure MCP Tunnel is not reaching C2C

Check each boundary separately:

1. `c2c status --json` reports `trustedTunnelAuth: true`.
2. `c2c doctor --json` confirms the local token file exists. This does not test
   the OpenAI side.
3. Run the official client diagnostic for the approved profile:

   ```bash
   tunnel-client doctor --profile <profile> --explain
   ```

4. Confirm `tunnel-client run` remains ready and polling. Its local admin UI is
   loopback-only by default.
5. Confirm the tunnel is associated with the intended Platform organization
   and ChatGPT workspace, and the operator has Tunnels Read + Use.
6. In ChatGPT developer-mode app creation, choose **Tunnel** and the exact
   tunnel ID. Test an actual `workspace_info` call.

The C2C fixed header must be configured for both normal and discovery requests:

```text
--mcp.extra-headers "X-C2C-Tunnel-Token: file:<token-file>"
--mcp.discovery-extra-headers "X-C2C-Tunnel-Token: file:<token-file>"
```

Do not print the token file. If `c2c unpair` was run, the file is intentionally
gone. Stop the old client, obtain approval to reconnect, and run setup again.

## Tunnel is not visible in ChatGPT

Platform tunnel permissions and ChatGPT developer-mode access are separate.
Check the target Platform organization, tunnel-to-workspace association,
Tunnels Read + Use, and ChatGPT workspace policy. A tunnel associated only with
a personal Platform organization may not appear in a separate Enterprise/Edu
workspace.

## Cloudflare Quick Tunnel is unreachable

`c2c doctor` may report the old public endpoint as unreachable, but it will not
reopen public exposure. After the user explicitly approves another temporary
public endpoint:

```bash
c2c restart -w <workspace> --cloudflare-quick-tunnel
```

Quick Tunnel URLs can change after restart. Update only the connector belonging
to this workspace and repeat OAuth pairing. Do not edit other connectors.

## `cloudflared` is missing

C2C intentionally does not install it. If the user has accepted the Cloudflare
fallback, install it using Cloudflare's current official instructions, verify
the binary provenance/version, and place it in a standard system location such
as `/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin` before retrying. C2C
does not execute a workspace- or arbitrary `PATH`-provided tunnel binary.
Otherwise use local-only or OpenAI Secure MCP Tunnel mode.

## Pairing code is invalid or expired

Pairing codes are one-time and short-lived. This applies to the OAuth external
HTTPS mode, not fixed-header OpenAI tunnel mode.

```bash
c2c pair -w <workspace>
```

Confirm the pairing page shows the expected workspace, client, callback origin,
and scopes before entering the new code.

## ChatGPT receives 401 in OAuth mode

The access token may be expired/revoked, or refresh rotation may have failed.
Generate a new pairing code and reconnect the intended connector. If access was
revoked intentionally, obtain approval before reconnecting.

In trusted-tunnel mode, 401 usually means the fixed header is absent, the wrong
workspace token file is configured, the file permissions/value are invalid, or
`unpair` removed it.

## Reading a file returns `ACCESS_DENIED_SENSITIVE_FILE`

The path matches the built-in deny policy or `.c2cignore`. Do not bypass the
policy by copying the content to another allowed path. If the content truly
needs external review, make a separate, redacted artifact after explicit user
approval.

If every operation fails after adding `.c2cignore`, ensure the file is readable
by the local account. C2C fails closed when it cannot enforce that file.

## Search regex is unsupported

Regex mode requires ripgrep. Literal search has a bounded Node.js fallback.
Install ripgrep only with approval, or repeat the request as a literal search.

## Git status/diff differs from an interactive shell

C2C deliberately ignores global/system Git config and disables hooks, external
diff drivers, textconv, renames, pagers, and parent-repository discovery. The
result is a hardened inspection view, not necessarily byte-for-byte identical
to the user's customized interactive Git output.

## Codex cannot write C2C state

The state directory lives outside the repository. First inspect the target
paths without mutation:

```bash
c2c sandbox-allow --check --json
```

The separate command below edits the user's global Codex config and creates an
owner-only recovery backup when a config already exists:

```bash
c2c sandbox-allow --json
```

Show the reported paths and obtain explicit approval before running the
modifying command. It is not an automatic repair step.

## Revoke access

```bash
c2c unpair -w <workspace>
c2c stop -w <workspace>
```

`unpair` revokes local OAuth state and deletes the trusted-tunnel token. It does
not stop `tunnel-client`, delete a Platform tunnel, or remove a ChatGPT app.
Those are distinct actions and require separate intent.

## Version drift

```bash
c2c update-check --json
```

This is advisory only. Before updating, inspect local changes, the exact source
repository, tag/commit, release notes, lockfile, and test result. Never resolve
an update by automatically stashing, resetting, cleaning, or pulling over user
work.
