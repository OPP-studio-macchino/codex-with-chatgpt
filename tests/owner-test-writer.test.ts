import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("checks the fixed receipt writer with Python's standard unittest runner", () => {
  const result = spawnSync("python3", ["tests/test_owner_test_evidence.py"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/Ran 11 tests/);
});
