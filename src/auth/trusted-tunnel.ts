import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getStateDir, writeSecureText } from "../config/paths.js";
import { safeEqual } from "./store.js";

export const TRUSTED_TUNNEL_HEADER = "X-C2C-Tunnel-Token";
const TOKEN_RE = /^c2c_tunnel_[A-Za-z0-9_-]{40,64}$/;

export function trustedTunnelTokenFile(workspaceId: string): string {
  if (!/^[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Invalid workspace id for tunnel token.");
  return path.join(getStateDir(), "tunnel-auth", `${workspaceId}.token`);
}

function readToken(file: string): string {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 256) {
    throw new Error("Trusted tunnel token file is invalid.");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Trusted tunnel token file must be owner-readable only (0600).");
  }
  const token = fs.readFileSync(file, "utf8").trim();
  if (!TOKEN_RE.test(token)) throw new Error("Trusted tunnel token file has an invalid value.");
  return token;
}

export function ensureTrustedTunnelToken(workspaceId: string): { file: string; created: boolean } {
  const file = trustedTunnelTokenFile(workspaceId);
  if (fs.existsSync(file)) {
    readToken(file);
    return { file, created: false };
  }
  const token = `c2c_tunnel_${randomBytes(32).toString("base64url")}`;
  writeSecureText(file, token + "\n");
  readToken(file);
  return { file, created: true };
}

export function verifyTrustedTunnelToken(file: string, presented: string): boolean {
  if (!presented || presented.length > 128) return false;
  try {
    return safeEqual(readToken(file), presented);
  } catch {
    return false;
  }
}

export function hasValidTrustedTunnelToken(workspaceId: string): boolean {
  try {
    readToken(trustedTunnelTokenFile(workspaceId));
    return true;
  } catch {
    return false;
  }
}

export function removeTrustedTunnelToken(workspaceId: string): boolean {
  const file = trustedTunnelTokenFile(workspaceId);
  try {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
