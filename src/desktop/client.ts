import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger/index.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_REQUEST_TIMEOUT_MS = 125_000;
const DEFAULT_REQUEST_DEADLINE_MARGIN_MS = 2_000;
const PROCESS_REQUEST_DEADLINE_MARGIN_MS = 5_000;

export type DesktopAgentRequest = Record<string, unknown>;

export interface DesktopAgent {
  call(request: DesktopAgentRequest): Promise<unknown>;
}

export class DesktopAgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface DesktopAgentClientOptions {
  rpcPath: string;
  configPath: string;
  logger: Logger;
  nodeBinary?: string;
}

function validateRegularFile(file: string, label: string): string {
  if (!path.isAbsolute(file)) throw new Error(`${label} must be an absolute path.`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  return fs.realpathSync.native(file);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.platform === "darwin"
      ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      : "/usr/local/bin:/usr/bin:/bin",
  };
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function defaultPaths(): { rpcPath: string; configPath: string } | null {
  const home = process.env.HOME || os.homedir();
  if (!home || !path.isAbsolute(home)) return null;
  return {
    rpcPath: path.join(home, ".local", "share", "opp-desktop-agent", "current", "src", "rpc.mjs"),
    configPath: path.join(home, ".local", "share", "opp-desktop-agent", "config", "roots.json"),
  };
}

function requestTiming(request: DesktopAgentRequest): { timeoutMs: number; deadlineAt: string } {
  const processRun = request.op === "processRun";
  const timeoutMs = processRun ? PROCESS_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
  const marginMs = processRun ? PROCESS_REQUEST_DEADLINE_MARGIN_MS : DEFAULT_REQUEST_DEADLINE_MARGIN_MS;
  return {
    timeoutMs,
    deadlineAt: new Date(Date.now() + timeoutMs - marginMs).toISOString(),
  };
}

export class DesktopAgentClient implements DesktopAgent {
  readonly rpcPath: string;
  readonly configPath: string;
  readonly nodeBinary: string;

  constructor(private readonly opts: DesktopAgentClientOptions) {
    this.rpcPath = validateRegularFile(opts.rpcPath, "Desktop Agent RPC");
    this.configPath = validateRegularFile(opts.configPath, "Desktop Agent config");
    this.nodeBinary = validateRegularFile(opts.nodeBinary ?? process.execPath, "Node executable");
  }

  async call(request: DesktopAgentRequest): Promise<unknown> {
    // The caller never controls this lease: leave time to return a fail-closed
    // response before the outer hard-kill fires.
    const timing = requestTiming(request);
    const payload = JSON.stringify({
      ...request,
      requestDeadlineAt: timing.deadlineAt,
    });
    if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) {
      throw new DesktopAgentError("REQUEST_TOO_LARGE", "Desktop Agent request exceeds the local limit.");
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          this.nodeBinary,
          [this.rpcPath, "--config", this.configPath],
          {
            shell: false,
            env: childEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }
        );
      } catch {
        reject(new DesktopAgentError("DESKTOP_AGENT_UNAVAILABLE", "Desktop Agent could not be started."));
        return;
      }

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settled = true;
        reject(new DesktopAgentError("DESKTOP_AGENT_TIMEOUT", "Desktop Agent request timed out."));
    }, timing.timeoutMs);
      timer.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_RESPONSE_BYTES) {
          child.kill("SIGKILL");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 64 * 1024) child.kill("SIGKILL");
      });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DesktopAgentError("DESKTOP_AGENT_UNAVAILABLE", "Desktop Agent process failed."));
      });
      child.once("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutBytes > MAX_RESPONSE_BYTES || stderrBytes > 64 * 1024) {
          reject(new DesktopAgentError("DESKTOP_AGENT_OUTPUT_LIMIT", "Desktop Agent output exceeded the limit."));
          return;
        }

        try {
          const text = Buffer.concat(stdout).toString("utf8").trim();
          const parsed = JSON.parse(text) as {
            ok?: unknown;
            result?: unknown;
            error?: unknown;
            message?: unknown;
          };
          if (parsed.ok === true) {
            resolve(parsed.result);
            return;
          }
          const code = typeof parsed.error === "string" ? parsed.error : "DESKTOP_AGENT_FAILED";
          const message = typeof parsed.message === "string"
            ? parsed.message
            : "Desktop Agent request failed.";
          reject(new DesktopAgentError(code, message));
        } catch {
          reject(new DesktopAgentError("DESKTOP_AGENT_PROTOCOL", "Desktop Agent returned an invalid response."));
        }
      });

      child.stdin.end(payload);
    });
  }
}

export function createInstalledDesktopAgent(
  logger: Logger,
  overrides: Partial<Pick<DesktopAgentClientOptions, "rpcPath" | "configPath">> = {}
): DesktopAgentClient | undefined {
  const defaults = defaultPaths();
  if (!defaults) return undefined;
  const rpcPath = overrides.rpcPath ?? process.env.C2C_DESKTOP_AGENT_RPC ?? defaults.rpcPath;
  const configPath = overrides.configPath ?? process.env.C2C_DESKTOP_AGENT_CONFIG ?? defaults.configPath;
  if (!fs.existsSync(rpcPath) || !fs.existsSync(configPath)) return undefined;
  try {
    return new DesktopAgentClient({ rpcPath, configPath, logger });
  } catch (error) {
    logger.warn("Desktop Agent integration disabled", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
