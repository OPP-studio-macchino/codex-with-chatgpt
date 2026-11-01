import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { gitStatus, runGit } from "../src/workspace/git.js";
import { fingerprintWorkspace } from "../src/execution/reconciliation-evidence.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, makeGitRepo, git, write } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("hydrates only HEAD for exact identity reads and retains abbreviation/history fallback", () => {
  const root = makeTmpDir("current-dependencies"), snapshots = makeTmpDir("current-dependency-snapshots");
  vi.spyOn(os, "tmpdir").mockReturnValue(snapshots);
  vi.stubEnv("C2C_GIT_SNAPSHOT_MS", "10000");
  try {
    makeGitRepo(root);
    const head = git(root, "rev-parse", "HEAD").trim();
    const store = path.join(root, ".git/objects");
    const unused = path.join(store, "unused-history"), fd = fs.openSync(unused, "wx");
    fs.ftruncateSync(fd, 513 * 1024 * 1024); fs.closeSync(fd);
    const open = fs.openSync.bind(fs), reads: string[] = [];
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file).startsWith(store + path.sep)) reads.push(String(file));
      return (open as (...args: unknown[]) => number)(file, ...args);
    }) as typeof fs.openSync);
    expect(runGit(root, ["rev-parse", "HEAD"])).toMatchObject({ ok: true, stdout: head + "\n" });
    expect(reads).toEqual([path.join(store, head.slice(0, 2), head.slice(2))]);
    expect(() => runGit(root, ["rev-parse", "--short", "HEAD"])).toThrow("GIT_SNAPSHOT_FAILED: objects: byte_limit");
    expect(() => runGit(root, ["rev-parse", "HEAD^"])).toThrow("GIT_SNAPSHOT_FAILED: objects: byte_limit");
  } finally { cleanup(root); cleanup(snapshots); }
});

it("keeps staged modes and one status snapshot with an absent empty pack directory", () => {
  const root = makeTmpDir("current-modes"), snapshots = makeTmpDir("current-mode-snapshots");
  vi.spyOn(os, "tmpdir").mockReturnValue(snapshots);
  vi.stubEnv("C2C_GIT_SNAPSHOT_MS", "10000");
  try {
    makeGitRepo(root);
    fs.rmdirSync(path.join(root, ".git/objects/pack"));
    git(root, "update-index", "--chmod=+x", "src/index.ts");
    const index = fs.readFileSync(path.join(root, ".git/index"));
    const mode = fs.statSync(path.join(root, "src/index.ts")).mode;
    const mkdtemp = vi.spyOn(fs, "mkdtempSync");
    const status = gitStatus(root);
    expect(status.staged).toContainEqual({ path: "src/index.ts", change: "M" });
    expect(status.modeOnly).not.toContain("src/index.ts");
    expect(mkdtemp.mock.calls.filter(([prefix]) => String(prefix).endsWith("c2c-git-snapshot-"))).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, ".git/index"))).toEqual(index);
    expect(fs.statSync(path.join(root, "src/index.ts")).mode).toBe(mode);
  } finally { cleanup(root); cleanup(snapshots); }
});

it("reads current status and reconciliation without copying unrelated loose/packed history", () => {
  const root = makeTmpDir("current-history"), snapshots = makeTmpDir("current-snapshots");
  vi.spyOn(os, "tmpdir").mockReturnValue(snapshots);
  vi.stubEnv("C2C_GIT_SNAPSHOT_MS", "10000");
  try {
    makeGitRepo(root);
    const store = path.join(root, ".git/objects");
    const loose = (type: string, data: Buffer): string => {
      const raw = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
      const oid = createHash("sha1").update(raw).digest("hex");
      const dir = path.join(store, oid.slice(0, 2)); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, oid.slice(2)), deflateSync(raw));
      return oid;
    };
    const history: string[] = [], entries: Buffer[] = [], packInput: Buffer[] = [];
    for (let i = 0; i < 21_010; i++) {
      const data = Buffer.from(`historical content ${i}\n`);
      const oid = i < 2000 ? loose("blob", data)
        : createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
      if (i < 2000) history.push(oid);
      else packInput.push(Buffer.from(`blob\ndata ${data.length}\n`), data, Buffer.from("\n"));
      entries.push(Buffer.from(`100644 old-${String(i).padStart(5, "0")}\0`), Buffer.from(oid, "hex"));
    }
    // Keep the same historical object count without spending the test timeout
    // creating and deleting 21,010 separate files on slow external storage.
    const pack = spawnSync("git", ["fast-import", "--quiet"], {
      cwd: root, input: Buffer.concat(packInput), encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    expect(pack.status).toBe(0);
    const tree = loose("tree", Buffer.concat(entries));
    const parent = loose("commit", Buffer.from(`tree ${tree}\nauthor Fixture <fixture@c2c.local> 1 +0000\ncommitter Fixture <fixture@c2c.local> 1 +0000\n\nhistorical fixture\n`));
    const currentTree = git(root, "rev-parse", "HEAD^{tree}").trim();
    const head = loose("commit", Buffer.from(`tree ${currentTree}\nparent ${parent}\nauthor Fixture <fixture@c2c.local> 2 +0000\ncommitter Fixture <fixture@c2c.local> 2 +0000\n\ncurrent fixture\n`));
    git(root, "update-ref", "refs/heads/main", head);
    write(root, "hello.txt", "staged\n"); git(root, "add", "hello.txt");
    write(root, "hello.txt", "unstaged\n");
    fs.unlinkSync(path.join(root, "src/index.ts"));
    write(root, "new.txt", "untracked\n");
    const index = fs.readFileSync(path.join(root, ".git/index"));
    const statusArgs = ["-c", "core.filemode=false", "status", "--porcelain=v2", "--no-renames", "--ignore-submodules=all", "--untracked-files=all", "-z", "--", "."];
    // Match the snapshot's isolation from the host's implicit global ignore
    // file; otherwise macOS sidecars can differ despite identical Git state.
    const expected = git(root, "-c", "core.excludesFile=/dev/null", ...statusArgs);
    const open = fs.openSync.bind(fs), historicalPaths = new Set(history.map(oid => path.join(store, oid.slice(0, 2), oid.slice(2))));
    for (const name of fs.readdirSync(path.join(store, "pack")).filter(n => /^pack-.*\.(idx|pack)$/.test(n)))
      historicalPaths.add(path.join(store, "pack", name));
    let unrelatedReads = 0;
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (historicalPaths.has(String(file)) || String(file) === path.join(store, parent.slice(0, 2), parent.slice(2))) unrelatedReads++;
      return (open as (...args: unknown[]) => number)(file, ...args);
    }) as typeof fs.openSync);
    expect(runGit(root, statusArgs)).toMatchObject({ ok: true, stdout: expected });
    expect(gitStatus(root)).toMatchObject({ staged: [{ path: "hello.txt", change: "M" }], untracked: ["new.txt"] });
    const evidence = fingerprintWorkspace(new Workspace(root));
    expect(evidence).toMatchObject({ head, staged: true, changedCount: 3, fileCount: 3 });
    expect(fingerprintWorkspace(new Workspace(root)).digest).toBe(evidence.digest);
    expect(unrelatedReads).toBe(0);
    expect(fs.readFileSync(path.join(root, ".git/index"))).toEqual(index);
    expect(fs.readdirSync(snapshots).filter(n => !n.startsWith("._"))).toEqual([]);
  } finally { cleanup(root); cleanup(snapshots); }
}, 120_000);

it.each(["appledouble", "index", "pack", "missing", "loose-hash", "hardlink", "index-race"])("current reads validate required objects: %s", attack => {
  const root = makeTmpDir("current-validation"), snapshots = makeTmpDir("current-validation-snapshots");
  vi.spyOn(os, "tmpdir").mockReturnValue(snapshots);
  vi.stubEnv("C2C_GIT_SNAPSHOT_MS", "10000");
  try {
    makeGitRepo(root);
    const oid = git(root, "rev-parse", "HEAD:hello.txt").trim();
    const blob = path.join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
    if (["missing", "loose-hash", "hardlink"].includes(attack)) {
      if (attack === "missing") fs.unlinkSync(blob);
      else if (attack === "hardlink") {
        // Some registered workspaces use filesystems without hardlinks. Inject
        // the same descriptor precondition there, without skipping the guard.
        try { fs.linkSync(blob, path.join(root, "alias")); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOTSUP") throw e;
          const lstat = fs.lstatSync.bind(fs);
          vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
            const stat = (lstat as (...args: unknown[]) => fs.Stats)(file, ...args);
            if (String(file) === blob) stat.nlink = 2;
            return stat;
          }) as typeof fs.lstatSync);
        }
      }
      else { fs.chmodSync(blob, 0o600); fs.writeFileSync(blob, deflateSync(Buffer.from("blob 4\0bad\n"))); }
    } else {
      git(root, "gc", "--prune=now");
      const packDir = path.join(root, ".git/objects/pack");
      const idx = path.join(packDir, fs.readdirSync(packDir).find(n => /^pack-.*\.idx$/.test(n))!);
      write(root, path.relative(root, path.join(packDir, "._" + path.basename(idx))), "not an index");
      if (attack === "index") { fs.chmodSync(idx, 0o600); fs.writeFileSync(idx, "malformed real index"); }
      if (attack === "pack") {
        const file = idx.replace(/\.idx$/, ".pack"), data = fs.readFileSync(file);
        data[data.length - 1] ^= 1; fs.chmodSync(file, 0o600); fs.writeFileSync(file, data);
      }
      if (attack === "index-race") {
        fs.chmodSync(idx, 0o600);
        const open = fs.openSync.bind(fs); let reads = 0;
        vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
          if (String(file) === idx && ++reads === 2) fs.writeFileSync(idx, "changed after search");
          return (open as (...args: unknown[]) => number)(file, ...args);
        }) as typeof fs.openSync);
      }
    }
    write(root, "hello.txt", "changed\n");
    const index = fs.readFileSync(path.join(root, ".git/index"));
    if (attack === "appledouble") {
      expect(gitStatus(root).unstaged.map(e => e.path)).toContain("hello.txt");
      expect(fingerprintWorkspace(new Workspace(root)).changedCount).toBe(1);
    } else expect(() => gitStatus(root)).toThrow("GIT_SNAPSHOT_FAILED");
    expect(fs.readFileSync(path.join(root, ".git/index"))).toEqual(index);
    expect(fs.readdirSync(snapshots).filter(n => !n.startsWith("._"))).toEqual([]);
  } finally { cleanup(root); cleanup(snapshots); }
});
