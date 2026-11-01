import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readGitInWorker } from "../src/workspace/git-read-worker.js";
import { createGitReadStorage, awaitGitReadCleanup } from "../src/workspace/git-read-storage.js";
import { inspectForReconciliation } from "../src/execution/reconciliation-evidence.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, makeGitRepo, cleanup, write, isolateStateDir } from "./helpers.js";
const state = vi.hoisted(() => ({ entry: "", reconciliationEntry: "", hook: "", marker: "", child: "", workers: [] as Array<import("node:worker_threads").Worker & { storage: string }> }));
vi.mock("node:worker_threads", async original => {
  const real = await original<typeof import("node:worker_threads")>();
  return { ...real, Worker: class extends real.Worker {
    storage: string;
    constructor(_url: URL, options: import("node:worker_threads").WorkerOptions) {
      super(new URL(options.workerData.kind === "c2c-reconciliation" ? state.reconciliationEntry : state.entry), { ...options, execArgv: ["--import", state.hook],
        env: { ...process.env, OWNED_TEST_CHILD: state.child, OWNED_TEST_MARKER: state.marker } });
      this.storage = options.workerData.snapshotRoot; state.workers.push(this);
    }
  } };
});
let fixture: string, root: string, ownedBuild: string | undefined;
beforeAll(() => {
  isolateStateDir(); fixture = makeTmpDir("owned-git-child"); root = path.join(fixture, "repo"); fs.mkdirSync(root); makeGitRepo(root);
  const build = process.env.C2C_RECONCILIATION_TEST_BUILD ?? (ownedBuild = makeTmpDir("cleanup-worker-build"));
  if (ownedBuild) {
    const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--outDir", build, "--sourceMap", "false"],
      { encoding: "utf8", timeout: 25000, maxBuffer: 1024 * 1024, env: { ...process.env, COREPACK_ENABLE_NETWORK: "0", npm_config_offline: "true" } });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }
  state.entry = pathToFileURL(path.resolve(build, "workspace/git-read-worker.js")).href;
  state.reconciliationEntry = pathToFileURL(path.resolve(build, "execution/reconciliation-evidence.js")).href;
  state.child = write(fixture, "child.cjs", `const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[2]+'.writing',JSON.stringify({pid:process.pid,token:'owned-fixture'}));fs.renameSync(process.argv[2]+'.writing',process.argv[2]);setTimeout(()=>process.exit(0),1800);`);
  state.hook = pathToFileURL(write(fixture, "hook.mjs", `
import cp from 'node:child_process';
import { syncBuiltinESMExports, registerHooks } from 'node:module';
const original=cp.spawnSync;
cp.spawnSync=function(binary,args,options){
  if(args?.includes('status') && args.some(a=>a.startsWith('--git-dir='))) {
    if(options.killSignal!=='SIGKILL') throw Error('missing owned-child hard timeout');
    return original(process.execPath,[process.env.OWNED_TEST_CHILD,process.env.OWNED_TEST_MARKER],{...options,timeout:800});
  }
  return original(binary,args,options);
};
syncBuiltinESMExports();
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/execution/reconciliation-processes.js')) return loaded;
  const anchor = 'export function scanReconciliationProcesses(';
  let source = String(loaded.source);
  if (!source.includes(anchor)) throw Error('scan hook mismatch');
  source = source.replace(anchor, 'function unusedHostScan(');
  source += '\\nexport function scanReconciliationProcesses(context) { const snapshot={rows:[],cwds:new Map(),observed_at:new Date().toISOString()}; return compareProcessSnapshots(context,snapshot,snapshot,501); }';
  return { ...loaded, source };
} });
`)).href;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const w of state.workers) await w.terminate(); if (fixture) cleanup(fixture); if (ownedBuild) cleanup(ownedBuild); });
async function until(check: () => boolean) {
  for (let n = 0; n < 150; n++) { if (check()) return; await delay(20); }
  throw Error("owned fixture did not reach expected state within3s");
}
it.each(["mcp", "reconciliation"].flatMap(route => ["cancel", "timeout", "terminate"].map(kind => ({ route, kind }))))("cleans owned live child/private snapshot: $route $kind (real child; timeout callback simulated)", async ({ route, kind }) => {
  state.marker = path.join(fixture, `ready-${route}-${kind}.json`);
  let timeout!: () => void;
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms && ms > 19000 && ms <= 20000) timeout = callback;
    return timer(callback, ms, ...args);
  }) as typeof setTimeout);
  const controller = new AbortController();
  const pending = route === "mcp" ? readGitInWorker(root, { op: "status" }, controller.signal)
    : inspectForReconciliation(new Workspace(root), controller.signal);
  // Observe immediately without creating a detached assertion if fixture setup fails.
  const outcome = pending.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  await until(() => fs.existsSync(state.marker));
  const owned = JSON.parse(fs.readFileSync(state.marker, "utf8")); expect(owned.token).toBe("owned-fixture");
  // Exact PID came from this unique fixture's child handshake; no enumeration or control signal.
  expect(() => process.kill(owned.pid, 0)).not.toThrow();
  const worker = state.workers.at(-1)!;
  expect(fs.readdirSync(worker.storage).some(n => n.startsWith("c2c-git-snapshot-"))).toBe(true);
  const started = performance.now();
  if (kind === "cancel") controller.abort();
  else if (kind === "timeout") { expect(timeout).toBeTypeOf("function"); timeout(); }
  else void worker.terminate();
  const result = await outcome;
  expect(result.ok).toBe(false);
  expect("error" in result && result.error).toMatchObject(route === "mcp" ? { code: "GIT_READ_FAILED" } : {
    code: kind === "cancel" ? "RECONCILIATION_CANCELLED" : kind === "timeout" ? "RECONCILIATION_INSPECTION_TIMEOUT" : "RECONCILIATION_INSPECTION_FAILED",
  });
  if (kind !== "terminate") expect(performance.now() - started).toBeLessThan(300);
  await until(() => !fs.existsSync(worker.storage));
  // Native timeout uses SIGKILL on the spawn handle and reaps before thread exit/parent cleanup.
  expect(performance.now() - started).toBeLessThan(1600);
  expect(() => process.kill(owned.pid, 0)).toThrow();
});
it("owned storage refuses a substituted root without deleting the replacement", async () => {
  const storage = createGitReadStorage(), moved = storage.root + "-owned-moved";
  fs.renameSync(storage.root, moved); fs.mkdirSync(storage.root, { mode: 0o700 });
  try { await expect(storage.dispose()).rejects.toThrow("identity changed"); expect(fs.existsSync(storage.root)).toBe(true); }
  finally { cleanup(storage.root); cleanup(moved); }
});
it.each(["chmod", "verification"])("removes its empty owned directory after storage %s failure", stage => {
  const original = fs.mkdtempSync.bind(fs); let created = "";
  vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => created = original(prefix)) as typeof fs.mkdtempSync);
  if (stage === "chmod") vi.spyOn(fs, "chmodSync").mockImplementation(() => { throw Error("fixture chmod failure"); });
  else {
    const lstat = fs.lstatSync.bind(fs); let calls = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: string) => {
      if (p === created && ++calls === 2) throw Error("fixture verification failure");
      return lstat(p);
    }) as typeof fs.lstatSync);
  }
  expect(() => createGitReadStorage()).toThrow(`fixture ${stage} failure`);
  expect(created).not.toBe(""); expect(fs.existsSync(created)).toBe(false);
});
it("creation failure preserves a substituted directory", () => {
  let created = "", moved = "";
  vi.spyOn(fs, "chmodSync").mockImplementation(p => {
    created = String(p); moved = created + "-owned-moved";
    fs.renameSync(created, moved); fs.mkdirSync(created, { mode: 0o700 });
    throw Error("fixture replacement");
  });
  try {
    expect(() => createGitReadStorage()).toThrow("fixture replacement");
    expect(fs.existsSync(created)).toBe(true); expect(fs.existsSync(moved)).toBe(true);
  } finally { if (created) cleanup(created); if (moved) cleanup(moved); }
});
it("canonicalizes the temp parent before creating a private owned root (workspace-only alias)", async () => {
  const real = path.join(fixture, "real-temp"), alias = path.join(fixture, "temp-alias");
  fs.mkdirSync(real); fs.symlinkSync(real, alias);
  vi.spyOn(os, "tmpdir").mockReturnValue(alias);
  const storage = createGitReadStorage();
  expect(path.dirname(storage.root)).toBe(real);
  expect(fs.statSync(storage.root).mode & 0o777).toBe(0o700);
  await storage.dispose(); expect(fs.readdirSync(real).filter(n => !n.startsWith("._"))).toEqual([]);
});
it("cleanup wait cannot renew total deadline or ignore cancellation (simulated timers)", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController(), pending = new Promise<void>(() => {});
    const cancelled = awaitGitReadCleanup(pending, process.hrtime.bigint() + 20_000_000_000n, controller.signal);
    const rejection = expect(cancelled).rejects.toThrow("cancelled"); controller.abort(); await rejection;
    const expired = awaitGitReadCleanup(pending, process.hrtime.bigint() - 1n);
    const expiry = expect(expired).rejects.toThrow("budget_exhausted"); await vi.advanceTimersByTimeAsync(1); await expiry;
  } finally { vi.useRealTimers(); }
});
