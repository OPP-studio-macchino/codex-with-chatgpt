export type TransportMode =
  | "local"
  | "openai-secure-tunnel"
  | "cloudflare-quick-tunnel"
  | "external-https";

export interface TransportSelection {
  cloudflareQuickTunnel: boolean;
  externalBaseUrl?: string;
  openaiSecureTunnel: boolean;
}

export interface ActiveTransportState {
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null };
  trustedTunnelAuth: boolean;
}

export function normalizeExternalBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("External base URL must be a valid HTTPS origin.");
  }
  if (
    value !== value.trim() ||
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("External base URL must be a credential-free HTTPS origin without a path or query.");
  }
  return url.origin;
}

export function selectedTransport(opts: TransportSelection): TransportMode {
  const selected = [opts.cloudflareQuickTunnel, Boolean(opts.externalBaseUrl), opts.openaiSecureTunnel].filter(
    Boolean
  ).length;
  if (selected > 1) throw new Error("Choose exactly one remote transport at a time.");
  if (opts.externalBaseUrl) normalizeExternalBaseUrl(opts.externalBaseUrl);
  if (opts.openaiSecureTunnel) return "openai-secure-tunnel";
  if (opts.cloudflareQuickTunnel) return "cloudflare-quick-tunnel";
  if (opts.externalBaseUrl) return "external-https";
  return "local";
}

export function activeTransport(info: ActiveTransportState): TransportMode {
  if (info.trustedTunnelAuth) {
    if (info.publicUrl || info.tunnel.running || info.tunnel.url) {
      throw new Error("Bridge reports inconsistent remote transport state; stop it before reconnecting.");
    }
    return "openai-secure-tunnel";
  }
  if (info.tunnel.running) {
    if (!info.tunnel.url || info.publicUrl !== info.tunnel.url) {
      throw new Error("Bridge reports inconsistent Cloudflare tunnel state; stop it before reconnecting.");
    }
    return "cloudflare-quick-tunnel";
  }
  if (info.publicUrl) return "external-https";
  return "local";
}

/**
 * A local daemon may be upgraded to Quick Tunnel because that action is
 * explicit and the daemon owns that provider. Every other mode change needs a
 * stop/restart so local-only invocations never inherit remote exposure.
 */
export function assertTransportCompatible(info: ActiveTransportState, requested: TransportMode): void {
  const active = activeTransport(info);
  if (active === requested) return;
  if (active === "local" && requested === "cloudflare-quick-tunnel") return;
  throw new Error(
    `Bridge is already using ${active}; stop it explicitly before changing to ${requested}.`
  );
}
