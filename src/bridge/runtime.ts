import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  trustedTunnelAuth?: boolean;
  codexExecution?: boolean;
  startedAt: string;
}

export function runtimeFile(workspaceId: string): string {
  if (!/^[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Invalid workspace id for runtime state.");
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  const validated = validateRuntimeState(state, state.workspaceId);
  if (!validated) throw new Error("Invalid runtime state.");
  writeSecureJson(runtimeFile(state.workspaceId), validated);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return validateRuntimeState(readJsonIfExists<unknown>(runtimeFile(workspaceId), 64 * 1024), workspaceId);
}

function normalizeRuntimePublicUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function validateRuntimeState(value: unknown, workspaceId: string): RuntimeState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const publicUrl = normalizeRuntimePublicUrl(raw.publicUrl);
  if (
    raw.service !== SERVICE_NAME ||
    typeof raw.version !== "string" ||
    raw.version.length < 1 ||
    raw.version.length > 100 ||
    raw.workspaceId !== workspaceId ||
    typeof raw.workspaceRoot !== "string" ||
    raw.workspaceRoot.length < 1 ||
    raw.workspaceRoot.length > 4096 ||
    !path.isAbsolute(raw.workspaceRoot) ||
    /[\u0000-\u001f\u007f]/.test(raw.workspaceRoot) ||
    typeof raw.pid !== "number" ||
    !Number.isInteger(raw.pid) ||
    raw.pid < 1 ||
    typeof raw.port !== "number" ||
    !Number.isInteger(raw.port) ||
    raw.port < 1 ||
    raw.port > 65_535 ||
    typeof raw.adminToken !== "string" ||
    !/^c2c_admin_[A-Za-z0-9_-]{32}$/.test(raw.adminToken) ||
    publicUrl === undefined ||
    (raw.trustedTunnelAuth !== undefined && typeof raw.trustedTunnelAuth !== "boolean") ||
    (raw.codexExecution !== undefined && typeof raw.codexExecution !== "boolean") ||
    typeof raw.startedAt !== "string" ||
    raw.startedAt.length > 64 ||
    !Number.isFinite(Date.parse(raw.startedAt))
  ) {
    return null;
  }
  return {
    service: SERVICE_NAME,
    version: raw.version,
    workspaceId,
    workspaceRoot: raw.workspaceRoot,
    pid: raw.pid,
    port: raw.port,
    adminToken: raw.adminToken,
    publicUrl,
    trustedTunnelAuth: raw.trustedTunnelAuth as boolean | undefined,
    codexExecution: raw.codexExecution as boolean | undefined,
    startedAt: raw.startedAt,
  };
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  status: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const state = readRuntimeState(workspaceId);
  if (!state) return null;
  const health = await probeBridge(state.port);
  if (!health) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/admin/info`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const info = (await response.json()) as {
      service?: unknown;
      version?: unknown;
      workspaceId?: unknown;
      pid?: unknown;
    };
    if (
      info.service === SERVICE_NAME &&
      info.version === state.version &&
      info.workspaceId === workspaceId &&
      info.pid === state.pid
    ) {
      return state;
    }
  } catch {
    return null;
  }
  return null;
}

export { SERVICE_NAME, VERSION };
