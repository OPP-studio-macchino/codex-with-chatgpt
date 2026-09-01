import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { redactAndTruncate, redactSensitiveText } from "../security/redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FIELD_CHARS = 8000;

/**
 * Secret redaction. Logs must never contain tokens, pairing codes or credentials.
 */
const REDACT_PATTERNS: RegExp[] = [
  /c2c_(?:at|rt|ac|admin|tunnel)_[A-Za-z0-9_-]+/g,
  /(authorization"?\s*[:=]\s*"?bearer\s+)[^\s"']+/gi,
  /((?:access_token|refresh_token|client_secret|code_verifier|code|token)"?\s*[:=]\s*"?)[A-Za-z0-9._~+/-]{16,}/gi,
  /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g, // pairing-code shaped strings
];

export function redact(input: string): string {
  let out = redactSensitiveText(input).text;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, (_m, g1) => (typeof g1 === "string" ? `${g1}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

export interface LoggerOptions {
  name?: string;
  level?: LogLevel;
  file?: string | null;
  console?: boolean;
}

export class Logger {
  private level: number;
  private file: string | null;
  private useConsole: boolean;
  private name: string;

  constructor(opts: LoggerOptions = {}) {
    this.name = opts.name ?? "c2c";
    this.level = LEVELS[opts.level ?? (process.env.C2C_LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;
    this.useConsole = opts.console ?? false;
    if (opts.file === undefined) {
      const dir = ensureDir(path.join(getStateDir(), "logs"));
      this.file = path.join(dir, `${this.name}.log`);
    } else {
      this.file = opts.file;
    }
  }

  private write(level: LogLevel, msg: string, extra?: unknown): void {
    if (LEVELS[level] < this.level) return;
    const parts = [
      new Date().toISOString(),
      level.toUpperCase().padEnd(5),
      `[${this.name}]`,
      redactAndTruncate(redact(msg), MAX_LOG_FIELD_CHARS).text,
    ];
    if (extra !== undefined) {
      try {
        parts.push(redactAndTruncate(redact(JSON.stringify(extra)), MAX_LOG_FIELD_CHARS).text);
      } catch {
        parts.push("[unserializable]");
      }
    }
    const line = parts.join(" ") + "\n";
    if (this.file) {
      try {
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        const fd = fs.openSync(
          this.file,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow,
          0o600
        );
        try {
          if (fs.fstatSync(fd).size > MAX_LOG_BYTES) {
            fs.ftruncateSync(fd, 0);
            fs.writeSync(fd, `${new Date().toISOString()} WARN  [${this.name}] log rotated locally\n`);
          }
          fs.writeSync(fd, line);
          try {
            fs.fchmodSync(fd, 0o600);
          } catch {
            // Filesystems without POSIX permissions are handled by their host ACLs.
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // logging must never crash the bridge
      }
    }
    if (this.useConsole) process.stderr.write(line);
  }

  debug(msg: string, extra?: unknown): void {
    this.write("debug", msg, extra);
  }
  info(msg: string, extra?: unknown): void {
    this.write("info", msg, extra);
  }
  warn(msg: string, extra?: unknown): void {
    this.write("warn", msg, extra);
  }
  error(msg: string, extra?: unknown): void {
    this.write("error", msg, extra);
  }
}

export const nullLogger = new Logger({ file: null, console: false, level: "error" });
