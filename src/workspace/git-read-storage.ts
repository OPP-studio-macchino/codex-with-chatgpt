import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Parent-owned storage survives loss of a worker's JavaScript finally blocks. */
export function createGitReadStorage() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "c2c-git-read-"));
  const before = fs.lstatSync(root);
  const owned = (s: fs.Stats) => s.isDirectory() && !s.isSymbolicLink() &&
    s.dev === before.dev && s.ino === before.ino &&
    (process.getuid === undefined || s.uid === process.getuid());
  const matches = (s: fs.Stats) => owned(s) && (s.mode & 0o777) === 0o700;
  try {
    if (!owned(before) || fs.realpathSync.native(root) !== root) throw Error("Git read storage identity unavailable");
    fs.chmodSync(root, 0o700);
    if (!matches(fs.lstatSync(root)) || fs.realpathSync.native(root) !== root) throw Error("Git read storage identity unavailable");
  } catch (error) {
    // No worker has received this root. Remove only our same, still-empty directory;
    // never recursively delete an unverified replacement or mask the original error.
    try {
      if (owned(fs.lstatSync(root)) && fs.realpathSync.native(root) === root) fs.rmdirSync(root);
    } catch { /* Identity unavailable or nonempty: fail closed without deletion. */ }
    throw error;
  }
  return { root, async dispose() {
    const current = await fs.promises.lstat(root);
    if (!matches(current) || await fs.promises.realpath(root) !== root) throw Error("Git read storage identity changed");
    // Caller must await owned worker termination first. Never accept a path from a worker message.
    await fs.promises.rm(root, { recursive: true, force: false });
  } };
}

/** Waiting for cleanup must not extend the parent's original response deadline. */
export function awaitGitReadCleanup(cleaned: Promise<void>, deadlineNs: bigint, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (reason?: string) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (reason) reject(new Error(reason)); else resolve();
    };
    const abort = () => finish("cancelled");
    const timer = setTimeout(() => finish("budget_exhausted"), Math.max(1, Math.floor(Number(deadlineNs - process.hrtime.bigint()) / 1e6)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    cleaned.then(() => finish(signal?.aborted ? "cancelled" : process.hrtime.bigint() >= deadlineNs ? "budget_exhausted" : undefined),
      () => finish("unverified"));
  });
}
