import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { inspectForReconciliation } from "../src/execution/reconciliation-evidence.js";
import { compareProcessSnapshots, incompleteProcessEvidence, gitReadFailureSchema, processEvidenceSchema } from "../src/execution/reconciliation-processes.js";
import { GitReadError } from "../src/workspace/git.js";
import type { Workspace } from "../src/workspace/manager.js";

const state = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn>; options: any }> }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { isMainThread: true, workerData: undefined, parentPort: null, Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(_url: URL, readonly options: any) { super(); state.workers.push(this); }
  } };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); state.workers.length = 0; });
function pending() {
  const snapshot = { rows: [{ pid: 12, ppid: 0, uid: 501, state: "S", executable: "/bin/node",
    process_start_time: "2026-10-06T00:00:00.000Z" }], cwds: new Map([[12, "/fixture"]]), observed_at: "2026-10-07T00:00:00.000Z" };
  const processes = compareProcessSnapshots({ root: "/fixture" }, snapshot, snapshot, 501);
  const controller = new AbortController();
  const promise = inspectForReconciliation({ root: "/fixture" } as Workspace, controller.signal);
  return { processes, promise, worker: state.workers.at(-1)!, controller };
}
it("passes one parent monotonic deadline and rejects success after it even before the timer runs (mock Worker)", async () => {
  let now = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const s = pending();
  expect(s.worker.options.workerData.deadlineNs).toBe(20_000_000_000n);
  const rejected = expect(s.promise).rejects.toMatchObject({ code: "RECONCILIATION_INSPECTION_TIMEOUT" });
  now = 20_000_000_001n;
  const snapshot = { rows: [], cwds: new Map<number, string>(), observed_at: "2026-10-07T00:00:00.000Z" };
  const quiet = compareProcessSnapshots({ root: "/fixture" }, snapshot, snapshot, 501);
  s.worker.emit("message", { ok: true, processes: quiet, evidence: {} });
  await rejected;
  expect(s.worker.terminate).toHaveBeenCalledOnce();
});
it("preserves exact PROCESS_PRESENT and safe metadata through the worker message boundary", async () => {
  const s = pending();
  s.worker.emit("message", { ok: false, code: "RECONCILIATION_PROCESS_PRESENT", processes: s.processes, argv: "discard" });
  await expect(s.promise).rejects.toMatchObject({ code: "RECONCILIATION_PROCESS_PRESENT", details: s.processes });
});
it.each(["error", "exit", "timeout", "cancel"])("retains last bounded evidence and UNKNOWN on worker %s", async kind => {
  vi.useFakeTimers();
  const s = pending();
  const rejected = expect(s.promise).rejects.toMatchObject({ details: { candidates: s.processes.candidates,
    quiescence: "UNKNOWN", observed_at: s.processes.observed_at } });
  s.worker.emit("message", { progress: true, processes: s.processes });
  if (kind === "timeout") await vi.advanceTimersByTimeAsync(20000);
  else if (kind === "cancel") s.controller.abort();
  else s.worker.emit(kind, kind === "error" ? new Error("sensitive host details") : 1);
  await rejected;
});
it("unknown error strings and unsafe details cannot cross into durable evidence", async () => {
  const s = pending();
  s.worker.emit("message", { ok: false, code: "RECONCILIATION_" + "SECRET".repeat(1000), processes: { ...s.processes, environment: "secret" } });
  await expect(s.promise).rejects.toMatchObject({ code: "RECONCILIATION_FAILED", details: undefined });
});
it.each(["error", "exit", "timeout", "cancel"])("does not throw from a worker %s callback after a successful resample", async kind => {
  vi.useFakeTimers();
  const s = pending();
  const empty = { rows: [], cwds: new Map<number, string>(), observed_at: "2026-10-07T00:00:00.000Z" };
  const appeared = { ...empty, rows: [{ pid: 42, ppid: 0, uid: 501, state: "S", executable: "/bin/node",
    process_start_time: "2026-10-06T00:00:00.000Z" }], cwds: new Map([[42, "/outside"]]) };
  const initial = compareProcessSnapshots({ root: "/fixture" }, empty, appeared, 501);
  const { evidence_hash: _hash, ...body } = compareProcessSnapshots({ root: "/fixture" }, appeared, appeared, 501);
  const value = { ...body, observation_retry: { attempts: 2 as const, initial_evidence_hash: initial.evidence_hash,
    initial_observed_at: initial.observed_at, initial_diagnostics: initial.snapshot_diagnostics! } };
  const quiet = processEvidenceSchema.parse({ ...value, evidence_hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") });
  const rejected = expect(s.promise).rejects.toMatchObject({ details: { quiescence: "UNKNOWN", observation_retry: quiet.observation_retry } });
  s.worker.emit("message", { progress: true, processes: quiet });
  if (kind === "timeout") await vi.advanceTimersByTimeAsync(20000);
  else if (kind === "cancel") s.controller.abort();
  else s.worker.emit(kind, kind === "error" ? new Error("worker failed") : 1);
  await rejected;
  expect(s.worker.terminate).toHaveBeenCalledOnce();
});
it("a malformed final success cannot borrow quiescent evidence from a progress message", async () => {
  const s = pending();
  const empty = { rows: [], cwds: new Map<number, string>(), observed_at: "2026-10-07T00:00:00.000Z" };
  const quiet = compareProcessSnapshots({ root: "/fixture" }, empty, empty, 501);
  s.worker.emit("message", { progress: true, processes: quiet });
  s.worker.emit("message", { ok: true, processes: { ...quiet, argv: "unsafe" }, evidence: {} });
  await expect(s.promise).rejects.toMatchObject({ code: "RECONCILIATION_EVIDENCE_INVALID" });
});

it("publishes latest abort evidence synchronously before promise catch and ignores late messages", async () => {
  const observe = vi.fn();
  const controller = new AbortController();
  const promise = inspectForReconciliation({ root: "/fixture" } as Workspace, controller.signal, undefined, observe);
  const worker = state.workers.at(-1)!;
  const rows = [{ pid: 12, ppid: 0, uid: 501, state: "S", executable: "/bin/node", process_start_time: "2026-10-06T00:00:00.000Z" }];
  const snapshot = { rows, cwds: new Map([[12, "/fixture"]]), observed_at: "2026-10-07T00:00:00.000Z" };
  const processes = compareProcessSnapshots({ root: "/fixture" }, snapshot, snapshot, 501);
  worker.emit("message", { progress: true, processes });
  controller.abort();
  expect(observe.mock.lastCall?.[0]).toMatchObject({ candidate_count: 1, quiescence: "UNKNOWN", code: "RECONCILIATION_CANCELLED" });
  const count = observe.mock.calls.length;
  worker.emit("message", { progress: true, processes });
  expect(observe).toHaveBeenCalledTimes(count);
  await expect(promise).rejects.toMatchObject({ details: observe.mock.lastCall![0] });
});

it("a failed fingerprint cannot retain prior QUIESCENT as its current observation", async () => {
  const s = pending();
  const empty = { rows: [], cwds: new Map<number, string>(), observed_at: "2026-10-07T00:00:00.000Z" };
  const quiet = compareProcessSnapshots({ root: "/fixture" }, empty, empty, 501);
  s.worker.emit("message", { progress: true, processes: quiet });
  s.worker.emit("message", { ok: false, code: "RECONCILIATION_GIT_UNVERIFIED", processes: quiet });
  await expect(s.promise).rejects.toMatchObject({ code: "RECONCILIATION_GIT_UNVERIFIED",
    details: { quiescence: "UNKNOWN", observed_at: quiet.observed_at } });
});

it("retains a closed actionable Git cause across worker failure without granting quiescence", async () => {
  const s = pending();
  const error = new GitReadError("GIT_SNAPSHOT_FAILED", "objects", "budget_exhausted");
  const cause = gitReadFailureSchema.parse({ code: error.code, stage: error.stage, reason: error.reason, limits: error.details().limits });
  const processes = incompleteProcessEvidence(s.processes, "RECONCILIATION_GIT_UNVERIFIED", cause);
  s.worker.emit("message", { ok: false, code: "RECONCILIATION_GIT_UNVERIFIED", processes });
  await expect(s.promise).rejects.toMatchObject({ code: "RECONCILIATION_GIT_UNVERIFIED", details: {
    quiescence: "UNKNOWN", coverage: "INCOMPLETE", git_failure: cause,
  } });
  expect(gitReadFailureSchema.safeParse({ ...cause, stderr: "private host details" }).success).toBe(false);
  expect(gitReadFailureSchema.safeParse({ ...cause, reason: "/private/path" }).success).toBe(false);
  expect(processEvidenceSchema.safeParse({ ...processes, quiescence: "QUIESCENT" }).success).toBe(false);
  const empty = { rows: [], cwds: new Map<number, string>(), observed_at: "2026-10-07T00:00:00.000Z" };
  const { evidence_hash: _hash, ...quiet } = compareProcessSnapshots({ root: "/fixture" }, empty, empty, 501);
  const unsafe = { ...quiet, git_failure: cause };
  expect(processEvidenceSchema.safeParse({ ...unsafe,
    evidence_hash: createHash("sha256").update(JSON.stringify(unsafe)).digest("hex"),
  }).success).toBe(false);
});
