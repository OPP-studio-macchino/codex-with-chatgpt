import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { Workspace } from "../workspace/manager.js";
import { gitStatus, runGit } from "../workspace/git.js";
import { TaskJournalError } from "./task-journal.js";
import type { ReconciliationEvidence } from "./task-reconciler.js";

function fail(code: string): never { throw new TaskJournalError(code, code.replaceAll("_", " ")); }
function hash(s: string): string { return createHash("sha256").update(s).digest("hex"); }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
export function parseCwdRecords(raw: string): Map<number, string> {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) fail("RECONCILIATION_PROCESS_UNVERIFIED");
  const found = new Map<number, string>();
  let pid: number | undefined;
  for (let field of raw.split("\0")) {
    field = field.replace(/^\n/, "");
    if (!field) continue;
    if (/^p\d+$/.test(field)) { pid = Number(field.slice(1)); continue; }
    if (field === "fcwd") continue;
    if (field.startsWith("n")) {
      const cwd = field.slice(1);
      if (!pid || !path.isAbsolute(cwd) || /[\u0000-\u001f\u007f]/.test(cwd) || found.has(pid)) fail("RECONCILIATION_PROCESS_UNVERIFIED");
      found.set(pid, cwd);
      if (found.size > 10_000) fail("RECONCILIATION_PROCESS_UNVERIFIED");
    } else fail("RECONCILIATION_PROCESS_UNVERIFIED");
  }
  return found;
}

export function isConfirmedZombieState(state: string | undefined): boolean {
  return state === "Z" || state === "Z+";
}

/** Conservative snapshot, not a claim about remote effects or every writable descriptor. */
function checkQuiescence(root: string): void {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") fail("RECONCILIATION_PLATFORM_UNSUPPORTED");
  const uid = process.getuid();
  const ps = spawnSync("/bin/ps", ["-axo", "uid=,pid="], { cwd: "/", encoding: "utf8", timeout: 4000, maxBuffer: 1024 * 1024 });
  if (ps.status !== 0 || ps.error) fail("RECONCILIATION_PROCESS_UNVERIFIED");
  const pids = new Set<number>();
  for (const line of ps.stdout.split("\n").filter(l => l.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) fail("RECONCILIATION_PROCESS_UNVERIFIED");
    if (Number(match[1]) === uid && Number(match[2]) !== ps.pid && Number(match[2]) !== process.pid) pids.add(Number(match[2]));
  }
  const scan = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-u", String(uid), "-d", "cwd", "-Fpn0"], {
    cwd: "/", encoding: "utf8", timeout: 8000, maxBuffer: 4 * 1024 * 1024,
  });
  if (scan.status !== 0 || scan.error || scan.stderr.trim()) fail("RECONCILIATION_PROCESS_UNVERIFIED");
  const records = parseCwdRecords(scan.stdout);
  const missing = [...pids].filter(pid => !records.has(pid));
  if (missing.length > 32) fail("RECONCILIATION_PROCESS_UNVERIFIED");
  if (missing.length) {
    // A kernel-confirmed zombie has no executing code/cwd. Do not mistake it for an unobserved live writer.
    // Recheck after lsof instead of trusting the earlier ps snapshot or treating all missing rows as safe.
    const detail = spawnSync("/bin/ps", ["-p", missing.join(","), "-o", "pid=,stat="], {
      cwd: "/", encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024,
    });
    if (detail.error || (detail.status !== 0 && detail.status !== 1) || detail.stderr.trim()) fail("RECONCILIATION_PROCESS_UNVERIFIED");
    const states = new Map<number, string>();
    for (const line of detail.stdout.split("\n").filter(l => l.trim())) {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) fail("RECONCILIATION_PROCESS_UNVERIFIED");
      states.set(Number(match[1]), match[2]!);
    }
    for (const pid of missing) {
      if (isConfirmedZombieState(states.get(pid))) continue;
      try { process.kill(pid, 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") continue; }
      fail("RECONCILIATION_PROCESS_UNVERIFIED");
    }
  }
  for (const [pid, cwd] of records) {
    if (pid === process.pid || pid === scan.pid) continue;
    let canonical: string;
    try { canonical = fs.realpathSync.native(cwd); }
    catch { fail("RECONCILIATION_PROCESS_UNVERIFIED"); }
    if (inside(root, canonical)) fail("RECONCILIATION_PROCESS_PRESENT");
  }
}
function checkedGit(root: string, args: string[]): string {
  const result = runGit(root, args);
  if (!result.ok || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) fail("RECONCILIATION_GIT_UNVERIFIED");
  return result.stdout;
}

/** Covers tracked plus non-ignored untracked files. Ignored files and external state are explicitly excluded. */
export function fingerprintWorkspace(workspace: Workspace): Omit<ReconciliationEvidence, "processScope"> {
  const root = workspace.root;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync.native(root) !== root) fail("RECONCILIATION_ROOT_CHANGED");
  const status = gitStatus(root);
  if (!status.isRepo || !status.head || status.truncated || status.redactedPathCount || status.conflicted.length) fail("RECONCILIATION_SCOPE_INCOMPLETE");
  const index = checkedGit(root, ["ls-files", "--stage", "-z"]);
  if (index.split("\0").some(l => l.startsWith("160000 "))) fail("RECONCILIATION_SUBMODULE_UNSUPPORTED");
  const listing = checkedGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const names = [...new Set(listing.split("\0").filter(Boolean))].sort();
  if (names.length > 4000) fail("RECONCILIATION_SCOPE_LIMIT");
  const entries: unknown[] = [];
  let total = 0;
  for (const name of names) {
    if (name.length > 4096 || /[\u0000-\u001f\u007f]/.test(name)) fail("RECONCILIATION_SCOPE_INCOMPLETE");
    let abs: string;
    try { abs = workspace.resolve(name).abs; } catch { fail("RECONCILIATION_SCOPE_INCOMPLETE"); }
    const lexical = path.join(root, name);
    if (!inside(root, lexical)) fail("RECONCILIATION_SCOPE_INCOMPLETE");
    let stat: fs.Stats;
    try { stat = fs.lstatSync(lexical); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") fail("RECONCILIATION_SCOPE_INCOMPLETE");
      entries.push([name, "deleted"]); continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) fail("RECONCILIATION_SCOPE_INCOMPLETE");
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) fail("RECONCILIATION_EVIDENCE_CHANGED");
      const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      for (;;) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
        bytes += n; total += n;
        if (bytes > 8 * 1024 * 1024 || total > 64 * 1024 * 1024) fail("RECONCILIATION_SCOPE_LIMIT");
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
  if (end.ino !== rootStat.ino || end.dev !== rootStat.dev || fs.realpathSync.native(root) !== root ||
      index !== checkedGit(root, ["ls-files", "--stage", "-z"]) || listing !== checkedGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]) ||
      gitStatus(root).head !== status.head) fail("RECONCILIATION_EVIDENCE_CHANGED");
  return { digest: hash(JSON.stringify({ root: [rootStat.dev, rootStat.ino], head: status.head, index: hash(index), entries })),
    head: status.head, fileCount: names.length,
    changedCount: status.staged.length + status.unstaged.length + status.untracked.length,
    fileScope: "tracked-and-nonignored-untracked" };
}

/** Heavy Git/file/process inspection never holds the bridge's event loop. */
export function inspectForReconciliation(workspace: Workspace, signal: AbortSignal): Promise<ReconciliationEvidence> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new TaskJournalError("RECONCILIATION_CANCELLED", "Inspection cancelled")); return; }
    const worker = new Worker(new URL("./reconciliation-evidence.js", import.meta.url), {
      workerData: { kind: "c2c-reconciliation", root: workspace.root }, resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = (error?: Error, evidence?: ReconciliationEvidence): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      void worker.terminate(); if (error) reject(error); else resolve(evidence!);
    };
    const abort = (): void => finish(new TaskJournalError("RECONCILIATION_CANCELLED", "Inspection cancelled"));
    const timer = setTimeout(() => finish(new TaskJournalError("RECONCILIATION_INSPECTION_TIMEOUT", "Inspection limit reached")), 20_000);
    timer.unref(); signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) => {
      if (message?.ok === true) finish(undefined, message.evidence);
      else finish(new TaskJournalError(typeof message?.code === "string" && /^RECONCILIATION_[A-Z_]+$/.test(message.code) ? message.code : "RECONCILIATION_INSPECTION_FAILED", "Inspection blocked"));
    });
    worker.once("error", () => finish(new TaskJournalError("RECONCILIATION_INSPECTION_FAILED", "Inspection unavailable")));
    worker.once("exit", () => { if (!settled) finish(new TaskJournalError("RECONCILIATION_INSPECTION_FAILED", "Inspection stopped")); });
  });
}
if (!isMainThread && workerData?.kind === "c2c-reconciliation") {
  try {
    const workspace = new Workspace(workerData.root);
    checkQuiescence(workspace.root);
    const evidence = fingerprintWorkspace(workspace);
    checkQuiescence(workspace.root);
    parentPort!.postMessage({ ok: true, evidence: { ...evidence, processScope: "same-user-cwd" } });
  } catch (e) {
    parentPort!.postMessage({ ok: false, code: e instanceof TaskJournalError ? e.code : "RECONCILIATION_INSPECTION_FAILED" });
  }
}
