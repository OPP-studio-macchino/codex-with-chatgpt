import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { DesktopAgentClient } from "../src/desktop/client.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

describe("temporary read launcher context", () => {
  it("allows startup overhead beyond the helper's 2s budget and kills a stuck probe at 5s", async () => {
    const root = makeTmpDir("temporary-read-timing");
    vi.useFakeTimers();
    try {
      const client = new DesktopAgentClient({ rpcPath: write(root, "rpc.mjs", ""), configPath: write(root, "config.json", "{}"), logger: nullLogger });
      const context = { authority: "c2c-owner:desktop.read" as const, scope: "backend-job" };
      for (const delay of [2_500, null]) {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end: vi.fn() }, kill: vi.fn() });
        vi.mocked(spawn).mockReturnValueOnce(child as any);
        if (delay) setTimeout(() => { child.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true, result: { ready: true, mode: "exact-file", ttlSeconds: 120 } }))); child.emit("exit"); }, delay);
        const pending = client.call({ op: "temporaryReadStatus" }, context);
        const checked = delay ? expect(pending).resolves.toMatchObject({ ready: true }) : expect(pending).rejects.toMatchObject({ code: "DESKTOP_AGENT_TIMEOUT" });
        await vi.advanceTimersByTimeAsync(delay ?? 5_000); await checked;
        expect(child.kill).toHaveBeenCalledTimes(delay ? 0 : 1);
        expect(child.stdin.end).toHaveBeenCalledWith(JSON.stringify({ op: "temporaryReadStatus" }));
      }
    } finally { vi.useRealTimers(); cleanup(root); }
  });
  it("denies direct calls, forwards fixed authority out of band, strips inherited authority from other operations", async () => {
    const root = makeTmpDir("temporary-read-client");
    const oldAuthority = process.env.OPP_DESKTOP_TRUSTED_READ_AUTHORITY;
    const oldScope = process.env.OPP_DESKTOP_TRUSTED_READ_SCOPE;
    try {
      const rpcPath = write(root, "rpc.mjs", `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const fields = {
  temporaryReadStatus: ["op"],
  temporaryReadRequest: ["op", "absolutePath", "requestDeadlineAt"],
  temporaryRead: ["op", "grantId"],
  temporaryReadRevoke: ["op", "grantId"],
}[request.op];
if (fields && (Object.keys(request).some(key => !fields.includes(key)) || fields.some(key => !(key in request)))) {
  process.stdout.write(JSON.stringify({ok:false,error:"INVALID_TEMPORARY_READ_REQUEST"}));
} else {
  process.stdout.write(JSON.stringify({ok:true,result:{request,authority:process.env.OPP_DESKTOP_TRUSTED_READ_AUTHORITY,scope:process.env.OPP_DESKTOP_TRUSTED_READ_SCOPE}}));
}
`);
      const client = new DesktopAgentClient({ rpcPath, configPath: write(root, "config.json", "{}"), logger: nullLogger });
      process.env.OPP_DESKTOP_TRUSTED_READ_AUTHORITY = "inherited";
      process.env.OPP_DESKTOP_TRUSTED_READ_SCOPE = "inherited";
      for (const op of ["temporaryReadStatus", "temporaryReadRequest", "temporaryRead", "temporaryReadRevoke"]) {
        await expect(client.call({ op, authority: "c2c-owner:desktop.read", scope: "stdin" })).rejects.toMatchObject({ code: "TRUSTED_READ_REQUIRED" });
      }
      const context = { authority: "c2c-owner:desktop.read" as const, scope: "backend-job" };
      const before = Date.now();
      const result = await client.call({ op: "temporaryReadRequest", absolutePath: "/fixture", requestDeadlineAt: "2099-01-01T00:00:00.000Z" }, context) as any;
      expect(result.authority).toBe(context.authority); expect(result.scope).toBe(context.scope);
      expect(result.request.authority).toBeUndefined(); expect(result.request.scope).toBeUndefined();
      expect(Date.parse(result.request.requestDeadlineAt)).toBeGreaterThanOrEqual(before + 2_707_000);
      expect(Date.parse(result.request.requestDeadlineAt)).toBeLessThanOrEqual(Date.now() + 2_709_000);
      for (const op of ["roots", "accessibilityApprovalRequest", "processRun"]) {
        const normal = await client.call({ op }, context) as any;
        expect(normal.authority).toBeUndefined(); expect(normal.scope).toBeUndefined();
      }
      for (const op of ["temporaryReadStatus", "temporaryRead", "temporaryReadRevoke"]) {
        const request = op === "temporaryReadStatus" ? { op } : { op, grantId: "a".repeat(32) };
        const response = await client.call(request, context) as any;
        expect(response.request).toEqual(request);
        expect(response.authority).toBe(context.authority); expect(response.scope).toBe(context.scope);
        expect(response.request.requestDeadlineAt).toBeUndefined();
        await expect(client.call({ ...request, requestDeadlineAt: "2099-01-01" }, context)).rejects.toMatchObject({ code: "INVALID_TEMPORARY_READ_REQUEST" });
      }
      for (const override of [{ scope: "caller" }, { approved: true }, { path: "/other" }, { ttl: 999 }, { authority: context.authority }]) {
        await expect(client.call({ op: "temporaryReadRequest", absolutePath: "/fixture", ...override }, context)).rejects.toMatchObject({ code: "INVALID_TEMPORARY_READ_REQUEST" });
      }
      await expect(client.call({ op: "temporaryRead" }, { ...context, scope: "bad/scope" })).rejects.toThrow();
    } finally {
      if (oldAuthority === undefined) delete process.env.OPP_DESKTOP_TRUSTED_READ_AUTHORITY; else process.env.OPP_DESKTOP_TRUSTED_READ_AUTHORITY = oldAuthority;
      if (oldScope === undefined) delete process.env.OPP_DESKTOP_TRUSTED_READ_SCOPE; else process.env.OPP_DESKTOP_TRUSTED_READ_SCOPE = oldScope;
      cleanup(root);
    }
  });
});
