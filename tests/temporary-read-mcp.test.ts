import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { TemporaryReadCoordinator } from "../src/desktop/temporary-read.js";
import { createMcpServer, type McpContext } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceProfiles } from "../src/workspace/profiles.js";
import { cleanup as removeTmp, makeTmpDir, write } from "./helpers.js";
import { nullLogger } from "../src/logger/index.js";
import { DesktopAgentError, type DesktopAgentRequest, type TrustedReadContext } from "../src/desktop/client.js";
import { StreamingSecretRedactor } from "../src/security/redaction.js";
import { OWNER_DIALOG_HELPER_TIMEOUT_MS, OWNER_DIALOG_REQUEST_TIMEOUT_MS } from "../src/security/owner-dialog-timeouts.js";

const auth: AuthInfo = { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["desktop.read"] };
const workspace = new Workspace(process.cwd());
const ready = { ready: true, mode: "exact-file", ttlSeconds: 120 };
const gid = "a".repeat(32);
const approved = () => ({ approved: true, grantCreated: true, grantId: gid, expiresAt: new Date(Date.now() + 120_000).toISOString(), mode: "exact-file" });
const deferred = () => { let resolve!: (v: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });

function fixture(handler?: (r: DesktopAgentRequest) => unknown) {
  const call = vi.fn(async (r: DesktopAgentRequest, _context?: TrustedReadContext) => {
    if (handler) { const value = handler(r); if (value !== undefined) return value; }
    if (r.op === "temporaryReadStatus") return ready;
    if (r.op === "temporaryReadRequest") return approved();
    if (r.op === "temporaryRead") return { grantId: gid, content: "hello", sizeBytes: 5, truncated: false };
    return { grantId: gid, revoked: true };
  });
  const agent = { call };
  const coordinator = new TemporaryReadCoordinator(agent);
  cleanup.push(() => coordinator.close());
  return { call, agent, coordinator };
}
async function connect(f: ReturnType<typeof fixture>, identity: AuthInfo | null = auth, overrides: Partial<McpContext> = {}) {
  const resolver = vi.fn((id?: string) => { if (id !== workspace.id) throw new Error("private/path"); return { workspace, codexNetworkHosts: [] }; });
  const server = createMcpServer({ workspace, resolveWorkspace: resolver, desktopAgent: f.agent, temporaryReads: f.coordinator, logger: nullLogger, ...overrides });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const send = ct.send.bind(ct);
  ct.send = (message, options) => send(message, { ...options, authInfo: identity ?? undefined });
  const client = new Client({ name: "temporary-test", version: "1" });
  await server.connect(st); await client.connect(ct);
  const close = async () => { await client.close(); await server.close(); };
  cleanup.push(close);
  return { close, resolver, listTools: () => client.listTools(), tool: async (action: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: action === "read" ? "desktop_temporary_read" : `desktop_temporary_read_${action}`, arguments: { workspace_id: workspace.id, ...args } });
    const text = (result.content as { text: string }[])[0].text;
    return { error: result.isError, data: text.startsWith("{") ? JSON.parse(text) : { validationError: text } };
  } };
}
const key = `${workspace.id}:${workspace.root}`;

describe("temporary exact-file MCP", () => {
  it("does not adopt a grant when approval validation crosses the absolute deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const native = deferred();
    const f = fixture(r => r.op === "temporaryReadRequest" ? native.promise : undefined);
    const id = f.coordinator.start(key, "/file").request_id; await flush();
    expect((await f.coordinator.status(key, id)).state).toBe("pending");
    const raw = approved();
    const expiresAt = raw.expiresAt;
    const crossDeadline = vi.fn(() => {
      // Accessed by approval.safeParse, after the post-await liveness check.
      vi.setSystemTime(startedAt + OWNER_DIALOG_REQUEST_TIMEOUT_MS);
      return expiresAt;
    });
    Object.defineProperty(raw, "expiresAt", { enumerable: true, get: crossDeadline });
    native.resolve(raw); await flush();
    expect(crossDeadline).toHaveBeenCalled();
    expect(await f.coordinator.status(key, id)).toMatchObject({ state: "expired", reason: "TEMPORARY_READ_TIMEOUT" });
    const context = f.call.mock.calls.find(([request]) => request.op === "temporaryReadRequest")![1];
    expect(f.call.mock.calls.filter(([request]) => request.op === "temporaryReadRevoke")).toEqual([[{ op: "temporaryReadRevoke", grantId: gid }, context]]);
    await expect(f.coordinator.read(key, id)).rejects.toThrow("NOT_APPROVED");
    expect(f.call.mock.calls.some(([request]) => request.op === "temporaryRead")).toBe(false);
  });
  it("returns no MCP content when synchronous redaction crosses grant expiry", async () => {
    vi.useFakeTimers();
    const f = fixture(); const c = await connect(f);
    const id = (await c.tool("start", { path: "/file" })).data.request_id; await flush();
    const status = await c.tool("status", { request_id: id });
    const expires = Date.parse(status.data.expires_at);
    const redactLine = StreamingSecretRedactor.prototype.redactLine;
    const crossing = vi.spyOn(StreamingSecretRedactor.prototype, "redactLine").mockImplementation(function (this: StreamingSecretRedactor, line) {
      const result = redactLine.call(this, line);
      vi.setSystemTime(expires);
      return result;
    });
    try {
      const result = await c.tool("read", { request_id: id });
      expect(crossing).toHaveBeenCalled();
      expect(result).toEqual({ error: true, data: { error: "TEMPORARY_READ_NOT_APPROVED" } });
      expect(JSON.stringify(result)).not.toContain("hello");
      expect((await c.tool("status", { request_id: id })).data.state).toBe("expired");
    } finally { crossing.mockRestore(); }
  });
  it("advertises action-specific semantics and rejects override fields before forwarding", async () => {
    const f = fixture(); const c = await connect(f);
    const listed = (await c.listTools()).tools.filter(tool => tool.name.startsWith("desktop_temporary_read"));
    expect(listed).toHaveLength(4);
    expect(new Set(listed.map(tool => tool.description)).size).toBe(4);
    for (const action of ["start", "status", "read", "revoke"]) {
      const name = action === "read" ? "desktop_temporary_read" : `desktop_temporary_read_${action}`;
      expect(listed.find(tool => tool.name === name)?.annotations).toEqual({ readOnlyHint: action === "read" || action === "status", destructiveHint: action === "revoke", idempotentHint: action !== "start", openWorldHint: false });
      const base = action === "start" ? { path: "/file" } : { request_id: gid };
      for (const override of [{ scope: "caller" }, { approved: true }, { ttl: 999 }, { permission: "read" }, { grantId: gid }, ...(action === "start" ? [{ absolutePath: "/other" }] : [{ path: "/other" }])]) {
        expect((await c.tool(action, { ...base, ...override })).error).toBe(true);
      }
    }
    expect(f.call).not.toHaveBeenCalled();
  });
  it("accepts a 2.5s readiness probe without reducing the native 45-minute approval budget", async () => {
    vi.useFakeTimers();
    const probe = deferred(); const f = fixture(r => r.op === "temporaryReadStatus" ? probe.promise : undefined);
    const id = f.coordinator.start(key, "/file").request_id;
    await vi.advanceTimersByTimeAsync(2_500); probe.resolve(ready); await flush();
    expect((await f.coordinator.status(key, id)).state).toBe("approved");
    const request = f.call.mock.calls.find(([r]) => r.op === "temporaryReadRequest")![0];
    expect(Date.parse(request.requestDeadlineAt as string) - Date.now()).toBe(OWNER_DIALOG_HELPER_TIMEOUT_MS);
  });
  it("accepts redaction expansion, hides open private keys and bounds final output without hiding filenames", async () => {
    for (const sample of [
      { content: "[REDACTED]", sizeBytes: 3, truncated: false },
      { content: "error.ts task-42.json\n-----BEGIN PRIVATE KEY-----\nTOP_SECRET_BODY\nMORE_SECRET", sizeBytes: 500, truncated: true },
      { content: "error.ts task-42.json\n-----BEGIN PRIVATE KEY-----\n" + "x\n".repeat(30_000), sizeBytes: 100_000, truncated: false },
      { content: "界".repeat(65_536), sizeBytes: 2 * 1024 * 1024, truncated: false },
    ]) {
      const f = fixture(r => r.op === "temporaryRead" ? { grantId: gid, ...sample } : undefined);
      const id = f.coordinator.start(key, "/file").request_id; await flush();
      const result = await f.coordinator.read(key, id);
      expect(result.sizeBytes).toBe(sample.sizeBytes);
      expect(result.content).not.toContain("TOP_SECRET_BODY"); expect(result.content).not.toContain("MORE_SECRET");
      expect(result.content.length).toBeLessThanOrEqual(65_536); expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(65_536);
      if (sample.content.startsWith("error.ts")) expect(result.content).toContain("error.ts task-42.json");
      if (sample.content.length > 60_000 || sample.truncated) expect(result.truncated).toBe(true);
      if (sample.sizeBytes === 3) { expect(result.content).toBe("[REDACTED]"); expect(result.truncated).toBe(false); }
    }
  });
  it("releases timed-out approval and revokes a late old grant without releasing a new prompt", async () => {
    vi.useFakeTimers(); const old = deferred(); const fresh = deferred(); let prompts = 0;
    const f = fixture(r => r.op === "temporaryReadRequest" ? (++prompts === 1 ? old.promise : fresh.promise) : undefined);
    const oldId = f.coordinator.start(key, "/old").request_id; await flush();
    const oldContext = f.call.mock.calls.find(([r]) => r.op === "temporaryReadRequest")![1];
    await vi.advanceTimersByTimeAsync(OWNER_DIALOG_REQUEST_TIMEOUT_MS + 1);
    expect(await f.coordinator.status(key, oldId)).toMatchObject({ state: "expired", reason: "TEMPORARY_READ_TIMEOUT" });
    const newId = f.coordinator.start(key, "/new").request_id; await flush();
    old.resolve(approved()); await flush();
    expect(f.call.mock.calls.filter(([r]) => r.op === "temporaryReadRevoke")).toEqual([[{ op: "temporaryReadRevoke", grantId: gid }, oldContext]]);
    expect((await f.coordinator.status(key, newId)).state).toBe("pending");
    expect(() => f.coordinator.start(key, "/third")).toThrow("BUSY");
    await expect(f.coordinator.read(key, oldId)).rejects.toThrow("NOT_APPROVED");
    await expect(f.coordinator.read(key, newId)).rejects.toThrow("NOT_APPROVED");
    fresh.resolve({ ...approved(), grantId: "b".repeat(32) }); await flush();
    expect((await f.coordinator.status(key, newId)).state).toBe("approved");
  });
  it("admin cancellation invalidates old shared-MCP jobs and reads but permits fresh explicit approval; shutdown is permanent", async () => {
    const old = deferred(); const fresh = deferred(); const reading = deferred(); let prompts = 0;
    const f = fixture(r => r.op === "temporaryReadRequest" ? (++prompts === 1 ? approved() : prompts === 2 ? old.promise : fresh.promise) : r.op === "temporaryRead" ? reading.promise : undefined);
    const a = await connect(f); const b = await connect(f);
    const approvedId = (await a.tool("start", { path: "/approved" })).data.request_id; await flush();
    const pendingRead = a.tool("read", { request_id: approvedId }); await flush();
    const oldId = (await b.tool("start", { path: "/old" })).data.request_id; await flush();
    f.coordinator.cancelAll();
    const newId = (await b.tool("start", { path: "/fresh" })).data.request_id; await flush();
    expect((await b.tool("status", { request_id: newId })).data.state).toBe("pending");
    old.resolve({ ...approved(), grantId: "b".repeat(32) }); reading.resolve({ grantId: gid, content: "secret", sizeBytes: 6, truncated: false }); await flush();
    expect((await pendingRead).error).toBe(true);
    expect((await a.tool("read", { request_id: oldId })).error).toBe(true);
    expect((await b.tool("start", { path: "/extra" })).data.error).toBe("TEMPORARY_READ_BUSY");
    expect(f.call.mock.calls.some(([r]) => r.op === "temporaryReadRevoke" && r.grantId === "b".repeat(32))).toBe(true);
    fresh.resolve({ ...approved(), grantId: "c".repeat(32) }); await flush();
    expect((await b.tool("status", { request_id: newId })).data.state).toBe("approved");
    f.coordinator.close();
    expect((await b.tool("start", { path: "/later" })).data.error).toBe("TEMPORARY_READ_CLOSED");
    expect((await b.tool("read", { request_id: newId })).error).toBe(true);
  });
  it.each([
    ["APPROVAL_TIMEOUT", "TEMPORARY_READ_APPROVAL_TIMEOUT"],
    ["DESKTOP_AGENT_TIMEOUT", "TEMPORARY_READ_TIMEOUT"],
    ["SYNTHETIC_UNKNOWN_BACKEND_CODE", "TEMPORARY_READ_FAILED"],
  ])("safely reports request failure %s and releases the prompt slot", async (code, reason) => {
    const sensitive = "/synthetic/private/file token=synthetic-secret-token backend stack";
    const fresh = deferred();
    let requests = 0;
    const f = fixture(r => {
      if (r.op === "temporaryReadRequest") {
        if (++requests === 1) throw new DesktopAgentError(code, sensitive);
        return fresh.promise;
      }
    });
    const c = await connect(f);
    const started = await c.tool("start", { path: "/synthetic/private/file" });
    const id = started.data.request_id; await flush();
    const status = await c.tool("status", { request_id: id });
    expect(status).toEqual({ error: false, data: { request_id: id, state: "failed", reason } });
    const read = await c.tool("read", { request_id: id });
    expect(read).toEqual({ error: true, data: { error: "TEMPORARY_READ_NOT_APPROVED" } });
    expect(requests).toBe(1);
    expect(f.call.mock.calls.some(([r]) => r.op === "temporaryRead")).toBe(false);
    const next = await c.tool("start", { path: "/synthetic/fresh" }); await flush();
    expect(next.data).toEqual({ request_id: expect.any(String), state: "pending" });
    expect(next.data.request_id).not.toBe(id);
    expect(requests).toBe(2);
    const nextStatus = await c.tool("status", { request_id: next.data.request_id });
    expect(nextStatus.data.state).toBe("pending");
    const serialized = JSON.stringify([started, status, read, next, nextStatus]);
    for (const secret of [sensitive, "/synthetic/", "synthetic-secret-token", "backend stack", "SYNTHETIC_UNKNOWN_BACKEND_CODE", gid, auth.token]) {
      expect(serialized).not.toContain(secret);
    }
    for (const [, context] of f.call.mock.calls) expect(serialized).not.toContain(context!.scope);
    fresh.resolve({ approved: false, grantCreated: false }); await flush();
  });
  it("returns actionable allowlisted job reasons without backend messages, paths or scope", async () => {
    for (const [failure, reason] of [
      [new DesktopAgentError("DESKTOP_AGENT_UNAVAILABLE", "/private/secret stack"), "TEMPORARY_READ_UNAVAILABLE"],
      [new DesktopAgentError("DESKTOP_AGENT_TIMEOUT", "/private/secret stack"), "TEMPORARY_READ_TIMEOUT"],
      [new DesktopAgentError("DESKTOP_AGENT_PROTOCOL", "/private/secret stack"), "TEMPORARY_READ_INVALID_RESPONSE"],
      [new DesktopAgentError("/private/secret", "/private/secret stack"), "TEMPORARY_READ_FAILED"],
    ] as const) {
      const f = fixture(() => { throw failure; }); const c = await connect(f);
      const id = (await c.tool("start", { path: "/file" })).data.request_id; await flush();
      const result = await c.tool("status", { request_id: id });
      expect(result.data).toEqual({ request_id: id, state: "failed", reason });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });
  it("uses the existing resolver without mutating the selected profile or acquiring Codex", async () => {
    const root = makeTmpDir("temporary-profiles");
    const previous = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = path.join(root, "state");
    cleanup.push(() => { if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous; removeTmp(root); });
    write(root, "alpha/file", "a"); write(root, "beta/file", "b");
    const alpha = new Workspace(path.join(root, "alpha"));
    const file = write(root, "profiles.json", JSON.stringify({ version: 1, defaultProfileId: "alpha", profiles: [{ id: "alpha", path: alpha.root }, { id: "beta", path: path.join(root, "beta") }] }));
    fs.chmodSync(file, 0o600);
    const profiles = WorkspaceProfiles.load(alpha, file)!;
    profiles.select("beta");
    const selected = profiles.current().workspace.id;
    const getCodex = vi.fn(() => { throw new Error("must not acquire Codex"); });
    const f = fixture();
    const c = await connect(f, auth, { workspace: alpha, workspaceProfiles: profiles, resolveWorkspace: undefined, getCodex });
    const id = (await c.tool("start", { workspace_id: alpha.id, path: "/file" })).data.request_id; await flush();
    expect((await c.tool("read", { workspace_id: selected, request_id: id })).error).toBe(true);
    expect((await c.tool("read", { workspace_id: alpha.id, request_id: id })).error).toBe(false);
    expect(profiles.current().workspace.id).toBe(selected);
    expect(getCodex).not.toHaveBeenCalled();
  });
  it.each([null, { ...auth, token: "oauth" }, { ...auth, clientId: "client" }, { ...auth, scopes: [] }])("requires real exact auth for every operation: %j", async identity => {
    const f = fixture(); const target = await connect(f, identity);
    for (const action of ["start", "status", "read", "revoke"]) {
      const result = await target.tool(action, action === "start" ? { path: "/private/file" } : { request_id: gid });
      expect(result).toEqual({ error: true, data: { error: "TRUSTED_DESKTOP_READ_REQUIRED" } });
    }
    expect(f.call).not.toHaveBeenCalled();
  });
  it("shares jobs across fresh servers, never changes selection, returns redacted exact reads repeatedly", async () => {
    const native = deferred(); const f = fixture(r => r.op === "temporaryReadRequest" ? native.promise : r.op === "temporaryRead" ? { grantId: gid, content: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890", sizeBytes: 54, truncated: false } : undefined);
    const first = await connect(f);
    const started = await first.tool("start", { path: "/private/file" });
    const id = started.data.request_id;
    expect(started.data).toEqual({ request_id: id, state: "pending" });
    expect((await first.tool("read", { request_id: id })).error).toBe(true);
    await first.close();
    const second = await connect(f);
    native.resolve(approved()); await flush();
    expect((await second.tool("status", { request_id: id })).data.state).toBe("approved");
    for (let i = 0; i < 2; i++) {
      const result = await second.tool("read", { request_id: id });
      expect(result.error).toBe(false); expect(result.data.content).toContain("REDACTED");
      expect(JSON.stringify(result)).not.toContain(gid);
    }
    expect(first.resolver).toHaveBeenCalledWith(workspace.id);
    expect((await second.tool("status", { workspace_id: "b".repeat(24), request_id: id })).error).toBe(true);
    expect((await second.tool("read", { request_id: "b".repeat(32) })).error).toBe(true);
    const nativeCall = f.call.mock.calls.find(([r]) => r.op === "temporaryReadRequest")!;
    expect(nativeCall[0]).toMatchObject({ absolutePath: "/private/file" });
    expect(Date.parse(nativeCall[0].requestDeadlineAt as string) - Date.now()).toBeGreaterThan(30_000);
    expect(nativeCall[1]).toMatchObject({ authority: "c2c-owner:desktop.read" });
    expect(nativeCall[1]!.scope).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(started)).not.toContain(nativeCall[1]!.scope);
    expect(f.call.mock.calls.filter(([r]) => r.op === "temporaryRead").every(([r]) => r.grantId === gid && !r.path)).toBe(true);
  });
  it("checks readiness without UI and rejects helper mismatch and malformed responses", async () => {
    for (const output of [{ ...ready, mode: "directory" }, { ...ready, ttlSeconds: 999 }, null]) {
      const f = fixture(r => r.op === "temporaryReadStatus" ? output : undefined);
      const c = await connect(f); expect((await c.tool("status")).error).toBe(true);
      expect(f.call.mock.calls.every(([r]) => r.op === "temporaryReadStatus")).toBe(true);
    }
    for (const output of [{ approved: true }, { ...approved(), extra: "private/path" }, { ...approved(), expiresAt: "2099-01-01T00:00:00.000Z" }]) {
      const f = fixture(r => r.op === "temporaryReadRequest" ? output : undefined);
      const id = f.coordinator.start(key, "/private/file").request_id; await flush();
      expect((await f.coordinator.status(key, id)).state).toBe("failed");
    }
  });
  it("rejects wrong workspace, wrong grant, overlong and incomplete read output safely", async () => {
    for (const output of [{ grantId: "b".repeat(32), content: "x", sizeBytes: 1, truncated: false }, { grantId: gid, content: "x".repeat(65_537), sizeBytes: 2e6, truncated: true }, { grantId: gid, content: "x" }, { grantId: gid, content: "secret", sizeBytes: 2 * 1024 * 1024 + 1, truncated: false }, { grantId: gid, content: "界".repeat(65_537), sizeBytes: 2e6, truncated: true }]) {
      const f = fixture(r => r.op === "temporaryRead" ? output : undefined); const c = await connect(f);
      const id = (await c.tool("start", { path: "/private/file" })).data.request_id; await flush();
      expect(() => f.coordinator.revoke("other", id)).toThrow();
      const result = await c.tool("read", { request_id: id }); expect(result.error).toBe(true); expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
  it("preserves denial across failed revoke and late read", async () => {
    const pending = deferred(); const f = fixture(r => {
      if (r.op === "temporaryRead") return pending.promise;
      if (r.op === "temporaryReadRevoke") throw new Error("/private/path");
    });
    const id = f.coordinator.start(key, "/private/file").request_id; await flush();
    const reading = f.coordinator.read(key, id); f.coordinator.revoke(key, id);
    pending.resolve({ grantId: gid, content: "secret", sizeBytes: 6, truncated: false });
    await expect(reading).rejects.toThrow("NOT_APPROVED");
    expect((await f.coordinator.status(key, id)).state).toBe("revoked");
    await expect(f.coordinator.read(key, id)).rejects.toThrow();
  });
  it.each(["revoke", "close", "expiry"])("revokes late approval after %s and isolates a new bridge", async action => {
    vi.useFakeTimers(); const native = deferred(); const f = fixture(r => r.op === "temporaryReadRequest" ? native.promise : undefined);
    const id = f.coordinator.start(key, "/private/file").request_id; await flush();
    if (action === "revoke") f.coordinator.revoke(key, id);
    if (action === "close") f.coordinator.close();
    if (action === "expiry") await vi.advanceTimersByTimeAsync(OWNER_DIALOG_REQUEST_TIMEOUT_MS + 1);
    native.resolve(approved()); await flush();
    await expect(f.coordinator.read(key, id)).rejects.toThrow();
    expect(f.call.mock.calls.some(([r]) => r.op === "temporaryReadRevoke" && r.grantId === gid)).toBe(true);
    await expect(fixture().coordinator.status(key, id)).rejects.toThrow("NOT_FOUND");
  });
  it("bounds pending jobs, one prompt, capacity and approved TTL even for unsettled mocks", async () => {
    vi.useFakeTimers(); const native = deferred(); const f = fixture(r => r.op === "temporaryReadRequest" ? native.promise : undefined);
    const id = f.coordinator.start(key, "/private/file").request_id; await flush();
    expect(() => f.coordinator.start(key, "/other")).toThrow("BUSY");
    await vi.advanceTimersByTimeAsync(OWNER_DIALOG_REQUEST_TIMEOUT_MS + 1);
    expect((await f.coordinator.status(key, id)).state).toBe("expired");
    const g = fixture(); let last = "";
    for (let i = 0; i < 16; i++) { last = g.coordinator.start(key, "/file").request_id; await flush(); }
    expect(() => g.coordinator.start(key, "/file")).toThrow("CAPACITY");
    await vi.advanceTimersByTimeAsync(120_001);
    await expect(g.coordinator.read(key, last)).rejects.toThrow("NOT_APPROVED");
    expect(g.coordinator.start(key, "/file").state).toBe("pending");
  });
  it("requires workspace, rejects relative paths, and sanitizes native errors", async () => {
    const f = fixture(r => { if (r.op === "temporaryRead") throw new Error("/private/file secret stack"); });
    const c = await connect(f);
    expect((await c.tool("start", { workspace_id: undefined, path: "/file" })).error).toBe(true);
    expect((await c.tool("start", { path: "relative" })).error).toBe(true);
    expect(f.call).not.toHaveBeenCalled();
    const id = (await c.tool("start", { path: "/file" })).data.request_id; await flush();
    const result = await c.tool("read", { request_id: id });
    expect(result).toEqual({ error: true, data: { error: "TEMPORARY_READ_FAILED" } });
  });
  it("bounds capability probes and read I/O; denies late reads on TTL or close", async () => {
    vi.useFakeTimers();
    const stuck = fixture(() => new Promise(() => undefined));
    const probe = expect(stuck.coordinator.status(key)).rejects.toThrow("TIMEOUT");
    await vi.advanceTimersByTimeAsync(6_001); await probe;
    for (const action of ["expiry", "close", "timeout"]) {
      const native = deferred(); const f = fixture(r => r.op === "temporaryRead" ? native.promise : undefined);
      const id = f.coordinator.start(key, "/file").request_id; await flush();
      if (action === "expiry") await vi.advanceTimersByTimeAsync(119_000);
      const reading = expect(f.coordinator.read(key, id)).rejects.toThrow();
      if (action === "expiry") await vi.advanceTimersByTimeAsync(1_001);
      if (action === "close") f.coordinator.close();
      if (action === "timeout") await vi.advanceTimersByTimeAsync(15_001);
      native.resolve({ grantId: gid, content: "secret", sizeBytes: 6, truncated: false });
      await reading;
    }
  });
  it("keeps default denial and helper-not-ready from issuing reads or prompts", async () => {
    const denied = fixture(r => r.op === "temporaryReadRequest" ? { approved: false, grantCreated: false } : undefined);
    const id = denied.coordinator.start(key, "/file").request_id; await flush();
    expect((await denied.coordinator.status(key, id)).state).toBe("denied");
    await expect(denied.coordinator.read(key, id)).rejects.toThrow();
    const unavailable = fixture(r => r.op === "temporaryReadStatus" ? { ...ready, ready: false } : undefined);
    const other = unavailable.coordinator.start(key, "/file").request_id; await flush();
    expect((await unavailable.coordinator.status(key, other)).state).toBe("failed");
    expect(unavailable.call.mock.calls.every(([r]) => r.op === "temporaryReadStatus")).toBe(true);
  });
});
