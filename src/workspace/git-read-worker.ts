import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { z } from "zod/v3";
import { Workspace } from "./manager.js";
import { gitStatus, gitDiff, GitReadError, remainingReconciliationReadMs } from "./git.js";
import { gitReadFailureSchema } from "../execution/reconciliation-processes.js";
import { createGitReadStorage, awaitGitReadCleanup } from "./git-read-storage.js";

const mode = z.enum(["unstaged", "staged", "head"]);
const relativePath = z.string().max(4096).refine(p => !p.includes("\0") && !p.includes("\\") &&
  !path.isAbsolute(p) && !p.split("/").includes("..") && (p === "" || path.posix.normalize(p) === p));
const requestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }).strict(),
  z.object({ op: z.literal("diff"), mode, path: relativePath.optional(),
    offset: z.number().int().min(0).max(16 * 1024 * 1024),
    maxBytes: z.number().int().min(1024).max(262144) }).strict(),
]);
type Request = z.infer<typeof requestSchema>;
const count = z.number().int().nonnegative().safe();
const label = z.string().max(4096);
const entry = z.object({ path: z.string().max(1000), change: z.string().length(1) }).strict();
const statusSchema = z.object({ contentDirty: z.boolean().nullable(), modeOnly: z.array(label).max(500),
  isRepo: z.boolean(), branch: label.nullable(), head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i).nullable(),
  upstream: label.nullable(), ahead: count, behind: count, staged: z.array(entry).max(500), unstaged: z.array(entry).max(500),
  untracked: z.array(z.string().max(1000)).max(500), conflicted: z.array(z.string().max(1000)).max(500),
  redactedPathCount: count, truncated: z.boolean(),
}).strict().refine(v => v.staged.length + v.unstaged.length + v.untracked.length + v.conflicted.length <= 500);
const diffSchema = z.object({ isRepo: z.boolean(), mode, totalBytes: count, offset: count, returnedBytes: count.max(262144),
  hasMore: z.boolean(), nextOffset: count.nullable(), diff: z.string().max(262144), eligibleFileCount: count,
  redactedPathCount: count, redactionCount: count, truncatedByFileLimit: z.boolean(),
}).strict();
const failure = (reason: string) => new GitReadError("GIT_READ_FAILED", "scope", reason, 1000);

/** Called only after MCP scope/target/path authorization; never accepts commands or module paths. */
export function readGitInWorker(root: string, request: Request, signal?: AbortSignal): Promise<z.infer<typeof statusSchema> | z.infer<typeof diffSchema>> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success || typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0"))
    return Promise.reject(failure("invalid_path"));
  if (signal?.aborted) return Promise.reject(failure("cancelled"));
  const deadlineNs = process.hrtime.bigint() + 20_000_000_000n;
  return new Promise((resolve, reject) => {
    let storage: ReturnType<typeof createGitReadStorage>;
    try { storage = createGitReadStorage(); } catch { reject(failure("unavailable")); return; }
    let worker: Worker;
    try { worker = new Worker(new URL("./git-read-worker.js", import.meta.url), {
      workerData: { kind: "c2c-git-read", root, request: parsed.data, deadlineNs, snapshotRoot: storage.root },
    }); } catch { void storage.dispose().catch(() => {}); reject(failure("unavailable")); return; }
    let settled = false;
    const finish = (error?: GitReadError, value?: z.infer<typeof statusSchema> | z.infer<typeof diffSchema>) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      // Native spawnSync must return/reap its owned child before the thread exits.
      // Do not remove its private files while the thread can still use them.
      const cleaned = worker.terminate().then(() => storage.dispose());
      if (error) { void cleaned.catch(() => {}); reject(error); }
      else void awaitGitReadCleanup(cleaned, deadlineNs, signal).then(() => resolve(value!),
        error => reject(failure(error.message)));
    };
    const abort = () => finish(failure("cancelled"));
    const timer = setTimeout(() => finish(failure("budget_exhausted")),
      Math.max(1, Math.floor(Number(deadlineNs - process.hrtime.bigint()) / 1e6)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.on("error", () => finish(failure("unavailable")));
    worker.on("exit", () => finish(failure("unavailable")));
    worker.on("message", (message: unknown) => {
      if (settled) return;
      if (process.hrtime.bigint() >= deadlineNs) { finish(failure("budget_exhausted")); return; }
      const error = z.object({ ok: z.literal(false), error: gitReadFailureSchema }).strict().safeParse(message);
      if (error.success) {
        const e = error.data.error; finish(new GitReadError(e.code, e.stage, e.reason, 1000)); return;
      }
      const result = z.object({ ok: z.literal(true), result: parsed.data.op === "status" ? statusSchema : diffSchema }).strict().safeParse(message);
      if (!result.success) { finish(failure("unverified")); return; }
      if (parsed.data.op === "diff" && "diff" in result.data.result &&
        (result.data.result.mode !== parsed.data.mode || result.data.result.returnedBytes > parsed.data.maxBytes)) {
        finish(failure("unverified")); return;
      }
      if (process.hrtime.bigint() >= deadlineNs) { finish(failure("budget_exhausted")); return; }
      finish(undefined, result.data.result);
    });
  });
}

if (!isMainThread && workerData?.kind === "c2c-git-read") {
  try {
    const data = z.object({ kind: z.literal("c2c-git-read"), root: z.string().max(32768), request: requestSchema, deadlineNs: z.bigint(), snapshotRoot: z.string().max(32768) }).strict().parse(workerData);
    const budget = { deadlineNs: data.deadlineNs, snapshotRoot: data.snapshotRoot };
    remainingReconciliationReadMs(budget);
    const workspace = new Workspace(data.root);
    if (workspace.root !== data.root) throw failure("identity_changed");
    const before = fs.statSync(workspace.root);
    const request = data.request;
    const rel = request.op === "diff" && request.path !== undefined ? workspace.resolve(request.path).rel : undefined;
    if (request.op === "diff" && rel !== request.path) throw failure("invalid_path");
    remainingReconciliationReadMs(budget);
    const result = request.op === "status" ? gitStatus(workspace.root, budget)
      : gitDiff(workspace.root, request, rel, budget);
    const after = fs.statSync(workspace.root);
    if (before.dev !== after.dev || before.ino !== after.ino || fs.realpathSync.native(workspace.root) !== workspace.root)
      throw failure("identity_changed");
    remainingReconciliationReadMs(budget);
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    const safe = error instanceof GitReadError ? gitReadFailureSchema.safeParse({ code: error.code,
      stage: error.stage, reason: error.reason, limits: { ...error.details().limits, snapshot_ms: 1000 } }) : undefined;
    const fallback = failure("unverified");
    parentPort?.postMessage({ ok: false, error: safe?.success ? safe.data : {
      code: fallback.code, stage: fallback.stage, reason: fallback.reason, limits: fallback.details().limits,
    } });
  }
}
