import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { fingerprintWorkspace } from "../src/execution/reconciliation-evidence.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const observation = vi.hoisted(() => ({ after: undefined as undefined | ((args: string[]) => void) }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawnSync: (...args: Parameters<typeof real.spawnSync>) => {
    const result = real.spawnSync(...args);
    observation.after?.(args[1] as string[]);
    return result;
  } };
});
const roots: string[] = [];
afterEach(() => { observation.after = undefined; vi.restoreAllMocks(); roots.splice(0).forEach(cleanup); });
function fixture() {
  const root = makeTmpDir("git-brackets"), snapshots = makeTmpDir("git-bracket-snapshots");
  roots.push(root, snapshots); makeGitRepo(root);
  vi.spyOn(os, "tmpdir").mockReturnValue(snapshots);
  write(root, "dirty.txt", "dirty evidence\n");
  return { root, snapshots, budget: { deadlineNs: process.hrtime.bigint() + 20_000_000_000n, snapshotRoot: snapshots } };
}

it("shares initial verified objects and keeps the final reads independent", () => {
  const { root, snapshots, budget } = fixture();
  const blob = git(root, "rev-parse", "HEAD:hello.txt").trim();
  const source = path.join(root, ".git/objects", blob.slice(0, 2), blob.slice(2));
  const open = vi.spyOn(fs, "openSync"), mkdtemp = vi.spyOn(fs, "mkdtempSync");
  expect(fingerprintWorkspace(new Workspace(root), budget)).toMatchObject({ changedCount: 1, fileCount: 1 });
  expect(mkdtemp.mock.calls.filter(([prefix]) => String(prefix).endsWith("c2c-git-snapshot-"))).toHaveLength(5);
  expect(open.mock.calls.filter(([file]) => file === source)).toHaveLength(3);
  expect(fs.readdirSync(snapshots)).toEqual([]);
});

it.each(["branch", "head"])("rejects %s changes after the final status returns", attack => {
  const { root, snapshots, budget } = fixture();
  const head = git(root, "rev-parse", "HEAD").trim();
  const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
  const alternate = git(root, "commit-tree", tree, "-p", head, "-m", "same tree, different commit").trim();
  git(root, "branch", "changed");
  let statusCalls = 0, changed = false;
  observation.after = args => {
    if (args.includes("status") && args.some(arg => arg.startsWith("--git-dir=")) && ++statusCalls === 2) {
      changed = true;
      if (attack === "branch") git(root, "symbolic-ref", "HEAD", "refs/heads/changed");
      else git(root, "update-ref", "refs/heads/main", alternate);
    }
  };
  expect(() => fingerprintWorkspace(new Workspace(root), budget))
    .toThrowError(expect.objectContaining({ code: "RECONCILIATION_EVIDENCE_CHANGED" }));
  expect(changed).toBe(true);
  expect(statusCalls).toBe(2);
  expect(git(root, "rev-parse", "HEAD").trim()).toBe(attack === "head" ? alternate : head);
  expect(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(attack === "branch" ? "changed" : "main");
  expect(fs.readdirSync(snapshots)).toEqual([]);
});

it("rejects index changes during final object acquisition", () => {
  const { root, snapshots, budget } = fixture(), open = fs.openSync.bind(fs);
  let dirtyRead = false, changed = false;
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (file === path.join(root, "dirty.txt")) dirtyRead = true;
    return (open as Function)(file, ...args);
  }) as typeof fs.openSync);
  observation.after = args => {
    if (dirtyRead && !changed && args.includes("ls-files") && args.some(arg => arg.startsWith("--git-dir="))) {
      changed = true;
      git(root, "add", "dirty.txt");
    }
  };
  expect(() => fingerprintWorkspace(new Workspace(root), budget))
    .toThrowError(expect.objectContaining({ code: "RECONCILIATION_EVIDENCE_CHANGED" }));
  expect(changed).toBe(true);
  expect(git(root, "ls-files", "--", "dirty.txt").trim()).toBe("dirty.txt");
  expect(fs.readdirSync(snapshots)).toEqual([]);
});

it.each(["branch", "index", "object"])("rejects %s changes between the two fresh brackets", attack => {
  const { root, snapshots, budget } = fixture();
  const blob = git(root, "rev-parse", "HEAD:hello.txt").trim();
  const source = path.join(root, ".git/objects", blob.slice(0, 2), blob.slice(2));
  const open = fs.openSync.bind(fs);
  let changed = false;
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (!changed && file === path.join(root, "dirty.txt")) {
      changed = true;
      if (attack === "branch") { git(root, "branch", "changed"); git(root, "symbolic-ref", "HEAD", "refs/heads/changed"); }
      else if (attack === "index") git(root, "add", "dirty.txt");
      else { fs.chmodSync(source, 0o600); fs.writeFileSync(source, deflateSync(Buffer.from("blob 1\0x"))); }
    }
    return (open as Function)(file, ...args);
  }) as typeof fs.openSync);
  expect(() => fingerprintWorkspace(new Workspace(root), budget)).toThrow(attack === "object" ? "object_hash_mismatch" : "RECONCILIATION EVIDENCE CHANGED");
  expect(changed).toBe(true);
  expect(fs.readdirSync(snapshots)).toEqual([]);
});
