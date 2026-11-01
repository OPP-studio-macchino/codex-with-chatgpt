import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactAndTruncate } from "../security/redaction.js";

// Deliberately closed subset of the installed official form schema. No defaults,
// free-text/secret fields, extensions or display transformations authorize input.
const secret = /password|passwd|secret|token|credential|api[ _-]?key|cookie|authorization|private[ _-]?key/i;
export function elicitationText(value: string, bytes = 2048): string {
  if (secret.test(value)) return "[OMITTED SECRET-BEARING TEXT]";
  return redactAndTruncate(value.replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/https?:\/\/[^\s<>"']+/gi, url => {
      try { const u = new URL(url); return u.origin + "/[PATH QUERY FRAGMENT OMITTED]"; }
      catch { return "[URL OMITTED]"; }
    }), bytes).text;
}
const text = z.string().min(1).max(1024).refine(s => Buffer.byteLength(s) <= 1024 && elicitationText(s) === s);
const labels = { title: text.optional(), description: text.optional() };
const field = z.union([
  z.object({ type: z.literal("boolean"), ...labels }).strict(),
  z.object({ type: z.enum(["integer", "number"]), ...labels,
    minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict()
    .refine(f => f.minimum === undefined || f.maximum === undefined || f.minimum <= f.maximum),
  z.object({ type: z.literal("string"), ...labels, enum: z.array(text).min(1).max(8) }).strict()
    .refine(f => new Set(f.enum).size === f.enum.length),
]);
export const formSchema = z.object({ type: z.literal("object"), properties: z.record(field), required: z.array(text).min(1).max(8) }).strict()
  .refine(s => {
    const keys = Object.keys(s.properties);
    return keys.length > 0 && keys.length <= 8 && s.required.length === keys.length && new Set(s.required).size === keys.length &&
      keys.every(k => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k) && !secret.test(k) &&
        !["constructor", "prototype", "__proto__"].includes(k) && s.required.includes(k));
  });
export const formParams = z.object({ threadId: z.string().min(1).max(256), turnId: z.string().min(1).max(256),
  serverName: text, mode: z.literal("form"), message: text, requestedSchema: formSchema }).strict()
  .refine(p => ElicitRequestFormParamsSchema.safeParse({ mode: p.mode, message: p.message, requestedSchema: p.requestedSchema }).success);
export type ElicitationForm = z.infer<typeof formSchema>;
export const elicitationEvidenceSchema = z.object({
  method: z.string().max(128), request_kind: z.enum(["form", "url", "verification", "unknown"]),
  observed_mode: z.enum(["form", "openai/form", "openaiForm", "url", "openai/userVerification", "unknown", "unavailable"]),
  correlation_sha256: z.string().regex(/^[a-f0-9]{64}$/), observed_at: z.string().datetime(),
  server: z.string().max(1024), originating_tool: z.literal("unavailable"),
  classification: z.enum(["supported_form", "unsupported_url", "unsupported_schema", "unsupported_verification", "malformed"]),
  summary: z.string().refine(s => Buffer.byteLength(s) <= 8192), omissions: z.array(z.string().max(128)).max(8),
}).strict();
export type ElicitationEvidence = z.infer<typeof elicitationEvidenceSchema>;
export type ElicitationEvent = { evidence: ElicitationEvidence; phase: "captured" | "pending" | "response_attempted" | "write_acknowledged" | "channel_closed";
  action?: "accept" | "decline" | "cancel"; reason?: string };

export function captureElicitation(value: Record<string, unknown>): ElicitationEvidence {
  const p = value.params && typeof value.params === "object" && !Array.isArray(value.params)
    ? value.params as Record<string, unknown> : {};
  const bounded = Buffer.byteLength(JSON.stringify(p)) <= 16 * 1024;
  const parsed = bounded && value.method === "mcpServer/elicitation/request" ? formParams.safeParse(p) : undefined;
  const mode = p.mode === undefined ? "unavailable" : p.mode === "form" || p.mode === "openai/form" || p.mode === "openaiForm" || p.mode === "url" || p.mode === "openai/userVerification" ? p.mode : "unknown";
  const kind = mode === "form" || mode === "openai/form" || mode === "openaiForm" ? "form" : mode === "url" ? "url" : mode === "openai/userVerification" ? "verification" : "unknown";
  // Unsupported data is never recursively copied: unknown metadata, env and
  // arbitrary schema values may contain credentials. Retain shape diagnostics.
  const summary = parsed?.success ? JSON.stringify({ message: parsed.data.message, requestedSchema: parsed.data.requestedSchema })
    : JSON.stringify({ message: typeof p.message === "string" ? elicitationText(p.message) : "unavailable",
      schema_type: p.requestedSchema && typeof p.requestedSchema === "object" ? "object" : typeof p.requestedSchema,
      url: typeof p.url === "string" ? elicitationText(p.url) : "unavailable",
      rpc_id_type: value.id === undefined ? "unavailable" : typeof value.id,
      ...(kind === "verification" ? { title: typeof p.title === "string" ? elicitationText(p.title) : "unavailable",
        description: typeof p.description === "string" ? elicitationText(p.description) : "unavailable" } : {}),
      elicitation_id_sha256: typeof p.elicitationId === "string" ? correlation(p.elicitationId) : "unavailable" });
  return elicitationEvidenceSchema.parse({ method: elicitationText(String(value.method), 128), request_kind: kind, observed_mode: mode,
    correlation_sha256: correlation({ id: value.id, threadId: p.threadId, turnId: p.turnId }), observed_at: new Date().toISOString(),
    server: typeof p.serverName === "string" ? elicitationText(p.serverName, 1024) : "unavailable", originating_tool: "unavailable",
    classification: value.method !== "mcpServer/elicitation/request" ? "malformed" : parsed?.success ? "supported_form"
      : kind === "url" ? ElicitRequestURLParamsSchema.safeParse(p).success ? "unsupported_url" : "malformed"
        : kind === "verification" ? typeof p.challenge === "string" && typeof p.title === "string" && typeof p.description === "string" ? "unsupported_verification" : "malformed"
          : kind === "form" ? "unsupported_schema" : "malformed",
    summary: redactAndTruncate(summary, 8192).text,
    omissions: parsed?.success ? ["originating_tool_unavailable", "raw_correlation_omitted", ...(Buffer.byteLength(summary) > 8192 ? ["summary_truncated_to_8192_bytes"] : [])]
      : ["originating_tool_unavailable", "raw_correlation_omitted", "unknown_metadata_and_schema_values_omitted", bounded ? "unsupported_or_malformed_shape" : "request_over_16KiB", "url_path_query_fragment_omitted",
        ...(kind === "verification" ? ["device_auth_challenge_and_proof_omitted"] : []),
        ...(Buffer.byteLength(summary) > 8192 ? ["summary_truncated_to_8192_bytes"] : [])] });
}
const correlation = (v: unknown) => createHash("sha256").update(JSON.stringify(v) ?? "unavailable").digest("hex");

export function validElicitationContent(schema: ElicitationForm, content: unknown): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  const values = content as Record<string, unknown>, keys = Object.keys(values);
  if (keys.length !== schema.required.length || keys.some(k => !schema.required.includes(k))) return false;
  return schema.required.every(k => {
    if (!Object.hasOwn(values, k)) return false;
    const f = schema.properties[k], v = values[k];
    if (f.type === "boolean") return typeof v === "boolean";
    if (f.type === "string") return typeof v === "string" && f.enum.includes(v);
    return typeof v === "number" && Number.isFinite(v) && (f.type !== "integer" || Number.isSafeInteger(v)) &&
      (f.minimum === undefined || v >= f.minimum) && (f.maximum === undefined || v <= f.maximum);
  });
}
