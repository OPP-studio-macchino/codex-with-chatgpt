import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { GitReadError } from "../src/workspace/git.js";
import { compareProcessSnapshots, diagnosticContextSchema, processEvidenceSchema, quarantine,
  scanReconciliationProcesses, parseProcessRows, incompleteProcessEvidence,
  type DiagnosticContext, type ProcessRow, type ProcessSnapshot, type RecordedProcessBindings,
} from "../src/execution/reconciliation-processes.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const historical = { workspace_id: "a".repeat(24), runtime_id: "b".repeat(32), run_id: "c".repeat(32),
  session_id: "recorded-session", started_at: "2026-10-04T10:47:35.131Z", ended_at: "2026-10-04T11:07:35.199Z" };
const context: DiagnosticContext = { root: "/fixture", historical };
const observed_at = "2026-10-07T12:00:00.000Z";
const parent: ProcessRow = { pid: 10, ppid: 0, uid: 501, state: "S", process_start_time: "2026-10-04T10:00:00.000Z", executable: "/bin/host", birth_identity: "3".repeat(64) };
const helper: ProcessRow = { pid: 20, ppid: 10, uid: 501, state: "S", process_start_time: "2026-10-04T10:48:00.000Z", executable: "/bin/node", birth_identity: "4".repeat(64) };
function snapshot(rows = [parent, helper], target = "/fixture"): ProcessSnapshot {
  return { rows, observed_at, cwds: new Map(rows.map(r => [r.pid, r.pid === 10 ? "/elsewhere" : target])) };
}
function receipt(row = helper, other = false): RecordedProcessBindings {
  const { uid: _uid, state: _state, ...process } = row;
  const { uid: _parentUid, state: _parentState, ...p } = parent;
  const data = { ...historical, root: context.root, process: { ...process, birth_identity: row.birth_identity ?? null },
    parent: { ...p, birth_identity: parent.birth_identity ?? null }, recorded_at: observed_at };
  const { started_at: _start, ended_at: _end, ...binding } = data;
  if (other) Object.assign(binding, { runtime_id: "d".repeat(32), run_id: "e".repeat(32), session_id: "another-recorded-session" });
  return { spawn: { ...binding, source_sha256: "1".repeat(64) }, session: { ...binding, source_sha256: "2".repeat(64) } };
}
function compare(rows = [parent, helper], bindings?: RecordedProcessBindings) {
  return compareProcessSnapshots(context, snapshot(rows), snapshot(rows), 501, () => bindings);
}
it("attributes exact recorded run/runtime/session plus independent spawn and parent identities to history", () => {
  const e = compare(undefined, receipt());
  expect(e.candidates[0].ownership).toBe("PROVEN_HISTORICAL");
  expect(e.ownership_counts.PROVEN_HISTORICAL).toBe(1);
  expect(e.quiescence).toBe("NON_QUIESCENT");
});
it("keeps a post-end known other runtime's live helper NON_QUIESCENT and BLOCKED", () => {
  const row = { ...helper, process_start_time: "2026-10-06T00:00:00.000Z" };
  const e = compare([parent, row], receipt(row, true));
  expect(e.candidates[0]).toMatchObject({ ownership: "PROVEN_OTHER", physical_original: "FALSE" });
  expect(quarantine(e, true)).toMatchObject({ quiescence: "NON_QUIESCENT", new_unrelated_writer_admission: "BLOCKED",
    old_outcome: "UNKNOWN", context: "NON_RESUMABLE", replay: "PROHIBITED" });
});
it.each(["2026-10-04T10:48:00.000Z", "2026-10-06T00:00:00.000Z"])("missing binding is UNPROVEN at %s", process_start_time => {
  const e = compare([parent, { ...helper, process_start_time }]);
  expect(e.candidates[0].ownership).toBe("UNPROVEN");
  expect(e.candidates[0].physical_original).toBe(process_start_time.startsWith("2026-10-06") ? "FALSE" : "UNKNOWN");
});
it("a known other binding merely after run start does not establish PROVEN_OTHER", () => {
  expect(compare(undefined, receipt(helper, true)).candidates[0].ownership).toBe("UNPROVEN");
});
it("all candidates gone under stable surviving coverage is QUIESCENT without granting authority", () => {
  const e = compareProcessSnapshots(context, snapshot(), snapshot([parent]), 501);
  expect(e).toMatchObject({ quiescence: "QUIESCENT", candidate_count: 0, candidates: [] });
  expect(quarantine(e).new_unrelated_writer_admission).toBe("BLOCKED");
});
it("PID reuse cannot inherit a historical binding", () => {
  const replacement = { ...helper, process_start_time: "2026-10-06T00:00:00.000Z" };
  const e = compareProcessSnapshots(context, snapshot(), snapshot([parent, replacement]), 501, () => receipt());
  expect(e).toMatchObject({ quiescence: "UNKNOWN", code: "RECONCILIATION_SNAPSHOT_UNSTABLE" });
  expect(e.candidates[0].ownership).toBe("UNPROVEN");
});
it("second-resolution PID/start matches alone cannot support positive attribution", () => {
  const row = { ...helper, birth_identity: null };
  expect(compare([parent, row], receipt(row)).candidates[0].ownership).toBe("UNPROVEN");
  const reused = { ...helper, birth_identity: "5".repeat(64) };
  const e = compareProcessSnapshots(context, snapshot(), snapshot([parent, reused]), 501, () => receipt());
  expect(e).toMatchObject({ quiescence: "UNKNOWN", code: "RECONCILIATION_SNAPSHOT_UNSTABLE" });
  expect(e.candidates[0].ownership).toBe("UNPROVEN");
});
it.each(["cwd", "parent", "new-process"])("fails closed on a %s race", kind => {
  const last = snapshot();
  if (kind === "cwd") last.cwds.set(helper.pid, "/fixture/sub");
  if (kind === "parent") last.rows = [ { ...parent, process_start_time: "2026-10-05T00:00:00.000Z" }, helper ];
  if (kind === "new-process") { last.rows = [...last.rows, { ...helper, pid: 30 }]; last.cwds.set(30, "/elsewhere"); }
  const e = compareProcessSnapshots(context, snapshot(), last, 501, () => receipt());
  expect(e.quiescence).toBe("UNKNOWN");
  expect(e.candidates[0].ownership).toBe(kind === "new-process" ? "PROVEN_HISTORICAL" : "UNPROVEN");
  expect(quarantine(e).new_unrelated_writer_admission).toBe("BLOCKED");
});
it("unreadable cwd makes coverage UNKNOWN while retaining other observed candidates", () => {
  const rows = [parent, helper, { ...helper, pid: 30 }], first = snapshot(rows), last = snapshot(rows);
  last.cwds.delete(30);
  const e = compareProcessSnapshots(context, first, last, 501);
  expect(e).toMatchObject({ quiescence: "UNKNOWN", code: "RECONCILIATION_LSOF_COVERAGE_UNVERIFIED", candidate_count: 1 });
});
it("a disappeared process is never retained as live ownership evidence", () => {
  const getBinding = vi.fn(() => receipt());
  const e = compareProcessSnapshots(context, snapshot(), snapshot([parent]), 501, getBinding);
  expect(e.candidates).toEqual([]); expect(getBinding).not.toHaveBeenCalled();
});
it("retains a stable reparented process as a blocker without treating its newer parent as a birth receipt", () => {
  const adoptedParent = { ...parent, process_start_time: "2026-10-05T00:00:00.000Z" };
  const e = compare([adoptedParent, helper], receipt());
  expect(e).toMatchObject({ quiescence: "NON_QUIESCENT", candidate_count: 1 });
  expect(e.candidates[0]).toMatchObject({ ownership: "UNPROVEN", ancestry: [{ process_start_time: adoptedParent.process_start_time }] });
});
it("a stable different workspace is outside this cwd scope, without claiming coverage of remote effects", () => {
  const s = snapshot(undefined, "/other-workspace");
  const e = compareProcessSnapshots(context, s, s, 501);
  expect(e).toMatchObject({ candidate_count: 0, quiescence: "QUIESCENT", scope: "same-user-canonical-cwd-snapshots" });
});
it.each(["same-source", "session", "parent", "pid", "workspace", "future"])("does not trust inconsistent %s evidence", kind => {
  const b = receipt();
  if (kind === "same-source") b.session.source_sha256 = b.spawn.source_sha256;
  if (kind === "session") b.session.session_id = "other";
  if (kind === "parent") b.spawn.parent = { ...b.spawn.parent, pid: 11 };
  if (kind === "pid") b.spawn.process = { ...b.spawn.process, pid: 21 };
  if (kind === "workspace") b.spawn.workspace_id = "f".repeat(24);
  if (kind === "future") b.spawn.recorded_at = "2099-01-01T00:00:00.000Z";
  expect(compare(undefined, b).candidates[0].ownership).toBe("UNPROVEN");
});
it("rejects arbitrary authority, name exemptions and bindings in diagnostic context", () => {
  for (const extra of [{ allowlist: [20] }, { approved: true }, { bindings: receipt() }, { exempt_names: ["node", "cua", "Codex", "Desktop"] }])
    expect(diagnosticContextSchema.safeParse({ ...context, ...extra }).success).toBe(false);
});
it("validates hashes, closed shapes, counts, size and absence of argv/environment", () => {
  const e = compare();
  expect(processEvidenceSchema.safeParse(e).success).toBe(true);
  for (const bad of [ { ...e, argv: "secret" }, { ...e, environment: { TOKEN: "secret" } },
    { ...e, evidence_hash: "0".repeat(64) }, { ...e, candidate_count: 10001 },
    { ...e, candidates: [{ ...e.candidates[0], canonical_cwd: "/" + "x".repeat(513) }] },
    { ...e, quiescence: "QUIESCENT" }, { ...e, code: "RECONCILIATION_SECRET_" + "x".repeat(9999) } ])
    expect(processEvidenceSchema.safeParse(bad).success).toBe(false);
  expect(JSON.stringify(e)).not.toMatch(/argv|environment|recorded-session/);
});
it("caps inline inventory and preserves total counts, hash and UNKNOWN", () => {
  const rows = [parent, ...Array.from({ length: 100 }, (_, i) => ({ ...helper, pid: 100 + i }))];
  const e = compare(rows);
  expect(e).toMatchObject({ candidate_count: 100, inventory_truncated: true, quiescence: "UNKNOWN", ownership_counts: { UNPROVEN: 100 } });
  expect(e.candidates.length).toBeLessThanOrEqual(32);
  expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(64 * 1024);
  expect(processEvidenceSchema.safeParse(e).success).toBe(true);
});
it("later worker failures preserve bounded observations while downgrading quiescence", () => {
  const e = compare();
  const failed = incompleteProcessEvidence(e, "RECONCILIATION_INSPECTION_TIMEOUT");
  expect(failed).toMatchObject({ candidates: e.candidates, observed_at: e.observed_at, quiescence: "UNKNOWN" });
  expect(failed.evidence_hash).not.toBe(e.evidence_hash);
});

function nativeMocks() {
  vi.spyOn(fs, "lstatSync").mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 2 } as fs.Stats);
  vi.spyOn(fs.realpathSync, "native").mockImplementation(p => String(p));
  const uid = process.getuid!();
  const ps = `${uid} 10 0 Sun Oct  4 10:00:00 2026 S /bin/host\n${uid} 20 10 Sun Oct  4 10:48:00 2026 S /bin/node\n`;
  const cwd = "p10\0\nfcwd\0n/elsewhere\0\np20\0\nfcwd\0n/fixture\0\n";
  vi.mocked(spawnSync).mockImplementation((file) => ({ pid: 9000, status: 0, signal: null, output: [],
    stdout: file === "/bin/ps" ? ps : cwd, stderr: "" }));
  return { ps, cwd };
}
it("native diagnostic scan collects metadata only, never signals or calls approval/business APIs", () => {
  nativeMocks();
  const signal = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("No signal permitted"); });
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("No file contents permitted"); });
  const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("No diagnostic writes permitted"); });
  const e = scanReconciliationProcesses(context);
  expect(e).toMatchObject({ quiescence: "NON_QUIESCENT", candidate_count: 1 });
  expect(e.candidates[0].ownership).toBe("UNPROVEN");
  expect(signal).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  for (const [file, args] of vi.mocked(spawnSync).mock.calls) {
    expect(["/bin/ps", "/usr/sbin/lsof"]).toContain(file);
    expect(JSON.stringify(args)).not.toMatch(/argv|args=|command=|eww|osascript/);
  }
});
it("native cwd resolution errors remain UNKNOWN and preserve other bounded candidates", () => {
  nativeMocks();
  vi.mocked(fs.realpathSync.native).mockImplementation(p => { if (p === "/elsewhere") throw new Error("private diagnostic details"); return String(p); });
  const e = scanReconciliationProcesses(context);
  expect(e).toMatchObject({ quiescence: "UNKNOWN", code: "RECONCILIATION_CWD_UNRESOLVED", candidate_count: 1 });
  expect(JSON.stringify(e)).not.toContain("private diagnostic details");
});
it("lsof warnings and failure preserve exact codes and block writers", () => {
  nativeMocks();
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: "", stderr: "", pid: 9000 } as ReturnType<typeof spawnSync>)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "private warning", pid: 9001 } as ReturnType<typeof spawnSync>);
  expect(scanReconciliationProcesses(context)).toMatchObject({ code: "RECONCILIATION_LSOF_STDERR", quiescence: "UNKNOWN" });
});
it("parses executable identity without retaining args and rejects malformed process output", () => {
  nativeMocks();
  const rows = parseProcessRows("501 20 10 Sun Oct  4 10:48:00 2026 S /bin/node\n");
  expect(rows[0]).toMatchObject({ pid: 20, ppid: 10, process_start_time: helper.process_start_time, executable: "/bin/node" });
  expect(() => parseProcessRows("501 20 --token secret")).toThrow();
});

it("retains an outside-workspace process appearance as diagnostic evidence without weakening the gate", () => {
  const next = { ...helper, pid: 30 };
  const e = compareProcessSnapshots(context, snapshot([parent]), snapshot([parent, next], "/outside"), 501);
  expect(e).toMatchObject({ candidate_count: 0, quiescence: "UNKNOWN", code: "RECONCILIATION_SNAPSHOT_UNSTABLE",
    snapshot_diagnostics: { count: 1, truncated: false, entries: [{ phase: "comparison", reason: "process_appeared",
      pid: 30, before: null, after: { pid: 30, ppid: 10, executable: "/bin/node" }, cwd_after: "/outside" }] } });
  expect(quarantine(e, true).new_unrelated_writer_admission).toBe("BLOCKED");
});
it.each(["birth", "parent", "cwd"])("records both sides of a %s change", kind => {
  const last = snapshot();
  if (kind === "birth") last.rows = [parent, { ...helper, birth_identity: "5".repeat(64) }];
  if (kind === "parent") last.rows = [parent, { ...helper, ppid: 0 }];
  if (kind === "cwd") last.cwds.set(helper.pid, "/other");
  const e = compareProcessSnapshots(context, snapshot(), last, 501);
  expect(e.quiescence).toBe("UNKNOWN");
  expect(e.snapshot_diagnostics?.entries).toEqual(expect.arrayContaining([expect.objectContaining({
    pid: 20, reason: kind === "cwd" ? "cwd_changed" : "identity_changed",
    before: expect.objectContaining({ pid: 20, ppid: 10, birth_identity: helper.birth_identity }),
    after: expect.objectContaining({ pid: 20 }),
  })]));
});
it("retains native lsof-bracket mismatch PID after that process disappears in the later bracket", () => {
  const { ps, cwd } = nativeMocks();
  const extra = String(process.getuid!()) + " 30 10 Tue Oct  6 10:48:00 2026 S /bin/node\n";
  let n = 0;
  vi.mocked(spawnSync).mockImplementation(file => ({ pid: 9000, status: 0, signal: null, output: [],
    stdout: file === "/bin/ps" ? (++n === 2 ? ps + extra : ps) : cwd, stderr: "" }));
  const e = scanReconciliationProcesses(context);
  expect(e).toMatchObject({ quiescence: "UNKNOWN", code: "RECONCILIATION_SNAPSHOT_UNSTABLE",
    snapshot_diagnostics: { entries: [{ phase: "first_bracket", reason: "process_appeared", pid: 30 }] } });
  expect(e.candidates.some(c => c.pid === 30)).toBe(false);
});
it("records unresolvable cwd PID without raw cwd or exception text", () => {
  nativeMocks();
  vi.mocked(fs.realpathSync.native).mockImplementation(p => {
    if (p === "/elsewhere") throw new Error("secret-content"); return String(p);
  });
  const e = scanReconciliationProcesses(context);
  expect(e.snapshot_diagnostics?.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ pid: 10, reason: "cwd_unresolved", cwd_before: null, cwd_after: null }),
  ]));
  expect(JSON.stringify(e.snapshot_diagnostics)).not.toContain("secret-content");
  expect(e.quiescence).toBe("UNKNOWN");
});
it("bounds diagnostics separately from candidate inventory and preserves the failure on overflow", () => {
  const added = Array.from({ length: 80 }, (_, i) => ({ ...helper, pid: 100 + i }));
  const e = compareProcessSnapshots(context, snapshot([parent]), snapshot([parent, ...added], "/outside"), 501);
  expect(e.snapshot_diagnostics).toMatchObject({ count: 80, truncated: true });
  expect(e.snapshot_diagnostics?.entries.length).toBeLessThanOrEqual(8);
  expect(Buffer.byteLength(JSON.stringify(e.snapshot_diagnostics))).toBeLessThanOrEqual(16 * 1024);
  expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(64 * 1024);
  expect(e).toMatchObject({ quiescence: "UNKNOWN", candidate_count: 0 });
  expect(processEvidenceSchema.safeParse(e).success).toBe(true);
});
it("strictly validates diagnostic fields, count, envelope hash and inability to grant quiescence", () => {
  const e = compareProcessSnapshots(context, snapshot([parent]), snapshot(), 501);
  const d = e.snapshot_diagnostics!;
  const rehash = (body: Record<string, unknown>) => {
    const { evidence_hash: _, ...value } = body;
    return { ...value, evidence_hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  };
  for (const bad of [
    { ...d, entries: [{ ...d.entries[0], argv: "--token private" }] },
    { ...d, entries: [{ ...d.entries[0], environment: { TOKEN: "private" } }] },
    { ...d, entries: [{ ...d.entries[0], cwd_after: "/key?token=secret" + "\n" }] },
    { ...d, entries: [{ ...d.entries[0], after: { ...d.entries[0].after, approved: true } }] },
    { ...d, count: 0 }, { ...d, count: 2, truncated: false },
    { ...d, entries: Array(9).fill(d.entries[0]), count: 9 },
  ]) expect(processEvidenceSchema.safeParse(rehash({ ...e, snapshot_diagnostics: bad })).success).toBe(false);
  expect(processEvidenceSchema.safeParse(rehash({ ...e, candidate_count: 0, candidates: [],
    ownership_counts: { PROVEN_HISTORICAL: 0, PROVEN_OTHER: 0, UNPROVEN: 0 },
    coverage: "STABLE", quiescence: "QUIESCENT", code: undefined })).success).toBe(false);
  expect(processEvidenceSchema.safeParse({ ...e, snapshot_diagnostics: { ...d, count: 2, truncated: true } }).success).toBe(false);
  expect(incompleteProcessEvidence(e, "RECONCILIATION_CANCELLED").snapshot_diagnostics).toEqual(d);
  expect(compare().snapshot_diagnostics).toBeUndefined();
});

it.each(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"])("diagnoses %s without leaking the cwd or weakening quiescence", errno => {
  nativeMocks();
  vi.mocked(fs.realpathSync.native).mockImplementation(p => { if (p === "/elsewhere") throw Object.assign(new Error("private path and credentials"), { code: errno }); return String(p); });
  const evidence = scanReconciliationProcesses(context);
  expect(evidence).toMatchObject({ quiescence: "UNKNOWN", coverage: "INCOMPLETE", code: "RECONCILIATION_CWD_UNRESOLVED" });
  const failures = evidence.snapshot_diagnostics!.entries.filter(e => e.cwd_failure);
  expect(failures[0].cwd_failure).toMatchObject({ method: "lsof-cwd/realpath", errno, process_recheck: "same_identity", path_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(failures)).not.toContain("private path and credentials");
  expect(quarantine(evidence).new_unrelated_writer_admission).toBe("BLOCKED");
  expect(processEvidenceSchema.safeParse(evidence).success).toBe(true);
});
it.each(["disappeared", "identity_changed"])("cwd failure identifies a %s during the recheck without treating the PID as safe", change => {
  const { ps, cwd } = nativeMocks(); let psCalls = 0;
  vi.mocked(fs.realpathSync.native).mockImplementation(p => { if (p === "/elsewhere") throw Object.assign(new Error(), { code: "ENOENT" }); return String(p); });
  vi.mocked(spawnSync).mockImplementation(file => {
    if (file === "/bin/ps") psCalls++;
    const changed = change === "disappeared" ? ps.split("\n").filter(l => !l.includes(" 10 0 ")).join("\n") : ps.replace("10:00:00", "11:00:00");
    return { pid: 9000, status: 0, signal: null, output: [], stdout: file === "/bin/ps" ? psCalls === 3 ? changed : ps : cwd, stderr: "" };
  });
  const e = scanReconciliationProcesses(context);
  expect(e.snapshot_diagnostics?.entries.find(e => e.cwd_failure)?.cwd_failure?.process_recheck).toBe(change);
  expect(e.quiescence).toBe("UNKNOWN");
});

function appearingProcess(mode = "stable") {
  const { ps, cwd } = nativeMocks();
  vi.mocked(spawnSync).mockClear();
  let psCalls = 0, lsofCalls = 0;
  const extra = `${process.getuid!()} 30 10 Tue Oct  6 10:48:00 2026 S /Applications/Docker.app/Contents/Resources/bin/docker\n`;
  vi.mocked(spawnSync).mockImplementation(file => {
    let stdout: string;
    if (file === "/bin/ps") {
      psCalls++;
      stdout = ps + (psCalls >= 4 ? extra : "");
      if (mode === "churn" && psCalls === 8) stdout += extra.replace(" 30 ", " 40 ");
      if (mode === "reuse" && psCalls >= 5) stdout = stdout.replace("10:48:00", "11:48:00");
    } else {
      lsofCalls++;
      stdout = cwd.replace("n/fixture", "n/outside") +
        (lsofCalls >= 3 && mode !== "missing" ? "p30\0\nfcwd\0n/outside\0\n" : "");
      if (mode === "target") stdout = stdout.replace("n/outside", "n/fixture");
    }
    return { pid: 9000, status: 0, signal: null, output: [], stdout, stderr: "" };
  });
  return () => ({ psCalls, lsofCalls });
}
it("resamples one fresh complete pair, preserves the failed observation and never stops the outside process", () => {
  const calls = appearingProcess();
  const kill = vi.spyOn(process, "kill");
  const observations: ReturnType<typeof scanReconciliationProcesses>[] = [];
  const e = scanReconciliationProcesses(context, value => observations.push(value));
  expect(e).toMatchObject({ coverage: "STABLE", quiescence: "QUIESCENT", candidate_count: 0,
    observation_retry: { attempts: 2, initial_evidence_hash: observations[1].evidence_hash,
      initial_diagnostics: observations[1].snapshot_diagnostics } });
  expect(observations[1]).toMatchObject({ quiescence: "UNKNOWN", code: "RECONCILIATION_SNAPSHOT_UNSTABLE" });
  expect(observations.at(-1)).toEqual(e);
  expect(calls()).toEqual({ psCalls: 8, lsofCalls: 4 });
  expect(kill).not.toHaveBeenCalled();
  expect(vi.mocked(spawnSync).mock.calls.every(([file]) => file === "/bin/ps" || file === "/usr/sbin/lsof")).toBe(true);
  const { evidence_hash: _hash, observation_retry: _retry, ...body } = e;
  const rows = parseProcessRows(vi.mocked(spawnSync).mock.results.at(-1)!.value.stdout);
  const final = { rows, observed_at: e.observed_at, cwds: new Map([[10, "/elsewhere"], [20, "/outside"], [30, "/outside"]]) };
  const { evidence_hash: _expectedHash, ...expected } = compareProcessSnapshots(context, final, final, process.getuid!());
  expect(body).toEqual(expected);
  expect(quarantine(e)).toMatchObject({ replay: "PROHIBITED", new_unrelated_writer_admission: "BLOCKED" });
});
it.each(["churn", "missing", "reuse"])("keeps %s after resampling UNKNOWN within two attempts", mode => {
  const calls = appearingProcess(mode);
  const e = scanReconciliationProcesses(context);
  expect(e.quiescence).toBe("UNKNOWN");
  expect(e.observation_retry?.attempts).toBe(2);
  expect(calls().psCalls).toBeLessThanOrEqual(8);
  expect(calls().lsofCalls).toBeLessThanOrEqual(4);
});
it("never retries past an observed target candidate even with unrelated appearance", () => {
  const calls = appearingProcess("target");
  const e = scanReconciliationProcesses(context);
  expect(e.candidate_count).toBe(1);
  expect(e.quiescence).toBe("UNKNOWN");
  expect(e.observation_retry).toBeUndefined();
  expect(calls()).toEqual({ psCalls: 4, lsofCalls: 2 });
});
it("does not erase a new process whose raw cwd aliases the target", () => {
  const calls = appearingProcess();
  const collect = vi.mocked(spawnSync).getMockImplementation()!;
  vi.mocked(spawnSync).mockImplementation((...args) => {
    const result = collect(...args);
    return args[0] === "/usr/sbin/lsof" ? { ...result, stdout: result.stdout + "p30\0\nfcwd\0n/alias\0\n" } : result;
  });
  vi.mocked(fs.realpathSync.native).mockImplementation(p => p === "/alias" ? "/fixture" : String(p));
  const e = scanReconciliationProcesses(context);
  expect(e.quiescence).toBe("UNKNOWN");
  expect(e.observation_retry).toBeUndefined();
  expect(calls()).toEqual({ psCalls: 4, lsofCalls: 2 });
});
it("does not erase a target candidate that departs before the failed pair ends", () => {
  const { ps, cwd } = nativeMocks();
  let n = 0;
  const extra = `${process.getuid!()} 30 10 Tue Oct  6 10:48:00 2026 S /bin/node\n`;
  vi.mocked(spawnSync).mockImplementation(file => ({ pid: 9000, status: 0, signal: null, output: [], stderr: "",
    stdout: file === "/bin/ps" ? (++n <= 2 ? ps : ps.split("\n")[0] + "\n" + extra) : n <= 2 ? cwd : "p10\0\nfcwd\0n/elsewhere\0\np30\0\nfcwd\0n/outside\0\n" }));
  const e = scanReconciliationProcesses(context);
  expect(e).toMatchObject({ quiescence: "UNKNOWN", candidate_count: 0 });
  expect(e.observation_retry).toBeUndefined(); expect(n).toBe(4);
});
it("strictly validates retry history rather than upgrading arbitrary past failures", () => {
  appearingProcess();
  const e = scanReconciliationProcesses(context);
  const rehash = (retry: unknown) => {
    const { evidence_hash: _hash, ...body } = e;
    const value = { ...body, observation_retry: retry };
    return { ...value, evidence_hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  };
  const retry = e.observation_retry!;
  for (const invalid of [{ ...retry, attempts: 3 }, { ...retry, approved: true },
    { ...retry, initial_evidence_hash: "invalid" }, { ...retry, initial_observed_at: "2099-01-01T00:00:00.000Z" },
    { ...retry, initial_diagnostics: { ...retry.initial_diagnostics, truncated: true } },
    { ...retry, initial_diagnostics: { count: 1, truncated: false, entries: [{ ...retry.initial_diagnostics.entries[0], reason: "identity_changed" }] } },
  ]) expect(processEvidenceSchema.safeParse(rehash(invalid)).success).toBe(false);
});
it.each(["time", "bytes"])("stops at the shared %s budget without another collection", kind => {
  const calls = appearingProcess();
  const budget = { deadline: performance.now() + 20_000, remainingBytes: 32 * 1024 * 1024, remainingRetries: 1 };
  const e = scanReconciliationProcesses(context, value => {
    if (value.snapshot_diagnostics?.entries.some(d => d.reason === "process_appeared")) {
      if (kind === "time") budget.deadline = 0;
      else budget.remainingBytes = 0;
    }
  }, budget);
  expect(e).toMatchObject({ quiescence: "UNKNOWN", code: kind === "time" ? "RECONCILIATION_INSPECTION_TIMEOUT" : "RECONCILIATION_PROCESS_SCOPE_LIMIT" });
  expect(calls()).toEqual({ psCalls: 4, lsofCalls: 2 });
});
it("shares the retry cap and original physical root across pre/post fingerprint scans", () => {
  const budget = { deadline: performance.now() + 20_000, remainingBytes: 64 * 1024 * 1024, remainingRetries: 1 };
  appearingProcess();
  const first = scanReconciliationProcesses(context, undefined, budget);
  expect(first.quiescence).toBe("QUIESCENT");
  const stable = scanReconciliationProcesses(context, undefined, budget);
  expect(stable).toMatchObject({ quiescence: "QUIESCENT", observation_retry: first.observation_retry });
  expect(budget.remainingRetries).toBe(0);
  const calls = appearingProcess();
  expect(scanReconciliationProcesses(context, undefined, budget).quiescence).toBe("UNKNOWN");
  expect(calls()).toEqual({ psCalls: 4, lsofCalls: 2 });
  vi.mocked(fs.lstatSync).mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 99 } as fs.Stats);
  expect(scanReconciliationProcesses(context, undefined, budget).code).toBe("RECONCILIATION_ROOT_CHANGED");
  expect(calls()).toEqual({ psCalls: 4, lsofCalls: 2 });
});
it("retains a successful resample when later Git, worker or cancellation checks fail", () => {
  appearingProcess();
  const quiet = scanReconciliationProcesses(context);
  expect(quiet.quiescence).toBe("QUIESCENT");
  expect(quiet.observation_retry?.attempts).toBe(2);
  const error = new GitReadError("GIT_SNAPSHOT_FAILED", "scoped_objects", "budget_exhausted");
  const cause = { code: error.code, stage: error.stage, reason: error.reason, limits: error.details().limits };
  for (const code of ["RECONCILIATION_GIT_UNVERIFIED", "RECONCILIATION_INSPECTION_FAILED", "RECONCILIATION_CANCELLED"] as const) {
    const failed = incompleteProcessEvidence(quiet, code, code === "RECONCILIATION_GIT_UNVERIFIED" ? cause : undefined);
    expect(failed).toMatchObject({ coverage: "INCOMPLETE", quiescence: "UNKNOWN", code,
      observation_retry: quiet.observation_retry });
    expect(processEvidenceSchema.safeParse(JSON.parse(JSON.stringify(failed))).success).toBe(true);
    const timedOut = incompleteProcessEvidence(failed, "RECONCILIATION_TIMEOUT");
    expect(timedOut).toMatchObject({ quiescence: "UNKNOWN", observation_retry: quiet.observation_retry });
    expect(timedOut.git_failure).toEqual(failed.git_failure);
    expect(quarantine(failed).new_unrelated_writer_admission).toBe("BLOCKED");
  }
  expect(processEvidenceSchema.safeParse({ ...quiet, evidence_hash: "0".repeat(64) }).success).toBe(false);
});
it("does not retry permission failures mixed with a new PID or discard incomplete diagnostics", () => {
  const calls = appearingProcess();
  vi.mocked(fs.realpathSync.native).mockImplementation(p => { if (p === "/outside") throw Object.assign(new Error(), { code: "EPERM" }); return String(p); });
  const e = scanReconciliationProcesses(context);
  expect(e.quiescence).toBe("UNKNOWN"); expect(e.observation_retry).toBeUndefined();
  expect(calls().lsofCalls).toBe(2);
});
it.each(["root-swap", "root-alias", "EPERM", "ps-failure", "ps-malformed", "lsof-failure", "lsof-warning", "lsof-malformed"])("does not recover from %s during resampling", kind => {
  const calls = appearingProcess();
  const collect = vi.mocked(spawnSync).getMockImplementation()!;
  vi.mocked(spawnSync).mockImplementation((...args) => {
    const result = collect(...args);
    if (calls().psCalls >= 5) {
      if (kind === "root-swap") vi.mocked(fs.lstatSync).mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 99 } as fs.Stats);
      if (kind === "root-alias") vi.mocked(fs.realpathSync.native).mockImplementation(p => p === "/fixture" ? "/alias" : String(p));
      if (kind === "EPERM") vi.mocked(fs.realpathSync.native).mockImplementation(p => { if (p === "/outside") throw Object.assign(new Error(), { code: "EPERM" }); return String(p); });
      if (kind.startsWith("ps-") && args[0] === "/bin/ps" || kind.startsWith("lsof-") && args[0] === "/usr/sbin/lsof") {
        if (kind.endsWith("failure")) return { ...result, status: 1 };
        if (kind.endsWith("warning")) return { ...result, stderr: "partial coverage" };
        return { ...result, stdout: "malformed" };
      }
    }
    return result;
  });
  expect(scanReconciliationProcesses(context).quiescence).toBe("UNKNOWN");
  expect(calls().lsofCalls).toBeLessThanOrEqual(4);
});
