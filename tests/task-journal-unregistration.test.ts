import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { workspaceUnregistrationSafety } from "../src/execution/task-journal.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = "a".repeat(24);
const now = "2026-11-01T00:00:00.000Z";
const later = "2026-11-01T00:01:00.000Z";
let state: string | undefined;
let previous: string | undefined;

afterEach(() => {
  if (state) cleanup(state);
  if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous;
  state = undefined;
});

function run(state = "completed", reason?: string) {
  return { task_id: "task", workspace_id: workspace, iteration: 1, run_id: "b".repeat(32), state,
    runtime_id: "c".repeat(32), instruction_excerpt: "fixture", instruction_truncated: false,
    request_sha256: "d".repeat(64), started_at: now, updated_at: now, ...(reason ? { reason } : {}) };
}
function checkpoint(status: "approved" | "consumed" | "revoked", expires_at = later) {
  return { workspace_id: workspace, task_id: "task", next_iteration: 2, source: "journal",
    source_sha256: "e".repeat(64), known_records: [{ iteration: 1, run_id: "b".repeat(32) }],
    request_sha256: "d".repeat(64), instruction_excerpt: "fixture", instruction_truncated: false,
    checkpoint_id: "f".repeat(32), runtime_id: "c".repeat(32), evidence_sha256: "0".repeat(64),
    owner_approved_at: now, expires_at, status,
    ...(status === "consumed" ? { consumed_run_id: "1".repeat(32) } : {}) };
}
function consumedRun() {
  return { ...run(), iteration: 2, run_id: "1".repeat(32), state: "completed", started_at: "2026-11-01T00:00:30.000Z", updated_at: "2026-11-01T00:00:30.000Z" };
}
function writeSnapshot(snapshot: unknown) {
  previous = process.env.C2C_STATE_DIR;
  state = isolateStateDir();
  const dir = path.join(state, "task-journal");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${workspace}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 }); fs.chmodSync(file, 0o600);
}

it.each([
  ["normal terminal history", { version: 1, runs: [run()] }, "clear"],
  ["running work", { version: 1, runs: [run("running")] }, "blocking"],
  ["waiting input", { version: 1, runs: [run("blocked", "user_input_required")] }, "blocking"],
  ["approved checkpoint before expiry", { version: 1, runs: [run()], checkpoints: [checkpoint("approved")] }, "blocking"],
  ["approved checkpoint after expiry", { version: 1, runs: [run()], checkpoints: [{ ...checkpoint("approved"), owner_approved_at: "2026-10-01T00:00:00.000Z", expires_at: "2026-10-01T00:01:00.000Z" }] }, "blocking"],
  ["valid consumed checkpoint", { version: 1, runs: [run(), consumedRun()], checkpoints: [checkpoint("consumed")] }, "clear"],
  ["consumed checkpoint without its next-iteration run", { version: 1, runs: [run()], checkpoints: [checkpoint("consumed")] }, "unknown"],
  ["consumed checkpoint with mismatched run evidence", { version: 1, runs: [run(), { ...consumedRun(), request_sha256: "1".repeat(64) }], checkpoints: [checkpoint("consumed")] }, "unknown"],
  ["consumed checkpoint with mismatched runtime", { version: 1, runs: [run(), { ...consumedRun(), runtime_id: "1".repeat(32) }], checkpoints: [checkpoint("consumed")] }, "unknown"],
  ["reused consumed run", { version: 1, runs: [run(), consumedRun()], checkpoints: [checkpoint("consumed"), { ...checkpoint("consumed"), checkpoint_id: "2".repeat(32) }] }, "unknown"],
  ["consumed action without journal evidence", { version: 1, runs: [run()], checkpoints: [{ ...checkpoint("consumed"), consumed_run_id: undefined, consumed_action_id: "1".repeat(32) }] }, "unknown"],
  ["revoked checkpoint", { version: 1, runs: [run()], checkpoints: [checkpoint("revoked")] }, "clear"],
  ["malformed checkpoint", { version: 1, runs: [run()], checkpoints: [{ ...checkpoint("approved"), status: "unknown" }] }, "unknown"],
  ["mismatched record", { version: 1, runs: [{ ...run(), workspace_id: "b".repeat(24) }] }, "unknown"],
  ["blocked recovery", { version: 1, runs: [run()], recoveries: [{ recovery_id: "1".repeat(32), workspace_id: workspace,
    state: "blocked", updated_at: now, records: [{ task_id: "task", run_id: "b".repeat(32), source_record_sha256: "2".repeat(64) }] }] }, "unknown"],
] as const)("returns %s safely", (_name, snapshot, expected) => {
  writeSnapshot(snapshot);
  expect(workspaceUnregistrationSafety(workspace)).toBe(expected);
});
