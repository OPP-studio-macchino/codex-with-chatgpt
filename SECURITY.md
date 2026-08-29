# Security policy

## Supported version

Security fixes are developed against the latest commit on this fork's default
branch. No long-term support promise is currently made for older commits or for
the upstream repository.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for
`OPP-studio-macchino/codex-with-chatgpt` when available. Include the smallest
reproduction, affected commit, expected boundary, and impact.

Do **not** include live API keys, OAuth tokens, tunnel tokens, cookies, private
source, customer data, personal data, raw logs, or production evidence. Replace
them with synthetic values and redact local paths. If private reporting is not
available, open a minimal public issue asking for a private contact channel and
do not disclose exploit details there.

## Scope guidance

Useful reports include workspace escape, sensitive-path bypass, authentication
bypass, token disclosure, unauthorized remote exposure, repository-controlled
command execution, unsafe update/config mutation, or a reproducible redaction
bypass involving a common credential format.

The following are known limitations unless a new bypass is demonstrated:

- requested MCP content is sent to ChatGPT/OpenAI;
- pattern redaction cannot detect arbitrary PII or all secret encodings;
- a process already running as the same OS user can generally read the
  workspace and C2C state;
- Cloudflare Quick Tunnel is a public transport when explicitly enabled;
- the project has no independent audit or formal security proof.

Please allow maintainers reasonable time to investigate before public
disclosure.
