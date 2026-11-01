import { createHash } from "node:crypto";
import { z } from "zod/v3";

export const approvalStages = ["schema", "kind", "environment", "command", "git_boundary", "text", "network", "decision", "cwd", "glob", "permission", "entries", "scope_count", "request", "root", "path_identity", "inspection"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const shape = z.enum(["absent", "null", "array", "object", "other"]);
export const nativeFailureCodeSchema = z.enum([
  "NATIVE_HELPER_PREPARE_FAILED", "NATIVE_HELPER_PREPARE_TIMEOUT",
  "NATIVE_HELPER_COMPILE_FAILED", "NATIVE_HELPER_COMPILE_TIMEOUT",
  "NATIVE_HELPER_SIGN_FAILED", "NATIVE_HELPER_SIGN_TIMEOUT",
  "NATIVE_HELPER_LAUNCH_FAILED", "NATIVE_HELPER_LAUNCH_TIMEOUT",
  "NATIVE_HELPER_RUN_FAILED", "NATIVE_HELPER_RUN_TIMEOUT",
  "NATIVE_HELPER_NOT_READY", "NATIVE_HELPER_CLEANUP_FAILED",
  "NATIVE_HELPER_SOURCE_INVALID", "NATIVE_HELPER_PROTOCOL_INVALID", "NATIVE_HELPER_RESPONSE_INVALID",
]);
export function safeNativeFailureCode(error: unknown): z.infer<typeof nativeFailureCodeSchema> | undefined {
  const parsed = nativeFailureCodeSchema.safeParse(error && typeof error === "object" && "code" in error ? error.code : undefined);
  return parsed.success ? parsed.data : undefined;
}
export const diagnosticPaths = new Set(["kind", "threadId", "turnId", "itemId", "startedAtMs", "approvalId", "environmentId", "reason", "command", "cwd", "commandActions", "additionalPermissions", "network", "enabled", "fileSystem", "read", "write", "entries", "globScanMaxDepth", "path", "type", "access", "pattern", "value", "networkApprovalContext", "host", "protocol", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions", "unknown", "[]"]);
const schemaDiagnostic = z.object({ valid: z.boolean(), issues: z.array(z.object({ code: z.nativeEnum(z.ZodIssueCode),
  path: z.array(z.string().refine(s => diagnosticPaths.has(s))).max(8) }).strict()).max(4), omitted: z.boolean() }).strict();
export const approvalDiagnosticSchema = z.object({
  version: z.literal(1), stage: z.enum(approvalStages), reason: z.enum(["scope_unverified", "native_delivery"]),
  request_sha256: digest, command_present: z.boolean(), command_sha256: digest.optional(), cwd_sha256: digest.optional(),
  permissions_shape: shape, filesystem_shape: shape,
  read_count: z.number().int().min(0).max(17), write_count: z.number().int().min(0).max(17), entry_count: z.number().int().min(0).max(17),
  network_requested: z.boolean(), decisions: z.array(z.enum(["accept_once", "deny", "session", "other"])).max(4),
  schema_diagnostic: schemaDiagnostic.optional(),
  native_delivery: z.object({
    phase: z.enum(["prepare", "compile", "sign", "launch", "pending_owner", "approved", "denied", "expired", "cancelled", "unavailable", "failed"]),
    readiness: z.enum(["unobserved", "helper_reported"]),
    user_receipt: z.literal("unknown"),
    failure_code: nativeFailureCodeSchema.optional(),
  }).strict().optional(),
}).strict();
export type ApprovalDiagnostic = z.infer<typeof approvalDiagnosticSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const kind = (value: unknown): z.infer<typeof shape> => value === undefined ? "absent" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : "other";
const count = (value: unknown) => Array.isArray(value) ? Math.min(value.length, 17) : 0;

/** Hashes only; no values or attacker-controlled field names survive. */
export function approvalDiagnostic(value: Record<string, unknown>, stage: ApprovalDiagnostic["stage"], schema?: unknown): ApprovalDiagnostic {
  const permissions = object(value.additionalPermissions), filesystem = object(permissions.fileSystem);
  const decisions: ApprovalDiagnostic["decisions"] = [...new Set((Array.isArray(value.availableDecisions) ? value.availableDecisions.slice(0, 8) : []).map(v =>
    v === "accept" ? "accept_once" as const : v === "decline" || v === "cancel" ? "deny" as const : v === "acceptForSession" ? "session" as const : "other" as const))];
  return approvalDiagnosticSchema.parse({ version: 1, stage, reason: "scope_unverified", request_sha256: hash(JSON.stringify(value)),
    ...(schema === undefined ? {} : { schema_diagnostic: schemaDiagnostic.parse(schema) }),
    command_present: typeof value.command === "string" && value.command.length > 0,
    ...(typeof value.command === "string" ? { command_sha256: hash(value.command) } : {}),
    ...(typeof value.cwd === "string" ? { cwd_sha256: hash(value.cwd) } : {}),
    permissions_shape: kind(value.additionalPermissions), filesystem_shape: kind(permissions.fileSystem),
    read_count: count(filesystem.read), write_count: count(filesystem.write), entry_count: count(filesystem.entries),
    network_requested: object(permissions.network).enabled === true || value.networkApprovalContext != null || (Array.isArray(value.proposedNetworkPolicyAmendments) && value.proposedNetworkPolicyAmendments.length > 0), decisions });
}
