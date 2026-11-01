import { OWNER_DIALOG_HELPER_TIMEOUT_MS } from "../security/owner-dialog-timeouts.js";
import { diagnosticPaths, safeNativeFailureCode, type ApprovalDiagnostic } from "./approval-diagnostic.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readStableFile, sameFile } from "../security/stable-file.js";
import { z } from "zod/v3";
import { normalizeCodexNetworkHost } from "./network-policy.js";
import { redactAndTruncate } from "../security/redaction.js";
import { executeFolderScript, LOCAL_GIT_APPROVAL_SCRIPT, LOCAL_COMMAND_APPROVAL_SCRIPT, LOCAL_NETWORK_APPROVAL_SCRIPT, type NativeHelperPhase } from "../workspace/registration-native.js";

// Exact argv only: no shell expansion, aliases or caller-supplied flags.
export const LOCAL_GIT_PREFIX = "/usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 /usr/bin/git --no-pager --literal-pathspecs -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c tag.gpgSign=false -c core.editor=/usr/bin/false -c sequence.editor=/usr/bin/false -c protocol.allow=never -c core.attributesFile=/dev/null -c gc.auto=0 -c maintenance.auto=false";
const id = z.string().min(1).max(256);
const wireSchema = z.object({
  kind: z.enum(["command", "writeStdin"]).optional(),
  threadId: id, turnId: id, itemId: id,
  startedAtMs: z.number().int().nonnegative().optional(),
  approvalId: id.nullable().optional(),
  environmentId: z.string().max(256).nullable().optional(),
  reason: z.string().max(1024).nullable().optional(),
  command: z.string().max(8192).nullable().optional(),
  cwd: z.string().max(4096).nullable().optional(),
  commandActions: z.array(z.unknown()).max(16).nullable().optional(),
  additionalPermissions: z.object({
    network: z.object({ enabled: z.boolean().nullable().optional() }).strict().nullable().optional(),
    fileSystem: z.object({
      read: z.array(z.string().max(4096)).max(16).nullable().optional(),
      write: z.array(z.string().max(4096)).max(16).nullable().optional(),
      entries: z.array(z.object({
        path: z.unknown(),
        access: z.enum(["read", "write", "deny"]),
      }).strict()).max(16).nullable().optional(),
      globScanMaxDepth: z.number().int().min(1).max(64).nullable().optional(),
    }).strict().nullable().optional(),
  }).strict().nullable().optional(),
  networkApprovalContext: z.object({ host: z.string().max(253), protocol: z.string().max(16) }).strict().nullable().optional(),
  proposedExecpolicyAmendment: z.array(z.string().max(1024).refine(s => Buffer.byteLength(s, "utf8") <= 1024)).max(128)
    .refine(parts => parts.reduce((bytes, part) => bytes + Buffer.byteLength(part, "utf8"), 0) <= 4096).nullable().optional(),
  proposedNetworkPolicyAmendments: z.array(z.unknown()).max(16).nullable().optional(),
  availableDecisions: z.array(z.unknown()).max(8).nullable().optional(),
}).strict();

const schema = z.object({
  kind: z.literal("command").optional(), threadId: id, turnId: id, itemId: id,
  startedAtMs: z.number().int().nonnegative().optional(), approvalId: id.nullable().optional(),
  environmentId: z.literal("local").nullable(), reason: z.string().max(1024).nullable().optional(),
  command: z.string().min(1).max(8192), cwd: z.string().max(4096),
  commandActions: z.array(z.unknown()).max(16).nullable().optional(),
  additionalPermissions: z.object({
    network: z.object({ enabled: z.literal(false).nullable() }).strict().nullable().optional(),
    fileSystem: z.object({
      read: z.null(), write: z.array(z.string()).length(1),
      entries: z.array(z.object({
        path: z.object({ type: z.literal("path"), path: z.string().max(4096) }).strict(),
        access: z.literal("write"),
      }).strict()).length(1).optional(),
    }).strict().refine(p => !p.entries || (p.entries.length === 1 && p.entries[0].path.path === p.write[0]), { path: ["entries"] }),
  }).strict(),
  networkApprovalContext: z.null().optional(),
  // Proposal metadata is inert: only a separate literal accept-once is supported.
  proposedExecpolicyAmendment: z.array(z.string().max(1024).refine(s => Buffer.byteLength(s, "utf8") <= 1024)).max(128)
    .refine(parts => parts.reduce((bytes, part) => bytes + Buffer.byteLength(part, "utf8"), 0) <= 4096).nullable().optional(),
  proposedNetworkPolicyAmendments: z.null().optional(),
  availableDecisions: z.array(z.unknown()).min(1).max(8).nullable().optional(),
}).strict().refine(p => p.proposedExecpolicyAmendment == null || p.availableDecisions?.includes("accept"), { path: ["availableDecisions"] });
export type LocalApprovalRequest = z.infer<typeof schema>;
// Values, messages and unrecognized key names never enter diagnostics.

export function localApprovalSchemaDiagnostic(value: unknown) {
  const parsed = wireSchema.safeParse(value);
  return parsed.success ? { valid: true, issues: [], omitted: false } : {
    valid: false,
    issues: parsed.error.issues.slice(0, 4).map(issue => ({ code: issue.code,
      path: issue.path.slice(0, 8).map(part => typeof part === "number" ? "[]" : diagnosticPaths.has(part) ? part : "unknown"),
    })),
    omitted: parsed.error.issues.length > 4 || parsed.error.issues.some(issue => issue.path.length > 8),
  };
}
export type LocalApprovalScope =
  | { type: "managed_network"; root: string; host: string; protocol: "https"; fingerprint: string }
  | { type: "git_commit" | "git_stage"; root: string; files: string[]; fingerprint: string }
  | { type: "workspace_command"; root: string; command: string; readPaths: string[]; writePaths: string[]; fingerprint: string };

// Destination metadata comes only from the managed-network protocol, never command text.
const managedNetworkSchema = wireSchema.extend({
  kind: z.literal("command").optional(),
  environmentId: z.literal("local").nullable().optional(),
  networkApprovalContext: z.object({ host: z.string().min(1).max(253), protocol: z.literal("https") }).strict(),
  additionalPermissions: z.object({
    network: z.object({ enabled: z.literal(true) }).strict().nullable().optional(),
    fileSystem: z.null().optional(),
  }).strict().nullable().optional(),
  proposedExecpolicyAmendment: z.null().optional(),
  proposedNetworkPolicyAmendments: z.null().optional(),
  availableDecisions: z.array(z.enum(["accept", "decline", "cancel", "acceptForSession"]))
    .min(1).max(8).refine(v => v.includes("accept")).nullable().optional(),
});

export function validateManagedNetworkApproval(value: unknown, root: string): LocalApprovalScope | null {
  const parsed = managedNetworkSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(value)) > 16384) return null;
  try {
    const host = normalizeCodexNetworkHost(parsed.data.networkApprovalContext.host);
    // Public DNS syntax only. No resolution or connection is performed here.
    if (/\.(?:localhost|local|internal|lan|home|invalid|test)$/.test(host) ||
        host.endsWith(".home.arpa") || /(?:^|\.)\d+$/.test(host)) return null;
    return { type: "managed_network", root, host, protocol: "https",
      fingerprint: createHash("sha256").update(JSON.stringify(value)).update(root).digest("hex") };
  } catch { return null; }
}
// Presentation only: the original wire command remains in the fingerprint/RPC.
const localGitCommand = (raw: string): string => /^\/bin\/sh -c "([^"\\$`\p{Cc}\p{Cf}]+)"$/u.exec(raw)?.[1] ?? raw;
const gitLikeCommand = (raw: string): boolean =>
  localGitCommand(raw).startsWith(LOCAL_GIT_PREFIX + " ") ||
  /(^|[\s'"])(?:\/usr\/bin\/)?git(?:[\s'"]|$)/u.test(raw);

export function localApprovalScopeReason(value: Record<string, unknown>): string {
  if (value.environmentId !== undefined && value.environmentId !== null && value.environmentId !== "local") return "LOCAL_ENVIRONMENT_REQUIRED";
  if (value.kind !== undefined && value.kind !== "command") return "COMMAND_APPROVAL_REQUIRED";
  if (!wireSchema.safeParse(value).success) return "INLINE_PERMISSION_SCOPE_REQUIRED";
  if (typeof value.command !== "string" || typeof value.cwd !== "string") return "EXACT_COMMAND_SCOPE_REQUIRED";
  if (gitLikeCommand(value.command) || JSON.stringify(value.additionalPermissions ?? {}).includes("/.git")) {
    return "HERMETIC_GIT_COMMAND_REQUIRED";
  }
  return "EXACT_COMMAND_SCOPE_UNVERIFIED";
}
const safe = (s: string) => !/[\p{Cc}\p{Cf}$`\\;&|<>!*?{}\[\]~]/u.test(s) &&
  !/(?:password|passwd|secret|token|api[_ -]?key|cookie)\s*[:=]|(?:^|\/)\.env(?:\.|$)|credentials|auth\.json/i.test(s) &&
  redactAndTruncate(s, 16384).redactionCount === 0;

/** Read-only snapshot. Bounded ordinary repositories only; no worktrees/symlinks. */
function validateGitApproval(value: unknown, workspaceRoot: string): LocalApprovalScope | null {
  try {
    const p = schema.parse(value);
    if (redactAndTruncate(JSON.stringify(value), 32768).redactionCount) return null;
    if (![p.command, p.cwd, p.threadId, p.turnId, p.itemId, p.approvalId ?? "", p.reason ?? ""].every(safe)) return null;
    const root = fs.realpathSync.native(workspaceRoot);
    if (root !== workspaceRoot || p.cwd !== root || p.additionalPermissions.fileSystem.write[0] !== path.join(root, ".git") ||
        (p.availableDecisions && !p.availableDecisions.includes("accept"))) return null;
    if (fs.realpathSync.native("/usr/bin/git") !== "/usr/bin/git") return null;
    const command = localGitCommand(p.command);
    if (!command.startsWith(LOCAL_GIT_PREFIX + " ")) return null;
    const tail = command.slice(LOCAL_GIT_PREFIX.length + 1);
    const match = /^(?:commit --only -m '([^'\\\r\n]{1,200})'|add) -- ([A-Za-z0-9_./ -]+)$/.exec(tail);
    if (!match) return null;
    const files = match[2].split(" ");
    if (files.length > 32 || new Set(files).size !== files.length || files.some(f => !f || f.startsWith("-") ||
        f.split("/").some(c => !c || c === "." || c === ".." || c === ".git") || !safe(f))) return null;
    const hash = createHash("sha256").update(JSON.stringify(p)).update(root);
    let bytes = 0;
    const observed = new Map<string, fs.Stats | null>();
    const snapshot = (file: string, optional = false): string => {
      try {
        const { data, stat } = readStableFile(file, 8 * 1024 * 1024);
        observed.set(file, stat);
        bytes += data.length; if (bytes > 32 * 1024 * 1024) throw new Error("scope too large");
        hash.update(file).update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs])).update(data);
        return data.toString("utf8");
      } catch (e) {
        if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") { observed.set(file, null); hash.update(file + ":absent"); return ""; }
        throw e;
      }
    };
    const gitDir = path.join(root, ".git");
    const gitStat = fs.lstatSync(gitDir);
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink() || fs.realpathSync.native(gitDir) !== gitDir) return null;
    hash.update(JSON.stringify([gitStat.dev, gitStat.ino, gitStat.mode]));
    for (const name of ["objects", "objects/info", "objects/pack", "refs", "refs/heads"]) {
      const directory = path.join(gitDir, name);
      if (!fs.existsSync(directory)) continue;
      const s = fs.lstatSync(directory);
      if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) return null;
      hash.update(directory).update(JSON.stringify([s.dev, s.ino, s.mode]));
    }
    for (const forbidden of ["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "index.lock", "shallow", "info/grafts"]) {
      if (fs.existsSync(path.join(gitDir, forbidden))) return null;
    }
    // No Git preflight: reject includes before any Git could follow them. Only
    // inert ordinary-repository settings are supported; never display values.
    const config = snapshot(path.join(gitDir, "config"));
    let section = "";
    for (const raw of config.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^[#;]/.test(line)) continue;
      const heading = /^\[(core|user|remote|branch)(?: "[^"\\\r\n]+")?\]$/i.exec(line);
      if (heading) { section = heading[1].toLowerCase(); continue; }
      const entry = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
      const keys: Record<string, string[]> = { core: ["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode"], user: ["name", "email"], remote: ["url", "fetch"], branch: ["remote", "merge"] };
      if (!entry || !keys[section]?.includes(entry[1].toLowerCase()) || /\\$/.test(line)) return null;
      if (section === "core" && !(entry[1].toLowerCase() === "repositoryformatversion" ? entry[2] === "0" : /^(true|false)$/i.test(entry[2]))) return null;
      if (section === "core" && entry[1].toLowerCase() === "bare" && entry[2].toLowerCase() !== "false") return null;
    }
    const head = snapshot(path.join(gitDir, "HEAD")).trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5);
      if (!/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref) || ref.split("/").some(c => !c || c === "." || c === "..")) return null;
      const resolved = snapshot(path.join(gitDir, ref), true).trim();
      if (resolved && !/^[a-f0-9]{40,64}$/.test(resolved)) return null;
    } else if (!/^[a-f0-9]{40,64}$/.test(head)) return null;
    snapshot(path.join(gitDir, "packed-refs"), true);
    snapshot(path.join(gitDir, "index"), true);
    snapshot("/usr/bin/git");
    snapshot("/usr/bin/env");
    if (command !== p.command) {
      snapshot("/bin/sh");
      const shell = observed.get("/bin/sh")!;
      if (shell.uid !== 0 || (shell.mode & 0o022) !== 0 || (shell.mode & 0o111) === 0) return null;
    }
    for (const file of files) {
      const absolute = path.join(root, file);
      snapshot(absolute);
      for (let dir = path.dirname(absolute); ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, ".gitattributes"))) return null;
        if (dir === root) break;
      }
    }
    if (fs.existsSync(path.join(gitDir, "info/attributes"))) return null;
    for (const [file, before] of observed) {
      if (before ? !sameFile(before, fs.lstatSync(file)) : fs.existsSync(file)) return null;
    }
    const finalGit = fs.lstatSync(gitDir);
    if (finalGit.isSymbolicLink() || finalGit.dev !== gitStat.dev || finalGit.ino !== gitStat.ino) return null;
    return { type: match[1] ? "git_commit" : "git_stage", root, files, fingerprint: hash.digest("hex") };
  } catch { return null; }
}

const commandTextSafe = (s: string): boolean =>
  !/[\p{Cc}\p{Cf}]/u.test(s) &&
  redactAndTruncate(s, 16384).redactionCount === 0;

function exactPermissionPath(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "path,type" || p.type !== "path" || typeof p.path !== "string") return null;
  return p.path;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function permissionBoundary(root: string, candidate: string): string | null {
  if (!path.isAbsolute(candidate) || candidate.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(candidate)) return null;
  if (path.normalize(candidate) !== candidate) return null;
  const gitDir = path.join(root, ".git");
  if (inside(gitDir, candidate)) return null;
  if (inside(root, candidate)) return candidate === root ? null : root;
  const tmpRoots = [...new Set([path.resolve(os.tmpdir()), "/private/tmp"])];
  for (const tmp of tmpRoots) if (inside(tmp, candidate)) return candidate === tmp ? null : tmp;
  return null;
}

function hashPathIdentity(hash: ReturnType<typeof createHash>, boundary: string, candidate: string): boolean {
  try {
    const boundaryStat = fs.lstatSync(boundary);
    if (!boundaryStat.isDirectory() || boundaryStat.isSymbolicLink()) return false;
    hash.update(boundary).update(JSON.stringify([boundaryStat.dev, boundaryStat.ino, boundaryStat.mode, boundaryStat.uid]));
    let current = candidate;
    while (inside(boundary, current) && current !== boundary) {
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) return false;
        hash.update(current).update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs]));
      } else {
        hash.update(current + ":absent");
      }
      current = path.dirname(current);
    }
    return current === boundary;
  } catch {
    return false;
  }
}

function validateWorkspaceCommandApproval(value: unknown, workspaceRoot: string, rejected?: (stage: ApprovalDiagnostic["stage"]) => void): LocalApprovalScope | null {
  const reject = (stage: ApprovalDiagnostic["stage"]): null => { rejected?.(stage); return null; };
  try {
    const parsed = wireSchema.safeParse(value);
    if (!parsed.success) return reject("schema");
    const p = parsed.data;
    if ((p.kind ?? "command") !== "command") return reject("kind");
    if (p.environmentId !== undefined && p.environmentId !== null && p.environmentId !== "local") return reject("environment");
    if (typeof p.command !== "string" || !p.command || typeof p.cwd !== "string") return reject("command");
    if (gitLikeCommand(p.command)) return reject("git_boundary");
    if (![p.command, p.cwd, p.threadId, p.turnId, p.itemId, p.approvalId ?? "", p.reason ?? ""].every(commandTextSafe)) return reject("text");
    if (p.networkApprovalContext != null || (p.proposedNetworkPolicyAmendments?.length ?? 0) > 0) return reject("network");
    if (p.availableDecisions && !p.availableDecisions.includes("accept")) return reject("decision");
    if (p.additionalPermissions?.network?.enabled === true) return reject("network");

    const root = fs.realpathSync.native(workspaceRoot);
    if (root !== workspaceRoot || p.cwd !== root) return reject("cwd");
    const fsPerm = p.additionalPermissions?.fileSystem;
    if (fsPerm?.globScanMaxDepth != null) return reject("glob");

    const reads = new Set<string>();
    const writes = new Set<string>();
    for (const raw of fsPerm?.read ?? []) {
      const boundary = permissionBoundary(root, raw);
      if (!boundary) return reject("permission");
      reads.add(raw);
    }
    for (const raw of fsPerm?.write ?? []) {
      const boundary = permissionBoundary(root, raw);
      if (!boundary) return reject("permission");
      writes.add(raw);
    }

    const entryReads = new Set<string>();
    const entryWrites = new Set<string>();
    for (const entry of fsPerm?.entries ?? []) {
      if (entry.access === "deny") return reject("entries");
      const raw = exactPermissionPath(entry.path);
      if (!raw || !permissionBoundary(root, raw)) return reject("entries");
      (entry.access === "read" ? entryReads : entryWrites).add(raw);
    }
    if (fsPerm?.entries) {
      if (reads.size && (reads.size !== entryReads.size || [...reads].some(v => !entryReads.has(v)))) return reject("entries");
      if (writes.size && (writes.size !== entryWrites.size || [...writes].some(v => !entryWrites.has(v)))) return reject("entries");
      if (!reads.size) for (const v of entryReads) reads.add(v);
      if (!writes.size) for (const v of entryWrites) writes.add(v);
    }
    if (reads.size + writes.size > 16) return reject("scope_count");

    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw, "utf8") > 16384 || redactAndTruncate(raw, 32768).redactionCount) return reject("request");
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return reject("root");
    const hash = createHash("sha256").update(raw).update(root)
      .update(JSON.stringify([rootStat.dev, rootStat.ino, rootStat.mode, rootStat.uid]));
    for (const item of [...reads].sort()) {
      const boundary = permissionBoundary(root, item);
      if (!boundary || !hashPathIdentity(hash, boundary, item)) return reject("path_identity");
      hash.update("read").update(item);
    }
    for (const item of [...writes].sort()) {
      const boundary = permissionBoundary(root, item);
      if (!boundary || !hashPathIdentity(hash, boundary, item)) return reject("path_identity");
      hash.update("write").update(item);
    }
    return {
      type: "workspace_command",
      root,
      command: p.command,
      readPaths: [...reads].sort(),
      writePaths: [...writes].sort(),
      fingerprint: hash.digest("hex"),
    };
  } catch {
    return reject("inspection");
  }
}

export function validateLocalApproval(value: unknown, workspaceRoot: string, rejected?: (stage: ApprovalDiagnostic["stage"]) => void): LocalApprovalScope | null {
  return validateGitApproval(value, workspaceRoot) ?? validateWorkspaceCommandApproval(value, workspaceRoot, rejected);
}

export function localApprovalPresentation(scope: LocalApprovalScope, task: string, run: string): { mode: string; message: string } {
  const common = [`対象: ${path.basename(scope.root)}\n${scope.root}`, `作業: ${task}\nrun: ${run}`];
  if (scope.type === "managed_network") return { mode: LOCAL_NETWORK_APPROVAL_SCRIPT, message: [...common,
    `操作: 管理ネットワークの保留中の宛先要求を許可\n宛先: ${scope.host}\nプロトコル: HTTPS`,
    "追加ファイル権限: なし。永続・セッション許可は発行しません。",
    "この要求への一回限りの応答です。Codex が同じ宛先の要求をまとめる場合があり、HTTP 接続一回だけを保証する承認ではありません。",
    "45分で自動的に拒否します。",
  ].join("\n\n") };
  const message = scope.type === "workspace_command"
    ? [...common,
      "操作: 下記コマンドを一回だけ実行",
      `コマンド:\n${redactAndTruncate(scope.command, 4096).text}`,
      `追加読取範囲:\n${scope.readPaths.length ? scope.readPaths.join("\n") : "なし"}`,
      `追加書込範囲:\n${scope.writePaths.length ? scope.writePaths.join("\n") : "なし"}`,
      "ネットワーク追加: なし",
      `確認値: ${scope.fingerprint}`,
      "この承認ダイアログは45分で自動的に拒否します。許可はこのexact commandへの一回限りです。session/persistent許可は発行しません。"
    ].join("\n\n")
    : [...common,
      `操作: ${scope.type === "git_commit" ? "指定ファイルだけをコミット" : "指定ファイルだけをステージ"}`,
      `追加書込範囲: ${scope.root}/.git\nネットワーク追加: なし`,
      `ファイル:\n${scope.files.join("\n")}`,
      `確認値: ${scope.fingerprint}`,
      "この承認ダイアログは45分で自動的に拒否します。許可は同じ実行への一回限りです。"
    ].join("\n\n");
  return { mode: scope.type === "workspace_command" ? LOCAL_COMMAND_APPROVAL_SCRIPT : LOCAL_GIT_APPROVAL_SCRIPT, message };
}

export async function nativeLocalApproval(scope: LocalApprovalScope, task: string, run: string, signal: AbortSignal, onPhase?: (phase: NativeHelperPhase) => void): Promise<string> {
  if (process.platform !== "darwin") return "unavailable";
  const presentation = localApprovalPresentation(scope, task, run);
  try { return await executeFolderScript(presentation.mode, [presentation.message], OWNER_DIALOG_HELPER_TIMEOUT_MS, signal, undefined, onPhase); }
  catch (error) {
    const code = safeNativeFailureCode(error);
    if (code) throw Object.assign(new Error("Native approval helper failed."), { code });
    return "unavailable";
  }
}
