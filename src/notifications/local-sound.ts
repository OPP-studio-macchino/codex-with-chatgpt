import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger/index.js";

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
