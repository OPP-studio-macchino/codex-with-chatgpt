import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseQuickTunnelUrl } from "../src/tunnel/cloudflared.js";
import { findBinary } from "../src/tunnel/detect.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe("https://random-words-here-1234.trycloudflare.com");
  });

  it("ignores unrelated lines", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
  });

  it("does not match non-trycloudflare hosts", () => {
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("does not discover executables through an untrusted PATH entry", () => {
    const dir = makeTmpDir("tunnel-untrusted-path");
    const name = "c2c-untrusted-cloudflared-fixture";
    const binary = write(dir, name, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(binary, 0o700);
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(findBinary(name)).toBeNull();
    } finally {
      process.env.PATH = previous;
      cleanup(dir);
    }
  });
});
