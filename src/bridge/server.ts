import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { safeEqual } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import {
  hasValidTrustedTunnelToken,
  removeTrustedTunnelToken,
  trustedTunnelTokenFile,
} from "../auth/trusted-tunnel.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { normalizeExternalBaseUrl } from "../config/transport.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";
import { CodexAppServer } from "../codex/app-server.js";
import { createLocalSoundNotifier, type CompletionNotifier } from "../notifications/local-sound.js";
import type { DesktopAgent } from "../desktop/client.js";

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
  /** Stable externally visible HTTPS base URL for a managed tunnel. */
  externalBaseUrl?: string;
  /** Owner-only token file used by OpenAI Secure MCP Tunnel static headers. */
  trustedTunnelTokenFile?: string;
  /** Enable the two Codex execution tools; valid only with trusted tunnel auth. */
  codexExecution?: boolean;
  /** Optional explicit installed official Codex executable path. */
  codexBinary?: string;
  /** Test-only injection; production uses C2C_COMPLETION_SOUND_PATH. */
  completionNotifier?: CompletionNotifier;
  /** Optional Desktop Agent injection. Undefined auto-detects the installed local agent; null disables it. */
  desktopAgent?: DesktopAgent | null;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const completionNotifier = opts.completionNotifier ?? createLocalSoundNotifier({
    soundPath: process.env.C2C_COMPLETION_SOUND_PATH,
    logger,
  });
  const desktopAgent = opts.desktopAgent ?? undefined;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? new CloudflaredQuickTunnel(logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  if (
    opts.trustedTunnelTokenFile &&
    path.resolve(opts.trustedTunnelTokenFile) !== path.resolve(trustedTunnelTokenFile(workspace.id))
  ) {
    throw new Error("Trusted tunnel token file must use the per-workspace state location.");
  }
  if (opts.codexExecution && !opts.trustedTunnelTokenFile) {
    throw new Error("Codex execution requires OpenAI Secure MCP Tunnel authentication.");
  }
  if (opts.codexBinary && !opts.codexExecution) {
    throw new Error("A Codex binary override requires Codex execution mode.");
  }
  const codex = opts.codexExecution
    ? new CodexAppServer({ workspaceRoot: workspace.root, binary: opts.codexBinary, logger, completionNotifier })
    : undefined;

  let publicBaseUrl: string | null = null;
  const managedExternalUrl = Boolean(opts.externalBaseUrl);
  if (opts.externalBaseUrl) {
    publicBaseUrl = normalizeExternalBaseUrl(opts.externalBaseUrl);
  }

  const app = express();
  app.set("trust proxy", false);
  app.set("query parser", "simple");
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  const getBaseUrl = (_req: Request): string => {
    const activePublicUrl = managedExternalUrl ? publicBaseUrl : tunnel.getPublicUrl();
    if (activePublicUrl) return activePublicUrl;
    return `http://${host}:${port}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, status: "ok" });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(
    () => createMcpServer({ workspace, logger, codex, completionNotifier, desktopAgent }),
    logger
  );
  let activeMcpRequests = 0;
  const admitMcpRequest = (_req: Request, res: Response, next: NextFunction): void => {
    if (activeMcpRequests >= 8) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    activeMcpRequests++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activeMcpRequests--;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  app.post(
    "/mcp",
    bearerAuth({
      store: authStore,
      workspaceId: workspace.id,
      getBaseUrl,
      logger,
      trustedTunnelTokenFile: opts.trustedTunnelTokenFile,
      trustedTunnelCodexExecution: Boolean(opts.codexExecution),
      trustedTunnelDesktopAccess: Boolean(desktopAgent),
    }),
    admitMcpRequest,
    express.json({ limit: "1mb", strict: true }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );
  app.all("/mcp", (_req, res) => {
    res.status(405).json({ error: "method_not_allowed" });
  });

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || !safeEqual(token, adminToken)) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      publicUrl: managedExternalUrl ? publicBaseUrl : tunnel.getPublicUrl(),
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      trustedTunnelAuth: Boolean(opts.trustedTunnelTokenFile),
      trustedTunnelTokenPresent:
        Boolean(opts.trustedTunnelTokenFile) && hasValidTrustedTunnelToken(workspace.id),
      codexExecution: Boolean(opts.codexExecution),
      codexRuntimeDetected: Boolean(codex),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    if (managedExternalUrl || opts.trustedTunnelTokenFile) {
      res.status(409).json({
        error: "different_transport_configured",
        message: "A different remote transport is configured; restart explicitly to change transports.",
      });
      return;
    }
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    if (managedExternalUrl || opts.trustedTunnelTokenFile) {
      res.status(409).json({
        error: "different_transport_configured",
        message: "This process is not using Cloudflare Quick Tunnel; restart explicitly to change transports.",
      });
      return;
    }
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    const trustedTunnelRevoked = removeTrustedTunnelToken(workspace.id);
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count, trustedTunnelRevoked });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: managedExternalUrl ? publicBaseUrl : tunnel.getPublicUrl(),
      trustedTunnelAuth: Boolean(opts.trustedTunnelTokenFile),
      codexExecution: Boolean(opts.codexExecution),
      startedAt,
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await codex?.close().catch(() => undefined);
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
    logger.info("Bridge stopped");
  };

  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) res.status(400).json({ error: "invalid_request" });
  });

  return {
    workspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => (managedExternalUrl ? publicBaseUrl : tunnel.getPublicUrl()),
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
