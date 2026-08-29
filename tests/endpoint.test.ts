import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  connectorAction,
  connectorNameFor,
  DEFAULT_CONNECTOR_NAME,
  mcpUrlFromPublic,
  normalizePublicUrl,
  endpointFile,
  readLastEndpoint,
  writeLastEndpoint,
} from "../src/config/endpoint.js";
import { isolateStateDir } from "./helpers.js";

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", "https://a.trycloudflare.com/mcp/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp", "https://new.trycloudflare.com/mcp")).toBe("update");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", null)).toBe("none");
  });
});

describe("connectorNameFor", () => {
  it("keeps a stored name for the same workspace", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        previousName: "Codex with ChatGPT",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("keeps the legacy title when this workspace was used before the name field existed", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("gives a new workspace its own connector title", () => {
    expect(
      connectorNameFor({
        workspaceName: "Landing",
        workspaceId: "def456def456",
        hadEndpointBefore: false,
      })
    ).toBe("Codex with ChatGPT · Landing");
  });
});

describe("mcpUrlFromPublic", () => {
  it("appends /mcp and folds case/slash variants", () => {
    expect(mcpUrlFromPublic("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com/mcp");
    expect(mcpUrlFromPublic("https://a.trycloudflare.com/mcp")).toBe("https://a.trycloudflare.com/mcp");
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
  });

  it("rejects insecure, credentialed, and ambiguous endpoint URLs", () => {
    for (const candidate of [
      "http://public.example.com",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com/?token=secret",
      "https://example.com/#fragment",
    ]) {
      expect(mcpUrlFromPublic(candidate)).toBeNull();
    }
    expect(mcpUrlFromPublic("http://127.0.0.1:48765")).toBe("http://127.0.0.1:48765/mcp");
  });
});

describe("persisted endpoint validation", () => {
  const workspaceId = "0123456789abcdef01234567";

  it("round-trips a validated endpoint", () => {
    isolateStateDir();
    writeLastEndpoint({
      workspaceId,
      port: 48765,
      publicUrl: "https://mcp.example.com",
      mcpUrl: "https://mcp.example.com/mcp",
      connectorName: "Codex with ChatGPT · Demo",
    });
    expect(readLastEndpoint(workspaceId)?.mcpUrl).toBe("https://mcp.example.com/mcp");
  });

  it("rejects credentialed or cross-origin state loaded from disk", () => {
    const state = isolateStateDir();
    const file = endpointFile(workspaceId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        workspaceId,
        port: 48765,
        publicUrl: "https://mcp.example.com",
        mcpUrl: "https://user:secret@attacker.example/mcp",
        savedAt: new Date().toISOString(),
      })
    );
    expect(state).toBeTruthy();
    expect(readLastEndpoint(workspaceId)).toBeNull();
  });

  it("sanitizes stored connector labels before displaying them", () => {
    isolateStateDir();
    writeLastEndpoint({
      workspaceId,
      port: 48765,
      publicUrl: "https://mcp.example.com",
      mcpUrl: "https://mcp.example.com/mcp",
      connectorName: "Trusted\u202e\nConnector",
    });
    expect(readLastEndpoint(workspaceId)?.connectorName).toBe("Trusted Connector");
  });
});
