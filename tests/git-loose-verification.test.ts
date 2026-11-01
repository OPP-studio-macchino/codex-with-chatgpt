import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { runGit } from "../src/workspace/git.js";
import { makeTmpDir, makeGitRepo, git, write, cleanup } from "./helpers.js";

// Real installed Git and real private copying; only record subprocess calls.
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawnSync: vi.fn(real.spawnSync) };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(cleanup); });
function fixture() {
  const root = makeTmpDir("loose-verification"); roots.push(root); makeGitRepo(root);
  const oid = git(root, "rev-parse", "HEAD:hello.txt").trim();
  const source = path.join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
  // Only our disposable object is writable so corruption fixtures can run on APFS.
  fs.chmodSync(source, 0o600);
  return { root, oid, source };
}
const indexArgs = ["ls-files", "--stage", "-z"];

it("verifies many real loose objects without per-object Git startups (simulated clock, actual process count)", () => {
  const { root } = fixture();
  for (let i = 0; i < 24; i++) write(root, `file-${i}`, `unique content ${i}\n`);
  git(root, "add", ".");
  const expected = git(root, ...indexArgs);
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.mocked(spawnSync).mockClear();
  expect(runGit(root, indexArgs)).toMatchObject({ ok: true, stdout: expected });
  const commands = vi.mocked(spawnSync).mock.calls.map(call => call[1] as string[]);
  expect(commands.filter(args => args.includes("cat-file"))).toHaveLength(0);
  expect(commands.filter(args => args.includes("ls-files"))).toHaveLength(2);
});

it.each([
  ["type", Buffer.from("tree 1\0x"), "invalid_object"],
  ["length", Buffer.from("blob 2\0x"), "invalid_object"],
  ["extra-header", Buffer.from("blob 1 ignored\0x"), "invalid_object"],
  ["noncanonical-length", Buffer.from("blob 01\0x"), "invalid_object"],
  ["missing-nul", Buffer.from("blob 1x"), "invalid_object"],
  ["oversized-header", Buffer.concat([Buffer.alloc(1024 * 1024, 32), Buffer.from("\0")]), "invalid_object"],
  ["hash", Buffer.from("blob 1\0x"), "object_hash_mismatch"],
  ["inflation-limit", Buffer.alloc(8 * 1024 * 1024 + 129), "invalid_object"],
] as const)("rejects real loose %s corruption before returning index evidence (simulated clock)", (_name, raw, reason) => {
  const { root, source } = fixture();
  fs.writeFileSync(source, deflateSync(raw));
  vi.spyOn(performance, "now").mockReturnValue(0);
  expect(() => runGit(root, indexArgs)).toThrow(`GIT_SNAPSHOT_FAILED: scoped_objects: ${reason}`);
});

it.each(["missing", "broken-zlib"])("rejects %s required loose object (simulated clock)", kind => {
  const { root, source } = fixture();
  if (kind === "missing") fs.unlinkSync(source); else fs.writeFileSync(source, "invalid zlib");
  vi.spyOn(performance, "now").mockReturnValue(0);
  expect(() => runGit(root, indexArgs)).toThrow(`GIT_SNAPSHOT_FAILED: scoped_objects: ${kind === "missing" ? "object_missing" : "invalid_object"}`);
});

it("decodes the private copy even if the original changes after copying (simulated clock)", () => {
  const { root, source, oid } = fixture();
  const expected = git(root, ...indexArgs), open = fs.openSync.bind(fs);
  let changed = false;
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (!changed && String(file).includes("c2c-git-snapshot-") && String(file).endsWith(oid.slice(2)) && args[0] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) {
      changed = true; fs.writeFileSync(source, deflateSync(Buffer.from("blob 1\0x")));
    }
    return (open as (...args: unknown[]) => number)(file, ...args);
  }) as typeof fs.openSync);
  expect(runGit(root, indexArgs)).toMatchObject({ ok: true, stdout: expected });
  expect(changed).toBe(true);
  expect(() => runGit(root, indexArgs)).toThrow("object_hash_mismatch");
});

it("checks the unchanged deadline after private loose decoding (simulated expiry)", () => {
  const { root, oid } = fixture(), open = fs.openSync.bind(fs);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).includes("c2c-git-snapshot-") && String(file).endsWith(oid.slice(2)) && args[0] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) now = 10001;
    return (open as (...args: unknown[]) => number)(file, ...args);
  }) as typeof fs.openSync);
  expect(() => runGit(root, indexArgs)).toThrow("GIT_SNAPSHOT_FAILED: scoped_objects: budget_exhausted");
});

it.each(["sha1", "sha256"])("preserves real %s loose and packed verification (simulated clock)", format => {
  const root = makeTmpDir("object-format-verification"); roots.push(root);
  git(root, "init", "-b", "main", `--object-format=${format}`);
  write(root, "hello.txt", "verified object format\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  const expected = git(root, ...indexArgs);
  vi.spyOn(performance, "now").mockReturnValue(0);
  expect(runGit(root, indexArgs)).toMatchObject({ ok: true, stdout: expected });
  git(root, "gc", "--prune=now");
  expect(runGit(root, indexArgs)).toMatchObject({ ok: true, stdout: expected });
});
