import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskJournal } from "../src/execution/task-journal.js";
import { ExtensionStore, extensionHash } from "../src/execution/extensions.js";
import { dispatchRunNotification, startRunNotifications } from "../src/notifications/local-sound.js";
import { notificationId, notificationFile } from "../src/notifications/delivery-store.js";
import { nullLogger } from "../src/logger/index.js";
import { TaskJournal as R32, inspectTaskJournalLayout as r32Layout } from "./fixtures/legacy-r32/dist/execution/task-journal.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = "a".repeat(24), run = { task_id: "notification", iteration: 1, run_id: "b".repeat(32), state: "running" as const };
const final = { ...run, state: "completed" as const };
let state: string;
const journals: Array<TaskJournal | R32> = [];
const open = () => { const j = new TaskJournal(workspace); journals.push(j); return j; };
const main = () => path.join(state, "task-journal", workspace + ".json");
const bytes = () => fs.readFileSync(main(), "utf8");
const notices = (j: TaskJournal) => (j.status(workspace) as any).tasks[0];
beforeEach(() => { state = isolateStateDir(); vi.stubEnv("C2C_STATE_DIR", state); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const j of journals.splice(0)) j.close(); cleanup(state); vi.unstubAllEnvs(); });

it.each([
  { outcome: "process_exit", exit_code: 0 }, { outcome: "process_exit", exit_code: 9 },
  { outcome: "process_exit", exit_code: null }, { outcome: "process_error" }, { outcome: "timeout" }, { outcome: "unavailable" },
] as const)("redelivers %j with the same ID and bounded spool, never business execution", async outcome => {
  vi.useFakeTimers();
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final); const before = bytes();
  const notify = vi.fn(async () => outcome), sound = vi.fn();
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify, sound);
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify, sound);
  expect(notify).toHaveBeenCalledTimes(1);
  const ledger = path.join(state, "task-extensions", workspace + ".journal.json");
  const evidence = fs.readFileSync(ledger, "utf8");
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify, sound);
  }
  expect(notify).toHaveBeenCalledTimes(13); expect(sound).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(ledger, "utf8")).toBe(evidence);
  expect(fs.statSync(notificationFile(notificationId(workspace, run.run_id, "terminal"))).size).toBeLessThan(4096);
  expect(new Set(notify.mock.calls.map(call => call[0].notification_id)).size).toBe(1);
  expect(notices(j).notifications[0]).toMatchObject({ presentation_policy: "persistent_until_acknowledgement",
    automatic_delivery_retry: true, automatic_retry: false, user_receipt: "unknown", os_presentation: "unknown",
    delivery: { attempts: 13, observation: outcome } });
  expect(bytes()).toBe(before);
});

it.each([
  ["blocked", "blocked"], ["failed", "child_exit"], ["blocked", "approval_required"],
  ["blocked", "user_input_required"], ["blocked", "mcp_elicitation_required"],
  ["blocked", "decision_owner_attention"], ["completed", undefined],
] as const)("durably hands off %s/%s; concurrent callbacks and acknowledgement grant no authority", async (state, reason) => {
  const j = open(); j.begin(workspace, { ...run, execution_mode: "read_only" }, "fixture");
  const pending = { ...run, state, reason };
  const before = bytes();
  let acknowledge!: (outcome: { outcome: "notice_acknowledged" }) => void;
  const notify = vi.fn(() => new Promise<{ outcome: "notice_acknowledged" }>(resolve => { acknowledge = resolve; }));
  const dispatched = dispatchRunNotification(j, workspace, pending, "attention:1", nullLogger, notify);
  await Promise.all(Array.from({ length: 10 }, () => dispatchRunNotification(j, workspace, pending, "attention:1", nullLogger, notify)));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notices(j).notifications[0]).toMatchObject({ notice_acknowledgement: "pending", execution_mode: "read_only",
    notification_id: notificationId(workspace, run.run_id, "attention:1"), iteration: 1,
    handoff: { grants_authority: false, revalidate_live_channel: true } });
  acknowledge({ outcome: "notice_acknowledged" }); await dispatched;
  expect(notices(j)).toMatchObject({ execution_state: "running", notifications: [{ notice_acknowledgement: "acknowledged",
    acknowledgement_grants_authority: false, automatic_delivery_retry: false, automatic_retry: false, goal_verified: false }] });
  expect(j.checkpointStatus(workspace, run.task_id)).toEqual([]); expect(bytes()).toBe(before);
  j.close(); const reopened = open();
  const worker = startRunNotifications(reopened, workspace, nullLogger, notify);
  await worker.close();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notices(reopened)).toMatchObject({ execution_state: "interrupted", execution_mode: "read_only" });
  expect(bytes()).toBe(before);
});

it("delivers the same ID after intent commit, crash before invoke, and previous-runtime restart", async () => {
  vi.useFakeTimers();
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  const original = j.recordNotificationDispatch.bind(j);
  const fault = vi.spyOn(j, "recordNotificationDispatch").mockImplementation((w, r, id, observation) => {
    original(w, r, id, observation); throw new Error("fixture crash after durable intent");
  });
  const notify = vi.fn(async () => ({ outcome: "notice_acknowledged" as const }));
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify); fault.mockRestore();
  expect(notify).not.toHaveBeenCalled(); const before = bytes(); j.close();
  const reopened = open(), worker = startRunNotifications(reopened, workspace, nullLogger, notify);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0].notification_id).toBe(notificationId(workspace, run.run_id, "terminal"));
  expect(notices(reopened).notifications[0].notice_acknowledgement).toBe("acknowledged");
  await worker.close(); expect(bytes()).toBe(before);
});

it("a failed attempt is retried by its timer without polls, and close aborts only delivery", async () => {
  vi.useFakeTimers();
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  const notify = vi.fn().mockResolvedValueOnce({ outcome: "process_error" }).mockResolvedValue({ outcome: "notice_acknowledged" });
  const worker = startRunNotifications(j, workspace, nullLogger, notify);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(notify).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000); expect(notify).toHaveBeenCalledTimes(2);
  await worker.close();
});

it.each(["before_terminal_rename", "after_terminal_rename"] as const)("closes the terminal/event gap at %s without promoting other prepared evidence", async phase => {
  const j = open(); j.begin(workspace, run, "fixture"); const rename = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === main()) {
      if (phase === "after_terminal_rename") rename(from, to);
      throw new Error("fixture terminal crash");
    }
    return rename(from, to);
  });
  expect(() => j.complete(workspace, final)).toThrow(); fault.mockRestore(); j.close();
  const reopened = open(), notify = vi.fn(async () => ({ outcome: "notice_acknowledged" as const }));
  const worker = startRunNotifications(reopened, workspace, nullLogger, notify);
  await worker.close();
  expect(notify).toHaveBeenCalledTimes(phase === "after_terminal_rename" ? 1 : 0);
  expect(notices(reopened).execution_state).toBe(phase === "after_terminal_rename" ? "completed" : "interrupted");
});

it.each(["reservation", "intent", "spool"] as const)("never invokes before successful %s commit", async phase => {
  const j = open(); j.begin(workspace, run, "fixture"); const rename = fs.renameSync;
  const ledger = path.join(state, "task-extensions", workspace + ".journal.json");
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (phase === "spool" && String(to).includes("notification-delivery")) throw new Error("fixture spool failure");
    if (phase !== "spool" && String(to) === ledger) {
      const value = JSON.parse(fs.readFileSync(from, "utf8"));
      if (value.entries.some((e: any) => e.payload.kind === (phase === "reservation" ? "notification" : "notification_dispatch") &&
        value.committed.includes(e.id))) throw new Error("fixture commit failure");
    }
    return rename(from, to);
  });
  const notify = vi.fn(async () => ({ outcome: "unavailable" as const }));
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify);
  expect(notify).not.toHaveBeenCalled(); fault.mockRestore();
});

it.each(["corrupt", "symlink", "tampered", "permissive", "missing-ledger"] as const)("fails closed on %s evidence", async fault => {
  vi.useFakeTimers();
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, async () => ({ outcome: "timeout" }));
  const spool = notificationFile(notificationId(workspace, run.run_id, "terminal"));
  if (fault === "corrupt") fs.writeFileSync(spool, "{truncated");
  if (fault === "symlink") { fs.renameSync(spool, spool + ".outside"); fs.symlinkSync(spool + ".outside", spool); }
  if (fault === "tampered") { const v = JSON.parse(fs.readFileSync(spool, "utf8")); v.payload.observation = { outcome: "notice_acknowledged" }; fs.writeFileSync(spool, JSON.stringify(v)); }
  if (fault === "permissive") {
    fs.chmodSync(spool, 0o644);
    // Some fixture volumes ignore chmod. Exercise the same descriptor validation there.
    if ((fs.statSync(spool).mode & 0o077) === 0) {
      const inode = fs.statSync(spool).ino, lstat = fs.lstatSync, fstat = fs.fstatSync;
      const mode = (s: fs.Stats) => { if (s.ino === inode) s.mode |= 0o044; return s; };
      vi.spyOn(fs, "lstatSync").mockImplementation((...args: any[]) => mode((lstat as any)(...args)) as any);
      vi.spyOn(fs, "fstatSync").mockImplementation((...args: any[]) => mode((fstat as any)(...args)) as any);
    }
  }
  if (fault === "missing-ledger") fs.unlinkSync(path.join(state, "task-extensions", workspace + ".journal.json"));
  j.close(); const reopened = open(), notify = vi.fn(async () => ({ outcome: "notice_acknowledged" as const }));
  await vi.advanceTimersByTimeAsync(60_000);
  await dispatchRunNotification(reopened, workspace, final, "terminal", nullLogger, notify);
  expect(notify).not.toHaveBeenCalled();
});

it("missing attempt evidence never suppresses delivery, but cannot erase a committed acknowledgement", async () => {
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  const notify = vi.fn().mockResolvedValueOnce({ outcome: "timeout" }).mockResolvedValue({ outcome: "notice_acknowledged" });
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify);
  const spool = notificationFile(notificationId(workspace, run.run_id, "terminal"));
  fs.unlinkSync(spool); j.close(); const reopened = open();
  await dispatchRunNotification(reopened, workspace, final, "terminal", nullLogger, notify);
  expect(notify).toHaveBeenCalledTimes(2);
  fs.unlinkSync(spool);
  await dispatchRunNotification(reopened, workspace, final, "terminal", nullLogger, notify);
  expect(notify).toHaveBeenCalledTimes(2);
});

it("does not backfill old completed history lacking an explicit event", async () => {
  const old = new R32(workspace); journals.push(old); old.begin(workspace, run, "fixture"); old.complete(workspace, final); old.close();
  const reopened = open(), notify = vi.fn(async () => ({ outcome: "notice_acknowledged" as const }));
  const worker = startRunNotifications(reopened, workspace, nullLogger, notify); await worker.close();
  expect(notify).not.toHaveBeenCalled(); expect(notices(reopened).notifications).toEqual([]);
});

it("resumes an old committed reservation/intent/outcome without a spool using its same ID", async () => {
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final); j.close();
  const store = new ExtensionStore(workspace, "journal", main());
  const reservation = store.entries().find(e => e.payload.kind === "notification")!;
  if (reservation.payload.kind !== "notification") throw new Error("fixture reservation");
  for (const observation of [{ outcome: "dispatch_intent" }, { outcome: "process_exit", exit_code: 0 }] as const) {
    store.commit([store.prepare({ kind: "notification_dispatch", binding: reservation.payload.binding,
      dispatch: { event_id: "terminal", observed_at: new Date().toISOString(), observation } })]);
  }
  const reopened = open(), notify = vi.fn(async () => ({ outcome: "notice_acknowledged" as const }));
  const worker = startRunNotifications(reopened, workspace, nullLogger, notify); await worker.close();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0].notification_id).toBe(notificationId(workspace, run.run_id, "terminal"));
});

it("reuses a prepared explicit receipt after repeated commit failures without ledger growth", async () => {
  vi.useFakeTimers();
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  const original = ExtensionStore.prototype.commit;
  const fault = vi.spyOn(ExtensionStore.prototype, "commit").mockImplementation(function(ids) {
    if (this.entries().some(e => ids.includes(e.id) && e.payload.kind === "notification_dispatch" &&
      e.payload.dispatch.observation.outcome === "notice_acknowledged")) throw new Error("fixture receipt commit failure");
    return original.call(this, ids);
  });
  const notify = vi.fn(async () => ({ outcome: "notice_acknowledged" as const }));
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify);
  const evidence = JSON.stringify(j.extensionStatus());
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify);
    expect(JSON.stringify(j.extensionStatus())).toBe(evidence);
  }
  fault.mockRestore(); j.close(); const reopened = open();
  await vi.advanceTimersByTimeAsync(60_000);
  await dispatchRunNotification(reopened, workspace, final, "terminal", nullLogger, notify);
  expect(notices(reopened).notifications[0].notice_acknowledgement).toBe("acknowledged");
});

it("rejects a changed duplicate event and treats a backward clock as unknown timing", async () => {
  vi.useFakeTimers();
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  const notify = vi.fn(async () => ({ outcome: "timeout" as const }));
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify);
  await dispatchRunNotification(j, workspace, { ...final, state: "failed" }, "terminal", nullLogger, notify);
  expect(notify).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() - 60_000);
  await dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify);
  expect(notify).toHaveBeenCalledTimes(2);
});

it("aborts an in-flight notice and waits for closure without resuming execution", async () => {
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  const before = bytes(); let stopped = false;
  const worker = startRunNotifications(j, workspace, nullLogger, (_notice, _logger, signal) => new Promise(resolve => {
    signal!.addEventListener("abort", () => { stopped = true; resolve({ outcome: "process_error" }); }, { once: true });
  }));
  await worker.close(); expect(stopped).toBe(true); expect(bytes()).toBe(before);
  expect(notices(j).notifications[0].notice_acknowledgement).toBe("pending");
});

it("serializes the same global ID even when a journal is reopened while an old attempt settles", async () => {
  const j = open(); j.begin(workspace, run, "fixture"); j.complete(workspace, final);
  let finish!: (outcome: { outcome: "timeout" }) => void;
  const notify = vi.fn(() => new Promise<{ outcome: "timeout" }>(resolve => { finish = resolve; }));
  const first = dispatchRunNotification(j, workspace, final, "terminal", nullLogger, notify);
  j.close(); const reopened = open();
  await dispatchRunNotification(reopened, workspace, final, "terminal", nullLogger, notify);
  expect(notify).toHaveBeenCalledTimes(1);
  finish({ outcome: "timeout" }); await first;
});

it("bounds event count without eviction and keeps raw prompts/IDs/errors out of handoffs", async () => {
  const j = open(); j.begin(workspace, run, "fixture");
  for (let i = 0; i < 34; i++) j.recordNotification(workspace, final, "event:" + i);
  const notify = vi.fn(async () => { throw new Error("nonce=private proof=private"); });
  await dispatchRunNotification(j, workspace, { ...final, reason: "prompt=secret", elicitation_request_id: "c".repeat(32) }, "event:0", nullLogger, notify);
  await dispatchRunNotification(j, workspace, final, "event:34", nullLogger, notify);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(notices(j).notifications)).not.toMatch(/nonce=|proof=|prompt=|cccccccc/);
  expect(notices(j).notifications).toHaveLength(34);
});

it.each([{ outcome: "timeout" }, { outcome: "notice_acknowledged" }] as const)("local notice %j preserves actual r32 readability, old-writer roundtrip and canonical reconciliation hashes", async outcome => {
  const j = open(); j.begin(workspace, run, "fixture"); const failed = { ...run, state: "failed" as const, reason: "child_exit" };
  j.complete(workspace, failed); const before = bytes(), hash = extensionHash(JSON.stringify(JSON.parse(before).runs[0]));
  await dispatchRunNotification(j, workspace, failed, "terminal", nullLogger, async () => outcome);
  expect(bytes()).toBe(before); j.close(); expect(r32Layout(state)).toMatchObject({ journals: 1, runs: 1 });
  const old = new R32(workspace); journals.push(old);
  const target = old.reconciliationTarget(workspace, run.task_id, run.run_id); expect(target.source_record_sha256).toBe(hash);
  old.reconcileConfirmed(target, "d".repeat(64), new Date().toISOString());
  const appended = { ...run, task_id: "r32-append", run_id: "e".repeat(32) };
  old.begin(workspace, appended, "old writer fixture"); old.complete(workspace, { ...appended, state: "completed" }); old.close();
  const after = bytes(), reopened = open();
  expect((reopened.status(workspace, run.task_id) as any).tasks[0]).toMatchObject({ reconciliation: { source_record_sha256: hash },
    notifications: [{ observations: [{ observation: { outcome: "dispatch_intent" } }, { observation: outcome }] }] });
  expect(bytes()).toBe(after);
});
