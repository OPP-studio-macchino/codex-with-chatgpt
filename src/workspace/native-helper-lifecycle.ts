import { execFile } from "node:child_process";
import path from "node:path";

export type HelperProcessCommand = (file: string, args: string[]) => Promise<number>;
export type HelperPause = (ms: number) => Promise<void>;
const pause: HelperPause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute: HelperProcessCommand = (file, args) => new Promise(resolve => {
  execFile(file, args, {
    cwd: "/", encoding: "utf8", timeout: 1000, maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  }, error => resolve(!error ? 0 : String((error as NodeJS.ErrnoException).code) === "1" ? 1 : -1));
});

/** Exact private helper only. Call after disarming its session; never target app names globally. */
export async function terminateNativeHelper(
  app: string, run: HelperProcessCommand = execute, wait: HelperPause = pause,
): Promise<boolean> {
  if (!path.isAbsolute(app) || path.basename(app) !== "C2C Project Access.app" ||
      !/^c2c-folder-owner-[A-Za-z0-9]+$/.test(path.basename(path.dirname(app))) ||
      /[\u0000-\u001f\u007f]/u.test(app) || typeof process.getuid !== "function") return false;
  const executable = path.join(app, "Contents/MacOS/applet");
  const pattern = `^${executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const match = ["-u", String(process.getuid()), "-f", pattern];
  try {
    // Three bounded attempts replace the previous 120 unconditional TERM calls.
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = await run("/usr/bin/pgrep", match);
      if (seen === 1) {
        await wait(100);
        return (await run("/usr/bin/pgrep", match)) === 1;
      }
      if (seen !== 0) return false;
      const result = await run("/usr/bin/pkill", [attempt === 0 ? "-TERM" : "-KILL", ...match]);
      if (result !== 0 && result !== 1) return false;
      await wait(100);
    }
    return (await run("/usr/bin/pgrep", match)) === 1;
  } catch { return false; }
}
