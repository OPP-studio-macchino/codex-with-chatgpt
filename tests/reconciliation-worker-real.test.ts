import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { inspectForReconciliation } from "../src/execution/reconciliation-evidence.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, makeGitRepo, cleanup, write, git } from "./helpers.js";

// Real Node workers; only process observation is replaced inside the isolated
// compiled module. Never run host ps/lsof to manufacture quiescence.
const state = vi.hoisted(() => ({ entry: "", hook: "", tmp: "", workers: [] as import("node:worker_threads").Worker[] }));
vi.mock("node:worker_threads", async original => {
  const real = await original<typeof import("node:worker_threads")>();
  return { ...real, Worker: class extends real.Worker {
    constructor(_url: URL, options: import("node:worker_threads").WorkerOptions) {
      super(new URL(state.entry), { ...options, execArgv: ["--import", state.hook], env: { ...process.env, TMPDIR: state.tmp } });
      state.workers.push(this);
    }
  } };
});
let root: string, fixture: string, ownedBuild: string | undefined;
beforeAll(() => {
  fixture = makeTmpDir("real-worker-budget"); root = path.join(fixture, "repo"); fs.mkdirSync(root); makeGitRepo(root);
  state.tmp = path.join(fixture, "snapshots"); fs.mkdirSync(state.tmp);
  const build = process.env.C2C_RECONCILIATION_TEST_BUILD ?? (ownedBuild = makeTmpDir("worker-budget-build"));
  if (ownedBuild) {
    const compiled = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--outDir", build, "--sourceMap", "false"], {
      encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, COREPACK_ENABLE_NETWORK: "0", npm_config_offline: "true" },
    });
    expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0);
  }
  state.entry = pathToFileURL(path.resolve(build, "execution/reconciliation-evidence.js")).href;
  expect(fs.existsSync(new URL(state.entry))).toBe(true);
  state.hook = pathToFileURL(write(fixture, "process-observation-hook.mjs", `
import { registerHooks } from 'node:module';
import { workerData } from 'node:worker_threads';
let scans = 0, deadline, reads = 0;
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith('/execution/reconciliation-processes.js')) {
    let source = String(loaded.source);
    const anchor = 'export function scanReconciliationProcesses(';
    if (!source.includes(anchor)) throw Error('scan hook mismatch');
    source = source.replace(anchor, 'function unusedHostScan(');
    source += '\\nexport function scanReconciliationProcesses(context, observe, budget) { return globalThis.__observeProcess(context, observe, budget, compareProcessSnapshots); }';
    return { ...loaded, source };
  }
  if (url.endsWith('/workspace/git.js')) {
    let source = String(loaded.source);
    for (const anchor of ['export function readReconciliationGitState(root, budget) {', 'export function runGit(root, args, budget) {']) {
      if (!source.includes(anchor)) throw Error('Git hook mismatch');
      source = source.replace(anchor, anchor + ' if (!budget || budget.deadlineNs !== globalThis.__expectedDeadline) throw Error("lost worker budget"); globalThis.__recordRead();');
    }
    return { ...loaded, source };
  }
  return loaded;
} });
globalThis.__expectedDeadline = workerData.deadlineNs;
globalThis.__recordRead = () => { reads++; };
globalThis.__observeProcess = (context, observe, budget, compare) => {
  if (++scans === 1) deadline = budget.deadline;
  else if (deadline !== budget.deadline || reads !== 5) throw Error('renewed deadline or missing Git context');
  const snapshot = { rows: [], cwds: new Map(), observed_at: new Date().toISOString() };
  const evidence = compare(context, snapshot, snapshot, 501); observe(evidence); return evidence;
};
`)).href;
});
afterAll(async () => {
  await Promise.all(state.workers.map(w => w.terminate()));
  cleanup(fixture); if (ownedBuild) cleanup(ownedBuild);
});

it("real worker completes actual Git fingerprint with one parent budget (synthetic process observations)", async () => {
  write(root, "new.txt", "worker data\n");
  const evidence = await inspectForReconciliation(new Workspace(root), new AbortController().signal);
  expect(evidence.changedCount).toBeGreaterThan(0);
  expect(evidence.processes.quiescence).toBe("QUIESCENT");
  expect(fs.readdirSync(state.tmp).filter(n => n.startsWith("c2c-git-snapshot-"))).toEqual([]);
});

it("parent remains responsive and rejects cancellation with a real worker (synthetic process observations)", async () => {
  const controller = new AbortController(); let ticked = false;
  const tick = setTimeout(() => { ticked = true; }, 0);
  const started = performance.now();
  const promise = inspectForReconciliation(new Workspace(root), controller.signal, undefined, evidence => {
    if (evidence.quiescence === "QUIESCENT") controller.abort();
  });
  const worker = state.workers.at(-1)!;
  const exited = once(worker, "exit");
  await expect(promise).rejects.toMatchObject({ code: "RECONCILIATION_CANCELLED" });
  expect(ticked).toBe(true);
  expect(performance.now() - started).toBeLessThan(2500);
  await exited; clearTimeout(tick);
});

it("a real worker refuses an elapsed parent deadline before observing host processes", async () => {
  const real = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  const worker = new real.Worker(new URL(state.entry), { execArgv: ["--import", state.hook],
    workerData: { kind: "c2c-reconciliation", root, deadlineNs: process.hrtime.bigint() - 1n }, env: { ...process.env, TMPDIR: state.tmp } });
  state.workers.push(worker);
  const [message] = await once(worker, "message");
  expect(message).toMatchObject({ ok: false, code: "RECONCILIATION_GIT_UNVERIFIED" });
  expect(message.processes).toBeUndefined();
});

it("real worker rejects an actual unmerged conflict (synthetic process observations)", async () => {
  const conflict = path.join(fixture, "conflict"); fs.mkdirSync(conflict); makeGitRepo(conflict);
  git(conflict, "checkout", "-b", "conflict-side");
  write(conflict, "hello.txt", "side\n"); git(conflict, "add", "hello.txt"); git(conflict, "commit", "-m", "side");
  git(conflict, "checkout", "main");
  write(conflict, "hello.txt", "main\n"); git(conflict, "add", "hello.txt"); git(conflict, "commit", "-m", "main");
  expect(() => git(conflict, "merge", "conflict-side")).toThrow();
  await expect(inspectForReconciliation(new Workspace(conflict), new AbortController().signal))
    .rejects.toMatchObject({ code: "RECONCILIATION_CONFLICT_PRESENT" });
});
