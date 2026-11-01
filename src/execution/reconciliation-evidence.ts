import { redactAndTruncate } from "../security/redaction.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { Workspace } from "../workspace/manager.js";
import { readReconciliationGitState, runGit, gitRepositoryIdentity, GitReadError, remainingReconciliationReadMs, type ReconciliationReadBudget } from "../workspace/git.js";
import { createGitReadStorage, awaitGitReadCleanup } from "../workspace/git-read-storage.js";
import { TaskJournalError } from "./task-journal.js";
import { scanReconciliationProcesses, processEvidenceSchema, gitReadFailureSchema, incompleteProcessEvidence, reconciliationCode, type ProcessEvidence, type DiagnosticContext } from "./reconciliation-processes.js";
export { parseCwdRecords, parseSingleCwdRecord, isConfirmedZombieState } from "./reconciliation-processes.js";
import type { ReconciliationEvidence } from "./task-reconciler.js";

function fail(code: string): never { throw new TaskJournalError(code, code.replaceAll("_", " ")); }
function hash(s: string): string { return createHash("sha256").update(s).digest("hex"); }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function checkedGit(root: string, args: string[], budget?: ReconciliationReadBudget): string {
  const result = runGit(root, args, budget);
  if (!result.ok || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) fail("RECONCILIATION_GIT_UNVERIFIED");
  return result.stdout;
}

/** Binds HEAD/index plus the complete content-dirty/untracked worktree. Clean tracked files are represented by index + status. */
export function fingerprintWorkspace(workspace: Workspace, budget?: ReconciliationReadBudget): Omit<ReconciliationEvidence, "processScope"> {
  const check = () => { if (budget !== undefined) remainingReconciliationReadMs(budget); };
  check();
  const root = workspace.root;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync.native(root) !== root) fail("RECONCILIATION_ROOT_CHANGED");
  const { head, branch, status: fullStatus, index } = readReconciliationGitState(root, budget);
  const repository = gitRepositoryIdentity(root);
  check();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(head)) fail("RECONCILIATION_GIT_HEAD_UNVERIFIED");
  const statusArgs = ["-c", "core.filemode=false", "status", "--porcelain=v2", "--no-renames", "--ignore-submodules=all", "--untracked-files=all", "-z", "--", "."];
  if (fullStatus && !fullStatus.endsWith("\0")) fail("RECONCILIATION_STATUS_FORMAT_UNVERIFIED");
  const names = new Set<string>();
  const statusEvidence: string[] = [];
  let changedCount = 0;
  let staged = false;
  for (const record of fullStatus.split("\0")) {
    check();
    if (!record) continue;
    if (record.startsWith("u ")) fail("RECONCILIATION_CONFLICT_PRESENT");
    let name: string | null = null;
    let untracked = false;
    if (record.startsWith("? ")) {
      name = record.slice(2);
      untracked = true;
    } else if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      if (parts[1]?.[0] !== ".") staged = true;
      if (parts.length < 9) fail("RECONCILIATION_STATUS_FORMAT_UNVERIFIED");
      name = parts.slice(8).join(" ");
    } else {
      fail("RECONCILIATION_STATUS_FORMAT_UNVERIFIED");
    }
    if (!name || name.length > 4096 || /[\u0000-\u001f\u007f]/.test(name)) fail("RECONCILIATION_PATH_UNVERIFIED");
    if (untracked && path.basename(name).startsWith("._")) continue;
    if (workspace.ignoreRules.isSensitive(name)) fail("RECONCILIATION_PATH_POLICY_BLOCKED");
    // A path may legitimately appear twice when the index records a deletion
    // while a new untracked file exists at the same worktree path. Keep both
    // status records in evidence, but hash the current worktree path only once.
    names.add(name);
    statusEvidence.push(record);
    if (++changedCount > 2000) fail("RECONCILIATION_DIRTY_SCOPE_LIMIT");
  }
  if (index.split("\0").some(l => l.startsWith("160000 "))) fail("RECONCILIATION_SUBMODULE_UNSUPPORTED");
  const entries: unknown[] = [];
  let total = 0;
  for (const name of [...names].sort()) {
    check();
    let abs: string;
    try { abs = workspace.resolve(name).abs; } catch { fail("RECONCILIATION_PATH_POLICY_BLOCKED"); }
    const lexical = path.join(root, name);
    if (!inside(root, lexical)) fail("RECONCILIATION_PATH_UNVERIFIED");
    let stat: fs.Stats;
    try { stat = fs.lstatSync(lexical); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") fail("RECONCILIATION_FILE_UNVERIFIED");
      entries.push([name, "deleted"]); continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("RECONCILIATION_FILE_UNVERIFIED");
    if (stat.size > 8 * 1024 * 1024) fail("RECONCILIATION_FILE_SCOPE_LIMIT");
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) fail("RECONCILIATION_EVIDENCE_CHANGED");
      const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      for (;;) {
        check();
        const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
        check();
        bytes += n; total += n;
        if (bytes > 8 * 1024 * 1024) fail("RECONCILIATION_FILE_SCOPE_LIMIT");
        if (total > 64 * 1024 * 1024) fail("RECONCILIATION_DIRTY_BYTES_LIMIT");
        digest.update(buffer.subarray(0, n));
      }
      const after = fs.fstatSync(fd), current = fs.lstatSync(lexical);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytes || after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev ||
          current.isSymbolicLink() || fs.realpathSync.native(lexical) !== abs) fail("RECONCILIATION_EVIDENCE_CHANGED");
      entries.push([name, before.mode, before.size, digest.digest("hex")]);
    } finally { fs.closeSync(fd); }
  }
  const end = fs.lstatSync(root);
  check();
  // Keep final reads independent and ordered: each must observe changes during the preceding acquisition.
  if (end.ino !== rootStat.ino || end.dev !== rootStat.dev || fs.realpathSync.native(root) !== root ||
      index !== checkedGit(root, ["ls-files", "--stage", "-z"], budget) ||
      fullStatus !== checkedGit(root, statusArgs, budget) ||
      checkedGit(root, ["rev-parse", "HEAD"], budget).trim() !== head ||
      checkedGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], budget).trim() !== branch ||
      gitRepositoryIdentity(root) !== repository) fail("RECONCILIATION_EVIDENCE_CHANGED");
  check();
  const evidence: Omit<ReconciliationEvidence, "processScope"> = {
    digest: hash(JSON.stringify({ root: [rootStat.dev, rootStat.ino, rootStat.mode], repository, branch, head, index: hash(index), status: hash(statusEvidence.join("\0")), entries })),
    head, fileCount: entries.length, changedCount,
    branch: redactAndTruncate(branch.replace(/[\p{Cc}\p{Cf}]/gu, "�"), 200).text, staged,
    fileScope: "git-index-status-and-dirty-worktree-excluding-appledouble",
  };
  check();
  return evidence;
}

/** Heavy Git/file/process inspection never holds the bridge's event loop. */
export function inspectForReconciliation(workspace: Workspace, signal: AbortSignal, historical?: DiagnosticContext["historical"], onObservation?: (processes: ProcessEvidence) => void): Promise<ReconciliationEvidence> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new TaskJournalError("RECONCILIATION_CANCELLED", "Inspection cancelled")); return; }
    const deadlineNs = process.hrtime.bigint() + 20_000_000_000n;
    let storage: ReturnType<typeof createGitReadStorage>;
    try { storage = createGitReadStorage(); } catch { reject(new TaskJournalError("RECONCILIATION_INSPECTION_FAILED", "Inspection unavailable")); return; }
    let worker: Worker;
    try { worker = new Worker(new URL("./reconciliation-evidence.js", import.meta.url), {
      workerData: { kind: "c2c-reconciliation", root: workspace.root, historical, deadlineNs, snapshotRoot: storage.root }, resourceLimits: { maxOldGenerationSizeMb: 128 },
    }); } catch { void storage.dispose().catch(() => {}); reject(new TaskJournalError("RECONCILIATION_INSPECTION_FAILED", "Inspection unavailable")); return; }
    let settled = false;
    let processes: ProcessEvidence | undefined;
    const finish = (error?: Error, evidence?: ReconciliationEvidence): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error && processes && !(reconciliationCode((error as TaskJournalError).code) === "RECONCILIATION_PROCESS_PRESENT" && processes.quiescence === "NON_QUIESCENT")) {
        processes = incompleteProcessEvidence(processes, reconciliationCode((error as TaskJournalError).code));
      }
      if (processes) onObservation?.(processes);
      const cleaned = worker.terminate().then(() => storage.dispose());
      if (error) { void cleaned.catch(() => {}); reject(new TaskJournalError(reconciliationCode((error as TaskJournalError).code), "Inspection blocked", processes)); }
      else void awaitGitReadCleanup(cleaned, deadlineNs, signal).then(() => resolve(evidence!), error => {
        const code = error.message === "cancelled" ? "RECONCILIATION_CANCELLED" : error.message === "budget_exhausted"
          ? "RECONCILIATION_INSPECTION_TIMEOUT" : "RECONCILIATION_INSPECTION_FAILED";
        if (processes) { processes = incompleteProcessEvidence(processes, code); onObservation?.(processes); }
        reject(new TaskJournalError(code, "Inspection cleanup unavailable", processes));
      });
    };
    const unavailable = (code: string): void => {
      if (processes) processes = incompleteProcessEvidence(processes, reconciliationCode(code));
      finish(new TaskJournalError(code, "Inspection unavailable"));
    };
    const abort = (): void => unavailable("RECONCILIATION_CANCELLED");
    const timer = setTimeout(() => unavailable("RECONCILIATION_INSPECTION_TIMEOUT"),
      Math.max(1, Math.floor(Number(deadlineNs - process.hrtime.bigint()) / 1e6)));
    timer.unref(); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    worker.on("message", (message) => {
      if (settled) return;
      if (process.hrtime.bigint() >= deadlineNs) { unavailable("RECONCILIATION_INSPECTION_TIMEOUT"); return; }
      const parsed = processEvidenceSchema.safeParse(message?.processes);
      if (parsed.success) { processes = parsed.data; onObservation?.(processes); }
      if (message?.progress === true) return;
      if (message?.ok === true && parsed.success && parsed.data.quiescence === "QUIESCENT") finish(undefined, { ...message.evidence, processes: parsed.data });
      else finish(new TaskJournalError(message?.ok === true ? "RECONCILIATION_EVIDENCE_INVALID" : reconciliationCode(message?.code), "Inspection blocked"));
    });
    worker.once("error", () => unavailable("RECONCILIATION_INSPECTION_FAILED"));
    worker.once("exit", () => { if (!settled) unavailable("RECONCILIATION_INSPECTION_FAILED"); });
  });
}
if (!isMainThread && workerData?.kind === "c2c-reconciliation") {
  // Shared by both scans and the one permitted resample; never reset around Git reads.
  const readBudget: ReconciliationReadBudget = { deadlineNs: workerData.deadlineNs, snapshotRoot: workerData.snapshotRoot };
  let processes: ProcessEvidence | undefined;
  const observation = (value: ProcessEvidence): void => { processes = value; parentPort!.postMessage({ progress: true, processes }); };
  try {
    // Convert the parent's process-wide monotonic deadline once; startup is charged.
    const processBudget = { deadline: performance.now() + remainingReconciliationReadMs(readBudget), remainingBytes: 64 * 1024 * 1024, remainingRetries: 1 };
    const workspace = new Workspace(workerData.root);
    processes = scanReconciliationProcesses({ root: workspace.root, historical: workerData.historical }, observation, processBudget);
    if (processes.quiescence !== "QUIESCENT") fail(processes.code!);
    const evidence = fingerprintWorkspace(workspace, readBudget);
    processes = scanReconciliationProcesses({ root: workspace.root, historical: workerData.historical }, observation, processBudget);
    if (processes.quiescence !== "QUIESCENT") fail(processes.code!);
    remainingReconciliationReadMs(readBudget);
    parentPort!.postMessage({ ok: true, evidence: { ...evidence, processScope: "same-user-cwd" }, processes });
  } catch (e) {
    if (e instanceof GitReadError && processes) {
      processes = incompleteProcessEvidence(processes, "RECONCILIATION_GIT_UNVERIFIED", gitReadFailureSchema.parse({
        code: e.code, stage: e.stage, reason: e.reason, limits: e.details().limits,
      }));
    }
    parentPort!.postMessage({ ok: false, code: e instanceof GitReadError ? "RECONCILIATION_GIT_UNVERIFIED"
      : e instanceof TaskJournalError ? reconciliationCode(e.code) : "RECONCILIATION_INSPECTION_FAILED", processes });
  }
}
