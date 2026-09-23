import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/logger/index.js";
import { createLocalSoundNotifier } from "../src/notifications/local-sound.js";

const dirs: string[] = [];

afterEach(() => {
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
