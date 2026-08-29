import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";
import { redactSensitiveText } from "../security/redaction.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

function quickTunnelEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const isolatedHome = ensureDir(path.join(getStateDir(), "cloudflared-home"));
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  return env;
}

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  const match = line.match(QUICK_TUNNEL_URL_RE);
  return match ? match[0] : null;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login and the URL changes on every start.
 * Re-publication and connector changes remain explicit operator actions.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private starting: Promise<string> | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string
  ) {}

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared", { includePath: false });
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.url) return this.url;
    if (this.starting) return this.starting;
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    const attempt = new Promise<string>((resolve, reject) => {
      const child = spawn(
        bin,
        ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
        { stdio: ["ignore", "pipe", "pipe"], env: quickTunnelEnv() }
      );
      this.child = child;
      this.url = null;
      this.lastError = null;

      const timeout = setTimeout(() => {
        if (!this.url) {
          this.logger.error("Quick tunnel did not produce a URL within 45s");
          child.kill("SIGTERM");
          reject(new Error("Tunnel start timed out"));
        }
      }, 45_000);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (url && !this.url) {
            this.url = url;
            clearTimeout(timeout);
            this.logger.info(`Quick tunnel established: ${url}`);
            resolve(url);
          }
          if (/error/i.test(line)) {
            this.lastError = redactSensitiveText(line.slice(0, 400)).text;
            this.logger.debug(`cloudflared: ${this.lastError}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        clearTimeout(timeout);
        this.child = null;
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        const wasStarting = this.url === null;
        this.logger.warn(`cloudflared exited with code ${code}`);
        this.child = null;
        this.url = null;
        if (wasStarting) {
          reject(new Error(`cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`));
        }
      });
    });
    this.starting = attempt;
    try {
      return await attempt;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.starting = null;
    this.url = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
