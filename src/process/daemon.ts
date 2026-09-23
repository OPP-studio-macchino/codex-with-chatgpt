import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { clearRuntimeState, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { ensureTrustedTunnelToken } from "../auth/trusted-tunnel.js";
import { normalizeExternalBaseUrl } from "../config/transport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "CODEX_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TZ",
    "LANG",
    "LC_ALL",
    "C2C_STATE_DIR",
    "C2C_LOG_LEVEL",
    "C2C_DISABLE_RG",
    "C2C_COMPLETION_SOUND_PATH",
    "C2C_CODEX_MAX_INSTRUCTION_BYTES",
    "C2C_CODEX_MAX_SUMMARY_BYTES",
    "C2C_CODEX_MAX_ITERATIONS",
    "C2C_CODEX_ECONOMY_MODE",
  ];
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.C2C_STATE_DIR = getStateDir();
  env.C2C_DAEMON = "1";
  return env;
}

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(
  workspaceRoot: string,
  opts: {
    port?: number;
    externalBaseUrl?: string;
    trustedTunnelAuth?: boolean;
    codexExecution?: boolean;
    codexBinary?: string;
  } = {}
): Promise<EnsureBridgeResult> {
  if (opts.codexExecution && !opts.trustedTunnelAuth) {
    throw new Error("Codex execution requires OpenAI Secure MCP Tunnel mode.");
  }
  if (opts.codexBinary && !opts.codexExecution) {
    throw new Error("A Codex binary override requires Codex execution mode.");
  }
  const workspace = new Workspace(workspaceRoot);
  const live = await findLiveBridge(workspace.id);
  if (live) {
    if (opts.externalBaseUrl) {
      const requested = normalizeExternalBaseUrl(opts.externalBaseUrl);
      if (live.publicUrl !== requested) {
        throw new Error("Bridge is already running with a different external base URL; stop it first.");
      }
    }
    if (
      opts.trustedTunnelAuth !== undefined &&
      Boolean(live.trustedTunnelAuth) !== opts.trustedTunnelAuth
    ) {
      throw new Error("Bridge is already running with a different authentication mode; stop it first.");
    }
    if (opts.codexExecution !== undefined && Boolean(live.codexExecution) !== opts.codexExecution) {
      throw new Error("Bridge is already running with a different Codex execution mode; stop it first.");
    }
    if (opts.codexBinary) {
      throw new Error("Stop the running bridge before supplying a Codex binary override.");
    }
    if (opts.trustedTunnelAuth) ensureTrustedTunnelToken(workspace.id);
    return { runtime: live, spawned: false };
  }
  const trustedTunnel = opts.trustedTunnelAuth ? ensureTrustedTunnelToken(workspace.id) : null;

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const out = fs.openSync(
    logFile,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow,
    0o600
  );
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.fchmodSync(out, 0o600);
    if (fs.fstatSync(out).size > 2 * 1024 * 1024) fs.ftruncateSync(out, 0);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [
      ...args,
      "serve",
      "--workspace",
      workspace.root,
      ...(opts.port ? ["--port", String(opts.port)] : []),
      ...(opts.externalBaseUrl ? ["--external-base-url", opts.externalBaseUrl] : []),
      ...(trustedTunnel ? ["--trusted-tunnel-token-file", trustedTunnel.file] : []),
      ...(opts.codexExecution ? ["--codex-execution"] : []),
      ...(opts.codexBinary ? ["--codex-binary", opts.codexBinary] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: daemonEnv(),
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = await findLiveBridge(workspace.id);
  if (!runtime) {
    clearRuntimeState(workspace.id);
    return false;
  }
  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    return true;
  } catch {
    // Never signal a PID from a stale runtime file: it may have been reused by
    // an unrelated process. Clearing the local record is the safe fallback.
    clearRuntimeState(workspace.id);
    return false;
  }
}
