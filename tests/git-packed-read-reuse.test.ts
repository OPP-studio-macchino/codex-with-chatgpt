import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { gitStatus } from "../src/workspace/git.js";
import { cleanup, git, makeTmpDir, write } from "./helpers.js";

vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawnSync: vi.fn(real.spawnSync) };
});
const real = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync;
afterEach(() => { vi.mocked(spawnSync).mockImplementation(real); vi.clearAllMocks(); });

it.each(["sha1", "sha256"])("verifies each private packed object once using bounded batches (%s, real scoped budget)", format => {
  const root = makeTmpDir("packed-reuse");
  try {
    git(root, "init", "-b", "main", `--object-format=${format}`);
    write(root, "a.txt", "initial\n"); write(root, "nested/b.txt", "other\n");
    git(root, "add", "."); git(root, "commit", "-m", "fixture"); git(root, "gc", "--prune=now");
    write(root, "a.txt", "changed\n");
    vi.mocked(spawnSync).mockClear();
    expect(gitStatus(root, { deadlineNs: process.hrtime.bigint() + 20_000_000_000n }).unstaged.map(e => e.path)).toContain("a.txt");
    const calls = vi.mocked(spawnSync).mock.calls.filter(c => (c[1] as string[]).includes("cat-file"));
    const content = calls.filter(c => (c[1] as string[]).includes("--batch"));
    expect(content.length).toBeLessThan(5);
    expect(calls.every(c => (c[1] as string[]).some(a => a === "--batch" || a === "--batch-check"))).toBe(true);
    const inputs = content.flatMap(c => String((c[2] as { input: string }).input).trim().split("\n"));
    expect(inputs).toHaveLength(5);
    expect(new Set(inputs).size).toBe(inputs.length);
  } finally { cleanup(root); }
});

it.each(["type", "length", "hash"])("rejects malformed reused packed %s and cleans private snapshots (injected response)", attack => {
  const root = makeTmpDir("packed-reuse-invalid"), snapshots = makeTmpDir("packed-reuse-storage");
  try {
    git(root, "init", "-b", "main"); write(root, "a.txt", "first\n"); write(root, "b.txt", "second\n");
    git(root, "add", "."); git(root, "commit", "-m", "fixture"); git(root, "gc", "--prune=now");
    let reads = 0;
    vi.mocked(spawnSync).mockImplementation(((binary: string, args: string[], options: unknown) => {
      const result = real(binary, args, options as never);
      if (args.includes("cat-file") && args.includes("--batch") && ++reads === 2) {
        const output = Buffer.from(result.stdout), end = output.indexOf(10);
        const fields = output.subarray(0, end).toString("ascii").split(" ");
        if (attack === "type") fields[1] = "tree";
        if (attack === "length") fields[2] = String(Number(fields[2]) + 1);
        if (attack === "hash") output[end + 1] ^= 1;
        result.stdout = Buffer.concat([Buffer.from(fields.join(" ") + "\n"), output.subarray(end + 1)]);
      }
      return result;
    }) as typeof spawnSync);
    expect(() => gitStatus(root, { deadlineNs: process.hrtime.bigint() + 20_000_000_000n, snapshotRoot: snapshots })).toThrow("GIT_SNAPSHOT_FAILED");
    expect(reads).toBe(2);
    expect(fs.readdirSync(snapshots).filter(n => !n.startsWith("._"))).toEqual([]);
  } finally { cleanup(root); cleanup(snapshots); }
});
