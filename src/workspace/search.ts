import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Workspace, WorkspaceError } from "./manager.js";
import { redactSensitiveText } from "../security/redaction.js";
import { findBinary } from "../tunnel/detect.js";

export interface SearchOptions {
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  regex?: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  matchCount: number;
  truncated: boolean;
  engine: "ripgrep" | "node";
  redactionCount: number;
}

const RG_CANDIDATES = [
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
];

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_NODE_FILES_SCANNED = 20_000;

let cachedRg: string | null | undefined;

function validatedExecutable(candidate: string): string | null {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const canonical = fs.realpathSync.native(candidate);
    const components = canonical.split(/[\\/]+/).map((part) => part.toLowerCase());
    if (components.some((part, index) => part === "node_modules" && components[index + 1] === ".bin")) {
      return null;
    }
    if (!fs.statSync(canonical).isFile()) return null;
    fs.accessSync(canonical, fs.constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function ripgrepEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { RIPGREP_CONFIG_PATH: "" };
  for (const key of ["SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function findRipgrep(): string | null {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  if (cachedRg !== undefined) return cachedRg;
  const onPath = findBinary("rg", { includePath: false });
  if (onPath) {
    cachedRg = onPath;
    return onPath;
  }
  for (const candidate of RG_CANDIDATES) {
    const executable = validatedExecutable(candidate);
    if (executable) {
      cachedRg = executable;
      return executable;
    }
  }
  cachedRg = null;
  return null;
}

/** For tests. */
export function resetRipgrepCache(): void {
  cachedRg = undefined;
}

async function searchWithRipgrep(
  ws: Workspace,
  rgBin: string,
  searchAbs: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const args = ["--no-config", "--json", "--max-filesize", "2M", "--max-count", "20"];
  if (!opts.regex) args.push("-F");
  args.push("--smart-case");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("--", opts.query, searchAbs);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(rgBin, args, {
      cwd: ws.root,
      env: ripgrepEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.resume();
    const matches: SearchMatch[] = [];
    let truncated = false;
    let redactionCount = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SEARCH_TIMEOUT_MS);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (matches.length >= limit) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      try {
        const event = JSON.parse(line) as {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (event.type !== "match" || !event.data?.path?.text) return;
        const rel = path.relative(ws.root, event.data.path.text).split(path.sep).join("/");
        if (rel.startsWith("..") || ws.ignoreRules.isHidden(rel)) return;
        const redacted = redactSensitiveText((event.data.lines?.text ?? "").trimEnd().slice(0, 500));
        redactionCount += redacted.redactionCount;
        matches.push({
          path: rel,
          line: event.data.line_number ?? 0,
          text: redacted.text,
        });
      } catch {
        // ignore malformed json lines
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("ripgrep search exceeded the local time limit"));
        return;
      }
      if (!truncated && code !== 0 && code !== 1 && signal === null) {
        reject(new Error(`ripgrep failed with exit code ${code}`));
        return;
      }
      resolvePromise({ matches, matchCount: matches.length, truncated, engine: "ripgrep", redactionCount });
    });
  });
}

async function searchWithNode(
  ws: Workspace,
  searchAbs: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const matcher = opts.regex ? new RegExp(opts.query, "i") : null;
  const needle = opts.query.toLowerCase();
  const globRegex = opts.glob ? globToRegex(opts.glob) : null;
  const matches: SearchMatch[] = [];
  let truncated = false;
  let redactionCount = 0;
  let scannedFiles = 0;
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (truncated || Date.now() > deadline || scannedFiles >= MAX_NODE_FILES_SCANNED) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (ws.ignoreRules.isHidden(childRel) || ws.ignoreRules.isHidden(childRel + "/")) continue;
      const childAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        scannedFiles++;
        if (scannedFiles > MAX_NODE_FILES_SCANNED || Date.now() > deadline) {
          truncated = true;
          return;
        }
        if (globRegex && !globRegex.test(childRel)) continue;
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(childAbs);
        } catch {
          continue;
        }
        if (stat.size > 2 * 1024 * 1024) continue;
        let content: string;
        try {
          content = await fs.promises.readFile(childAbs, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(needle);
          if (hit) {
            const redacted = redactSensitiveText(line.trimEnd().slice(0, 500));
            redactionCount += redacted.redactionCount;
            matches.push({ path: childRel, line: i + 1, text: redacted.text });
            if (matches.length >= limit) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
  };

  const startRel = path.relative(ws.root, searchAbs).split(path.sep).join("/");
  await walk(searchAbs, startRel === "" ? "" : startRel);
  return { matches, matchCount: matches.length, truncated, engine: "node", redactionCount };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

export async function searchWorkspace(ws: Workspace, opts: SearchOptions): Promise<SearchResult> {
  if (!opts.query || opts.query.length < 2) {
    return { matches: [], matchCount: 0, truncated: false, engine: "node", redactionCount: 0 };
  }
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const { abs } = ws.resolve(opts.path ?? ".");
  const rg = findRipgrep();
  if (rg) {
    try {
      return await searchWithRipgrep(ws, rg, abs, opts, limit);
    } catch (error) {
      if (opts.regex) throw error;
      // fall through to node engine
    }
  }
  if (opts.regex) {
    throw new WorkspaceError(
      "UNSUPPORTED_REGEX",
      "Regex search requires ripgrep; refusing unsafe JavaScript-regex fallback."
    );
  }
  return searchWithNode(ws, abs, opts, limit);
}
