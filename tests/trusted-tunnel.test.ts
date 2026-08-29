import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  ensureTrustedTunnelToken,
  hasValidTrustedTunnelToken,
  removeTrustedTunnelToken,
  trustedTunnelTokenFile,
  verifyTrustedTunnelToken,
} from "../src/auth/trusted-tunnel.js";
import { isolateStateDir } from "./helpers.js";

const WORKSPACE_ID = "0123456789abcdef01234567";

beforeEach(() => {
  isolateStateDir();
});

describe("trusted tunnel token storage", () => {
  it("creates one stable owner-only token outside the workspace", () => {
    const first = ensureTrustedTunnelToken(WORKSPACE_ID);
    const token = fs.readFileSync(first.file, "utf8").trim();
    const second = ensureTrustedTunnelToken(WORKSPACE_ID);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.file).toBe(first.file);
    expect(fs.readFileSync(second.file, "utf8").trim()).toBe(token);
    expect(token).toMatch(/^c2c_tunnel_[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") expect(fs.statSync(first.file).mode & 0o077).toBe(0);
    expect(verifyTrustedTunnelToken(first.file, token)).toBe(true);
    expect(verifyTrustedTunnelToken(first.file, "wrong")).toBe(false);
    expect(hasValidTrustedTunnelToken(WORKSPACE_ID)).toBe(true);
  });

  it("revokes by deleting only the per-workspace credential", () => {
    const { file } = ensureTrustedTunnelToken(WORKSPACE_ID);
    expect(removeTrustedTunnelToken(WORKSPACE_ID)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(removeTrustedTunnelToken(WORKSPACE_ID)).toBe(false);
  });

  it("rejects malformed workspace identifiers", () => {
    expect(() => trustedTunnelTokenFile("../../escape")).toThrow(/Invalid workspace id/);
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked credential file", () => {
    const { file } = ensureTrustedTunnelToken(WORKSPACE_ID);
    fs.rmSync(file);
    fs.symlinkSync("/dev/null", file);

    expect(hasValidTrustedTunnelToken(WORKSPACE_ID)).toBe(false);
    expect(() => ensureTrustedTunnelToken(WORKSPACE_ID)).toThrow(/invalid/i);
  });
});
