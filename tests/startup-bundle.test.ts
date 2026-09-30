import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("manifest-bound startup preparation", () => {
  it("passes fixture-only bundle generation and verification regressions", () => {
    const result = spawnSync("python3", ["-B", "scripts/test-startup-bundle.py"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
