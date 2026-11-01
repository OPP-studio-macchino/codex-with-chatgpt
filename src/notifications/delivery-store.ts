import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { getStateDir } from "../config/paths.js";
import { readPrivateFile, writePrivateFile } from "../security/stable-file.js";
import { notificationOutcomeSchema } from "../execution/extensions.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const id = z.string().regex(/^[a-f0-9]{64}$/).length(64);
export const noticeCategorySchema = z.enum(["completed", "blocked", "failed", "approval_required", "user_input_required",
  "mcp_elicitation_required", "decision_owner_attention"]);
export type NoticeCategory = z.infer<typeof noticeCategorySchema>;
export function noticeCategory(state: string, reason?: string): NoticeCategory {
  const parsed = noticeCategorySchema.safeParse(reason);
  return parsed.success ? parsed.data : noticeCategorySchema.parse(state);
}
export const notificationId = (workspace: string, run: string, event: string): string => digest(JSON.stringify([workspace, run, event]));

const deliverySchema = z.object({ version: z.literal(1), notification_id: id, reservation_sha256: id,
  attempts: z.number().int().min(1).max(1_000_000), next_attempt_at: z.string().datetime(),
  observed_at: z.string().datetime(), observation: z.union([
    z.object({ outcome: z.literal("dispatch_intent") }).strict(), notificationOutcomeSchema,
  ]),
}).strict().refine(d => {
  const delay = Date.parse(d.next_attempt_at) - Date.parse(d.observed_at);
  return delay >= 1_000 && delay <= 60_000;
});
export type NoticeDelivery = z.infer<typeof deliverySchema>;

/** Fixed local channel paths; never accepts a path or channel from a caller. */
export function notificationFile(notification: string, native = false): string {
  id.parse(notification);
  return path.join(getStateDir(), "notification-delivery", `${notification}.${native ? "native" : "json"}`);
}

export function readNoticeDelivery(notification: string, reservation: string): NoticeDelivery | null {
  const raw = readPrivateFile(notificationFile(notification), 4096);
  if (raw === null) return null; // Missing attempt evidence is unknown, never receipt.
  const envelope = z.object({ payload: deliverySchema, sha256: id }).strict().parse(JSON.parse(raw));
  if (envelope.sha256 !== digest(JSON.stringify(envelope.payload)) || envelope.payload.notification_id !== notification ||
      envelope.payload.reservation_sha256 !== reservation) throw new Error("NOTIFICATION_DELIVERY_CHANGED");
  return envelope.payload;
}

export function writeNoticeDelivery(delivery: NoticeDelivery): void {
  const payload = deliverySchema.parse(delivery);
  // Read before replace so a symlink, oversized or malformed existing spool fails closed.
  readNoticeDelivery(payload.notification_id, payload.reservation_sha256);
  writePrivateFile(notificationFile(payload.notification_id), JSON.stringify({ payload, sha256: digest(JSON.stringify(payload)) }), 4096);
}

export const deliveryDelay = (attempts: number): number => Math.min(60_000, 1_000 * 2 ** Math.min(6, attempts - 1));
