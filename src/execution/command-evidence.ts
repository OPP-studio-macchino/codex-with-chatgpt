import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod/v3";
import { getStateDir } from "../config/paths.js";
import { readPrivateFile, writePrivateFile, readStableFile, sameFile } from "../security/stable-file.js";
import { redactAndTruncate } from "../security/redaction.js";
import { IgnoreRules } from "../workspace/ignore.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const count = z.number().int().min(0).max(1000000);
const countsSchema = z.object({ passed: count, failed: count, skipped: count, total: count }).strict()
  .refine(c => c.passed + c.failed + c.skipped === c.total);
const stateSchema = z.object({ scope: z.literal("visible-workspace-files-v1"), observed_at: z.string().datetime(),
  complete: z.boolean(), file_count: count, digest: hash.nullable(), reason: z.enum(["bounded_or_unstable", "unavailable"]).nullable(),
}).strict();
export type CodeObservation = z.infer<typeof stateSchema>;
const recordSchema = z.object({ notification_id: hash, item_id_sha256: hash, command: z.string().max(2048), command_sha256: hash,
  started_observed_at: z.string().datetime(), completed_observed_at: z.string().datetime().nullable(),
  exit_code: z.number().int().min(-2147483648).max(2147483647).nullable(),
  status: z.enum(["started", "completed", "failed", "declined", "unverified"]), output_sha256: hash.nullable(),
  output_bytes: count.nullable(), output_summary: z.string().max(4096).nullable(),
  reported_counts: countsSchema.nullable(), verification: z.literal("protocol-observation-not-independent-test-attestation"),
  source_at_start_observation: stateSchema, source_at_completion_observation: stateSchema.nullable(),
}).strict();
const bodySchema = z.object({ version: z.literal(1), source: z.literal("codex-app-server-command-events"),
  workspace_id: z.string().regex(/^[a-f0-9]{24}$/), workspace_root_sha256: hash,
  task_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), run_id: id, iteration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  commands: z.array(recordSchema).max(32), truncated: z.boolean(),
}).strict();
const receiptSchema = bodySchema.extend({ evidence_sha256: hash }).strict();
type Body = z.infer<typeof bodySchema>;
export interface CommandObservation {
  itemId: string; completed: boolean; command: string; cwd: string; status: string;
  exitCode: number | null; output: string | null; observedAt: string;
}
export interface CommandBinding { task_id: string; run_id: string; iteration: number }
const inside = (root: string, value: string) => value === root || value.startsWith(root + path.sep);

/** Observation only: never executes Git, a command, a test, or an approval. Excluded
 * files/dependencies are not attested. The start notification can follow OS execution;
 * equal hashes do not prove absence of an intermediate change. */
export function observeCodeState(root: string): CodeObservation {
  const observed_at = new Date().toISOString();
  let files = 0;
  try {
    if (fs.realpathSync.native(root) !== root) throw new Error();
    const policy = new IgnoreRules(root), start = performance.now();
    const observations = new Map<string, fs.Stats>();
    const manifest: Array<[string, number, string]> = [];
    let bytes = 0, entries = 0;
    const visit = (relative: string) => {
      if (++entries > 4000 || performance.now() - start > 500) throw new Error();
      if (relative && (policy.isSensitive(relative) || policy.isNoise(relative) || policy.isNoise(relative + "/") || policy.isSensitive(relative + "/"))) return;
      const file = path.join(root, relative), s = fs.lstatSync(file);
      if (s.isSymbolicLink()) throw new Error();
      if (s.isDirectory()) {
        observations.set(file, s);
        for (const name of fs.readdirSync(file).sort()) visit(relative ? relative + "/" + name : name);
      } else {
        const { data, stat } = readStableFile(file, 8 * 1024 * 1024);
        bytes += data.length; if (bytes > 32 * 1024 * 1024) throw new Error();
        observations.set(file, stat); files++;
        manifest.push([relative, stat.mode & 0o777, sha(data)]);
      }
    };
    visit("");
    for (const [file, stat] of observations) if (!sameFile(stat, fs.lstatSync(file))) throw new Error();
    return { scope: "visible-workspace-files-v1", observed_at, complete: true, file_count: files, digest: sha(JSON.stringify(manifest)), reason: null };
  } catch { return { scope: "visible-workspace-files-v1", observed_at, complete: false, file_count: files, digest: null, reason: "bounded_or_unstable" }; }
}

/** Counts are explicitly runner-output claims, never inferred from narrative or exit 0. */
export function parseReportedTestCounts(output: string): z.infer<typeof countsSchema> | null {
  if (Buffer.byteLength(output) > 128 * 1024) return null;
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, "");
  const unittest = /^Ran (\d+) tests? in [\d.]+s\r?$/m.exec(normalized);
  if (unittest && (normalized.match(/^Ran \d+ tests? in [\d.]+s\r?$/gm)?.length === 1)) {
    const total = Number(unittest[1]); if (total > 1000000) return null;
    const tail = normalized.slice(unittest.index + unittest[0].length).trim();
    if (tail === "OK") return countsSchema.parse({ total, passed: total, failed: 0, skipped: 0 });
    const m = /^OK \(skipped=(\d+)\)$/.exec(tail);
    if (m && Number(m[1]) <= total) return countsSchema.parse({ total, passed: total - Number(m[1]), failed: 0, skipped: Number(m[1]) });
    return null;
  }
  // Only one anchored pytest or Vitest summary, bounded integer counts and known categories.
  const lines = normalized.split(/\r?\n/).filter(l => /^\s*Tests\s+.*\(\d+\)\s*$/.test(l) || /^=+ .* in [\d.]+s.*=+$/.test(l));
  if (lines.length !== 1) return null;
  const line = lines[0]!;
  if (/xfailed|xpassed|deselected|todo|cancelled/.test(line)) return null;
  const matches = [...line.matchAll(/\b(\d+) (passed|failed|skipped|errors?)\b/g)];
  if (!matches.length || new Set(matches.map(m => m[2])).size !== matches.length) return null;
  const counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const m of matches) { const key = m[2] === "passed" ? "passed" : m[2] === "skipped" ? "skipped" : "failed"; counts[key] += Number(m[1]); counts.total += Number(m[1]); }
  const vitestTotal = /\((\d+)\)\s*$/.exec(line);
  if (vitestTotal && Number(vitestTotal[1]) !== counts.total) return null;
  const parsed = countsSchema.safeParse(counts); return parsed.success ? parsed.data : null;
}

function fileFor(workspace: string, root: string, run: string): string {
  if (!/^[a-f0-9]{24}$/.test(workspace) || !id.safeParse(run).success || fs.realpathSync.native(root) !== root) throw new Error("COMMAND_EVIDENCE_BINDING");
  const state = getStateDir();
  if (inside(root, state) || inside(state, root)) throw new Error("COMMAND_EVIDENCE_UNTRUSTED_LOCATION");
  return path.join(state, "command-evidence", workspace, run + ".json");
}
function loadBody(file: string): Body | null {
  const raw = readPrivateFile(file, 512 * 1024); if (raw === null) return null;
  const { evidence_sha256, ...body } = receiptSchema.parse(JSON.parse(raw));
  if (sha(JSON.stringify(body)) !== evidence_sha256) throw new Error("COMMAND_EVIDENCE_HASH");
  return body;
}

/** Called only from the bound local app-server event observer, never from a public tool. */
export function recordCommandObservation(workspace: string, root: string, run: CommandBinding, item: CommandObservation): void {
  const file = fileFor(workspace, root, run.run_id);
  const existing = loadBody(file);
  if (!existing && fs.existsSync(path.dirname(file)) && fs.readdirSync(path.dirname(file)).length >= 256) throw new Error("COMMAND_EVIDENCE_CAPACITY");
  const body = existing ?? bodySchema.parse({ version: 1, source: "codex-app-server-command-events", workspace_id: workspace,
    workspace_root_sha256: sha(root), task_id: run.task_id, run_id: run.run_id, iteration: run.iteration, commands: [], truncated: false });
  if (body.workspace_id !== workspace || body.workspace_root_sha256 !== sha(root) || body.task_id !== run.task_id || body.iteration !== run.iteration || body.run_id !== run.run_id) throw new Error("COMMAND_EVIDENCE_BINDING");
  const key = sha(item.itemId), prior = body.commands.find(c => c.item_id_sha256 === key);
  if (prior?.completed_observed_at || (!item.completed && prior)) return;
  if (!prior && body.commands.length === 32) { body.truncated = true; }
  else if (!item.completed) {
    // Display only a single plain test invocation. Shell wrappers, inline code,
    // assignments, redacted values and other commands remain hash-identified.
    const simple = /^(?:[A-Za-z0-9_./+-]*\/)?(?:python(?:3(?:\.\d+)?)? -m (?:unittest|pytest|flake8)|pytest|flake8|vitest|tsc|(?:npm|pnpm|yarn) (?:test|typecheck|lint)|node node_modules\/(?:vitest\/vitest\.mjs|typescript\/bin\/tsc))(?: [A-Za-z0-9_./*?:=,@+-]+)*$/.test(item.command);
    const safe = redactAndTruncate(item.command, 2048);
    const command = simple && safe.text === item.command && !/(?:password|secret|token|credential|cookie|api[-_]?key)/i.test(item.command)
      ? item.command : "[command withheld; identify by command_sha256]";
    body.commands.push(recordSchema.parse({ notification_id: sha(run.run_id + ":" + key), item_id_sha256: key,
      command, command_sha256: sha(item.command), started_observed_at: item.observedAt, completed_observed_at: null,
      exit_code: null, status: "started", output_sha256: null, output_bytes: null, output_summary: null,
      reported_counts: null, verification: "protocol-observation-not-independent-test-attestation",
      source_at_start_observation: observeCodeState(root), source_at_completion_observation: null }));
  } else if (prior) {
    const complete = prior.command_sha256 === sha(item.command) && ["completed", "failed", "declined"].includes(item.status);
    const output = item.output !== null && Buffer.byteLength(item.output) <= 128 * 1024 ? item.output : null;
    const reported = complete && output !== null ? parseReportedTestCounts(output) : null;
    // Do not turn arbitrary stdout (which may contain file contents/secrets) into
    // a new read surface. Preserve its hash and only a constructed count summary.
    const redacted = reported === null ? null : JSON.stringify(reported);
    Object.assign(prior, { completed_observed_at: item.observedAt, exit_code: complete ? item.exitCode : null,
      status: complete ? item.status : "unverified", output_sha256: output === null ? null : sha(output),
      output_bytes: output === null ? null : Buffer.byteLength(output), output_summary: redacted,
      reported_counts: reported,
      source_at_completion_observation: observeCodeState(root) });
  } else { body.truncated = true; } // Unpaired completion must not become PASS.
  bodySchema.parse(body);
  writePrivateFile(file, JSON.stringify({ ...body, evidence_sha256: sha(JSON.stringify(body)) }), 512 * 1024);
}

/** Public read projection. Evidence cannot be imported from a caller-supplied path. */
export function readCommandEvidence(workspace: string, root: string, run?: CommandBinding, currentObservation?: CodeObservation) {
  try {
    if (!run) return { available: false as const, reason: "NO_BOUND_RUN" };
    const file = fileFor(workspace, root, run.run_id), body = loadBody(file);
    if (!body) return { available: false as const, reason: "COMMAND_EVIDENCE_ABSENT" };
    if (body.workspace_id !== workspace || body.workspace_root_sha256 !== sha(root) || body.run_id !== run.run_id || body.task_id !== run.task_id || body.iteration !== run.iteration) throw new Error();
    const current = currentObservation ?? observeCodeState(root);
    return { available: true as const, ...body, evidence_sha256: sha(JSON.stringify(body)), current_source: current,
      commands: body.commands.map(c => ({ ...c, current_source_match: current.complete && c.source_at_completion_observation?.complete
        ? current.digest === c.source_at_completion_observation.digest : null })),
      independent_test_verdict: "NOT_ATTESTED" as const, execution_completion_is_test_pass: false as const };
  } catch { return { available: false as const, reason: "COMMAND_EVIDENCE_UNVERIFIED" }; }
}
