import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/logger/index.js";
import { createLocalSoundNotifier, notifyLocalRun } from "../src/notifications/local-sound.js";

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function soundFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-sound-"));
  dirs.push(dir);
  const file = path.join(dir, "complete.aiff");
  fs.writeFileSync(file, "sound");
  return file;
}

describe("local completion sound", () => {
  it("is disabled when unset or invalid", () => {
    expect(createLocalSoundNotifier({ logger: nullLogger })).toBeUndefined();
    expect(createLocalSoundNotifier({ soundPath: "relative.aiff", logger: nullLogger })).toBeUndefined();
    expect(createLocalSoundNotifier({ soundPath: "/not/a/sound.aiff", logger: nullLogger })).toBeUndefined();
  });

  it("spawns afplay safely with the canonical sound file", () => {
    const file = soundFile();
    const calls: Array<{ command: string; args: readonly string[]; stdio: string }> = [];
    const notifier = createLocalSoundNotifier({
      soundPath: file,
      playerPath: "/tmp/fake-afplay",
      logger: nullLogger,
      spawn: (command, args, options) => {
        calls.push({ command, args, stdio: options.stdio });
        return { once: () => undefined, unref: () => undefined } as Pick<ChildProcess, "once" | "unref">;
      },
    });

    notifier?.();
    expect(calls).toEqual([{
      command: "/tmp/fake-afplay",
      args: [fs.realpathSync.native(file)],
      stdio: "ignore",
    }]);
  });

  it("contains player failures", () => {
    const notifier = createLocalSoundNotifier({
      soundPath: soundFile(),
      logger: nullLogger,
      spawn: () => {
        throw new Error("spawn failed");
      },
    });

    expect(() => notifier?.()).not.toThrow();
  });
});

const notice = { notification_id: "c".repeat(64), category: "completed" as const, workspace_id: "a".repeat(24), task_id: "task", run_id: "b".repeat(32), state: "completed" as const };
it("contains native helper errors without exposing raw text and never runs off macOS", async () => {
  const logger = { ...nullLogger, warn: vi.fn() };
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-notice-state-")); dirs.push(state); vi.stubEnv("C2C_STATE_DIR", state);
  const execute = vi.fn(async () => { throw new Error("nonce=secret proof=secret"); });
  expect(await notifyLocalRun(notice, logger, "darwin", execute)).toEqual({ outcome: "process_error" });
  const calls = execute.mock.calls.length;
  expect(await notifyLocalRun(notice, logger, "linux", execute)).toEqual({ outcome: "unavailable" });
  expect(execute).toHaveBeenCalledTimes(calls);
  expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/nonce=|proof=/);
});
