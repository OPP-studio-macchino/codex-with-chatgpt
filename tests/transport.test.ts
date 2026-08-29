import { describe, expect, it } from "vitest";
import {
  activeTransport,
  assertTransportCompatible,
  normalizeExternalBaseUrl,
  selectedTransport,
  type ActiveTransportState,
  type TransportMode,
} from "../src/config/transport.js";

const states: Record<TransportMode, ActiveTransportState> = {
  local: {
    publicUrl: null,
    tunnel: { running: false, url: null },
    trustedTunnelAuth: false,
  },
  "openai-secure-tunnel": {
    publicUrl: null,
    tunnel: { running: false, url: null },
    trustedTunnelAuth: true,
  },
  "cloudflare-quick-tunnel": {
    publicUrl: "https://random.trycloudflare.com",
    tunnel: { running: true, url: "https://random.trycloudflare.com" },
    trustedTunnelAuth: false,
  },
  "external-https": {
    publicUrl: "https://mcp.example.com",
    tunnel: { running: false, url: null },
    trustedTunnelAuth: false,
  },
};

describe("transport consent boundary", () => {
  it("requires mutually exclusive transport selection", () => {
    expect(() =>
      selectedTransport({
        cloudflareQuickTunnel: true,
        openaiSecureTunnel: true,
      })
    ).toThrow(/one remote transport/);
  });

  it("accepts only a credential-free HTTPS origin for managed transport", () => {
    expect(normalizeExternalBaseUrl("https://mcp.example.com")).toBe("https://mcp.example.com");
    for (const value of [
      "http://mcp.example.com",
      "https://user:secret@mcp.example.com",
      "https://mcp.example.com/path",
      "https://mcp.example.com?token=secret",
      " https://mcp.example.com",
    ]) {
      expect(() => normalizeExternalBaseUrl(value)).toThrow(/HTTPS origin/);
    }
  });

  it("classifies every active mode", () => {
    for (const [mode, state] of Object.entries(states)) {
      expect(activeTransport(state)).toBe(mode);
    }
  });

  it("never lets local-only reuse inherit a remote mode", () => {
    for (const mode of ["openai-secure-tunnel", "cloudflare-quick-tunnel", "external-https"] as const) {
      expect(() => assertTransportCompatible(states[mode], "local")).toThrow(/stop it explicitly/);
    }
  });

  it("allows only same-mode reuse plus an explicit local-to-Quick-Tunnel upgrade", () => {
    for (const mode of Object.keys(states) as TransportMode[]) {
      expect(() => assertTransportCompatible(states[mode], mode)).not.toThrow();
    }
    expect(() => assertTransportCompatible(states.local, "cloudflare-quick-tunnel")).not.toThrow();
    expect(() => assertTransportCompatible(states["external-https"], "cloudflare-quick-tunnel")).toThrow();
    expect(() => assertTransportCompatible(states["cloudflare-quick-tunnel"], "external-https")).toThrow();
  });

  it("fails closed on inconsistent daemon state", () => {
    expect(() =>
      activeTransport({
        publicUrl: "https://mcp.example.com",
        tunnel: { running: false, url: null },
        trustedTunnelAuth: true,
      })
    ).toThrow(/inconsistent/);
  });
});
