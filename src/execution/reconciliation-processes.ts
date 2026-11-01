import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod/v3";
import { redactSensitiveText } from "../security/redaction.js";

// Closed vocabulary shared by the worker, catch boundary and durable extension.
export const reconciliationCodeSchema = z.enum([
  "RECONCILIATION_PROCESS_PRESENT", "RECONCILIATION_SNAPSHOT_UNSTABLE", "RECONCILIATION_PROCESS_SCOPE_LIMIT",
  "RECONCILIATION_PLATFORM_UNSUPPORTED", "RECONCILIATION_PS_FAILED", "RECONCILIATION_PS_OUTPUT_INVALID",
  "RECONCILIATION_PS_DETAIL_FAILED", "RECONCILIATION_PS_DETAIL_INVALID", "RECONCILIATION_LSOF_FAILED",
  "RECONCILIATION_LSOF_STDERR", "RECONCILIATION_LSOF_COVERAGE_LIMIT", "RECONCILIATION_LSOF_COVERAGE_UNVERIFIED",
  "RECONCILIATION_CWD_RECORDS_UNVERIFIED", "RECONCILIATION_CWD_REFRESH_UNVERIFIED", "RECONCILIATION_CWD_UNRESOLVED",
  "RECONCILIATION_ROOT_CHANGED", "RECONCILIATION_GIT_UNVERIFIED", "RECONCILIATION_GIT_HEAD_UNVERIFIED",
  "RECONCILIATION_STATUS_FORMAT_UNVERIFIED", "RECONCILIATION_CONFLICT_PRESENT", "RECONCILIATION_PATH_UNVERIFIED",
  "RECONCILIATION_PATH_POLICY_BLOCKED", "RECONCILIATION_DIRTY_SCOPE_LIMIT", "RECONCILIATION_SUBMODULE_UNSUPPORTED",
  "RECONCILIATION_FILE_UNVERIFIED", "RECONCILIATION_FILE_SCOPE_LIMIT", "RECONCILIATION_DIRTY_BYTES_LIMIT",
  "RECONCILIATION_EVIDENCE_CHANGED", "RECONCILIATION_EVIDENCE_INVALID", "RECONCILIATION_CANCELLED",
  "RECONCILIATION_INSPECTION_FAILED", "RECONCILIATION_INSPECTION_TIMEOUT", "RECONCILIATION_TIMEOUT",
  "RECONCILIATION_FAILED", "OWNER_DENIED", "OWNER_APPROVAL_TIMEOUT", "OWNER_APPROVAL_UNAVAILABLE",
  "WORKSPACE_RECOVERY_CHANGED", "WORKSPACE_BUSY", "OWNER_APPROVAL_EXPIRED", "APPROVAL_ALREADY_USED",
]);
export type ReconciliationCode = z.infer<typeof reconciliationCodeSchema>;
export function reconciliationCode(value: unknown): ReconciliationCode {
  const parsed = reconciliationCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "RECONCILIATION_FAILED";
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
// Closed, path-free Git cause. Exception messages, stderr and OIDs never cross
// the worker/durable-evidence boundary.
export const gitReadFailureSchema = z.object({
  code: z.enum(["GIT_SNAPSHOT_FAILED", "GIT_READ_FAILED", "UNSAFE_GIT_CONFIGURATION"]),
  stage: z.enum(["layout", "head", "temporary_storage", "exclude", "objects", "index", "shared_index", "identity",
    "scoped_objects", "scoped_pack", "scope", "binary", "configuration", "preflight", "control_file", "status", "diff_paths", "diff"]),
  reason: z.enum(["unverified", "budget_exhausted", "file_limit", "byte_limit", "invalid_path", "unverified_or_byte_limit",
    "command_failed", "invalid_oid", "unsafe_fanout", "identity_changed", "unsafe_directory", "unsafe_file", "directory_entry_limit",
    "index_count_limit", "aggregate_index_byte_limit", "aggregate_index_oid_limit", "index_unverified", "object_missing",
    "invalid_object", "object_hash_mismatch", "single_file_required", "submodule_unsupported", "index_mode_unsupported",
    "invalid_commit", "invalid_tree", "duplicate_tree_entry", "invalid_parent", "unavailable"]),
  limits: z.object({ snapshot_ms: z.number().int().min(250).max(10000), object_files: z.literal(20000),
    object_bytes: z.literal(536870912), index_bytes: z.literal(67108864), pack_indexes: z.literal(128),
    pack_index_bytes: z.literal(16777216), aggregate_pack_index_bytes: z.literal(33554432), aggregate_pack_index_oids: z.literal(400000),
  }).strict(),
}).strict();
const pid = z.number().int().positive().max(2147483647);
const timestamp = z.string().datetime();
const safePath = z.string().max(512).refine(s => Buffer.byteLength(s) <= 512 && path.isAbsolute(s) && path.normalize(s) === s &&
  !/[\p{Cc}\p{Cf}]/u.test(s) && redactSensitiveText(s).text === s);
const ownershipSchema = z.enum(["PROVEN_HISTORICAL", "PROVEN_OTHER", "UNPROVEN"]);
export type HistoricalOwnership = z.infer<typeof ownershipSchema>;
const identitySchema = z.object({ pid, ppid: pid.or(z.literal(0)), process_start_time: timestamp,
  executable: safePath.nullable(), birth_identity: sha.nullable() }).strict();
const candidateBodySchema = identitySchema.extend({ canonical_cwd: safePath,
  ancestry: z.array(identitySchema).max(4), ancestry_complete: z.boolean(),
  executable_scope: z.literal("canonical-path-only"), start_time_scope: z.enum(["ps-lstart-seconds", "host-verified-birth-identity"]),
  ownership: ownershipSchema, physical_original: z.enum(["FALSE", "UNKNOWN"]),
  binding_evidence_sha256: z.array(sha).max(2), observed_at: timestamp,
}).strict();
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const candidateSchema = candidateBodySchema.extend({ evidence_hash: sha }).strict().refine(c => {
  const { evidence_hash, ...body } = c;
  const chain = [c, ...c.ancestry];
  return digest(body) === evidence_hash && new Set(chain.map(p => p.pid)).size === chain.length &&
    c.ancestry.every((p, i) => chain[i]!.ppid === p.pid) &&
    (!c.ancestry_complete || chain.at(-1)!.ppid === 0) &&
    c.start_time_scope === (c.birth_identity ? "host-verified-birth-identity" : "ps-lstart-seconds") &&
    (c.ownership === "UNPROVEN" ? c.binding_evidence_sha256.length === 0 :
      Boolean(c.birth_identity && c.ancestry[0]?.birth_identity) && new Set(c.binding_evidence_sha256).size === 2);
});
export type ProcessCandidate = z.infer<typeof candidateSchema>;
const snapshotIssueSchema = z.object({
  phase: z.enum(["first_bracket", "last_bracket", "comparison"]),
  reason: z.enum(["process_appeared", "identity_changed", "cwd_missing", "cwd_unresolved", "cwd_changed", "ancestry_changed", "snapshot_invalid"]),
  pid: pid.nullable(), before: identitySchema.nullable(), after: identitySchema.nullable(),
  cwd_before: safePath.nullable(), cwd_after: safePath.nullable(), observed_at: timestamp,
  cwd_failure: z.object({ method: z.literal("lsof-cwd/realpath"),
    errno: z.enum(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP", "OTHER"]),
    classification: z.enum(["path_not_found", "permission_denied", "not_directory", "symlink_loop", "unclassified"]),
    path_sha256: sha, process_recheck: z.enum(["same_identity", "disappeared", "identity_changed", "unverified"]),
  }).strict().optional(),
}).strict();
const snapshotDiagnosticsSchema = z.object({
  count: z.number().int().min(1).max(100000), entries: z.array(snapshotIssueSchema).max(8),
  truncated: z.boolean(),
}).strict().refine(d => d.entries.length <= d.count && d.truncated === (d.entries.length < d.count) &&
  Buffer.byteLength(JSON.stringify(d)) <= 16 * 1024);
type SnapshotDiagnostics = z.infer<typeof snapshotDiagnosticsSchema>;
type SnapshotIssue = z.infer<typeof snapshotIssueSchema>;

/** Diagnostic-only, bounded metadata. Never changes a decision or grants ownership. */
class SnapshotDiagnosticsCollector {
  private count = 0;
  private entries: SnapshotIssue[] = [];
  constructor(seeds: Array<SnapshotDiagnostics | undefined> = []) {
    for (const seed of seeds) {
      if (!seed) continue;
      this.count += seed.count;
      for (const entry of seed.entries) this.keep(entry);
    }
  }
  private keep(entry: SnapshotIssue): void {
    if (this.entries.length < 8 && Buffer.byteLength(JSON.stringify([...this.entries, entry])) < 15 * 1024)
      this.entries.push(entry);
  }
  add(phase: SnapshotIssue["phase"], reason: SnapshotIssue["reason"], before?: ProcessRow, after?: ProcessRow,
    cwdBefore?: string, cwdAfter?: string, relatedPid?: number, failure?: SnapshotIssue["cwd_failure"]): void {
    this.count++;
    const cwd = (value?: string) => safePath.safeParse(value).success ? value! : null;
    this.keep(snapshotIssueSchema.parse({ phase, reason, pid: relatedPid ?? after?.pid ?? before?.pid ?? null,
      before: before ? identity(before) : null, after: after ? identity(after) : null,
      cwd_before: cwd(cwdBefore), cwd_after: cwd(cwdAfter), observed_at: new Date().toISOString(),
      ...(failure ? { cwd_failure: failure } : {}) }));
  }
  value(): SnapshotDiagnostics | undefined {
    return this.count ? snapshotDiagnosticsSchema.parse({ count: this.count, entries: this.entries,
      truncated: this.entries.length < this.count }) : undefined;
  }
}
const evidenceBodySchema = z.object({
  version: z.literal(1), scope: z.literal("same-user-canonical-cwd-snapshots"),
  context_sha256: sha, observed_at: timestamp,
  candidate_count: z.number().int().min(0).max(10000), candidates: z.array(candidateSchema).max(32),
  ownership_counts: z.object({ PROVEN_HISTORICAL: z.number().int().nonnegative(),
    PROVEN_OTHER: z.number().int().nonnegative(), UNPROVEN: z.number().int().nonnegative() }).strict(),
  quiescence: z.enum(["QUIESCENT", "NON_QUIESCENT", "UNKNOWN"]),
  coverage: z.enum(["STABLE", "INCOMPLETE"]), inventory_truncated: z.boolean(),
  code: reconciliationCodeSchema.optional(),
  snapshot_diagnostics: snapshotDiagnosticsSchema.optional(),
  git_failure: gitReadFailureSchema.optional(),
  observation_retry: z.object({ attempts: z.literal(2), initial_evidence_hash: sha,
    initial_observed_at: timestamp, initial_diagnostics: snapshotDiagnosticsSchema,
  }).strict().optional(),
}).strict();
export const processEvidenceSchema = evidenceBodySchema.extend({ evidence_hash: sha }).strict().superRefine((e, ctx) => {
  const { evidence_hash, ...body } = e;
  const counts = { PROVEN_HISTORICAL: 0, PROVEN_OTHER: 0, UNPROVEN: 0 };
  for (const c of e.candidates) counts[c.ownership]++;
  if (Buffer.byteLength(JSON.stringify(e)) > 64 * 1024 || digest(body) !== evidence_hash ||
      (e.observation_retry && (!transientDiagnostics(e.observation_retry.initial_diagnostics) ||
        Date.parse(e.observation_retry.initial_observed_at) > Date.parse(e.observed_at))) ||
      new Set(e.candidates.map(c => c.pid)).size !== e.candidates.length ||
      Object.values(e.ownership_counts).reduce((a, b) => a + b, 0) !== e.candidate_count ||
      Object.keys(counts).some(k => counts[k as HistoricalOwnership] > e.ownership_counts[k as HistoricalOwnership]) ||
      e.candidates.length > e.candidate_count || (!e.inventory_truncated && e.candidates.length !== e.candidate_count) ||
      (e.coverage === "INCOMPLETE" || e.inventory_truncated ? e.quiescence !== "UNKNOWN" :
        e.quiescence !== (e.candidate_count ? "NON_QUIESCENT" : "QUIESCENT")) ||
      (e.quiescence === "QUIESCENT" ? e.code !== undefined : e.code === undefined) ||
      (e.quiescence === "NON_QUIESCENT" && e.code !== "RECONCILIATION_PROCESS_PRESENT") ||
      ((e.snapshot_diagnostics !== undefined || e.git_failure !== undefined) && (e.coverage !== "INCOMPLETE" || e.quiescence !== "UNKNOWN"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid bounded process evidence" });
  }
});
export type ProcessEvidence = z.infer<typeof processEvidenceSchema>;
export function quarantine(processes?: ProcessEvidence, admitted = false) {
  const counts = processes?.ownership_counts ?? { PROVEN_HISTORICAL: 0, PROVEN_OTHER: 0, UNPROVEN: 0 };
  const classifications = Object.entries(counts).filter(([, count]) => count > 0);
  return { old_outcome: "UNKNOWN" as const, context: "NON_RESUMABLE" as const, replay: "PROHIBITED" as const,
    ownership: classifications.length === 1 ? classifications[0]![0] as HistoricalOwnership : "UNPROVEN" as const,
    ownership_counts: counts,
    quiescence: processes?.quiescence ?? "UNKNOWN",
    new_unrelated_writer_admission: admitted && processes?.quiescence === "QUIESCENT" ? "ALLOWED" as const : "BLOCKED" as const };
}

// Diagnostic descriptions, never approvals, allowlists or purported trusted bindings.
export const diagnosticContextSchema = z.object({ root: safePath,
  historical: z.object({ workspace_id: z.string().regex(/^[a-f0-9]{24}$/),
    run_id: z.string().regex(/^[a-f0-9]{32}$/), runtime_id: z.string().regex(/^[a-f0-9]{32}$/),
    session_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
    started_at: timestamp, ended_at: timestamp.optional(),
  }).strict().refine(h => !h.ended_at || Date.parse(h.ended_at) >= Date.parse(h.started_at)).optional(),
}).strict();
export type DiagnosticContext = z.infer<typeof diagnosticContextSchema>;

/** Trusted in-process observation seam only. No HTTP/CLI/worker input can supply these.
 * Two independently recorded sources must already be authenticated by their host reader:
 * a spawn receipt and a session handshake. C2C currently persists neither pair; production
 * supplies none. Hashes bind evidence bytes, and are NOT authentication of a caller claim.
 */
const bindingSchema = z.object({ workspace_id: z.string().regex(/^[a-f0-9]{24}$/),
  run_id: z.string().regex(/^[a-f0-9]{32}$/), runtime_id: z.string().regex(/^[a-f0-9]{32}$/),
  session_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), root: safePath,
  process: identitySchema, parent: identitySchema, recorded_at: timestamp, source_sha256: sha,
}).strict();
export interface RecordedProcessBindings {
  spawn: z.infer<typeof bindingSchema>;
  session: z.infer<typeof bindingSchema>;
}
export function classifyHistoricalOwnership(context: DiagnosticContext, process: z.infer<typeof identitySchema>,
  parent: z.infer<typeof identitySchema> | undefined, records?: RecordedProcessBindings): HistoricalOwnership {
  const h = context.historical;
  if (!h || !parent || !records || process.ppid !== parent.pid || !process.executable || !parent.executable ||
      !process.birth_identity || !parent.birth_identity ||
      Date.parse(parent.process_start_time) > Date.parse(process.process_start_time)) return "UNPROVEN";
  const a = bindingSchema.safeParse(records.spawn), b = bindingSchema.safeParse(records.session);
  if (!a.success || !b.success) return "UNPROVEN";
  const { recorded_at: at, source_sha256: ah, ...spawn } = a.data;
  const { recorded_at: bt, source_sha256: bh, ...session } = b.data;
  if (ah === bh || JSON.stringify(spawn) !== JSON.stringify(session) || spawn.root !== context.root ||
      spawn.workspace_id !== h.workspace_id || JSON.stringify(spawn.process) !== JSON.stringify(process) ||
      JSON.stringify(spawn.parent) !== JSON.stringify(parent) || Date.parse(at) < Date.parse(process.process_start_time) || Date.parse(bt) < Date.parse(process.process_start_time) ||
      Date.parse(at) > Date.now() || Date.parse(bt) > Date.now()) return "UNPROVEN";
  if (h.session_id && spawn.runtime_id === h.runtime_id && spawn.run_id === h.run_id && spawn.session_id === h.session_id) return "PROVEN_HISTORICAL";
  if (h.ended_at && Date.parse(process.process_start_time) > Date.parse(h.ended_at) + 1000 &&
      spawn.runtime_id !== h.runtime_id && spawn.run_id !== h.run_id && spawn.session_id !== h.session_id) return "PROVEN_OTHER";
  return "UNPROVEN";
}

export class ProcessScanError extends Error {
  constructor(readonly code: ReconciliationCode) { super(code); }
}
function fail(code: ReconciliationCode): never { throw new ProcessScanError(code); }
export function isConfirmedZombieState(state: string | undefined): boolean { return state === "Z" || state === "Z+"; }
export function parseCwdRecords(raw: string): Map<number, string> {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) fail("RECONCILIATION_CWD_RECORDS_UNVERIFIED");
  const records = new Map<number, string>();
  for (const record of raw.split(/(?=p[1-9]\d*\0)/).filter(Boolean)) {
    const match = /^p([1-9]\d*)\0\n?fcwd\0n([^\0]+)\0\n?$/.exec(record);
    if (!match || match[0] !== record || !pid.safeParse(Number(match[1])).success ||
        !path.isAbsolute(match[2]!) || /[\p{Cc}\p{Cf}]/u.test(match[2]!) || records.has(Number(match[1]))) fail("RECONCILIATION_CWD_RECORDS_UNVERIFIED");
    records.set(Number(match[1]), match[2]!);
    if (records.size > 10000) fail("RECONCILIATION_CWD_RECORDS_UNVERIFIED");
  }
  return records;
}
export function parseSingleCwdRecord(raw: string, expectedPid: number): string {
  try {
    if (!pid.safeParse(expectedPid).success || Buffer.byteLength(raw) > 64 * 1024) throw new Error();
    const records = parseCwdRecords(raw);
    if (records.size !== 1 || !records.has(expectedPid)) throw new Error();
    return records.get(expectedPid)!;
  } catch { fail("RECONCILIATION_CWD_REFRESH_UNVERIFIED"); }
}
export interface ProcessRow extends Omit<z.infer<typeof identitySchema>, "birth_identity"> {
  uid: number; state: string;
  // Only a trusted host observation can supply a stable kernel birth identity. ps cannot.
  birth_identity?: string | null;
}
export function parseProcessRows(raw: string): ProcessRow[] {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) fail("RECONCILIATION_PS_OUTPUT_INVALID");
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n").filter(l => l.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) fail("RECONCILIATION_PS_OUTPUT_INVALID");
    const started = Date.parse(match[4] + " UTC");
    if (!Number.isFinite(started)) fail("RECONCILIATION_PS_OUTPUT_INVALID");
    const identity = identitySchema.safeParse({ pid: Number(match[2]), ppid: Number(match[3]),
      process_start_time: new Date(started).toISOString(), executable: null, birth_identity: null });
    if (!identity.success || !Number.isSafeInteger(Number(match[1])) || rows.some(r => r.pid === identity.data.pid)) fail("RECONCILIATION_PS_OUTPUT_INVALID");
    // comm is executable identity, never args/command. Unresolvable paths remain unavailable.
    let executable: string | null = null;
    if (path.isAbsolute(match[6]!)) {
      try { const canonical = fs.realpathSync.native(match[6]!); if (safePath.safeParse(canonical).success) executable = canonical; } catch { /* unavailable */ }
    }
    rows.push({ ...identity.data, executable, uid: Number(match[1]), state: match[5]! });
    if (rows.length > 10000) fail("RECONCILIATION_PROCESS_SCOPE_LIMIT");
  }
  return rows;
}
export interface ProcessSnapshot { rows: ProcessRow[]; cwds: Map<number, string>; observed_at: string; code?: ReconciliationCode;
  snapshot_diagnostics?: SnapshotDiagnostics; retry_forbidden?: boolean }
function sameIdentity(a: ProcessRow, b: ProcessRow): boolean {
  return a.pid === b.pid && a.ppid === b.ppid && a.uid === b.uid && a.process_start_time === b.process_start_time &&
    a.executable === b.executable && (a.birth_identity ?? null) === (b.birth_identity ?? null);
}
function inside(root: string, cwd: string): boolean {
  const relative = path.relative(root, cwd);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function identity(row: ProcessRow): z.infer<typeof identitySchema> {
  return { pid: row.pid, ppid: row.ppid, process_start_time: row.process_start_time, executable: row.executable,
    birth_identity: row.birth_identity ?? null };
}

/** Pure comparison of two complete host observations; records is a trusted test/host seam,
 * never exposed by scanReconciliationProcesses. Disappeared processes are not live evidence.
 */
export function compareProcessSnapshots(context: DiagnosticContext, first: ProcessSnapshot, last: ProcessSnapshot,
  uid: number, records?: (row: ProcessRow) => RecordedProcessBindings | undefined): ProcessEvidence {
  context = diagnosticContextSchema.parse(context);
  let code = last.code ?? first.code;
  const diagnostics = new SnapshotDiagnosticsCollector(first === last ? [first.snapshot_diagnostics] : [first.snapshot_diagnostics, last.snapshot_diagnostics]);
  const candidates: ProcessCandidate[] = [];
  const initial = new Map(first.rows.map(r => [r.pid, r]));
  const final = new Map(last.rows.map(r => [r.pid, r]));
  if (initial.size !== first.rows.length || final.size !== last.rows.length || !timestamp.safeParse(first.observed_at).success ||
      !timestamp.safeParse(last.observed_at).success || Date.parse(last.observed_at) < Date.parse(first.observed_at)) {
    code = "RECONCILIATION_SNAPSHOT_UNSTABLE"; diagnostics.add("comparison", "snapshot_invalid");
  }
  for (const row of last.rows) {
    if (row.uid !== uid || isConfirmedZombieState(row.state)) continue;
    const prior = initial.get(row.pid);
    const stable = prior && sameIdentity(prior, row) && !isConfirmedZombieState(prior.state);
    if (!stable) {
      code ??= "RECONCILIATION_SNAPSHOT_UNSTABLE";
      diagnostics.add("comparison", prior ? "identity_changed" : "process_appeared", prior, row,
        first.cwds.get(row.pid), last.cwds.get(row.pid));
    }
    const cwd = last.cwds.get(row.pid), previousCwd = first.cwds.get(row.pid);
    if (!cwd || (prior && !previousCwd)) {
      code ??= "RECONCILIATION_LSOF_COVERAGE_UNVERIFIED";
      diagnostics.add("comparison", "cwd_missing", prior, row, previousCwd, cwd); continue;
    }
    if (!safePath.safeParse(cwd).success) {
      code ??= "RECONCILIATION_CWD_UNRESOLVED";
      diagnostics.add("comparison", "cwd_unresolved", prior, row, previousCwd); continue;
    }
    if (prior && cwd !== previousCwd) {
      code ??= "RECONCILIATION_SNAPSHOT_UNSTABLE";
      diagnostics.add("comparison", "cwd_changed", prior, row, previousCwd, cwd);
    }
    if (!inside(context.root, cwd)) continue;
    const ancestry: Array<z.infer<typeof identitySchema>> = [];
    let parentId = row.ppid, ancestryStable = true;
    const seen = new Set([row.pid]);
    while (parentId && ancestry.length < 4) {
      const parent = final.get(parentId), oldParent = initial.get(parentId);
      if (seen.has(parentId) || !parent || !oldParent || !sameIdentity(parent, oldParent)) {
        ancestryStable = false; diagnostics.add("comparison", "ancestry_changed", oldParent, parent,
          first.cwds.get(parentId), last.cwds.get(parentId), parentId); break;
      }
      seen.add(parentId); ancestry.push(identity(parent)); parentId = parent.ppid;
    }
    if (!ancestryStable) code ??= "RECONCILIATION_SNAPSHOT_UNSTABLE";
    const bindings = stable && ancestryStable && cwd === previousCwd ? records?.(row) : undefined;
    const ownership = classifyHistoricalOwnership(context, identity(row), ancestry[0], bindings);
    const h = context.historical;
    const body = candidateBodySchema.parse({ ...identity(row), canonical_cwd: cwd, ancestry,
      ancestry_complete: ancestryStable && parentId === 0, executable_scope: "canonical-path-only",
      start_time_scope: row.birth_identity ? "host-verified-birth-identity" : "ps-lstart-seconds",
      ownership, physical_original: h?.ended_at && Date.parse(row.process_start_time) > Date.parse(h.ended_at) + 1000 ? "FALSE" : "UNKNOWN",
      binding_evidence_sha256: ownership === "UNPROVEN" ? [] : [bindings!.spawn.source_sha256, bindings!.session.source_sha256], observed_at: last.observed_at });
    candidates.push({ ...body, evidence_hash: digest(body) });
  }
  // A disappearance is allowed only if no surviving child was reparented and the remaining
  // full snapshot has stable coverage. Nothing from the departed PID becomes live evidence.
  return processEvidence(context, candidates, code, last.observed_at, diagnostics.value());
}
function processEvidence(context: DiagnosticContext, candidates: ProcessCandidate[], code?: ReconciliationCode,
  observed_at = new Date().toISOString(), diagnostics?: SnapshotDiagnostics): ProcessEvidence {
  candidates.sort((a, b) => a.pid - b.pid);
  const counts = { PROVEN_HISTORICAL: 0, PROVEN_OTHER: 0, UNPROVEN: 0 };
  for (const candidate of candidates) counts[candidate.ownership]++;
  const kept = candidates.slice(0, 32);
  while (Buffer.byteLength(JSON.stringify(kept)) + (diagnostics ? Buffer.byteLength(JSON.stringify(diagnostics)) : 0) > 60 * 1024) kept.pop();
  const truncated = kept.length !== candidates.length;
  if (truncated) code ??= "RECONCILIATION_PROCESS_SCOPE_LIMIT";
  const body = evidenceBodySchema.parse({ version: 1, scope: "same-user-canonical-cwd-snapshots", context_sha256: digest(context), observed_at,
    candidate_count: candidates.length, candidates: kept, ownership_counts: counts,
    quiescence: code ? "UNKNOWN" : candidates.length ? "NON_QUIESCENT" : "QUIESCENT",
    coverage: code ? "INCOMPLETE" : "STABLE", inventory_truncated: truncated,
    ...(code || candidates.length ? { code: code ?? "RECONCILIATION_PROCESS_PRESENT" } : {}),
    ...(diagnostics ? { snapshot_diagnostics: diagnostics } : {}) });
  return processEvidenceSchema.parse({ ...body, evidence_hash: digest(body) });
}

export interface ProcessInspectionBudget {
  deadline: number;
  remainingBytes: number;
  remainingRetries: number;
  rootIdentity?: { root: string; dev: number; ino: number };
  observationRetry?: ProcessEvidence["observation_retry"];
}
function remainingTime(budget: ProcessInspectionBudget): number {
  const remaining = Math.floor(budget.deadline - performance.now());
  if (remaining <= 0) fail("RECONCILIATION_INSPECTION_TIMEOUT");
  if (budget.remainingBytes <= 0) fail("RECONCILIATION_PROCESS_SCOPE_LIMIT");
  return remaining;
}
function accountOutput(budget: ProcessInspectionBudget, result: { stdout: string; stderr: string }): void {
  budget.remainingBytes -= Buffer.byteLength(result.stdout ?? "") + Buffer.byteLength(result.stderr ?? "");
  remainingTime(budget);
}
function processRows(budget: ProcessInspectionBudget): ProcessRow[] {
  const ps = spawnSync("/bin/ps", ["-axo", "uid=,pid=,ppid=,lstart=,stat=,comm="], {
    cwd: "/", encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C", TZ: "UTC" },
    timeout: Math.min(4000, remainingTime(budget)), maxBuffer: Math.min(4 * 1024 * 1024, budget.remainingBytes),
  });
  accountOutput(budget, ps);
  if (ps.status !== 0 || ps.error || ps.stderr.trim()) fail("RECONCILIATION_PS_FAILED");
  // Only the synchronously created observation child is excluded; never the host, bridge,
  // Desktop, node, or a named helper. No signal (including kill(pid, 0)) is used.
  return parseProcessRows(ps.stdout).filter(r => r.pid !== ps.pid);
}
function snapshot(uid: number, phase: "first_bracket" | "last_bracket", budget: ProcessInspectionBudget, root: string): ProcessSnapshot {
  const before = processRows(budget);
  const scan = spawnSync("/usr/sbin/lsof", ["-nP", "-w", "-a", "-u", String(uid), "-d", "cwd", "-Fpn0"], {
    cwd: "/", encoding: "utf8", timeout: Math.min(8000, remainingTime(budget)), maxBuffer: Math.min(4 * 1024 * 1024, budget.remainingBytes),
  });
  accountOutput(budget, scan);
  if (scan.status !== 0 || scan.error) fail("RECONCILIATION_LSOF_FAILED");
  if (scan.stderr.trim()) fail("RECONCILIATION_LSOF_STDERR");
  const raw = parseCwdRecords(scan.stdout), after = processRows(budget);
  const cwds = new Map<number, string>();
  const diagnostics = new SnapshotDiagnosticsCollector();
  let code: ReconciliationCode | undefined;
  // A raw cwd for a process omitted by the bracket cannot be erased by retrying.
  // In particular, resolve aliases even for a newly appeared or departed process.
  let retryForbidden = false;
  let recheck: ProcessRow[] | undefined;
  let recheckAttempted = false;
  for (const row of after) {
    if (row.uid !== uid || isConfirmedZombieState(row.state)) continue;
    const old = before.find(r => r.pid === row.pid);
    if (!old || !sameIdentity(old, row)) {
      code ??= "RECONCILIATION_SNAPSHOT_UNSTABLE";
      diagnostics.add(phase, old ? "identity_changed" : "process_appeared", old, row); continue;
    }
    const cwd = raw.get(row.pid);
    if (!cwd) {
      code ??= "RECONCILIATION_LSOF_COVERAGE_UNVERIFIED"; diagnostics.add(phase, "cwd_missing", old, row); continue;
    }
    try { cwds.set(row.pid, fs.realpathSync.native(cwd)); }
    catch (error) {
      code ??= "RECONCILIATION_CWD_UNRESOLVED";
      // One additional bounded metadata observation per bracket. A disappearance
      // explains a failure; it never upgrades this incomplete scan to QUIESCENT.
      if (!recheckAttempted) {
        recheckAttempted = true;
        try { recheck = processRows(budget); } catch { /* Diagnostic remains unverified. */ }
      }
      const now = recheck?.find(p => p.pid === row.pid);
      const rawCode = (error as NodeJS.ErrnoException)?.code;
      const errno = (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"] as const).find(c => c === rawCode) ?? "OTHER";
      diagnostics.add(phase, "cwd_unresolved", old, row, undefined, undefined, undefined, {
        method: "lsof-cwd/realpath", errno,
        classification: errno === "ENOENT" ? "path_not_found" : errno === "EACCES" || errno === "EPERM" ? "permission_denied"
          : errno === "ENOTDIR" ? "not_directory" : errno === "ELOOP" ? "symlink_loop" : "unclassified",
        path_sha256: createHash("sha256").update(cwd).digest("hex"),
        process_recheck: !recheck ? "unverified" : !now ? "disappeared" : sameIdentity(row, now) ? "same_identity" : "identity_changed",
      });
    }
  }
  for (const [pid, cwd] of raw) {
    try { if (inside(root, cwds.get(pid) ?? fs.realpathSync.native(cwd))) retryForbidden = true; }
    catch { retryForbidden = true; }
  }
  return { rows: after, cwds, observed_at: new Date().toISOString(), code,
    snapshot_diagnostics: diagnostics.value(), retry_forbidden: retryForbidden };
}

export function incompleteProcessEvidence(evidence: ProcessEvidence, code: ReconciliationCode,
  gitFailure?: z.infer<typeof gitReadFailureSchema>): ProcessEvidence {
  const { evidence_hash: _hash, ...body } = processEvidenceSchema.parse(evidence);
  const incomplete = evidenceBodySchema.parse({ ...body, coverage: "INCOMPLETE", quiescence: "UNKNOWN", code,
    ...(gitFailure ? { git_failure: gitReadFailureSchema.parse(gitFailure) } : {}) });
  return processEvidenceSchema.parse({ ...incomplete, evidence_hash: digest(incomplete) });
}

/** Read-only entrypoint: no Workspace, journal, native approval, business command or writer imports. */
export function scanReconciliationProcesses(input: DiagnosticContext, onObservation?: (evidence: ProcessEvidence) => void,
  budget: ProcessInspectionBudget = { deadline: performance.now() + 20_000, remainingBytes: 32 * 1024 * 1024, remainingRetries: 1 }): ProcessEvidence {
  const context = diagnosticContextSchema.parse(input);
  let partial: ProcessEvidence | undefined;
  let retry = budget.observationRetry;
  let previous: ProcessSnapshot | undefined;
  const observe = (value: ProcessEvidence): ProcessEvidence => {
    const { evidence_hash: _hash, ...body } = value;
    const result = retry ? { ...body, observation_retry: retry } : body;
    partial = processEvidenceSchema.parse({ ...result, evidence_hash: digest(result) });
    onObservation?.(partial);
    return partial;
  };
  try {
    if (process.platform !== "darwin" || typeof process.getuid !== "function") fail("RECONCILIATION_PLATFORM_UNSUPPORTED");
    const before = fs.lstatSync(context.root);
    if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync.native(context.root) !== context.root) fail("RECONCILIATION_ROOT_CHANGED");
    budget.rootIdentity ??= { root: context.root, dev: before.dev, ino: before.ino };
    const checkRoot = () => {
      const current = fs.lstatSync(context.root), initial = budget.rootIdentity!;
      if (initial.root !== context.root || initial.dev !== current.dev || initial.ino !== current.ino ||
          !current.isDirectory() || current.isSymbolicLink() || fs.realpathSync.native(context.root) !== context.root)
        fail("RECONCILIATION_ROOT_CHANGED");
    };
    checkRoot();
    for (let attempt = 0; attempt < 2; attempt++) {
      remainingTime(budget);
      const first = snapshot(process.getuid(), "first_bracket", budget, context.root);
      checkRoot();
      if (previous) {
        for (const row of first.rows) {
          const old = previous.rows.find(p => p.pid === row.pid);
          if (old && (!sameIdentity(old, row) || (previous.cwds.has(row.pid) && first.cwds.has(row.pid) &&
              previous.cwds.get(row.pid) !== first.cwds.get(row.pid)))) fail("RECONCILIATION_SNAPSHOT_UNSTABLE");
        }
      }
      const firstEvidence = compareProcessSnapshots(context, first, first, process.getuid());
      observe(incompleteProcessEvidence(firstEvidence, "RECONCILIATION_SNAPSHOT_UNSTABLE"));
      const last = snapshot(process.getuid(), "last_bracket", budget, context.root);
      checkRoot();
      remainingTime(budget);
      const result = observe(compareProcessSnapshots(context, first, last, process.getuid()));
      // Never erase an observed target candidate, even if it exited before the final bracket.
      if (attempt || budget.remainingRetries <= 0 || first.retry_forbidden || last.retry_forbidden ||
          firstEvidence.candidate_count || !transientAppearanceOnly(result)) return result;
      remainingTime(budget);
      budget.remainingRetries--;
      previous = last;
      retry = budget.observationRetry = { attempts: 2, initial_evidence_hash: result.evidence_hash,
        initial_observed_at: result.observed_at, initial_diagnostics: result.snapshot_diagnostics! };
    }
    return partial!;
  } catch (e) {
    const code = e instanceof ProcessScanError ? e.code : "RECONCILIATION_INSPECTION_FAILED";
    return observe(partial ? incompleteProcessEvidence(partial, code) : processEvidence(context, [], code));
  }
}

function transientAppearanceOnly(evidence: ProcessEvidence): boolean {
  const d = evidence.snapshot_diagnostics;
  return evidence.code === "RECONCILIATION_SNAPSHOT_UNSTABLE" && !evidence.candidate_count && !!d && transientDiagnostics(d);
}
function transientDiagnostics(d: SnapshotDiagnostics): boolean {
  if (d.truncated) return false;
  const appeared = new Set(d.entries.filter(e => e.reason === "process_appeared" && e.before === null).map(e => e.pid));
  return appeared.size > 0 && d.entries.every(e => !e.cwd_failure && e.pid !== null &&
    ((e.reason === "process_appeared" && e.before === null) ||
      (e.reason === "cwd_missing" && e.phase === "comparison" && appeared.has(e.pid))));
}
