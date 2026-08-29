import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { appendExecutionRecord } from "../execution/records.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import { Logger, redact } from "../logger/index.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import {
  normalizeChatGptSessionUrl,
  readSavedSession,
  sanitizeSessionLabel,
  sessionFile,
  type SavedSession,
} from "../config/session.js";
import { assertTransportCompatible, selectedTransport } from "../config/transport.js";
import { runGit as runWorkspaceGit } from "../workspace/git.js";
import {
  hasValidTrustedTunnelToken,
  TRUSTED_TUNNEL_HEADER,
  removeTrustedTunnelToken,
  trustedTunnelTokenFile,
} from "../auth/trusted-tunnel.js";
import {
  ensureSandboxAllowlist,
  inspectSandboxAllowlist,
} from "../config/sandbox-allow.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function trySandboxAllow():
  | {
      ok: true;
      added: boolean;
      alreadyAllowed: boolean;
      stateDir: string;
      configPath: string;
      backupPath?: string;
    }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface RevokeResponse {
  revoked: number;
  trustedTunnelRevoked: boolean;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  trustedTunnelAuth: boolean;
  trustedTunnelTokenPresent: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { cloudflareQuickTunnel: boolean; externalBaseUrl?: string; openaiSecureTunnel: boolean }
): Promise<{
  runtime: RuntimeState;
  info: AdminInfo;
  mcpUrl: string | null;
  localMcpUrl: string;
  trustedTunnelTokenFile: string | null;
}> {
  const requestedTransport = selectedTransport(opts);
  const { runtime } = await ensureBridge(workspaceRoot, {
    externalBaseUrl: opts.externalBaseUrl,
    trustedTunnelAuth: opts.openaiSecureTunnel,
  });
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  assertTransportCompatible(info, requestedTransport);
  const localMcpUrl = `http://127.0.0.1:${runtime.port}/mcp`;
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.cloudflareQuickTunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return {
    runtime,
    info,
    mcpUrl,
    localMcpUrl,
    trustedTunnelTokenFile: opts.openaiSecureTunnel ? trustedTunnelTokenFile(info.workspaceId) : null,
  };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .option("--external-base-url <url>", "managed tunnel HTTPS origin")
  .option("--trusted-tunnel-token-file <path>", "owner-only tunnel token file")
  .action(async (opts: {
    workspace: string;
    port?: string;
    externalBaseUrl?: string;
    trustedTunnelTokenFile?: string;
  }) => {
    const workspaceRoot = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(workspaceRoot);
    const logger = new Logger({ name: `bridge-${workspace.id}`, console: process.env.C2C_DAEMON !== "1" });
    const bridge = await startBridge({
      workspaceRoot,
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      externalBaseUrl: opts.externalBaseUrl,
      trustedTunnelTokenFile: opts.trustedTunnelTokenFile,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--cloudflare-quick-tunnel", "explicitly expose through a temporary public Cloudflare URL", false)
  .option("--openai-secure-tunnel", "prepare local authentication for OpenAI Secure MCP Tunnel", false)
  .option("--external-base-url <url>", "HTTPS origin provided by a managed tunnel")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    cloudflareQuickTunnel: boolean;
    openaiSecureTunnel: boolean;
    externalBaseUrl?: string;
    json: boolean;
  }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl, localMcpUrl, trustedTunnelTokenFile: tokenFile } =
        await ensureBridgeAndTunnel(root, opts);
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            port: runtime.port,
            workspaceId: info.workspaceId,
            transport: selectedTransport(opts),
            mcpUrl,
            localMcpUrl,
            connectorName,
            trustedTunnelHeader: tokenFile ? TRUSTED_TUNNEL_HEADER : null,
            trustedTunnelTokenFile: tokenFile,
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("リモート接続先を設定しました");
      if (tokenFile) check("OpenAI Secure MCP Tunnel 用のローカル認証を準備しました");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("Prepare a local bridge; every remote transport is explicit")
  .option("-w, --workspace <path>")
  .option("--cloudflare-quick-tunnel", "explicitly expose through a temporary public Cloudflare URL", false)
  .option("--openai-secure-tunnel", "prepare local authentication for OpenAI Secure MCP Tunnel", false)
  .option("--external-base-url <url>", "HTTPS origin provided by a managed tunnel")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    cloudflareQuickTunnel: boolean;
    openaiSecureTunnel: boolean;
    externalBaseUrl?: string;
    json: boolean;
  }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const { runtime, info, mcpUrl, localMcpUrl, trustedTunnelTokenFile: tokenFile } =
        await ensureBridgeAndTunnel(root, opts);
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = mcpUrl && !opts.openaiSecureTunnel
        ? await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing")
        : null;
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl,
            localMcpUrl,
            local: mcpUrl === null && !opts.openaiSecureTunnel,
            transport: selectedTransport(opts),
            pairingCode: pairingResult?.code ?? null,
            pairingExpiresAt: pairingResult?.expiresAt ?? null,
            trustedTunnelHeader: tokenFile ? TRUSTED_TUNNEL_HEADER : null,
            trustedTunnelTokenFile: tokenFile,
            sandboxModified: false,
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("リモート接続先を設定しました");
      if (tokenFile) check("OpenAI Secure MCP Tunnel 用のローカル認証を準備しました");
      say("");
      say(`ローカル MCP：${localMcpUrl}`);
      if (mcpUrl) say(`公開 MCP：${mcpUrl}`);
      if (pairingResult) {
        say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      }
      if (tokenFile) {
        say(`トンネル固定ヘッダー：${TRUSTED_TUNNEL_HEADER}（値は ${tokenFile} を file: 参照）`);
      }
      say("");
      say(
        tokenFile
          ? "次に、公式 tunnel-client をこのローカル MCP と固定ヘッダーへ設定し、ChatGPT では Tunnel 接続を選択します。"
          : mcpUrl
            ? "下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。"
            : "ローカル限定で準備しました。ChatGPT 接続は未作成です。リモート接続には方式の明示選択が必要です。"
      );
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--cloudflare-quick-tunnel", "explicitly expose through a temporary public Cloudflare URL", false)
  .option("--openai-secure-tunnel", "prepare local authentication for OpenAI Secure MCP Tunnel", false)
  .option("--external-base-url <url>", "HTTPS origin provided by a managed tunnel")
  .action(async (opts: {
    workspace?: string;
    cloudflareQuickTunnel: boolean;
    openaiSecureTunnel: boolean;
    externalBaseUrl?: string;
  }) => {
    const root = resolveWorkspace(opts.workspace);
    // Validate mutually exclusive transport intent before stopping a healthy
    // process. A malformed restart request must be non-destructive.
    selectedTransport(opts);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl, trustedTunnelTokenFile: tokenFile } = await ensureBridgeAndTunnel(root, opts);
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check("明示的に選択した外部 HTTPS 接続を設定しました");
      if (tokenFile) check("OpenAI Secure MCP Tunnel 用のローカル認証を準備しました");
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (!runtime) {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) {
      check(`Cloudflare Quick Tunnel（公開）：${info.tunnel.url}/mcp`);
    } else if (info.publicUrl) {
      check(`管理対象の外部 HTTPS 接続：${info.publicUrl}/mcp`);
    } else if (info.trustedTunnelAuth) {
      if (info.trustedTunnelTokenPresent) {
        check("OpenAI Secure MCP Tunnel：ローカル固定ヘッダー認証を準備済み");
        say("· tunnel-client / ChatGPT 側の到達性はこのコマンドでは未検証");
      } else {
        cross("OpenAI Secure MCP Tunnel：ローカル資格情報は失効済みまたは欠落");
      }
    } else {
      say("· リモート接続：未設定（ローカルのみ）");
    }
    say(`· OAuth 令牌：${info.tokenCount > 0 ? "已授权" : "无"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose the connection; local bridge repair is opt-in")
  .option("-w, --workspace <path>")
  .option("--fix", "start a missing local bridge; never opens a public tunnel", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Diagnostic only. Global Codex configuration is changed exclusively by
    // the explicit `sandbox-allow` command.
    try {
      const inspection = inspectSandboxAllowlist();
      report.sandbox = inspection.alreadyAllowed
        ? { ok: true, detail: "已在白名单" }
        : { ok: false, detail: "未在白名单" };
    } catch (error) {
      report.sandbox = { ok: false, detail: (error as Error).message };
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    if (workspace) {
      runtime = await findLiveBridge(workspace.id);
      if (!runtime && opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. Doctor never opens or restores public
    // exposure; that requires an explicit start/restart transport option.
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      const expectedPublic = Boolean(lastEndpoint?.publicUrl);
      const currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if (currentUrl && healthy) {
        report.transport = { ok: true, detail: `外部 HTTPS 到達確認済み: ${currentUrl}` };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp && opts.fix
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
      } else if (expectedPublic) {
        report.transport = report.transport ?? { ok: false, detail: "以前の公開 HTTPS 接続は現在到達不能" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (info.trustedTunnelAuth) {
        const tokenPresent = info.trustedTunnelTokenPresent;
        report.transport = tokenPresent
          ? {
              ok: false,
              detail: "ローカル認証は準備済み。tunnel-client / ChatGPT E2E は UNVERIFIED",
            }
          : { ok: false, detail: "OpenAI Secure MCP Tunnel の固定ヘッダートークンが見つからない" };
      } else if (!currentUrl) {
        report.transport = { ok: true, detail: "リモート接続なし（ローカルのみ）" };
      } else {
        report.transport = { ok: false, detail: "外部 HTTPS アドレスへ到達不能" };
      }
    } else if (lastEndpoint?.publicUrl) {
      report.transport = { ok: false, detail: "以前の公開 HTTPS 接続は停止中" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      const ok = Object.values(report).every((item) => item.ok) && !chatgptRepair.needed;
      say(JSON.stringify({ ok, report, repairs: results, chatgptRepair }));
      if (!ok) process.exitCode = 1;
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      transport: "Remote transport",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地状态已确认。重新公開する場合は接続方式を明示して再起動してください。"
          : "仍有问题未解决。`c2c doctor --fix` 仅修复本地 Bridge。"
    );
    if (!allOk) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (info.trustedTunnelAuth) {
        throw new Error("OpenAI Secure MCP Tunnel mode uses the fixed tunnel header, not OAuth pairing.");
      }
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch<RevokeResponse>(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
      removeTrustedTunnelToken(workspace.id);
    }
    if (new AuthStore(workspace.id).tokenCount() !== 0 || hasValidTrustedTunnelToken(workspace.id)) {
      throw new Error("Access revocation could not be verified; inspect the local state directory before reconnecting.");
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const logDir = path.join(getStateDir(), "logs");
    const candidates = [
      path.join(logDir, `bridge-${workspace.id}.log`),
      path.join(logDir, `bridge-${workspace.id}.out.log`),
    ];
    const requestedLines = Number.parseInt(opts.lines, 10);
    const lineLimit = Number.isInteger(requestedLines) ? Math.min(1000, Math.max(1, requestedLines)) : 50;
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lstat = fs.lstatSync(file);
      if (!lstat.isFile() || lstat.isSymbolicLink()) continue;
      const canonical = fs.realpathSync.native(file);
      const canonicalLogDir = fs.realpathSync.native(logDir);
      if (!canonical.startsWith(canonicalLogDir + path.sep)) continue;
      const stat = fs.statSync(canonical);
      const maxBytes = 2 * 1024 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(canonical, "r");
      const buffer = Buffer.alloc(stat.size - start);
      try {
        fs.readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(fd);
      }
      const lines = redact(buffer.toString("utf8")).trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-lineLimit).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

program
  .command("sandbox-allow")
  .description("Inspect or explicitly add the local state directory to the Codex sandbox allowlist")
  .option("--check", "inspect only; do not modify Codex configuration", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { check: boolean; json: boolean }) => {
    if (opts.check) {
      try {
        const inspection = inspectSandboxAllowlist();
        if (opts.json) say(JSON.stringify({ ok: true, checkOnly: true, added: false, ...inspection }));
        else {
          say(`Codex config：${inspection.configPath}`);
          say(`C2C state：${inspection.stateDir}`);
          say(`Allowlisted：${inspection.alreadyAllowed ? "yes" : "no"}`);
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
      return;
    }
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = runWorkspaceGit(repoRoot, args);
  return { ok: result.ok, stdout: result.stdout.trim() };
}

function parseGitHubRepository(remote: string): { owner: string; repo: string } | null {
  let owner: string;
  let repo: string;
  if (remote.startsWith("git@github.com:")) {
    const parts = remote.slice("git@github.com:".length).split("/");
    if (parts.length !== 2) return null;
    [owner, repo] = parts;
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return null;
    [owner, repo] = parts;
  }
  repo = repo.replace(/\.git$/, "");
  if (
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)
  ) {
    return null;
  }
  return { owner, repo };
}

program
  .command("update-check")
  .description("Explicitly check the configured Git remote for a newer commit; never installs it")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    const rawLast = readJsonIfExists<Record<string, unknown>>(file, 64 * 1024);
    const last: { date?: string; updateAvailable?: boolean } = {
      date:
        typeof rawLast?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawLast.date)
          ? rawLast.date
          : undefined,
      updateAvailable:
        typeof rawLast?.updateAvailable === "boolean" ? rawLast.updateAvailable : undefined,
    };

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const origin = runGit(["remote", "get-url", "origin"]);
    const repository = origin.ok ? parseGitHubRepository(origin.stdout) : null;
    if (!local.ok || !repository) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法安全检查更新（仅支持 GitHub HTTPS/SSH 来源），已跳过。" });
      return;
    }
    let remoteCommit: string;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/HEAD`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "codex-with-chatgpt-update-check",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const body = (await response.json()) as { sha?: unknown };
      if (typeof body.sha !== "string" || !/^[a-f0-9]{40}$/.test(body.sha)) {
        throw new Error("GitHub returned an invalid commit id");
      }
      remoteCommit = body.sha;
    } catch {
      emit({ checked: false, updateAvailable: false, note: "无法连接 GitHub 检查更新，已跳过。" });
      return;
    }
    const updateAvailable = remoteCommit !== local.stdout;
    writeSecureJson(file, { date: today, updateAvailable, remoteCommit });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation memory)

const session = program
  .command("session")
  .description("Remember and reuse the ChatGPT conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const file = sessionFile(workspace.id);
    const saved = readSavedSession(file);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved }));
    else if (!saved) say("尚未记录 ChatGPT 会话。");
    else {
      say(`会话：${saved.title ?? "(untitled)"}`);
      say(`地址：${saved.url}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
    }
  });

session
  .command("set")
  .description("Save the ChatGPT conversation to reuse in later tasks")
  .option("-w, --workspace <path>")
  .requiredOption("--url <url>", "conversation URL as shown in the browser address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .action((opts: { workspace?: string; url: string; title?: string; task?: string; iteration?: string; state?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const file = sessionFile(workspace.id);
    const previous = readSavedSession(file);
    const iteration = opts.iteration ? Number.parseInt(opts.iteration, 10) : previous?.iteration;
    if (iteration !== undefined && (!Number.isInteger(iteration) || iteration < 0 || iteration > 10_000)) {
      throw new Error("Invalid session iteration.");
    }
    if (opts.task && !/^[A-Za-z0-9_.:-]{1,128}$/.test(opts.task)) throw new Error("Invalid session task id.");
    if (opts.state && !/^[A-Z_]{2,32}$/.test(opts.state)) throw new Error("Invalid session state.");
    const saved: SavedSession = {
      url: normalizeChatGptSessionUrl(opts.url),
      title: sanitizeSessionLabel(opts.title) ?? previous?.title,
      taskId: opts.task ?? previous?.taskId,
      iteration,
      lastState: opts.state ?? previous?.lastState,
      savedAt: new Date().toISOString(),
    };
    writeSecureJson(file, saved);
    check("已记录 ChatGPT 会话，后续任务将复用");
  });

session
  .command("clear")
  .description("Forget the saved conversation (a new chat will be created next time)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    fs.rmSync(sessionFile(workspace.id), { force: true });
    check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = /^\d+$/.test(opts.changedFiles)
        ? parseInt(opts.changedFiles, 10)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      if (!["ok", "failed", "blocked"].includes(opts.exitStatus)) {
        throw new Error("Invalid exit status; expected ok, failed, or blocked.");
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: parseInt(opts.iteration, 10),
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus as "ok" | "failed" | "blocked",
        timestamp: new Date().toISOString(),
        notes: opts.notes,
      });
      check("已记录执行摘要");
    }
  );

function handleCliError(error: unknown, json: boolean): void {
  const message = redact(error instanceof Error ? error.message : String(error));
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("Cloudflare Quick Tunnel を明示的に選択しましたが、cloudflared が未導入です。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(redact(error.message));
  process.exit(1);
});
