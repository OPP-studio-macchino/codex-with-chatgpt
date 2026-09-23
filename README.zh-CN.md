# Codex with ChatGPT — 加固分支

这是一个需要明确授权的 MCP 桥：基础工作区通道为只读，ChatGPT 可按需检查指定
的本地工作区以辅助规划和审查。可选的 Codex execution 与 Desktop Agent mutation
通道使用独立 scope 和本地授权，不提供任意 shell 或任意 UI 自动化。

本仓库基于
[`XiaoDuoYa/codex-with-chatgpt`](https://github.com/XiaoDuoYa/codex-with-chatgpt)
的 commit `2165dea39017d29fef95b85e8054669ad68541e1` 进行安全重构。
它是独立社区项目，不代表 OpenAI 或 Cloudflare，也未获得其背书。

English: [README.md](README.md) · 日本語: [README.ja.md](README.ja.md)

## 真实的数据边界

ChatGPT 调用 MCP 工具时，请求到的源码片段、搜索结果、diff、路径和执行摘要会离开
本机，由 ChatGPT/OpenAI 处理。它不会一次性上传整个仓库，但也不能宣称“仓库永不
离开本机”。如果使用 Cloudflare Quick Tunnel，Cloudflare 也在传输链路中。

桥会拒绝常见凭据路径、执行 `.c2cignore`、限制输出大小并遮蔽多类凭据形文本。
这些措施只能降低风险，不能保证发现任意个人信息、商业机密或所有秘密格式。连接前
请检查工作区，并添加项目专用的 `.c2cignore`。

## 本分支的主要加固

- 默认仅本地运行；所有远程传输都需要显式选项。
- 优先支持 OpenAI Secure MCP Tunnel，并使用每工作区的私有固定请求头令牌。
- Cloudflare Quick Tunnel 仅作为明确选择的备用方案。
- 强化 OAuth redirect URI、PKCE、请求体、路由并发、每个配对窗口的注册总量和状态表
  hard cap。尝试次数按授权请求隔离，已接受的 provisional client 不会为后续不受信任
  注册而被驱逐。
- 使用 canonical realpath 阻止 `..`、绝对路径和符号链接逃逸；文件始终从同一个已验证
  descriptor 流式读取，project metadata 与 `.c2cignore` 也绑定到 descriptor；目录在遍历
  期间 identity 发生变化时会被拒绝。
- 对文件、搜索、Git 状态/diff 和执行记录统一执行敏感路径过滤；先对完整的有界逻辑单元
  进行有状态行流遮蔽，跨分页和搜索行的多行 private key 仍会被隐藏。
- 工作区搜索仅支持通过已验证 reader 执行的 literal 模式；无法保证 containment 的正则
  subprocess 搜索已禁用。
- Git 读取禁用全局配置、hooks、external diff、textconv、pager、lazy fetch 和父仓库穿透。
  含 filter、include、partial clone、credential helper 或 SSH command 的仓库会在读取
  index/object 前拒绝 Git status/diff。执行使用 owner-only 的临时 sanitized control-metadata
  snapshot，所有 status 路径忽略 submodule；`workspace_info` 不调用 Git。
- 管理接口同时要求 loopback 来源和 owner-only 管理令牌。
- `doctor` 不会打开公网隧道，`update-check` 不会安装更新，全局 Codex 配置修改被
  拆分到单独的 `sandbox-allow` 命令。
- Skill 不再静默安装软件、自动 pull/stash、修改连接器或隐藏浏览器操作。

详见 [安全模型](docs/security.md) 和 [加固记录](docs/hardening.md)。

## 安装

需要 Node.js 20+、Git 和 Corepack/pnpm。请先审查仓库和 lockfile：

```bash
git clone https://github.com/OPP-studio-macchino/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js --help
```

安装依赖可能执行第三方包的生命周期代码，必须由使用者明确决定。本项目不会静默安装
系统软件，也不会自行更新。

下文的 `c2c` 可替换为 `node /path/to/bin/c2c.js`。

## 连接方式

### 1. 仅本地（默认）

```bash
c2c setup -w /absolute/path/to/workspace --json
```

仅启动 loopback bridge，不创建任何远程传输。bridge 本地健康不等于 ChatGPT 已连接。

### 2. OpenAI Secure MCP Tunnel（推荐）

官方方式由本机向 OpenAI 建立 outbound HTTPS，不为本地 MCP 打开公网监听。它要求
`tunnel_id`、`tunnel-client` runtime API key、Platform 的 Tunnels Read + Use、
ChatGPT developer mode，以及 tunnel 与目标组织/工作区的正确关联。Platform 权限与
ChatGPT 权限彼此独立。

先准备本地固定请求头认证：

```bash
c2c setup -w /absolute/path/to/workspace --openai-secure-tunnel --json
```

受限的 Codex execution 需要显式 opt-in。

```bash
c2c setup -w /absolute/path/to/workspace --openai-secure-tunnel --codex-execution --json
```

#### 可选完成提示音

可设置 `C2C_COMPLETION_SOUND_PATH=/absolute/path/to/sound-file`，其值必须是存在的绝对
本地普通文件路径。在 macOS 上，C2C 使用 `/usr/bin/afplay` 播放，无需额外依赖。仅当
Codex 的 `turn/completed` 成功时自动恰好播放一次；失败或 blocked 的工作不会播放。
播放为尽力而为：播放失败绝不会将成功的工作结果变为失败。

同时配置受信任的 C2C Codex-execution 连接和该提示音时，C2C 还会公开
`completion_notify`。ChatGPT Web 和 ChatGPT macOS app 会被协作性地指示：仅在请求的
工作完全完成后、最终回答之前，将其作为最后一次 C2C tool call 恰好调用一次。这是协作式
MCP 信号，不是原生 ChatGPT UI 完成事件检测，也不是 Accessibility/browser polling。

JSON 会返回 `localMcpUrl`、`trustedTunnelHeader` 和
`trustedTunnelTokenFile`，不会返回令牌值。为普通 MCP 与 discovery 请求同时配置
`file:` 引用：

```bash
tunnel-client run \
  --control-plane.tunnel-id='<approved tunnel_id>' \
  --control-plane.api-key=file:/absolute/protected/path/to/openai-tunnel-runtime-api-key \
  --mcp.server-url='<localMcpUrl>' \
  --mcp.extra-headers '<trustedTunnelHeader>: file:<trustedTunnelTokenFile>' \
  --mcp.discovery-extra-headers '<trustedTunnelHeader>: file:<trustedTunnelTokenFile>'
```

不要把 API key 或令牌粘贴到聊天、shell 历史、issue 或配置文件。ChatGPT 创建
developer-mode app 时选择 **Tunnel**，只选择经过确认的 `tunnel_id`。

应分别验证：本地 bridge、`tunnel-client` ready/polling、ChatGPT 实际调用目标工作区
的 `workspace_info`。本分支已测试实现与本地认证路径，但需要账号专用权限和凭据的
官方 tunnel 真实端到端连接目前为 **UNVERIFIED**。

### 3. Cloudflare Quick Tunnel（显式备用）

```bash
c2c setup -w /absolute/path/to/workspace --cloudflare-quick-tunnel --json
```

这会通过 Cloudflare 创建临时公网 HTTPS URL。MCP 仍要求 OAuth、PKCE 和一次性配对码，
但公网攻击面和 Cloudflare 传输边界确实存在。命令不会自动安装 `cloudflared`。

### 4. 自管 HTTPS origin

```bash
c2c setup -w /absolute/path/to/workspace \
  --external-base-url https://reviewed-origin.example --json
```

调用者负责代理/隧道、TLS、DNS、日志与运行安全。C2C 校验 URL，但不建立或审计该链路。

## 项目专用隐私规则

在目标工作区根目录创建 `.c2cignore`，语法与 gitignore 相同：

```gitignore
internal-notes/
customer-data/
fixtures/private-*
```

`.c2cignore` 本身不会通过 MCP 返回。请自行加入客户信息和专有资料路径。

## 常用命令

```bash
c2c status -w <workspace> --json
c2c doctor -w <workspace> --json
c2c doctor -w <workspace> --fix --json  # 只启动缺失的本地 bridge
c2c logs -w <workspace> -n 100
c2c pair -w <workspace>                 # OAuth 模式
c2c unpair -w <workspace>               # 吊销本地认证
c2c stop -w <workspace>
c2c update-check --json                 # 只提示，不安装
```

先用 `c2c sandbox-allow --check --json` 无写入地查看目标路径。
`c2c sandbox-allow --json` 会改动用户的全局 Codex 配置，并在已有配置时创建私有恢复
备份；只有展示路径并获得明确授权后才可运行。

## 状态与免责声明

本分支经过加固和自动测试，但未做形式化验证，也没有独立第三方安全审计。基础工作区
通道为只读；可选 Desktop Agent / Codex 通道仅在独立 scope 和本地授权下执行有限变更。
这些控制并不意味着源码泄露、prompt injection、主机或供应链风险为零。

报告安全问题请遵循 [SECURITY.md](SECURITY.md)，不要在 issue 中放入真实凭据、私有
源码、个人信息或原始生产证据。

License: [MIT](LICENSE).
