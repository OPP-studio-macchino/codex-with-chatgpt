import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { runGit, remainingReconciliationReadMs, type ReconciliationReadBudget } from "../src/workspace/git.js";
import { fingerprintWorkspace } from "../src/execution/reconciliation-evidence.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, makeGitRepo, git, write, cleanup } from "./helpers.js";

const observation = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; timeout: number }>,
  before: undefined as undefined | ((args: string[]) => void) }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawnSync: (...args: Parameters<typeof real.spawnSync>) => {
    const argv = args[1] as string[], opts = args[2] as { timeout?: number };
    observation.calls.push({ args: argv, timeout: opts?.timeout ?? 0 }); observation.before?.(argv);
    return real.spawnSync(...args);
  } };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); observation.before = undefined; observation.calls = []; roots.splice(0).forEach(cleanup); });
function fixture() {
  const root = makeTmpDir("reconciliation-git-budget"), snapshots = makeTmpDir("reconciliation-git-snapshots");
  roots.push(root, snapshots); makeGitRepo(root);
  vi.spyOn(os, "tmpdir").mockReturnValue(snapshots);
  observation.calls = [];
  return { root, snapshots };
}
function clock() {
  const time = { ms: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => time.ms);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(time.ms) * 1_000_000n);
  return time;
}
const empty = (dir: string) => expect(fs.readdirSync(dir).filter(n => !n.startsWith("._"))).toEqual([]);
const budget = (ms = 20_000): ReconciliationReadBudget => ({ deadlineNs: process.hrtime.bigint() + BigInt(ms) * 1_000_000n });

it("scoped acquisition accepts 300ms but direct acquisition retains 250ms without leakage (simulated clock, real Git)", () => {
  const { root, snapshots } = fixture(), time = clock(), open = fs.openSync.bind(fs);
  vi.stubEnv("C2C_GIT_SNAPSHOT_MS", "250");
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).startsWith(snapshots + path.sep) && /objects\/[a-f0-9]{2}\/[a-f0-9]+$/.test(String(file)) &&
      typeof args[0] === "number" && (args[0] & fs.constants.O_CREAT)) time.ms += 300;
    return (open as Function)(file, ...args);
  }) as typeof fs.openSync);
  const context = budget(5000);
  expect(runGit(root, ["rev-parse", "HEAD"], context).ok).toBe(true);
  expect(observation.calls[0].timeout).toBe(1000);
  expect(() => runGit(root, ["rev-parse", "HEAD"])).toThrow("budget_exhausted");
  expect(runGit(root, ["rev-parse", "HEAD"], context).ok).toBe(true);
  empty(snapshots);
});

it("charges preflight against a smaller shared remainder and refuses a renewed read (simulated clock)", () => {
  const { root, snapshots } = fixture(), time = clock(), context = budget(80);
  observation.before = () => { time.ms += 40; };
  expect(() => runGit(root, ["rev-parse", "HEAD"], context)).toThrow("budget_exhausted");
  expect(observation.calls.map(c => c.timeout)).toEqual([80, 40]);
  const count = observation.calls.length;
  expect(() => runGit(root, ["rev-parse", "HEAD"], context)).toThrow("budget_exhausted");
  expect(observation.calls).toHaveLength(count); empty(snapshots);
});

it.each([NaN, Infinity, -Infinity, 0n, -1n, 30_000_000_000n])("rejects invalid/expired deadline %s before any Git or private storage (simulated clock)", deadlineNs => {
  const { root, snapshots } = fixture(); clock();
  expect(() => runGit(root, ["rev-parse", "HEAD"], { deadlineNs } as ReconciliationReadBudget)).toThrow();
  expect(observation.calls).toHaveLength(0); empty(snapshots);
});

it("clamps callback timeout and rejects late success with cleanup (simulated clock)", () => {
  const { root, snapshots } = fixture(), time = clock(), context = budget(80);
  observation.before = args => {
    if (args.some(a => a.startsWith("--git-dir=")) && args.includes("rev-parse")) time.ms = 81;
  };
  expect(() => runGit(root, ["rev-parse", "HEAD"], context)).toThrow("budget_exhausted");
  expect(observation.calls.at(-1)?.timeout).toBe(80);
  expect(observation.calls.every(c => c.timeout > 0 && c.timeout <= 80)).toBe(true);
  empty(snapshots);
});

it("successful snapshots cannot renew the enclosing fingerprint deadline (simulated clock)", () => {
  const { root, snapshots } = fixture(), workspace = new Workspace(root), time = clock(), context = budget(1000);
  observation.before = args => {
    if (args.some(a => a.startsWith("--git-dir=")) && (args.includes("rev-parse") || args.includes("status"))) time.ms += 350;
  };
  expect(() => fingerprintWorkspace(workspace, context)).toThrow("budget_exhausted");
  expect(observation.calls.filter(c => c.args.includes("config")).map(c => c.timeout)).toEqual([1000]);
  expect(observation.calls.at(-1)?.timeout).toBe(300);
  empty(snapshots);
});

it("charges private preparation to acquisition and cleans up on expiry (simulated clock)", () => {
  const { root, snapshots } = fixture(), time = clock(), context = budget(5000), writeFile = fs.writeFileSync.bind(fs);
  vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const result = (writeFile as Function)(file, ...args);
    if (String(file).startsWith(snapshots + path.sep) && String(file).endsWith("/config")) time.ms = 1001;
    return result;
  }) as typeof fs.writeFileSync);
  expect(() => runGit(root, ["rev-parse", "HEAD"], context)).toThrow("budget_exhausted"); empty(snapshots);
});

it("fresh final ref reads retain the shrinking parent deadline (simulated clock)", () => {
  const { root, snapshots } = fixture(), time = clock(), context = budget(1000);
  let statuses = 0;
  observation.before = args => {
    if (args.includes("status") && args.some(a => a.startsWith("--git-dir=")) && ++statuses === 2) time.ms = 950;
    else if (statuses === 2 && args.includes("config")) time.ms = 1001;
  };
  expect(() => fingerprintWorkspace(new Workspace(root), context)).toThrow("budget_exhausted");
  expect(statuses).toBe(2);
  expect(observation.calls.filter(c => c.args.includes("config")).map(c => c.timeout)).toEqual([1000, 1000, 1000, 50]);
  empty(snapshots);
});

it.each(["loose", "packed"])("fingerprints real %s Git with an explicit worker context and no env override", kind => {
  const { root, snapshots } = fixture();
  if (kind === "packed") git(root, "gc", "--prune=now");
  write(root, "hello.txt", "dirty scoped content\n"); write(root, "new.txt", "new content\n");
  observation.calls = [];
  const result = fingerprintWorkspace(new Workspace(root), budget());
  expect(result.changedCount).toBeGreaterThanOrEqual(2);
  expect(observation.calls.filter(c => c.args.includes("config")).every(c => c.timeout > 0 && c.timeout <= 1000)).toBe(true);
  empty(snapshots);
});

it.each([["type", "tree 1\0x", "invalid_object"], ["length", "blob 2\0x", "invalid_object"], ["hash", "blob 1\0x", "object_hash_mismatch"]])(
  "scoped real-clock %s corruption still rejects and cleans up", (_kind, raw, reason) => {
    const { root, snapshots } = fixture(), oid = git(root, "rev-parse", "HEAD:hello.txt").trim();
    const object = path.join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
    fs.chmodSync(object, 0o600);
    fs.writeFileSync(object, deflateSync(Buffer.from(raw)));
    expect(() => runGit(root, ["ls-files", "--stage", "-z"], budget())).toThrow(reason); empty(snapshots);
  });

it("dirty-file reads share the nonrenewable fingerprint deadline and close the descriptor (simulated expiry)", () => {
  const { root, snapshots } = fixture(); write(root, "dirty.txt", "dirty");
  const workspace = new Workspace(root), time = clock(), context = budget(1000);
  const open = fs.openSync.bind(fs), read = fs.readSync.bind(fs), close = fs.closeSync.bind(fs);
  let dirtyFd: number | undefined, closed = false;
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    const fd = (open as Function)(file, ...args);
    if (String(file) === path.join(root, "dirty.txt")) dirtyFd = fd;
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: unknown[]) => {
    const n = (read as Function)(fd, ...args); if (fd === dirtyFd) time.ms = 1001; return n;
  }) as typeof fs.readSync);
  vi.spyOn(fs, "closeSync").mockImplementation(fd => { if (fd === dirtyFd) closed = true; close(fd); });
  expect(() => fingerprintWorkspace(workspace, context)).toThrow("budget_exhausted");
  expect(closed).toBe(true); empty(snapshots);
});
