import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { readGitInWorker } from "../src/workspace/git-read-worker.js";
const state = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { options: any; terminate: ReturnType<typeof vi.fn> }> }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { isMainThread: true, parentPort: null, workerData: undefined, Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(_url: URL, readonly options: any) { super(); state.workers.push(this); }
  } };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); state.workers.length = 0; });
const status = { isRepo: false, contentDirty: null, modeOnly: [], branch: null, head: null, upstream: null,
  ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], redactedPathCount: 0, truncated: false };
it("passes only fixed operation and one parent deadline; accepts bounded status (mock Worker)", async () => {
  vi.spyOn(process.hrtime, "bigint").mockReturnValue(10n);
  const promise = readGitInWorker("/fixture", { op: "status" }); const worker = state.workers[0];
  expect(worker.options.workerData).toEqual({ kind: "c2c-git-read", root: "/fixture", request: { op: "status" }, deadlineNs: 20_000_000_010n, snapshotRoot: expect.any(String) });
  worker.emit("message", { ok: true, result: status }); await expect(promise).resolves.toEqual(status);
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it.each([
  { op: "shell", command: "git status" }, { op: "status", args: [] },
  { op: "diff", mode: "bad", offset: 0, maxBytes: 1024 },
  { op: "diff", mode: "head", offset: -1, maxBytes: 1024 },
  { op: "diff", mode: "head", offset: 0, maxBytes: Infinity },
  ...["../escape", "/outside", "a/../../escape", "a\\..\\escape", "a\0b"].map(path => ({ op: "diff", mode: "head", offset: 0, maxBytes: 1024, path })),
])("rejects malformed operation/arguments without starting a worker: %j", async request => {
  await expect(readGitInWorker("/fixture", request as any)).rejects.toThrow("invalid_path");
  expect(state.workers).toHaveLength(0);
});
it.each(["cancel", "timeout", "error", "exit"])("rejects %s and ignores late success (mock Worker)", async kind => {
  vi.useFakeTimers(); const controller = new AbortController();
  const promise = readGitInWorker("/fixture", { op: "status" }, controller.signal);
  const rejected = expect(promise).rejects.toThrow("GIT_READ_FAILED"); const worker = state.workers[0];
  if (kind === "cancel") controller.abort();
  else if (kind === "timeout") await vi.advanceTimersByTimeAsync(20000);
  else worker.emit(kind, kind === "error" ? new Error("SECRET host path") : 1);
  worker.emit("message", { ok: true, result: status }); await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("refuses pre-abort without a worker", async () => {
  const c = new AbortController(); c.abort();
  await expect(readGitInWorker("/fixture", { op: "status" }, c.signal)).rejects.toThrow("cancelled");
  expect(state.workers).toHaveLength(0);
});
it("rejects late success against monotonic time before timer delivery (simulated clock)", async () => {
  let now = 0n; vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const promise = readGitInWorker("/fixture", { op: "status" }); now = 20_000_000_000n;
  state.workers[0].emit("message", { ok: true, result: status });
  await expect(promise).rejects.toThrow("budget_exhausted");
});
it.each([{ ok: true, result: {} }, { ok: true, result: { ...status, secret: "SECRET" } },
  { ok: false, error: { message: "SECRET" } }])("rejects malformed worker output without echoing it", async message => {
  const promise = readGitInWorker("/fixture", { op: "status" }); state.workers[0].emit("message", message);
  await expect(promise).rejects.toThrow("GIT_READ_FAILED: scope: unverified");
});
