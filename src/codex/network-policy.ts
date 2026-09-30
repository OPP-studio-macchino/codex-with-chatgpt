import net from "node:net";

const MAX_CODEX_NETWORK_HOSTS = 16;
const HOST_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

export function normalizeCodexNetworkHost(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 253) {
    throw new Error("Codex network host must be a 1-253 character hostname.");
  }
  const host = value.toLowerCase();
  if (
    host.includes("://") ||
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#") ||
    host.includes("@") ||
    host.includes(":") ||
    net.isIP(host) !== 0 ||
    host === "localhost" ||
    host.endsWith(".local")
  ) {
    throw new Error("Codex network host must be an exact public DNS hostname without scheme, port, path, wildcard, or IP literal.");
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) {
    throw new Error("Codex network host must be an exact public DNS hostname.");
  }
  return host;
}

export function normalizeCodexNetworkHosts(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CODEX_NETWORK_HOSTS) {
    throw new Error(`codexNetworkHosts must be an array with at most ${MAX_CODEX_NETWORK_HOSTS} entries.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const host = normalizeCodexNetworkHost(entry);
    if (!seen.has(host)) {
      seen.add(host);
      result.push(host);
    }
  }
  return result;
}
