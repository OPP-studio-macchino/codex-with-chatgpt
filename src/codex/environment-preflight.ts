import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export const PREFLIGHT_TIMEOUT_MS = 1_500;
export const PREFLIGHT_OUTPUT_BYTES = 4_096;
export const PREFLIGHT_CLEANUP_MS = 500;

function entryIdentity(binary: string) {
  // The client supplies its already resolved canonical entry, never a caller path.
  if (fs.realpathSync.native(binary) !== binary) throw new Error("Entry changed");
  const stat = fs.lstatSync(binary, { bigint: true });
  if (!stat.isFile()) throw new Error("Entry unavailable");
  fs.accessSync(binary, fs.constants.X_OK);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    canonical_entry_sha256: hash(binary),
    metadata_sha256: hash([binary, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join("\n")),
    fingerprint_scope: "canonical_path_and_file_metadata_not_content" as const,
    underlying_toolchain: "unverified" as const,
  };
}

type ProbeStatus = "observed" | "identity_unavailable" | "identity_changed" | "spawn_failed" |
  "failed_exit" | "timed_out" | "output_limit" | "invalid_version_output" | "cancelled" | "cleanup_unconfirmed";

export interface EnvironmentObservation {
  evidence_scope: "fixed_version_probe_only";
  probe_status: ProbeStatus;
  observed_at: string;
  observed_version: string | null;
  configured_entry: ReturnType<typeof entryIdentity> | null;
  identity_after: ReturnType<typeof entryIdentity> | null;
  identity_stability: "unchanged_at_boundaries" | "changed" | "unknown";
  identity_limitations: string;
  cleanup: "child_closed" | "no_child" | "unconfirmed";
  cleanup_scope: string;
  exit_code: number | null;
  limits: { timeout_ms: number; output_max_bytes: number; cleanup_ms: number };
  app_server_compatibility: "unverified";
  mcp_inventory: { status: "unknown"; tools: null };
  live_acceptance: "unverified";
}

/** Internal only: arguments/environment come from the configured workspace client. */
export async function observeExecutionEnvironment(binary: string, workspaceRoot: string,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<EnvironmentObservation> {
  const observation: EnvironmentObservation = {
    evidence_scope: "fixed_version_probe_only", probe_status: "identity_unavailable",
    observed_at: new Date().toISOString(), observed_version: null,
    configured_entry: null, identity_after: null, identity_stability: "unknown",
    identity_limitations: "Metadata at two boundaries only; no executed-byte pin, transient-change guarantee, dependency pin or current-status identity recheck.",
    cleanup: "no_child",
    cleanup_scope: process.platform === "win32" ? "direct_child_only" : "process_group_best_effort; escaped descendants unverified",
    exit_code: null,
    limits: { timeout_ms: PREFLIGHT_TIMEOUT_MS, output_max_bytes: PREFLIGHT_OUTPUT_BYTES, cleanup_ms: PREFLIGHT_CLEANUP_MS },
    app_server_compatibility: "unverified", mcp_inventory: { status: "unknown", tools: null }, live_acceptance: "unverified",
  };
  try { observation.configured_entry = entryIdentity(binary); } catch { return observation; }
  if (signal.aborted) { observation.probe_status = "cancelled"; return observation; }

  await new Promise<void>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["--version"], {
        cwd: workspaceRoot, env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { observation.probe_status = "spawn_failed"; resolve(); return; }
    let done = false;
    let failure: ProbeStatus | undefined;
    let bytes = 0;
    const stdout: Buffer[] = [];
    let cleanupTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group may already have exited. */ }
      }
      try { child.kill("SIGKILL"); } catch { /* Closure below determines observed cleanup. */ }
    };
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", abort);
      observation.cleanup = child.pid ? (closed ? "child_closed" : "unconfirmed") : "no_child";
      observation.exit_code = child.exitCode;
      // Whitelist version syntax only. Never retain arbitrary stdout or raw stderr.
      const version = Buffer.concat(stdout).toString("utf8").trim().match(
        /^codex(?:-cli)? ([0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}(?:-(?:alpha|beta|rc|dev)(?:\.[0-9]{1,8})?)?)$/,
      );
      observation.probe_status = !closed ? "cleanup_unconfirmed" : failure ??
        (child.exitCode !== 0 ? "failed_exit" : version ? "observed" : "invalid_version_output");
      if (observation.probe_status === "observed") observation.observed_version = version![1];
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve();
    };
    const stop = (reason?: ProbeStatus) => {
      if (done) return;
      failure ??= reason;
      kill();
      cleanupTimer ??= setTimeout(() => finish(false), PREFLIGHT_CLEANUP_MS);
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed_out"), PREFLIGHT_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PREFLIGHT_OUTPUT_BYTES) stop("output_limit");
      else if (!failure) stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PREFLIGHT_OUTPUT_BYTES) stop("output_limit");
    });
    child.once("error", () => stop("spawn_failed"));
    // Even normal launcher exit may leave descendants holding its output pipes.
    child.once("exit", () => stop());
    child.once("close", () => finish(true));
    if (signal.aborted) abort();
  });
  try {
    observation.identity_after = entryIdentity(binary);
    observation.identity_stability = observation.configured_entry.metadata_sha256 === observation.identity_after.metadata_sha256
      ? "unchanged_at_boundaries" : "changed";
  } catch { observation.identity_stability = "unknown"; }
  if (observation.identity_stability === "changed") observation.probe_status = "identity_changed";
  observation.observed_at = new Date().toISOString();
  return observation;
}
