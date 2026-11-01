import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger/index.js";
import type { CodexRunResult } from "../codex/app-server.js";
import type { TaskJournal } from "../execution/task-journal.js";
import type { NotificationOutcome } from "../execution/extensions.js";
import { executeRunNotice } from "./notification-native.js";
import { noticeCategory, notificationId, type NoticeCategory } from "./delivery-store.js";
import { nativeHelperCommand, type NativeHelperCommand } from "../workspace/registration-native.js";

export type CompletionNotifier = () => void;

type SoundSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: "ignore" }
) => Pick<ChildProcess, "once" | "unref">;

export interface LocalSoundNotifierOptions {
  soundPath?: string;
  logger: Logger;
  /** Test seam only; production always uses /usr/bin/afplay by default. */
  playerPath?: string;
  spawn?: SoundSpawn;
}

/**
 * Creates a best-effort local macOS sound notification. Configuration and
 * playback failures are intentionally contained so work completion is never
 * changed into a failure.
 */
export function createLocalSoundNotifier(opts: LocalSoundNotifierOptions): CompletionNotifier | undefined {
  if (!opts.soundPath) return undefined;
  if (!path.isAbsolute(opts.soundPath)) {
    opts.logger.warn("Completion sound notification is disabled due to invalid configuration.");
    return undefined;
  }

  let soundPath: string;
  try {
    soundPath = fs.realpathSync.native(opts.soundPath);
    if (!fs.statSync(soundPath).isFile()) throw new Error("not a regular file");
  } catch {
    opts.logger.warn("Completion sound notification is disabled due to invalid configuration.");
    return undefined;
  }

  const playerPath = opts.playerPath ?? "/usr/bin/afplay";
  const run = opts.spawn ?? spawn;
  return () => {
    try {
      const child = run(playerPath, [soundPath], { stdio: "ignore" });
      child.once("error", () => {
        opts.logger.warn("Completion sound notification failed.");
      });
      child.unref();
    } catch {
      opts.logger.warn("Completion sound notification failed.");
    }
  };
}

export type LocalRunNotice = Pick<CodexRunResult, "task_id" | "run_id" | "state"> & {
  workspace_id: string; notification_id: string; category: NoticeCategory;
};
export type RunNotifier = (notice: LocalRunNotice, logger: Logger, signal?: AbortSignal) => Promise<NotificationOutcome>;

/** Fixed native notice. Only an explicit helper acknowledgement proves notice receipt. */
export async function notifyLocalRun(
  notice: LocalRunNotice, logger: Logger, platform = process.platform,
  execute: NativeHelperCommand = nativeHelperCommand, signal?: AbortSignal,
): Promise<NotificationOutcome> {
  logger.warn("C2C run transition requires review; inspect task_resume_context.");
  if (platform !== "darwin") return { outcome: "unavailable" };
  return executeRunNotice(notice, execute, signal);
}

const localNotifier: RunNotifier = (notice, logger, signal) => notifyLocalRun(notice, logger, process.platform, nativeHelperCommand, signal);
const active = new Set<string>();

/** Serialized per global ID. Durable intent precedes each attempt; only delivery may retry. */
export async function dispatchRunNotification(journal: TaskJournal, workspaceId: string, run: CodexRunResult,
  eventId: string, logger: Logger, notify: RunNotifier = localNotifier, completion?: CompletionNotifier,
  signal?: AbortSignal): Promise<void> {
  const id = notificationId(workspaceId, run.run_id, eventId);
  if (active.has(id) || signal?.aborted) return;
  active.add(id);
  try {
    journal.recordNotification(workspaceId, run, eventId);
    const attempt = journal.recordNotificationDispatch(workspaceId, run, eventId, { outcome: "dispatch_intent" });
    if (!attempt) return;
    // Sound is optional, has no receipt, and is never replayed by recovery/retries.
    if (attempt === 1 && run.state === "completed") {
      try { completion?.(); } catch { logger.warn("Completion sound notification failed."); }
    }
    let outcome: NotificationOutcome;
    try { outcome = await notify({ workspace_id: workspaceId, task_id: run.task_id, run_id: run.run_id,
      state: run.state, notification_id: id, category: noticeCategory(run.state, run.reason) }, logger, signal); }
    catch { outcome = { outcome: "process_error" }; }
    journal.recordNotificationDispatch(workspaceId, run, eventId, outcome);
  } catch { logger.warn("Run notification evidence unavailable; inspect task_status for receipt evidence."); }
  finally { active.delete(id); }
}

/** Delivery worker only: no Codex, selection, approval, answer or business execution. */
export function startRunNotifications(journal: TaskJournal, workspaceId: string, logger: Logger,
  notify: RunNotifier = localNotifier, completion?: CompletionNotifier) {
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const dispatch = (run: CodexRunResult, eventId: string, sound: CompletionNotifier | null | undefined = completion) => {
    if (controller.signal.aborted) return;
    const work = dispatchRunNotification(journal, workspaceId, run, eventId, logger, notify, sound ?? undefined, controller.signal);
    pending.add(work); void work.finally(() => pending.delete(work));
  };
  const recover = () => {
    if (controller.signal.aborted) return;
    try {
      journal.recoverNotificationEvents();
      for (const event of journal.pendingNotifications()) dispatch(event.run, event.eventId, null);
    } catch { logger.warn("Run notification recovery unavailable; inspect task_status."); }
  };
  recover();
  const timer = setInterval(recover, 1_000); timer.unref();
  return { dispatch, close: async () => {
    clearInterval(timer); controller.abort();
    await Promise.allSettled(pending);
  } };
}
