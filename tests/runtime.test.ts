import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
} from "../src/bridge/runtime.js";
import { isolateStateDir } from "./helpers.js";

const workspaceId = "0123456789abcdef01234567";

beforeEach(() => {
  isolateStateDir();
});

describe("runtime state validation", () => {
  it("round-trips a bounded owner state record", () => {
    writeRuntimeState({
      service: "c2c-bridge",
      version: "0.3.0-next.12",
      workspaceId,
      workspaceRoot: "/private/example/workspace",
      pid: 1234,
      port: 48765,
      adminToken: "c2c_admin_" + "a".repeat(32),
      publicUrl: null,
      trustedTunnelAuth: true,
      startedAt: new Date().toISOString(),
    });
    expect(readRuntimeState(workspaceId)?.port).toBe(48765);
  });

  it("rejects malformed local-port and admin-token values loaded from disk", () => {
    fs.writeFileSync(
      runtimeFile(workspaceId),
      JSON.stringify({
        service: "c2c-bridge",
        version: "0.3.0-next.12",
        workspaceId,
        workspaceRoot: "/private/example/workspace",
        pid: 1234,
        port: "80/admin/shutdown",
        adminToken: "not-a-token",
        publicUrl: null,
        startedAt: new Date().toISOString(),
      })
    );
    expect(readRuntimeState(workspaceId)).toBeNull();
  });

  it("rejects credentialed public URLs in persisted runtime state", () => {
    fs.writeFileSync(
      runtimeFile(workspaceId),
      JSON.stringify({
        service: "c2c-bridge",
        version: "0.3.0-next.12",
        workspaceId,
        workspaceRoot: "/private/example/workspace",
        pid: 1234,
        port: 48765,
        adminToken: "c2c_admin_" + "a".repeat(32),
        publicUrl: "https://user:secret@example.com",
        startedAt: new Date().toISOString(),
      })
    );
    expect(readRuntimeState(workspaceId)).toBeNull();
  });
});
