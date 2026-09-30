import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskJournal, inspectTaskJournalLayout } from "../src/execution/task-journal.js";
import { startBridge } from "../src/bridge/server.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const alpha = "a".repeat(24), beta = "b".repeat(24);
const run = { task_id: "old-work", iteration: 1, run_id: "c".repeat(32), state: "running" as const };
let state: string, root: string, previous: string | undefined;
beforeEach(() => { previous = process.env.C2C_STATE_DIR; state = isolateStateDir(); root = makeTmpDir("layout-preflight"); });
afterEach(() => {
  cleanup(root); cleanup(state);
  if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous;
});
function seed(target = alpha, completed = false) {
  const j = new TaskJournal(alpha);
  try { j.begin(target, run, "fixture only"); if (completed) j.complete(target, { ...run, state: "completed", summary: "saved result" }); }
  finally { j.close(); }
  return path.join(state, "task-journal", `${alpha}.json`);
}
function fingerprint(dir: string) {
  return Object.fromEntries(fs.readdirSync(dir).map(name => {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    return [name, [stat.ino, stat.mtimeMs, stat.size, stat.mode,
      stat.isFile() ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "not-file"]];
  }));
}

describe("legacy journal upgrade preflight", () => {
  it("reports absent storage without creating any files or directories", () => {
    const dir = path.join(root, "absent-state");
    expect(inspectTaskJournalLayout(dir)).toEqual({ status: "empty", journals: 0, runs: 0 });
    expect(fs.existsSync(dir)).toBe(false);
  });
  it("accepts a target-keyed record without modifying or claiming its result", () => {
    seed(alpha, true); const before = fingerprint(state), journals = fingerprint(path.join(state, "task-journal"));
    expect(inspectTaskJournalLayout()).toEqual({ status: "target_keyed", journals: 1, runs: 1 });
    expect(fingerprint(state)).toEqual(before); expect(fingerprint(path.join(state, "task-journal"))).toEqual(journals);
  });
  it.each([false, true])("refuses mixed anchor-era records, completed=%s, without discarding evidence", async completed => {
    seed(beta, completed); const before = fingerprint(path.join(state, "task-journal"));
    expect(() => inspectTaskJournalLayout()).toThrow(expect.objectContaining({ code: "TASK_JOURNAL_MIGRATION_REQUIRED" }));
    // The layout check precedes initialization, credentials and any Codex spawning.
    await expect(startBridge({ workspaceRoot: root, codexExecution: true, port: 0, persistRuntime: false }))
      .rejects.toMatchObject({ code: "TASK_JOURNAL_MIGRATION_REQUIRED" });
    expect(fingerprint(path.join(state, "task-journal"))).toEqual(before);
    expect(fs.existsSync(path.join(state, "workspace-identity.key"))).toBe(false);
  });
  it("accepts independent target journals without a global writer lock", () => {
    const first = new TaskJournal(alpha), second = new TaskJournal(beta);
    try {
      first.begin(alpha, run, "first"); second.begin(beta, { ...run, run_id: "d".repeat(32) }, "second");
      expect(inspectTaskJournalLayout()).toEqual({ status: "target_keyed", journals: 2, runs: 2 });
    } finally { first.close(); second.close(); }
  });
  it.each(["corrupt", "schema", "symlink", "permissions", "oversize", "hardlink", "filename"])("fails closed for %s", kind => {
    const file = seed(); const sentinel = "SENSITIVE_VALUE_MUST_NOT_LEAK";
    if (kind === "corrupt") fs.writeFileSync(file, "{" + sentinel);
    if (kind === "schema") { const data = JSON.parse(fs.readFileSync(file, "utf8")); data.secret = sentinel; fs.writeFileSync(file, JSON.stringify(data)); }
    if (kind === "symlink") { fs.renameSync(file, path.join(root, "outside")); fs.symlinkSync(path.join(root, "outside"), file); }
    if (kind === "permissions") fs.chmodSync(file, 0o644);
    if (kind === "oversize") fs.writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
    if (kind === "hardlink") fs.linkSync(file, path.join(root, "hard"));
    if (kind === "filename") fs.renameSync(file, path.join(path.dirname(file), sentinel + ".json"));
    let thrown: unknown;
    try { inspectTaskJournalLayout(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(Error); expect(String(thrown)).not.toContain(sentinel);
    expect((thrown as { code: string }).code).toMatch(/^TASK_JOURNAL_LAYOUT_/);
  });
  it("refuses symlinked storage ancestors and bounds the directory scan", () => {
    seed(); const alias = path.join(root, "state-alias"); fs.symlinkSync(state, alias);
    expect(() => inspectTaskJournalLayout(alias)).toThrow(expect.objectContaining({ code: "TASK_JOURNAL_LAYOUT_UNREADABLE" }));
    const dir = path.join(state, "task-journal");
    for (let i = 0; i < 257; i++) fs.writeFileSync(path.join(dir, `fixture-${i}.tmp`), "");
    expect(() => inspectTaskJournalLayout()).toThrow(expect.objectContaining({ code: "TASK_JOURNAL_LAYOUT_LIMIT" }));
  });
});
