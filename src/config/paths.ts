import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override.trim());
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "codex-with-chatgpt");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Filesystems without POSIX permissions are handled by their host ACLs.
  }
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/** Write a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  writeSecureText(file, JSON.stringify(data, null, 2));
}

export function writeSecureText(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // rename already consumed it or cleanup is best effort
    }
  }
}

export function readJsonIfExists<T>(file: string, maxBytes = 2 * 1024 * 1024): T | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Per-install secret used to make workspace identifiers non-reversible. */
export function getWorkspaceIdentityKey(): Buffer {
  const file = path.join(ensureDir(getStateDir()), "workspace-identity.key");
  if (!fs.existsSync(file)) {
    const generated = randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(file, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128) {
    throw new Error("Workspace identity key must be a small regular file.");
  }
  const encoded = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(encoded)) {
    throw new Error("Workspace identity key is invalid; refusing to derive workspace identifiers.");
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Filesystems without POSIX permissions are handled by their host ACLs.
  }
  return Buffer.from(encoded, "hex");
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
