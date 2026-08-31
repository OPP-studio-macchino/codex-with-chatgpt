import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists } from "./paths.js";
import { redactAndTruncate } from "../security/redaction.js";

export interface SavedSession {
  url: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
}

/** Validate and canonicalize a ChatGPT conversation URL before persistence. */
export function normalizeChatGptSessionUrl(input: string): string {
  const url = new URL(input);
  const isConversation = /^\/(?:c\/|g\/[^/]+\/c\/)[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  if (
    input.length > 2048 ||
    input !== input.trim() ||
    url.protocol !== "https:" ||
    url.hostname !== "chatgpt.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isConversation
  ) {
    throw new Error("Session URL must be a ChatGPT conversation URL on https://chatgpt.com.");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

export function sessionFile(workspaceId: string): string {
  if (!/^[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Invalid workspace id for session state.");
  return path.join(ensureDir(path.join(getStateDir(), "sessions")), `${workspaceId}.json`);
}

export function sanitizeSessionLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return undefined;
  return redactAndTruncate(clean, 200).text;
}

export function readSavedSession(file: string): SavedSession | null {
  const value = readJsonIfExists<unknown>(file, 64 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  let url: string;
  try {
    if (typeof raw.url !== "string") return null;
    url = normalizeChatGptSessionUrl(raw.url);
  } catch {
    return null;
  }
  if (
    typeof raw.savedAt !== "string" ||
    raw.savedAt.length > 64 ||
    !Number.isFinite(Date.parse(raw.savedAt)) ||
    (raw.taskId !== undefined &&
      (typeof raw.taskId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.taskId))) ||
    (raw.iteration !== undefined &&
      (typeof raw.iteration !== "number" ||
        !Number.isInteger(raw.iteration) ||
        raw.iteration < 0 ||
        raw.iteration > 10_000)) ||
    (raw.lastState !== undefined &&
      (typeof raw.lastState !== "string" || !/^[A-Z_]{2,32}$/.test(raw.lastState)))
  ) {
    return null;
  }
  return {
    url,
    title: sanitizeSessionLabel(raw.title),
    taskId: raw.taskId as string | undefined,
    iteration: raw.iteration as number | undefined,
    lastState: raw.lastState as string | undefined,
    savedAt: raw.savedAt,
  };
}
