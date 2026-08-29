import fs from "node:fs";
import path from "node:path";

function candidateDirectories(includePath: boolean): string[] {
  const directories = [
    ...(includePath ? (process.env.PATH ?? "").split(path.delimiter) : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "C:\\Program Files\\cloudflared",
    "C:\\Program Files (x86)\\cloudflared",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files\\Git\\bin",
    "C:\\Windows\\System32",
  ];
  const home = process.env.HOME;
  if (includePath && home && path.isAbsolute(home)) directories.push(path.join(home, ".local", "bin"));
  return [...new Set(directories.filter((dir) => dir && path.isAbsolute(dir)))];
}

/** Locate an executable in common system locations; PATH lookup is opt-in. */
export function findBinary(name: string, opts: { includePath?: boolean } = {}): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of candidateDirectories(opts.includePath ?? false)) {
    const full = path.join(dir, exe);
    try {
      if (!fs.existsSync(full)) continue;
      const canonical = fs.realpathSync.native(full);
      const components = canonical.split(/[\\/]+/).map((part) => part.toLowerCase());
      if (components.some((part, index) => part === "node_modules" && components[index + 1] === ".bin")) {
        continue;
      }
      if (!fs.statSync(canonical).isFile()) continue;
      fs.accessSync(canonical, fs.constants.X_OK);
      return canonical;
    } catch {
      // try next
    }
  }
  return null;
}

export interface TunnelBinaries {
  cloudflared: string | null;
  wrangler: string | null;
}

export function detectTunnelBinaries(): TunnelBinaries {
  return {
    cloudflared: findBinary("cloudflared", { includePath: false }),
    wrangler: findBinary("wrangler", { includePath: false }),
  };
}
