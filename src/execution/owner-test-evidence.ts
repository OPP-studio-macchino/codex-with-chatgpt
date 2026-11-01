import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { getStateDir } from "../config/paths.js";
import { readStableFile, sameFile } from "../security/stable-file.js";

export const OWNER_COMMANDS = [
  ["node", "node_modules/typescript/bin/tsc", "--noEmit"],
  ["node", "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2", "--minWorkers=1"],
  ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
  ["node", "scripts/validate-skill.mjs"],
];
const INPUTS = ["src", "tests", "scripts", "skill", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts"];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function canonicalEvidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalEvidence(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(1000000);
const counts = z.object({ passed: count, failed: count, skipped: count, total: count }).strict();
const resultSchema = z.object({
  status: z.enum(["passed", "failed", "partial"]), source_after: z.enum(["matched", "changed", "unknown"]),
  commands: z.array(z.object({ command: z.array(z.string().max(128)).max(8), exit_code: z.number().int().min(-255).max(255).nullable(),
    complete: z.boolean(), counts: counts.nullable(), test_files: counts.nullable().optional(),
  }).strict()).max(4),
}).strict();
const schema = z.object({
  schema_version: z.literal(1), source: z.literal("fixed-owner-runner"), workspace_id: z.string().regex(/^[a-f0-9]{24}$/),
  workspace_root: z.string().min(1).max(4096), recorded_at: z.string().datetime(),
  runner_manifest_sha256: hash, raw_result_sha256: hash, manifest_sha256: hash, result_sha256: hash,
  manifest: z.record(z.string().max(512), hash), result: resultSchema,
}).strict();
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

/** Trusted state only. No query argument can nominate a receipt or import evidence. */
export function readOwnerTestEvidence(workspaceId: string, workspaceRoot: string) {
  const unavailable = (reason: string) => ({ available: false as const, source: "fixed-owner-runner" as const, reason });
  let reason = "OWNER_EVIDENCE_INVALID";
  try {
    if (!/^[a-f0-9]{24}$/.test(workspaceId)) return unavailable("OWNER_EVIDENCE_BINDING");
    const root = fs.realpathSync.native(workspaceRoot), state = getStateDir();
    if (root !== workspaceRoot || inside(root, state)) return unavailable("OWNER_EVIDENCE_UNTRUSTED_LOCATION");
    const directory = path.join(state, "owner-test-evidence"), file = path.join(directory, `${workspaceId}.json`);
    const parents = new Map<string, fs.Stats>();
    for (let p = directory;; p = path.dirname(p)) {
      let s: fs.Stats;
      try { s = fs.lstatSync(p); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return unavailable("OWNER_EVIDENCE_ABSENT");
        throw e;
      }
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022) !== 0 ||
          (s.uid !== process.getuid?.() && s.uid !== 0) ||
          ((p === directory || p === state) && ((s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()))) return unavailable("OWNER_EVIDENCE_UNSAFE_PERMISSIONS");
      parents.set(p, s);
      if (path.dirname(p) === p) break;
    }
    let read;
    try { read = readStableFile(file, 2 * 1024 * 1024); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return unavailable("OWNER_EVIDENCE_ABSENT");
      throw e;
    }
    if ((read.stat.mode & 0o077) !== 0 || read.stat.uid !== process.getuid?.()) return unavailable("OWNER_EVIDENCE_UNSAFE_PERMISSIONS");
    const receipt = schema.parse(JSON.parse(read.data.toString("utf8")));
    if (receipt.workspace_id !== workspaceId || receipt.workspace_root !== root) return unavailable("OWNER_EVIDENCE_BINDING");
    if (Date.parse(receipt.recorded_at) > Date.now() + 60_000) return unavailable("OWNER_EVIDENCE_FUTURE_TIME");
    if (sha(canonicalEvidence(receipt.manifest)) !== receipt.manifest_sha256 || sha(canonicalEvidence(receipt.result)) !== receipt.result_sha256) return unavailable("OWNER_EVIDENCE_HASH_MISMATCH");
    const commands = receipt.result.commands;
    if (commands.some((c, i) => JSON.stringify(c.command) !== JSON.stringify(OWNER_COMMANDS[i]) ||
        [c.counts, c.test_files].some(n => n && n.passed + n.failed + n.skipped !== n.total))) return unavailable("OWNER_EVIDENCE_RESULT_INVALID");
    if (receipt.result.status === "passed" && (receipt.result.source_after !== "matched" || commands.length !== 4 ||
        commands.some(c => c.exit_code !== 0 || !c.complete) || !commands[1].counts || commands[1].counts.failed !== 0 || commands[1].counts.total === 0 ||
        !commands[1].test_files || commands[1].test_files.failed !== 0 || commands[1].test_files.total === 0 || commands[1].test_files.total > commands[1].counts.total)) return unavailable("OWNER_EVIDENCE_RESULT_INVALID");
    const names = Object.keys(receipt.manifest);
    if (!names.length || names.length > 10000 || names.some(n => !INPUTS.includes(n.split("/")[0]) || n.split("/").some(c => !c || c === "." || c === ".."))) return unavailable("OWNER_EVIDENCE_MANIFEST_INVALID");
    let currentMatch = false;
    try {
      const current: Record<string, string> = {};
      const observed = new Map<string, fs.Stats>();
      let entries = 0, bytes = 0;
      const visit = (relative: string) => {
        if (++entries > 10000) throw new Error("bounded");
        const base = path.basename(relative);
        if (base.startsWith("._") || base === ".DS_Store" || base === "__pycache__") return;
        const p = path.join(root, relative), s = fs.lstatSync(p);
        if (s.isSymbolicLink()) throw new Error("unsafe");
        if (s.isDirectory()) { observed.set(p, s); for (const name of fs.readdirSync(p).sort()) visit(`${relative}/${name}`); }
        else {
          const { data, stat } = readStableFile(p, 8 * 1024 * 1024);
          observed.set(p, stat);
          bytes += data.length; if (bytes > 64 * 1024 * 1024) throw new Error("bounded");
          current[relative] = sha(data);
        }
      };
      for (const name of INPUTS) visit(name);
      for (const [p, stat] of observed) if (!sameFile(stat, fs.lstatSync(p))) throw new Error("changed");
      currentMatch = canonicalEvidence(current) === canonicalEvidence(receipt.manifest);
    } catch { currentMatch = false; }
    for (const [p, original] of parents) {
      const now = fs.lstatSync(p);
      if (now.isSymbolicLink() || now.ino !== original.ino || now.dev !== original.dev || now.mode !== original.mode || now.uid !== original.uid) throw new Error("changed");
    }
    return { available: true as const, source: receipt.source, status: receipt.result.status, recorded_at: receipt.recorded_at,
      current_match: currentMatch, stale: !currentMatch, source_after: receipt.result.source_after,
      manifest_sha256: receipt.manifest_sha256, result_sha256: receipt.result_sha256,
      runner_manifest_sha256: receipt.runner_manifest_sha256, raw_result_sha256: receipt.raw_result_sha256,
      commands, applies_to_latest_task: false as const };
  } catch { return unavailable(reason); }
}
