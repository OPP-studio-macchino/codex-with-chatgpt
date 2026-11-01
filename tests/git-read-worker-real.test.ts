import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { readGitInWorker } from "../src/workspace/git-read-worker.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir, makeGitRepo, cleanup, write, git, isolateStateDir } from "./helpers.js";

const state = vi.hoisted(() => ({ entry: "", hook: "", slow: false, tmp: "", workers: [] as import("node:worker_threads").Worker[] }));
vi.mock("node:worker_threads", async original => {
  const real = await original<typeof import("node:worker_threads")>();
  return { ...real, Worker: class extends real.Worker {
    constructor(_url: URL, options: import("node:worker_threads").WorkerOptions) {
      super(new URL(state.entry), { ...options, execArgv: state.slow ? ["--import", state.hook] : [],
        env: { ...process.env, TMPDIR: state.tmp } }); state.workers.push(this);
    }
  } };
});
let fixture: string, root: string, workspace: Workspace, ownedBuild: string | undefined;
beforeAll(() => {
  isolateStateDir(); fixture = makeTmpDir("mcp-git-worker"); root = path.join(fixture, "repo"); fs.mkdirSync(root); makeGitRepo(root);
  state.tmp = path.join(fixture, "snapshots"); fs.mkdirSync(state.tmp);
  const build = process.env.C2C_RECONCILIATION_TEST_BUILD ?? (ownedBuild = makeTmpDir("git-worker-build"));
  if (ownedBuild) {
    const compiled = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--outDir", build, "--sourceMap", "false"],
      { encoding: "utf8", timeout: 25000, maxBuffer: 1024 * 1024, env: { ...process.env, COREPACK_ENABLE_NETWORK: "0", npm_config_offline: "true" } });
    expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0);
  }
  state.entry = pathToFileURL(path.resolve(build, "workspace/git-read-worker.js")).href;
  state.hook = pathToFileURL(write(fixture, "slow.mjs", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);\n")).href;
  write(root, ".env", "API_KEY=private-fixture-value\n");
  write(root, "src/index.ts", "export const api_key = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';\n");
  workspace = new Workspace(root);
});
afterAll(async () => { for (const w of state.workers) await w.terminate(); if (fixture) cleanup(fixture); if (ownedBuild) cleanup(ownedBuild); });
async function connect(scopes = ["git.read"]) {
  const resolver = vi.fn((id?: string) => { if (id !== workspace.id) throw Error("private resolver data"); return { workspace, codexNetworkHosts: [] }; });
  const server = createMcpServer({ workspace, resolveWorkspace: resolver, logger: nullLogger });
  const [ct, st] = InMemoryTransport.createLinkedPair(); const send = ct.send.bind(ct);
  ct.send = (message, options) => send(message, { ...options, authInfo: { token: "fixture", clientId: "fixture", scopes } });
  const client = new Client({ name: "git-worker-test", version: "1" }); await server.connect(st); await client.connect(ct);
  return { resolver, close: async () => { await client.close(); await server.close(); },
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { workspace_id: workspace.id, ...args } });
      return { error: result.isError, text: (result.content as { text: string }[])[0].text };
    } };
}
it("real MCP status/diff retain redaction and pagination through a real worker and real Git", async () => {
  const c = await connect();
  try {
    const status = await c.call("git_status"); expect(status.error).toBeFalsy(); expect(status.text).not.toContain(".env");
    expect(JSON.parse(status.text).unstaged.some((e: any) => e.path === "src/index.ts")).toBe(true);
    const diff = await c.call("git_diff", { path: "src/index.ts", max_bytes: 1024 });
    expect(diff.error).toBeFalsy(); expect(diff.text).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    const data = JSON.parse(diff.text); expect(data.isRepo).toBe(true); expect(data.redactionCount).toBeGreaterThan(0);
    expect(data.returnedBytes).toBeLessThanOrEqual(1024); expect(c.resolver).toHaveBeenCalled();
    expect(fs.readdirSync(state.tmp).filter(n => !n.startsWith("._"))).toEqual([]);
  } finally { await c.close(); }
});
it("MCP denies missing scope, unknown target, traversal and sensitive path before worker creation", async () => {
  const denied = await connect([]); const allowed = await connect(); const count = state.workers.length;
  try {
    expect((await denied.call("git_status")).error).toBe(true);
    expect((await allowed.call("git_status", { workspace_id: "0".repeat(24) })).error).toBe(true);
    for (const p of ["../outside", ".env"]) expect((await allowed.call("git_diff", { path: p })).error).toBe(true);
    expect((await allowed.call("git_diff", { mode: "shell" })).error).toBe(true);
    expect(state.workers).toHaveLength(count);
  } finally { await denied.close(); await allowed.close(); }
});
it("MCP event loop responds while a real worker is deliberately slow (real clock)", async () => {
  const c = await connect(); state.slow = true;
  try {
    let settled = false; const pending = c.call("git_status").finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false);
    expect((await c.call("git_diff", { path: "../outside" })).error).toBe(true);
    expect(settled).toBe(false); expect((await pending).error).toBeFalsy();
  } finally { state.slow = false; await c.close(); }
});
it("real worker cancellation rejects promptly and never becomes late success", async () => {
  state.slow = true; const controller = new AbortController();
  try {
    const pending = readGitInWorker(root, { op: "status" }, controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); await rejected;
  } finally { state.slow = false; }
});
it("real worker packed diff succeeds; corrupt required object still rejects", async () => {
  const separate = path.join(fixture, "packed"); fs.mkdirSync(separate); makeGitRepo(separate);
  git(separate, "gc", "--prune=now"); write(separate, "hello.txt", "packed change\n");
  const result = await readGitInWorker(separate, { op: "diff", mode: "head", path: "hello.txt", offset: 0, maxBytes: 1024 });
  expect("diff" in result && result.diff).toContain("packed change");
  const loose = path.join(fixture, "corrupt"); fs.mkdirSync(loose); makeGitRepo(loose);
  const oid = git(loose, "rev-parse", "HEAD").trim();
  const object = path.join(loose, ".git/objects", oid.slice(0, 2), oid.slice(2));
  fs.chmodSync(object, 0o600); fs.writeFileSync(object, "invalid zlib");
  await expect(readGitInWorker(loose, { op: "status" })).rejects.toThrow("GIT_SNAPSHOT_FAILED");
  expect(fs.readdirSync(state.tmp).filter(n => !n.startsWith("._"))).toEqual([]);
});
it("worker bootstrap independently rejects malformed payload and expired deadline", async () => {
  for (const data of [
    { request: { op: "status", command: "forbidden" }, deadlineNs: process.hrtime.bigint() + 20_000_000_000n },
    { request: { op: "status" }, deadlineNs: 0n },
  ]) {
    const worker = new Worker(new URL(state.entry), { workerData: { kind: "c2c-git-read", root, snapshotRoot: state.tmp, ...data } });
    const [message] = await once(worker, "message");
    expect(message.ok).toBe(false); expect(message.error.code).toMatch(/^GIT_/);
    expect(JSON.stringify(message)).not.toContain(root);
    await worker.terminate();
  }
});
it("public MCP worker preserves repository-configured diff-driver nonexecution (real clock)", async () => {
  write(root, "driver.sh", "#!/bin/sh\n: > driver-executed\nexit 0\n");
  fs.chmodSync(path.join(root, "driver.sh"), 0o700);
  write(root, ".gitattributes", "evil.txt diff=evil\n"); write(root, "evil.txt", "initial\n");
  git(root, "add", ".gitattributes", "evil.txt"); git(root, "commit", "-m", "diff driver fixture");
  git(root, "config", "diff.evil.command", "./driver.sh"); write(root, "evil.txt", "changed safely\n");
  const c = await connect();
  try {
    const result = await c.call("git_diff"); expect(result.error).toBeFalsy();
    expect(JSON.parse(result.text).diff).toContain("changed safely");
    expect(fs.existsSync(path.join(root, "driver-executed"))).toBe(false);
  } finally { await c.close(); }
});
