import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("read-only startup consistency checker", () => {
  it("passes the standalone Python regression suite", () => {
    const r = spawnSync("python3", ["-B", "scripts/test-startup-consistency.py"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: path.join(process.cwd(), ".tooling") },
    });
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
