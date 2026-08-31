import fs from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceError } from "./manager.js";
import { redactAndTruncate } from "../security/redaction.js";
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

async function searchWithNode(
  ws: Workspace,
  searchRel: string,
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

  const walk = async (dirRel: string): Promise<void> => {
    if (truncated || Date.now() > deadline || scannedFiles >= MAX_NODE_FILES_SCANNED) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = (await ws.readDirectoryEntries(dirRel || ".")).entries;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (ws.ignoreRules.isHidden(childRel) || ws.ignoreRules.isHidden(childRel + "/")) continue;
      if (entry.isDirectory()) {
        try {
          await ws.readDirectoryEntries(childRel);
          await walk(childRel);
        } catch {
          continue;
        }
      } else if (entry.isFile()) {
        scannedFiles++;
        if (scannedFiles > MAX_NODE_FILES_SCANNED || Date.now() > deadline) {
          truncated = true;
          return;
        }
        if (globRegex && !globRegex.test(childRel)) continue;
        const content = await ws.readSearchText(childRel);
        if (content === null) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(needle);
          if (hit) {
            const redacted = redactAndTruncate(line, 500);
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

  const start = await ws.readDirectoryEntries(searchRel || ".");
  await walk(start.rel);
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
  const { rel } = ws.resolve(opts.path ?? ".");
  if (opts.regex) {
    throw new WorkspaceError(
      "UNSUPPORTED_REGEX",
      "Regex search is disabled because mutable-path subprocess search cannot guarantee workspace containment."
    );
  }
  return searchWithNode(ws, rel, opts, limit);
}
