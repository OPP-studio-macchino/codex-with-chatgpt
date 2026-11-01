import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { runGit } from "../src/workspace/git.js";
import { cleanup, git, makeTmpDir, write } from "./helpers.js";

vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawnSync: vi.fn(real.spawnSync) };
});
const real = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync;
const roots: string[] = [], args = ["ls-files", "--stage", "-z"];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawnSync).mockImplementation(real); vi.clearAllMocks(); roots.splice(0).forEach(cleanup); });
function fixture(count = 4, format = "sha1", bytes = 32) {
  const root = makeTmpDir("packed-batch"), snapshots = makeTmpDir("packed-batch-snapshots"); roots.push(root, snapshots);
  git(root, "init", "-b", "main", `--object-format=${format}`);
  for (let i = 0; i < count; i++) write(root, `file-${String(i).padStart(4, "0")}.txt`, `${i}:` + "x".repeat(bytes));
  git(root, "add", "."); git(root, "commit", "-m", "private packed fixture"); git(root, "gc", "--prune=now");
  const expected = git(root, ...args), oids = expected.split("\0").filter(Boolean).map(row => row.split(" ")[1]!);
  vi.mocked(spawnSync).mockClear();
  return { root, snapshots, expected, oids, budget: { deadlineNs: process.hrtime.bigint() + 20_000_000_000n, snapshotRoot: snapshots } };
}
const contentCalls = () => vi.mocked(spawnSync).mock.calls.filter(c => (c[1] as string[]).includes("--batch"));

it.each(["sha1", "sha256"])("batches only current index blobs in a private pack (%s, real 1000ms budget)", format => {
  const f = fixture(64, format);
  expect(runGit(f.root, args, f.budget)).toMatchObject({ ok: true, stdout: f.expected });
  const calls = contentCalls(); expect(calls).toHaveLength(1);
  expect(String((calls[0]![2] as { input: string }).input).trim().split("\n")).toEqual(f.oids);
  expect((calls[0]![2] as { env: NodeJS.ProcessEnv }).env.GIT_OBJECT_DIRECTORY).toContain(f.snapshots);
  expect(fs.readdirSync(f.snapshots)).toEqual([]);
});

it.each(["oid", "type", "size", "limit", "truncated", "extra"])("rejects malformed packed batch metadata: %s", attack => {
  const f = fixture(); vi.spyOn(performance, "now").mockReturnValue(0);
  vi.mocked(spawnSync).mockImplementation(((binary: string, argv: string[], opts: unknown) => {
    const result = real(binary, argv, opts as never);
    if (argv.includes("--batch-check")) {
      let text = Buffer.from(result.stdout).toString("ascii");
      if (attack === "oid") text = "0".repeat(40) + text.slice(40);
      if (attack === "type") text = text.replace(" blob ", " tree ");
      if (attack === "size") text = text.replace(/ blob \d+/, " blob 01");
      if (attack === "limit") text = text.replace(/ blob \d+/, " blob 8388609");
      if (attack === "truncated") text = text.slice(0, -1);
      if (attack === "extra") text += `${f.oids[0]} blob 1\n`;
      result.stdout = Buffer.from(text);
    }
    return result;
  }) as typeof spawnSync);
  expect(() => runGit(f.root, args, f.budget)).toThrow("invalid_object");
  expect(fs.readdirSync(f.snapshots)).toEqual([]);
});

it.each(["hash", "truncated", "extra"])("verifies batched content including later cached blobs: %s", attack => {
  const f = fixture(); vi.spyOn(performance, "now").mockReturnValue(0);
  let injected = false;
  vi.mocked(spawnSync).mockImplementation(((binary: string, argv: string[], opts: unknown) => {
    const result = real(binary, argv, opts as never);
    if (argv.includes("--batch") && !injected) {
      injected = true; let output = Buffer.from(result.stdout);
      const firstEnd = output.indexOf(10), firstSize = Number(output.subarray(0, firstEnd).toString().split(" ")[2]);
      const secondHeader = firstEnd + firstSize + 2, secondEnd = output.indexOf(10, secondHeader);
      if (attack === "hash") output[secondEnd + 1] ^= 1;
      if (attack === "truncated") output = output.subarray(0, -1);
      if (attack === "extra") output = Buffer.concat([output, Buffer.from("extra")]);
      result.stdout = output;
    }
    return result;
  }) as typeof spawnSync);
  expect(() => runGit(f.root, args, f.budget)).toThrow(attack === "hash" ? "object_hash_mismatch" : "invalid_object");
  expect(injected).toBe(true); expect(fs.readdirSync(f.snapshots)).toEqual([]);
});

it("still checks a newly present corrupt loose object instead of accepting its prefetched packed copy", () => {
  const f = fixture(); vi.spyOn(performance, "now").mockReturnValue(0);
  let changed = false;
  vi.mocked(spawnSync).mockImplementation(((binary: string, argv: string[], opts: unknown) => {
    const result = real(binary, argv, opts as never);
    if (argv.includes("--batch") && !changed) {
      changed = true; const oid = f.oids[1]!, dir = path.join(f.root, ".git/objects", oid.slice(0, 2));
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, oid.slice(2)), deflateSync(Buffer.from("blob 1\0x")));
    }
    return result;
  }) as typeof spawnSync);
  expect(() => runGit(f.root, args, f.budget)).toThrow("object_hash_mismatch");
  expect(changed).toBe(true); expect(fs.readdirSync(f.snapshots)).toEqual([]);
});

it("bounds a batch below the unchanged output limit and still verifies larger aggregate content", () => {
  const f = fixture(3, "sha1", 3 * 1024 * 1024); vi.spyOn(performance, "now").mockReturnValue(0);
  expect(runGit(f.root, args, f.budget)).toMatchObject({ ok: true, stdout: f.expected });
  const calls = contentCalls(); expect(calls).toHaveLength(2);
  expect(calls.map(c => String((c[2] as { input: string }).input).trim().split("\n").length)).toEqual([2, 1]);
  expect(calls.every(c => (c[2] as { maxBuffer: number }).maxBuffer === 16 * 1024 * 1024)).toBe(true);
  expect(fs.readdirSync(f.snapshots)).toEqual([]);
});

it("does not renew the 1000ms acquisition budget after metadata batching", () => {
  const f = fixture(); let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(spawnSync).mockImplementation(((binary: string, argv: string[], opts: unknown) => {
    const result = real(binary, argv, opts as never); if (argv.includes("--batch-check")) now = 1001; return result;
  }) as typeof spawnSync);
  expect(() => runGit(f.root, args, f.budget)).toThrow("budget_exhausted");
  expect(contentCalls()).toHaveLength(0); expect(fs.readdirSync(f.snapshots)).toEqual([]);
});

it("imports another containing pack when a pending index blob is absent from the first private pack", () => {
  const f = fixture();
  write(f.root, "second-pack-a.txt", "new pack a"); write(f.root, "second-pack-b.txt", "new pack b");
  git(f.root, "add", "."); git(f.root, "commit", "-m", "second pack"); git(f.root, "repack", "-d", "-l");
  expect(fs.readdirSync(path.join(f.root, ".git/objects/pack")).filter(p => p.endsWith(".pack"))).toHaveLength(2);
  const expected = git(f.root, ...args); vi.spyOn(performance, "now").mockReturnValue(0);
  expect(runGit(f.root, args, f.budget)).toMatchObject({ ok: true, stdout: expected });
  expect(fs.readdirSync(f.snapshots)).toEqual([]);
});

it("rejects a missing required index object after importing available packed blobs", () => {
  const f = fixture();
  const missing = git(f.root, "hash-object", write(f.root, "missing.txt", "missing blob")).trim();
  git(f.root, "update-index", "--add", "--cacheinfo", `100644,${missing},missing.txt`);
  vi.spyOn(performance, "now").mockReturnValue(0);
  expect(() => runGit(f.root, args, f.budget)).toThrow("object_missing");
  expect(fs.readdirSync(f.snapshots)).toEqual([]);
});
