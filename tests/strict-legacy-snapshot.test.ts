import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { readLegacySnapshot } from "../src/execution/records.js";
const id = "a".repeat(24);
const record = { taskId: "same", iteration: 1, changedFiles: null, tests: null, exitStatus: "ok", timestamp: "2026-09-30T00:00:00Z" };
afterEach(() => vi.restoreAllMocks());
function storage(raw: string, mode = "ok") {
  const bytes = Buffer.from(raw);
  const stat = { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => mode === "symlink", nlink: mode === "hardlink" ? 2 : 1,
    mode: mode === "public" ? 0o644 : 0o600, uid: process.getuid?.() ?? 0, ino: 1, dev: 1, size: mode === "oversize" ? 4194305 : bytes.length, mtimeMs: 1, ctimeMs: 1 };
  vi.spyOn(fs, "lstatSync").mockImplementation(() => { if (mode === "absent") throw Object.assign(new Error("absent"), { code: "ENOENT" }); return stat as never; });
  let stats = 0, position = 0;
  vi.spyOn(fs, "fstatSync").mockImplementation(() => ({ ...stat, mtimeMs: mode === "mutation" && stats++ > 0 ? 2 : 1 }) as never);
  vi.spyOn(fs, "openSync").mockReturnValue(99);
  vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer, offset, length) => {
    const count = mode === "short" ? 0 : Math.min(length as number, bytes.length - position);
    bytes.copy(buffer as Buffer, offset as number, position, position + count); position += count; return count;
  });
  return vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("no writes"); });
}
it("freezes a complete descriptor-bound source without writes", () => {
  const writes = storage(JSON.stringify(record) + "\n");
  const result = readLegacySnapshot(id, "same");
  expect(result.records).toEqual([record]); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/); expect(writes).not.toHaveBeenCalled();
});
it.each(["absent", "mutation", "short", "oversize", "symlink", "hardlink", "public"])("refuses unsafe/incomplete source %s", mode => {
  storage(JSON.stringify(record), mode); expect(() => readLegacySnapshot(id, "same")).toThrow();
});
it.each(["malformed", "unknown", "rows", "wrong_task", "wrong_workspace", "wrong_run"])("refuses invalid records %s", mode => {
  const raw = mode === "malformed" ? JSON.stringify(record) + "\n{" : mode === "rows" ? Array(101).fill(JSON.stringify(record)).join("\n") :
    JSON.stringify({ ...record, ...(mode === "unknown" ? { unexpected: true } : {}), ...(mode === "wrong_run" ? { runId: "bad" } : {}) });
  storage(raw); expect(() => readLegacySnapshot(mode === "wrong_workspace" ? "../bad" : id, mode === "wrong_task" ? "absent" : "same")).toThrow();
});

it("accepts legitimate explicit-test rows and unrelated writer iterations without extra executions", () => {
  const runId = "a".repeat(32);
  storage([record, { ...record, runId }, { ...record, runId, tests: "PASS", notes: "explicit test report" },
    { ...record, taskId: "other", iteration: 9999 }, { ...record, taskId: "other", iteration: 9999 },
    { ...record, taskId: "other", iteration: 0 }].map(r => JSON.stringify(r)).join("\n"));
  expect(readLegacySnapshot(id, "same").records).toEqual([{ ...record, runId }]);
});

it.each(["conflicting_iteration", "reused_run", "selected_zero", "selected_unsafe"])("rejects selected execution ambiguity %s", mode => {
  const first = { ...record, runId: "a".repeat(32) };
  const second = { ...first, ...(mode === "conflicting_iteration" ? { runId: "b".repeat(32) } :
    { iteration: mode === "selected_zero" ? 0 : mode === "selected_unsafe" ? Number.MAX_SAFE_INTEGER + 1 : 2 }) };
  storage([first, second].map(r => JSON.stringify(r)).join("\n"));
  expect(() => readLegacySnapshot(id, "same")).toThrow();
});


it.each([13, 10001, Number.MAX_SAFE_INTEGER])("reads high iteration %s without rewriting evidence", iteration => {
  const high = { ...record, iteration };
  const writes = storage(JSON.stringify(high) + "\n");
  expect(readLegacySnapshot(id, "same").records).toEqual([high]);
  expect(writes).not.toHaveBeenCalled();
});
