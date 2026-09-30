import { describe, expect, it } from "vitest";
import {
  normalizeCodexNetworkHost,
  normalizeCodexNetworkHosts,
} from "../src/codex/network-policy.js";

describe("Codex network host policy", () => {
  it("normalizes exact public DNS hosts and removes duplicates", () => {
    expect(normalizeCodexNetworkHosts([
      "TTC.TAXI-INF.JP",
      "ttc.taxi-inf.jp",
      "example.com",
    ])).toEqual(["ttc.taxi-inf.jp", "example.com"]);
  });

  it.each([
    "*",
    "*.example.com",
    "https://example.com",
    "example.com/path",
    "127.0.0.1",
    "::1",
    "localhost",
    "service.local",
    "singlelabel",
  ])("rejects non-exact or local network target: %s", (value) => {
    expect(() => normalizeCodexNetworkHost(value)).toThrow();
  });

  it("bounds the owner allowlist", () => {
    expect(() => normalizeCodexNetworkHosts(
      Array.from({ length: 17 }, (_, index) => `host-${index}.example.com`)
    )).toThrow(/at most 16/);
  });
});
