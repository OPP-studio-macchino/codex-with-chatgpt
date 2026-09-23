# OpenAI submission architecture question draft

Status: **draft only — not sent**

This note prepares the architecture question that must be resolved before C2C Auto-loop can
be submitted as a public MCP-backed Plugin. It contains no account IDs, credentials, tunnel
IDs, local paths, or private workspace content.

## English draft

Subject: Public Plugin submission path for a per-user local MCP reached through OpenAI Secure MCP Tunnel

Hello OpenAI Plugins team,

We are preparing **C2C Auto-loop**, an open-source MCP integration that connects ChatGPT
planning/review to a development workspace selected by the user.

Its security model intentionally keeps the MCP server on the user's own machine. The
preferred remote transport is OpenAI Secure MCP Tunnel: the local bridge binds to loopback,
the user explicitly selects the intended tunnel, and workspace content is returned only
through bounded MCP tools. The default tool set is read-oriented; an optional Codex execution
mode is separately gated and keeps user approval in the loop.

The standard public Plugin submission guidance asks for a stable production HTTPS MCP URL.
We do not want to replace the local/tunnel architecture with a hosted multi-tenant server
merely to fit the review form, because that would materially change the product's privacy and
security model.

Could you confirm the supported public-submission path for this architecture?

1. Can a public Plugin be reviewed and distributed when each user runs the MCP server locally
   and ChatGPT reaches it through OpenAI Secure MCP Tunnel?
2. If yes, what should be entered or provided for the MCP URL and domain-verification steps?
3. Is a Template URL or another approved mechanism available for this per-user local-server
   model, and if so what eligibility/process applies?
4. If this architecture requires a separate review or trusted-developer process, which channel
   should we use before creating the final submission?

Repository:
https://github.com/OPP-studio-macchino/codex-with-chatgpt

We can provide an exact candidate revision, complete tool inventory and annotations, five
positive and three negative reviewer tests, privacy/terms/support URLs, and a demo recording
once the supported endpoint model is confirmed.

Thank you.

## 日本語メモ

確認したい核心は、「C2Cを公開Pluginにするためだけに中央ホスト型MCPへ設計変更する必要が
あるのか」です。

現在のC2Cは、ユーザーが選んだローカルworkspaceをローカルMCPが扱い、OpenAI Secure MCP
TunnelでChatGPTから到達する設計です。公開submissionの通常経路が求める固定HTTPS MCP
endpointと一致しないため、実装を変える前にOpenAIへ次を確認します。

- Secure MCP Tunnel経由のユーザー別ローカルMCPを公開Pluginとしてreviewできるか。
- 可能な場合、MCP URLとdomain verificationをどう扱うか。
- Template URL等の対象になるか、対象条件と申請経路は何か。
- 個別reviewが必要なら、最終submission前にどの窓口を使うか。

回答が得られるまで、公開用の中央multi-tenant MCPへ勝手に設計変更しません。
