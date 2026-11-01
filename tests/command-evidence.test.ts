import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import { observeCodeState, parseReportedTestCounts, recordCommandObservation, readCommandEvidence } from "../src/execution/command-evidence.js";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(cleanup); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const ws = "a".repeat(24), run = { task_id: "test-task", run_id: "b".repeat(32), iteration: 1 };
function fixture() {
  const root = makeTmpDir("command-workspace"), state = makeTmpDir("command-state"); roots.push(root, state);
  fs.chmodSync(state, 0o700); vi.stubEnv("C2C_STATE_DIR", state); write(root, "main.py", "print('fixture')\n");
  const event = { itemId: "item", command: "python3 -m unittest", cwd: root, status: "inProgress", completed: false,
    exitCode: null as number | null, output: null as string | null, observedAt: new Date().toISOString() };
  const start = () => recordCommandObservation(ws, root, run, event);
  const end = (extra = {}) => recordCommandObservation(ws, root, run, { ...event, completed: true, status: "completed", exitCode: 0,
    output: "......\n----------------------------------------------------------------------\nRan 6 tests in 0.123s\n\nOK\n", ...extra });
  const read = () => readCommandEvidence(ws, root, run) as any;
  return { root, state, event, start, end, read };
}
it("persists paired command facts, counts and code digest across reader instances without claiming independent PASS", () => {
  const f = fixture(); f.start(); f.end(); const value = f.read();
  expect(value).toMatchObject({ available: true, task_id: run.task_id, run_id: run.run_id, independent_test_verdict: "NOT_ATTESTED", execution_completion_is_test_pass: false });
  expect(value.commands[0]).toMatchObject({ exit_code: 0, reported_counts: { passed: 6, failed: 0, skipped: 0, total: 6 }, current_source_match: true });
  expect(value.commands[0].source_at_completion_observation.digest).toMatch(/^[a-f0-9]{64}$/);
  expect((readCommandEvidence(ws, f.root, run) as any).evidence_sha256).toBe(value.evidence_sha256);
});
it("exit zero and narrative PASS alone never produce test counts", () => {
  const f = fixture(); f.start(); f.end({ output: "All six tests PASS" });
  expect(f.read().commands[0].reported_counts).toBeNull();
});
it("failed command exit is independent of output claiming success", () => {
  const f = fixture(); f.start(); f.end({ status: "failed", exitCode: 1 });
  expect(f.read().commands[0]).toMatchObject({ status: "failed", exit_code: 1 });
  expect(f.read().independent_test_verdict).toBe("NOT_ATTESTED");
});
it("start-only crash receipt stays incomplete and never replays a business command", () => {
  const f = fixture(); f.start();
  expect(f.read().commands[0]).toMatchObject({ status: "started", exit_code: null, completed_observed_at: null, reported_counts: null });
});
it("deduplicates notification identity and ignores duplicate changed completion", () => {
  const f = fixture(); f.start(); f.start(); f.end(); const first = f.read(); f.end({ output: "wrong" });
  expect(f.read().evidence_sha256).toBe(first.evidence_sha256); expect(f.read().commands).toHaveLength(1);
});
it("unpaired and command-mismatched completions cannot become verified tests", () => {
  const f = fixture(); f.end(); expect(f.read()).toMatchObject({ truncated: true, commands: [] });
  f.start(); f.end({ command: "different" }); expect(f.read().commands[0]).toMatchObject({ status: "unverified", exit_code: null, reported_counts: null });
});
it("detects changed current source and does not ascribe old tests to it", () => {
  const f = fixture(); f.start(); f.end(); write(f.root, "main.py", "changed\n");
  expect(f.read().commands[0].current_source_match).toBe(false);
});
it("limits command count and declares truncated rather than overwriting evidence", () => {
  const f = fixture(); for (let i = 0; i < 35; i++) recordCommandObservation(ws, f.root, run, { ...f.event, itemId: "id-" + i });
  expect(f.read()).toMatchObject({ truncated: true }); expect(f.read().commands).toHaveLength(32);
});
it("oversized output is explicitly unavailable", () => {
  const f = fixture(); f.start(); f.end({ output: "x".repeat(128 * 1024 + 1) });
  expect(f.read().commands[0]).toMatchObject({ output_sha256: null, reported_counts: null });
});
it("source aliases fail closed and sensitive file content is not captured", () => {
  const f = fixture(); write(f.root, ".env", "KEY=never-read");
  const original = observeCodeState(f.root); expect(original.complete).toBe(true);
  fs.symlinkSync(path.join(f.root, "main.py"), path.join(f.root, "alias.py"));
  expect(observeCodeState(f.root).complete).toBe(false);
});
it("does not accept caller workspace evidence files, wrong run binding or tampering", () => {
  const f = fixture(); f.start(); f.end();
  expect(readCommandEvidence(ws, f.root, { ...run, task_id: "another" })).toMatchObject({ available: false });
  const file = path.join(f.state, "command-evidence", ws, run.run_id + ".json");
  const body = JSON.parse(fs.readFileSync(file, "utf8")); body.commands[0].exit_code = 99; fs.writeFileSync(file, JSON.stringify(body));
  expect(f.read()).toMatchObject({ available: false, reason: "COMMAND_EVIDENCE_UNVERIFIED" });
  vi.stubEnv("C2C_STATE_DIR", path.join(f.root, "fake-state")); expect(() => f.start()).toThrow("UNTRUSTED_LOCATION");
});
it.each(["6 passed", "PASS", "Tests  2 passed (4)", "== 1 passed, 1 xfailed in 0.1s ==", "Ran 6 tests in 0.1s\nOK\nmore unverified output"])("rejects ambiguous output: %s", output => expect(parseReportedTestCounts(output)).toBeNull());
it.each([["== 6 passed in 0.2s ==", 6, 0, 0], [" Tests  3 passed | 1 failed | 2 skipped (6)", 3, 1, 2], ["Ran 6 tests in 0.2s\nOK (skipped=1)", 5, 0, 1]])("parses bounded runner claims: %s", (output, passed, failed, skipped) => {
  expect(parseReportedTestCounts(String(output))).toEqual({ passed, failed, skipped, total: 6 });
});

it("never exports arbitrary stdout file content even when it has no recognizable credential syntax", () => {
  const f = fixture(); f.start(); f.end({ output: "PRIVATE_ARBITRARY_CONTENT" });
  const e = f.read(); expect(JSON.stringify(e)).not.toContain("PRIVATE_ARBITRARY_CONTENT");
  expect(e.commands[0].output_sha256).toMatch(/^[a-f0-9]{64}$/); expect(e.commands[0].output_summary).toBeNull();
});

it.each(["/bin/zsh -lc 'printf PRIVATE_CONTENT'", "node --eval=PRIVATE_CONTENT", "bash -ec 'printf PRIVATE_CONTENT'", "python3 -c PRIVATE_CONTENT"])("withholds complex command content: %s", command => {
  const f = fixture(); recordCommandObservation(ws, f.root, run, { ...f.event, command });
  const e = f.read(); expect(JSON.stringify(e)).not.toContain("PRIVATE_CONTENT");
  expect(e.commands[0].command).toBe("[command withheld; identify by command_sha256]");
});
