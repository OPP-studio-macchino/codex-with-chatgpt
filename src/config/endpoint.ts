import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";

export const DEFAULT_CONNECTOR_NAME = "Codex with ChatGPT";

export interface LastEndpoint {
  workspaceId: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  savedAt: string;
}

export function endpointFile(workspaceId: string): string {
  if (!/^[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Invalid workspace id for endpoint state.");
  return path.join(getStateDir(), "endpoints", `${workspaceId}.json`);
}

export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  const raw = readJsonIfExists<unknown>(endpointFile(workspaceId));
  return sanitizeLastEndpoint(raw, workspaceId);
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved = sanitizeLastEndpoint({ ...endpoint, savedAt: new Date().toISOString() }, endpoint.workspaceId);
  if (!saved) throw new Error("Invalid endpoint state.");
  writeSecureJson(endpointFile(saved.workspaceId), saved);
  return saved;
}

function sanitizeStoredConnectorName(value: unknown, workspaceId: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/[^\p{L}\p{N}._\-· ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || `${DEFAULT_CONNECTOR_NAME} · ${workspaceId.slice(0, 6)}`;
}

function sanitizeLastEndpoint(value: unknown, workspaceId: string): LastEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.workspaceId !== workspaceId ||
    !Number.isInteger(raw.port) ||
    (raw.port as number) < 1 ||
    (raw.port as number) > 65_535 ||
    typeof raw.savedAt !== "string" ||
    raw.savedAt.length > 64 ||
    !Number.isFinite(Date.parse(raw.savedAt))
  ) {
    return null;
  }
  let publicUrl: string | null = null;
  let mcpUrl: string | null = null;
  try {
    if (raw.publicUrl !== null) {
      if (typeof raw.publicUrl !== "string") return null;
      const normalized = normalizePublicUrl(raw.publicUrl);
      if (normalized.endsWith("/mcp")) return null;
      publicUrl = normalized;
    }
    if (raw.mcpUrl !== null) {
      if (typeof raw.mcpUrl !== "string") return null;
      const normalized = normalizePublicUrl(raw.mcpUrl);
      if (!normalized.endsWith("/mcp")) return null;
      mcpUrl = normalized;
    }
    if (publicUrl && mcpUrl && new URL(publicUrl).origin !== new URL(mcpUrl).origin) return null;
  } catch {
    return null;
  }
  return {
    workspaceId,
    port: raw.port as number,
    publicUrl,
    mcpUrl,
    connectorName: sanitizeStoredConnectorName(raw.connectorName, workspaceId),
    savedAt: raw.savedAt,
  };
}

export function normalizePublicUrl(url: string): string {
  const parsed = new URL(url.trim());
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (
    url !== url.trim() ||
    url.length > 2048 ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "/mcp" && parsed.pathname !== "/mcp/")
  ) {
    throw new Error("Endpoint must be a credential-free HTTPS origin or /mcp URL.");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return null;
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  try {
    const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
    return `${base}/mcp`;
  } catch {
    return null;
  }
}

/** What the Skill should do to THIS workspace's ChatGPT connector. */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  try {
    return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
  } catch {
    return "update";
  }
}

export function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

/**
 * Same workspace keeps one connector title forever.
 * A workspace already recorded without a title stays on the original
 * "Codex with ChatGPT" name. A new workspace gets a distinct title.
 */
export function connectorNameFor(opts: {
  workspaceName: string;
  workspaceId: string;
  previousName?: string | null;
  hadEndpointBefore: boolean;
}): string {
  const previousName = sanitizeStoredConnectorName(opts.previousName, opts.workspaceId);
  if (opts.previousName?.trim() && previousName) return previousName;
  if (opts.hadEndpointBefore) return DEFAULT_CONNECTOR_NAME;
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.workspaceName, opts.workspaceId)}`;
}

export function reclaimUserMessage(connectorName: string): string {
  return `「${connectorName}」の以前の接続先は利用できません。再公開とChatGPT側の更新には明示的な承認が必要です。`;
}
