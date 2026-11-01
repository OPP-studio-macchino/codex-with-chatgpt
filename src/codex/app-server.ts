import { OWNER_DIALOG_TIMEOUT_MS, OWNER_DIALOG_HELPER_TIMEOUT_MS, CODEX_TURN_TIMEOUT_MS } from "../security/owner-dialog-timeouts.js";
import { captureElicitation, formParams, validElicitationContent, type ElicitationEvent, type ElicitationEvidence, type ElicitationForm } from "./mcp-elicitation.js";
import { approvalDiagnostic, safeNativeFailureCode, type ApprovalDiagnostic } from "./approval-diagnostic.js";
import { FIRST_TURN_CONTRACT_PREFIX, RUNTIME_CONTRACT } from "./runtime-contract.js";
import { observeExecutionEnvironment, type EnvironmentObservation } from "./environment-preflight.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { executionModeSchema, executionSandbox, type ExecutionMode } from "./execution-mode.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import { redactAndTruncate } from "../security/redaction.js";
import { normalizeCodexNetworkHosts } from "./network-policy.js";
import type { Logger } from "../logger/index.js";
import { validateLocalApproval, validateManagedNetworkApproval, nativeLocalApproval, localApprovalScopeReason, localApprovalSchemaDiagnostic, type LocalApprovalScope } from "./local-approval.js";
import { NATIVE_HELPER_STARTUP_TIMEOUT_MS, type NativeHelperPhase } from "../workspace/registration-native.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 1_000;
const MAX_WAIT_TIMEOUT_MS = 3_000;
const CHILD_STOP_TIMEOUT_MS = 1_000;
const MAX_LINE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_INSTRUCTION_BYTES = 8 * 1024;
const DEFAULT_MAX_SUMMARY_BYTES = 8 * 1024;
const MAX_THREADS_PER_CHILD = 8;
const MAX_RUNS = 96;
const MAX_EXPIRED_TASKS = 96;
const MAX_NETWORK_APPROVALS_PER_TURN = 3;
const MAX_PROGRESS_ITEMS = 256;

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

type JsonObject = Record<string, unknown>;
export type CodexRunState = "running" | "completed" | "blocked" | "failed";

interface CodexLimits {
  maxInstructionBytes: number;
  maxSummaryBytes: number;
  waitTimeoutMs: number;
  economyMode: boolean;
  waitSource: string;
}

function envInteger(name: string, fallback: number, min: number, max: number): number | null {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function readLimits(logger: Logger): CodexLimits {
  const instruction = envInteger("C2C_CODEX_MAX_INSTRUCTION_BYTES", DEFAULT_MAX_INSTRUCTION_BYTES, 1024, 16 * 1024);
  const summary = envInteger("C2C_CODEX_MAX_SUMMARY_BYTES", DEFAULT_MAX_SUMMARY_BYTES, 1024, 32 * 1024);
  const waitTimeout = envInteger("C2C_CODEX_WAIT_TIMEOUT_MS", DEFAULT_WAIT_TIMEOUT_MS, 250, MAX_WAIT_TIMEOUT_MS);
  const economy = process.env.C2C_CODEX_ECONOMY_MODE;
  if (
    instruction === null ||
    summary === null ||
    waitTimeout === null ||
    (economy !== undefined && economy !== "0" && economy !== "1")
  ) {
    logger.warn("Invalid C2C Codex economy configuration; safe defaults applied.");
  }
  return {
    maxInstructionBytes: instruction ?? DEFAULT_MAX_INSTRUCTION_BYTES,
    maxSummaryBytes: summary ?? DEFAULT_MAX_SUMMARY_BYTES,
    waitTimeoutMs: waitTimeout ?? DEFAULT_WAIT_TIMEOUT_MS,
    economyMode: economy !== "0",
    waitSource: waitTimeout === null ? "invalid_env_fallback" : process.env.C2C_CODEX_WAIT_TIMEOUT_MS ? "environment" : "default",
  };
}

/** Bounded owner-trusted observation; never part of a generic run snapshot. */
export interface CodexProgressObservation {
  cursor: string;
  phase: "command_completed";
}

export interface CodexRunResult {
  execution_mode?: ExecutionMode;
  checkpoint_continuation?: true;
  original_context_restored?: false;
  task_id: string;
  iteration: number;
  state: CodexRunState;
  run_id: string;
  summary?: string;
  reason?: string;
  resumable?: boolean;
  approval_type?: "unsupported" | "managed_network" | "git_commit" | "git_stage" | "workspace_command";
  waiting_for_local_approval?: true;
  approval_diagnostic?: ApprovalDiagnostic;
  approval_diagnostic_available?: boolean;
  approval_scope_error?: "UNSUPPORTED_APPROVAL_SCOPE";
  approval_scope_reason?: string;
  approval_scope_diagnostic?: { valid: boolean; issues: Array<{ code: string; path: Array<string | number> }>; omitted: boolean };
  input_request_id?: string;
  questions?: InputQuestion[];
  elicitation_evidence?: ElicitationEvidence;
  elicitation_history?: Array<ElicitationEvent & { observed_at: string; resumable: false; delivery_proven: false; goal_verified: false }>;
  legacy_terminal_reason?: string;
  elicitation_request_id?: string;
  elicitation_prompt?: { message: string; requestedSchema: ElicitationForm; expires_at: string; untrusted_data: true };
  elicitation_response?: { action: "accept" | "decline" | "cancel"; transport_write_acknowledged: boolean;
    delivery_proven: false; server_acceptance_proven: false; run_resumption_proven: false; goal_verified: false };
}

const boundedText = (bytes: number) => z.string().min(1).max(bytes)
  .refine((text) => Buffer.byteLength(text, "utf8") <= bytes);
const questionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
    .refine((id) => !["__proto__", "prototype", "constructor"].includes(id)),
  header: boundedText(128),
  question: boundedText(2048),
  isSecret: z.boolean().optional(),
  isOther: z.boolean().optional(),
  options: z.array(z.object({ label: boundedText(256), description: boundedText(1024) }).strict()).min(1).max(8).nullable().optional(),
}).strict();
type InputQuestion = z.infer<typeof questionSchema>;
const inputParamsSchema = z.object({
  threadId: boundedText(256), turnId: boundedText(256), itemId: boundedText(256),
  questions: z.array(questionSchema).min(1).max(4),
  isBlocking: z.boolean().optional().default(true),
  autoResolutionMs: z.number().int().min(0).max(20 * 60_000).nullable().optional(),
}).strict();

function stripControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

function inputDisplay(text: string): string {
  return redactAndTruncate(stripControls(text), 4096).text;
}

interface PendingInput {
  rpcId: string | number;
  turnId: string;
  nonce: string;
  questions: InputQuestion[];
  expiresAt?: number;
  timer?: NodeJS.Timeout;
}

interface Run extends CodexRunResult {
  progress?: CodexProgressObservation;
  progressItems: Map<string, "started" | "closed">;
  progressCount: number;
  progressDisabled?: true;
  execution_mode: ExecutionMode;
  threadId: string;
  turnId?: string;
  epoch: number;
  timer?: NodeJS.Timeout;
  waiters: Set<() => void>;
  lastAgentMessage?: string;
  executionRecordWritten?: boolean;
  executionRecordWrite?: Promise<void>;
  networkApprovals: number;
  input?: PendingInput;
  inputIds: Set<string | number>;
  elicitation?: { rpcId: string | number; turnId: string; nonce: string; message: string; schema: ElicitationForm; expires: number; timer: NodeJS.Timeout };
  elicitationCount?: number;
  approval?: { rpcId: string | number; turnId: string; params: JsonObject; scope: LocalApprovalScope;
    controller: AbortController; timer: NodeJS.Timeout; expires: number; started: boolean };
  approvalScopeDiagnostic?: { valid: boolean; issues: Array<{ code: string; path: Array<string | number> }>; omitted: boolean };
}

interface Task {
  executionMode: ExecutionMode;
  threadId: string;
  lastIteration: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  epoch: number;
}

export interface CodexAppServerOptions {
  /** Evidence-only observer; never authorizes or replays a command. */
  onCommandObservation?: (run: CodexRunResult, item: import("../execution/command-evidence.js").CommandObservation) => void;
  workspaceRoot: string;
  binary?: string;
  logger: Logger;
  /** Exact owner-approved HTTPS hosts eligible for one-request network approval. */
  allowedNetworkHosts?: readonly string[];
  /** Synchronous write-ahead hook: failure prevents child/turn startup. */
  onRunStarting?: (run: CodexRunResult, instruction: string) => void;
  /** Synchronous durable terminal hook, independent of MCP wait. */
  onRunTerminal?: (run: CodexRunResult) => void;
  /** Transition-only hook, independent of polling. */
  onRunNotification?: (run: CodexRunResult, eventId: string) => void;
  /** Required durable safe evidence hook. Failure closes transport before reply. */
  onElicitation?: (run: CodexRunResult, event: ElicitationEvent) => void;
}

export class CodexAppServerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function validateExecutable(candidate: string, workspaceRoot: string): string {
  if (!path.isAbsolute(candidate)) throw new Error("Codex binary path must be absolute.");
  const canonical = fs.realpathSync.native(candidate);
  const workspace = fs.realpathSync.native(workspaceRoot);
  const components = canonical.split(/[\\/]+/).map((part) => part.toLowerCase());
  if (isInside(workspace, canonical)) throw new Error("Codex binary must be outside the workspace.");
  if (components.some((part, i) => part === "node_modules" && components[i + 1] === ".bin")) {
    throw new Error("Codex binary must not come from node_modules/.bin.");
  }
  if (!fs.statSync(canonical).isFile()) throw new Error("Codex binary must be a regular file.");
  fs.accessSync(canonical, fs.constants.X_OK);
  return canonical;
}

export function resolveCodexBinary(workspaceRoot: string, requested?: string): string {
  if (requested) return validateExecutable(requested, workspaceRoot);
  const home = process.env.HOME;
  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    ...(home ? [
      path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      path.join(home, ".local", "bin", "codex"),
    ] : []),
  ];
  const releaseRoot = home ? path.join(home, ".codex", "packages", "standalone", "releases") : null;
  for (const candidate of candidates) {
    try {
      const canonical = validateExecutable(candidate, workspaceRoot);
      if (candidate.includes("Codex.app")) {
        const end = candidate.indexOf("Codex.app") + 9;
        const appRoot = fs.realpathSync.native(candidate.slice(0, end));
        if (isInside(appRoot, canonical)) return canonical;
      }
      if (releaseRoot && fs.existsSync(releaseRoot)) {
        if (isInside(fs.realpathSync.native(releaseRoot), canonical)) return canonical;
      }
    } catch {
      // Try the next fixed official installation location.
    }
  }
  throw new Error("No supported installed Codex binary was found; pass --codex-binary with an absolute path.");
}

function codexEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
      : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const pathKeys = [
    "HOME", "USERPROFILE", "CODEX_HOME", "TMPDIR", "TMP", "TEMP",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  ];
  for (const key of pathKeys) {
    const value = process.env[key];
    if (!value || !path.isAbsolute(value)) continue;
    try {
      const canonical = fs.existsSync(value) ? fs.realpathSync.native(value) : path.resolve(value);
      if (!isInside(workspaceRoot, canonical)) env[key] = value;
    } catch {
      // Omit invalid state paths instead of passing them to Codex.
    }
  }
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  return env;
}

export class CodexAppServer {
  readonly binary: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private stopping: Promise<void> | null = null;
  private epochCounter = 0;
  private activeEpoch = 0;
  private nextRequestId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private tasks = new Map<string, Task>();
  private expiredTasks = new Map<string, ExecutionMode>();
  private runs = new Map<string, Run>();
  private active: Run | null = null;
  private starting = false;
  private closed = false;
  private persistenceFailed = false;
  private readonly limits: CodexLimits;
  private readonly allowedNetworkHosts: ReadonlySet<string>;
  private environmentObservation: EnvironmentObservation | null = null;
  private environmentProbe: Promise<EnvironmentObservation> | null = null;
  private environmentProbeController: AbortController | null = null;

  constructor(private readonly opts: CodexAppServerOptions) {
    this.binary = resolveCodexBinary(opts.workspaceRoot, opts.binary);
    this.limits = readLimits(opts.logger);
    this.allowedNetworkHosts = new Set(normalizeCodexNetworkHosts(opts.allowedNetworkHosts ?? []));
  }

  async startTurn(taskId: string, iteration: number, instruction: string, executionMode?: ExecutionMode): Promise<CodexRunResult> {
    return this.startTurnInternal(taskId, iteration, instruction, executionMode);
  }

  /** Internal controller seam: admission must durably consume the checkpoint before any child starts. */
  async startCheckpointTurn(taskId: string, iteration: number, instruction: string,
    admit: (run: CodexRunResult) => void, executionMode?: ExecutionMode): Promise<CodexRunResult> {
    return this.startTurnInternal(taskId, iteration, instruction, executionMode, admit);
  }

  private async startTurnInternal(taskId: string, iteration: number, instruction: string,
    requestedMode?: ExecutionMode, admit?: (run: CodexRunResult) => void): Promise<CodexRunResult> {
    const parsedMode = executionModeSchema.default("read_only").safeParse(requestedMode);
    if (!parsedMode.success) throw new CodexAppServerError("INVALID_EXECUTION_MODE", "execution_mode must be read_only or workspace_write.");
    const executionMode = parsedMode.data;
    if ((this.tasks.has(taskId) && this.tasks.get(taskId)!.executionMode !== executionMode) ||
        (this.expiredTasks.has(taskId) && this.expiredTasks.get(taskId) !== executionMode) ||
        [...this.runs.values()].some(run => run.task_id === taskId && run.execution_mode !== executionMode)) {
      throw new CodexAppServerError("EXECUTION_MODE_MISMATCH", "A task's execution_mode cannot change; use a new task for a different mode.");
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(taskId)) {
      throw new CodexAppServerError("INVALID_TASK_ID", "task_id has an invalid format.");
    }
    if (!Number.isSafeInteger(iteration) || iteration < 1) {
      throw new CodexAppServerError(
        "INVALID_ITERATION",
        "iteration must be a positive safe integer."
      );
    }
    const newTask = !this.tasks.has(taskId);
    const turnInstruction = newTask && this.limits.economyMode
      ? `${FIRST_TURN_CONTRACT_PREFIX}${instruction}`
      : instruction;
    if (!instruction || Buffer.byteLength(turnInstruction, "utf8") > this.limits.maxInstructionBytes) {
      throw new CodexAppServerError(
        "INVALID_INSTRUCTION",
        `instruction exceeds the local ${this.limits.maxInstructionBytes}-byte limit.`
      );
    }

    if (this.persistenceFailed) {
      throw new CodexAppServerError("TASK_JOURNAL_UNAVAILABLE", "Durable task recording failed; execution is stopped for reconciliation.");
    }
    const retained = [...this.runs.values()].find(
      (run) => run.task_id === taskId && run.iteration === iteration
    );
    if (retained) return this.publicResult(retained);
    if (this.closed) throw new CodexAppServerError("CLOSED", "Codex App Server client is closed.");
    if (this.active?.state === "running" || this.starting) {
      throw new CodexAppServerError("TURN_ACTIVE", "Only one Codex turn may be active at a time.");
    }

    const task = admit ? undefined : this.tasks.get(taskId);
    if (!admit && !task && this.expiredTasks.has(taskId)) {
      throw new CodexAppServerError("TASK_CONTEXT_EXPIRED", "The ephemeral Codex task context has expired.");
    }
    if (task && iteration !== task.lastIteration + 1) {
      throw new CodexAppServerError("INVALID_ITERATION", "iteration must advance exactly once for an existing task.");
    }
    if (!admit && !task && iteration !== 1) {
      throw new CodexAppServerError("INVALID_ITERATION", "A new task must start at iteration 1.");
    }

    this.starting = true;
    const run: Run = {
      task_id: taskId, iteration, state: "running", execution_mode: executionMode,
      ...(admit ? { checkpoint_continuation: true as const, original_context_restored: false as const } : {}),
      run_id: randomBytes(16).toString("hex"), threadId: "", epoch: 0,
      waiters: new Set(), networkApprovals: 0, inputIds: new Set(),
      progressItems: new Map(), progressCount: 0,
    };
    let admitted = false;
    try {
      try {
        if (admit) admit(this.publicResult(run));
        else this.opts.onRunStarting?.(this.publicResult(run), instruction);
      } catch {
        this.persistenceFailed = true;
        throw new CodexAppServerError("TASK_JOURNAL_UNAVAILABLE", "Task start could not be recorded; no child or turn was started.");
      }
      admitted = true;
      if (!task && this.tasks.size >= MAX_THREADS_PER_CHILD) await this.recycleChild();
      await this.ensureInitialized();

      let currentTask = admit ? undefined : this.tasks.get(taskId);
      if (!currentTask) {
        const response = await this.request("thread/start", {
          cwd: this.opts.workspaceRoot,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: executionMode === "read_only" ? "read-only" : "workspace-write",
          ephemeral: true,
          // Enable permission requests and Default-mode structured input. Approvals
          // and answers still require an explicit user decision.
          config: {
            "features.exec_permission_approvals": true,
            "features.default_mode_request_user_input": true,
            // Override each inherited writer setting, even on reader threads.
            "sandbox_workspace_write.writable_roots": [],
            "sandbox_workspace_write.network_access": false,
            "sandbox_workspace_write.exclude_tmpdir_env_var": true,
            "sandbox_workspace_write.exclude_slash_tmp": true,
          },
        });
        if (!isObject(response) || !isObject(response.thread) || typeof response.thread.id !== "string") {
          this.failChild("thread_policy_unverified", this.activeEpoch);
          throw new Error("Invalid thread/start response.");
        }
        if (response.cwd !== this.opts.workspaceRoot || response.approvalPolicy !== "on-request" ||
            response.approvalsReviewer !== "user" || !isDeepStrictEqual(response.sandbox, executionSandbox(executionMode))) {
          this.failChild("thread_policy_unverified", this.activeEpoch);
          throw new CodexAppServerError("UNSUPPORTED_SANDBOX_POLICY", "The effective thread sandbox could not be verified; no turn was started.");
        }
        currentTask = {
          executionMode,
          threadId: response.thread.id,
          lastIteration: admit ? iteration - 1 : 0,
        };
        this.tasks.set(taskId, currentTask);
      }

      run.threadId = currentTask.threadId;
      run.epoch = this.activeEpoch;
      this.retainRun(run);
      this.active = run;
      currentTask.lastIteration = iteration;

      try {
        const response = await this.request("turn/start", {
          threadId: currentTask.threadId,
          input: [{
            type: "text",
            text: turnInstruction,
            text_elements: [],
          }],
          cwd: this.opts.workspaceRoot,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: executionSandbox(executionMode),
        });
        if (!isObject(response) || !isObject(response.turn) || typeof response.turn.id !== "string") {
          throw new Error("Invalid turn/start response.");
        }
        run.turnId = response.turn.id;
        if (run.approval) {
          if (run.approval.turnId !== run.turnId) this.failChild("approval_identity_mismatch", run.epoch);
          else this.openLocalApproval(run);
        }
        if (run.input && run.input.turnId !== run.turnId) this.failChild("input_identity_mismatch", run.epoch);
        if (run.elicitation && run.elicitation.turnId !== run.turnId) this.failChild("elicitation_identity_mismatch", run.epoch);
        this.notifyRun(run);
        if (run.state !== "running") return this.publicResult(run);
        for (const waiter of run.waiters) waiter();
        run.timer = setTimeout(() => {
          if (this.active === run && run.state === "running") {
            this.finish(run, "failed", "turn_timeout");
            this.failChild("turn_timeout", run.epoch);
          }
        }, CODEX_TURN_TIMEOUT_MS);
        run.timer.unref();
      } catch (error) {
        if (run.state === "running") this.finish(run, "failed", "turn_start_failed");
        this.failChild("turn_start_failed", run.epoch);
        throw error;
      }
      return this.publicResult(run);
    } catch (error) {
      if (admitted && run.state === "running") this.finish(run, "failed", "turn_start_failed");
      throw error;
    } finally {
      this.starting = false;
    }
  }

  hasBlockingRun(): boolean {
    if (this.starting) return true;
    return [...this.runs.values()].some((run) => run.state === "running");
  }

  async wait(taskId: string, runId: string): Promise<CodexRunResult> {
    const run = this.runs.get(runId);
    if (!run || run.task_id !== taskId) {
      throw new CodexAppServerError("RUN_NOT_FOUND", "No matching local Codex run was found.");
    }
    if (run.state === "running" && !run.approval && !run.elicitation && !(run.input && run.turnId === run.input.turnId)) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (): void => {
          if (timer) clearTimeout(timer);
          run.waiters.delete(done);
          resolve();
        };
        timer = setTimeout(done, this.limits.waitTimeoutMs);
        timer.unref();
        run.waiters.add(done);
      });
    }
    return this.publicResult(run);
  }

  /** Read retained state only: never spawn, reply, recover, or consume an approval. */
  observeRun(taskId: string, runId: string): {
    state: CodexRunState | "waiting" | "unknown"; progress?: CodexProgressObservation;
  } {
    const run = this.runs.get(runId);
    if (!run || run.task_id !== taskId || this.closed || run.epoch !== this.activeEpoch) return { state: "unknown" };
    return {
      state: run.state === "running" && (run.approval || run.input || run.elicitation) ? "waiting" : run.state,
      ...this.progressResult(run),
    };
  }

  /** Read retained state only: never spawn, reply, recover, or consume an approval. */
  approvalStatus(taskId: string, runId: string): CodexRunResult {
    const run = this.runs.get(runId);
    if (!run || run.task_id !== taskId) {
      throw new CodexAppServerError("RUN_NOT_FOUND", "No matching local Codex run was found.");
    }
    return this.publicResult(run);
  }

  async waitAndRecordTerminalResult(
    taskId: string,
    runId: string,
    writeRecord: (result: CodexRunResult) => void | Promise<void>
  ): Promise<CodexRunResult> {
    const result = await this.wait(taskId, runId);
    if (result.state === "running" || result.resumable) return result;
    const run = this.runs.get(runId);
    if (!run || run.task_id !== taskId) {
      throw new CodexAppServerError("RUN_NOT_FOUND", "No matching local Codex run was found.");
    }
    if (run.executionRecordWritten) return result;
    if (!run.executionRecordWrite) {
      run.executionRecordWrite = Promise.resolve()
        .then(() => writeRecord(result))
        .then(() => {
          run.executionRecordWritten = true;
        })
        .finally(() => {
          delete run.executionRecordWrite;
        });
    }
    await run.executionRecordWrite;
    return result;
  }

  /** Explicit execution operation: never invoked by status or task startup. */
  async executionPreflight(): Promise<EnvironmentObservation> {
    if (this.closed) throw new CodexAppServerError("CLOSED", "Codex App Server client is closed.");
    if (this.environmentProbe) throw new CodexAppServerError("PREFLIGHT_BUSY", "An execution-environment probe is already in progress.");
    if (this.environmentObservation?.cleanup === "unconfirmed") {
      throw new CodexAppServerError("PREFLIGHT_CLEANUP_REQUIRED", "Prior probe cleanup is unconfirmed; owner process inspection is required. Do not retry automatically.");
    }
    this.environmentProbeController = new AbortController();
    this.environmentProbe = observeExecutionEnvironment(this.binary, this.opts.workspaceRoot,
      codexEnvironment(this.opts.workspaceRoot), this.environmentProbeController.signal);
    try {
      this.environmentObservation = await this.environmentProbe;
      return structuredClone(this.environmentObservation);
    } finally { this.environmentProbe = null; this.environmentProbeController = null; }
  }

  runtimeStatus() {
    const firstTurnOverhead = this.limits.economyMode ? Buffer.byteLength(FIRST_TURN_CONTRACT_PREFIX, "utf8") : 0;
    return {
      runtime_contract: structuredClone(RUNTIME_CONTRACT),
      execution_environment_observation: this.environmentObservation ? {
        ...structuredClone(this.environmentObservation),
        age_ms: Math.max(0, Date.now() - Date.parse(this.environmentObservation.observed_at)),
        cache_scope: "this_client_memory_only; identity_not_rechecked_by_status",
      } : null,
      instruction_max_utf8_bytes: this.limits.maxInstructionBytes,
      first_turn_internal_contract_utf8_bytes: firstTurnOverhead,
      usable_first_turn_utf8_bytes: this.limits.maxInstructionBytes - firstTurnOverhead,
      summary_max_utf8_bytes: this.limits.maxSummaryBytes,
      max_iterations: null,
      turn_timeout_ms: CODEX_TURN_TIMEOUT_MS,
      owner_dialog_timeout_ms: OWNER_DIALOG_TIMEOUT_MS,
      wait_ceiling_ms: MAX_WAIT_TIMEOUT_MS,
      maxIterations: null,
      hardMaxIterations: null,
      iterationConfiguration: {
        key: "C2C_CODEX_MAX_ITERATIONS", source: "removed",
        requested: null, effective: null, default: null, hard: null,
        readAt: "not_applicable", requiresRestartOrClientRecreation: false,
        restoresTaskContext: false,
      },
      wait: { defaultMs: DEFAULT_WAIT_TIMEOUT_MS, effectiveMs: this.limits.waitTimeoutMs, hardCeilingMs: MAX_WAIT_TIMEOUT_MS,
        key: "C2C_CODEX_WAIT_TIMEOUT_MS", source: this.limits.waitSource },
      activeRuns: [...this.runs.values()].filter((run) => run.state === "running").length,
      waitingRuns: [...this.runs.values()].filter((run) => run.state === "running" && (run.elicitation || (run.input && run.turnId === run.input.turnId) || (run.approval && run.turnId === run.approval.turnId))).length,
    };
  }

  async reply(taskId: string, runId: string, inputRequestId: string, message?: unknown, answers?: unknown): Promise<CodexRunResult> {
    const run = this.runs.get(runId);
    const input = run?.input;
    if (run && input?.expiresAt !== undefined && Date.now() >= input.expiresAt && run === this.active) {
      this.failChild("input_timeout", run.epoch);
    }
    if (!run || run.task_id !== taskId || run !== this.active || run.state !== "running" ||
        this.closed || this.persistenceFailed || run.epoch !== this.activeEpoch || !input ||
        !run.turnId || run.turnId !== input.turnId || input.nonce !== inputRequestId) {
      throw new CodexAppServerError("INPUT_REQUEST_NOT_FOUND", "No matching live pending input request exists.");
    }
    const invalid = () => new CodexAppServerError("INVALID_INPUT_REPLY", "Provide one bounded non-secret message for a single question, or answers mapping every question ID to a nonempty string array.");
    if ((message !== undefined) === (answers !== undefined)) throw invalid();
    if (message !== undefined && input.questions.length !== 1) throw invalid();
    const mapping = message !== undefined ? { [input.questions[0].id]: [message] } : answers;
    if (!isObject(mapping) || Object.keys(mapping).length !== input.questions.length ||
        Object.keys(mapping).some((id) => !input.questions.some((q) => q.id === id))) throw invalid();
    const response: Record<string, { answers: string[] }> = Object.create(null);
    let bytes = 0;
    for (const question of input.questions) {
      const values = Object.hasOwn(mapping, question.id) ? mapping[question.id] : undefined;
      if (!Array.isArray(values) || values.length < 1 || values.length > 8) throw invalid();
      const clean: string[] = [];
      for (const value of values) {
        if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 2048) throw invalid();
        const display = stripControls(value);
        if (!display.trim() || redactAndTruncate(value, 4096).redactionCount || redactAndTruncate(display, 4096).redactionCount ||
            /(?:password|passwd|secret|token|api[_ -]?key|cookie)\s*[:=]|-----BEGIN .*PRIVATE KEY/i.test(display)) throw invalid();
        bytes += Buffer.byteLength(display, "utf8");
        if (bytes > 8192 || clean.includes(display)) throw invalid();
        clean.push(display);
      }
      response[question.id] = { answers: clean };
    }
    // Consume before writing, including on failure: a reply can never send twice.
    this.clearInput(run);
    const child = this.child;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const current = this.child === child && this.activeEpoch === run.epoch && this.active === run && run.state === "running";
        if (reason || !current) {
          if (current) this.failChild(reason ?? "protocol_write_failed", run.epoch);
          reject(new CodexAppServerError("INPUT_REPLY_FAILED", "The input reply could not be delivered; the run is no longer resumable."));
        } else resolve();
      };
      const timeout = Math.min(REQUEST_TIMEOUT_MS, input.expiresAt === undefined ? REQUEST_TIMEOUT_MS : Math.max(0, input.expiresAt - Date.now()));
      const timer = setTimeout(() => finish("input_reply_timeout"), timeout);
      timer.unref();
      if (!child || !child.stdin.writable) return finish("protocol_write_failed");
      try {
        child.stdin.write(JSON.stringify({ id: input.rpcId, result: { answers: response } }) + "\n", (error) => {
          finish(error ? "protocol_write_failed" : undefined);
        });
      } catch { finish("protocol_write_failed"); }
    });
    return this.publicResult(run);
  }

  private onInputRequest(value: JsonObject, epoch: number): void {
    const run = this.active;
    const id = value.id;
    const validId = (typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= 128) ||
      (typeof id === "number" && Number.isSafeInteger(id) && id >= 0);
    const parsed = Buffer.byteLength(JSON.stringify(value.params ?? null), "utf8") <= 24 * 1024
      ? inputParamsSchema.safeParse(value.params) : undefined;
    if (!run || run.state !== "running" || run.epoch !== epoch || !validId || !parsed?.success ||
        parsed.data.threadId !== run.threadId || (run.turnId && parsed.data.turnId !== run.turnId) ||
        run.input || run.approval || run.elicitation || run.inputIds.has(id as string | number) || run.inputIds.size >= 16 ||
        new Set(parsed.data.questions.map((q) => q.id)).size !== parsed.data.questions.length ||
        parsed.data.questions.some((q) => q.isSecret || inputDisplay(q.id) !== q.id ||
          !inputDisplay(q.header).trim() || !inputDisplay(q.question).trim() ||
          (q.options && (q.options.some((o) => !inputDisplay(o.label).trim() || !inputDisplay(o.description).trim()) ||
            new Set(q.options.map((o) => inputDisplay(o.label))).size !== q.options.length)))) {
      return this.failChild("invalid_input_request", epoch);
    }
    run.inputIds.add(id as string | number);
    run.input = {
      rpcId: id as string | number, turnId: parsed.data.turnId, nonce: randomBytes(16).toString("hex"),
      questions: parsed.data.questions.map((q) => ({ ...q, header: inputDisplay(q.header), question: inputDisplay(q.question),
        ...(q.options ? { options: q.options.map((o) => ({ label: inputDisplay(o.label), description: inputDisplay(o.description) })) } : {}),
      })),
    };
    if (parsed.data.autoResolutionMs != null) {
      const input = run.input;
      input.expiresAt = Date.now() + parsed.data.autoResolutionMs;
      input.timer = setTimeout(() => {
        if (this.active === run && run.input === input && run.epoch === this.activeEpoch) {
          this.failChild("input_timeout", run.epoch);
        }
      }, parsed.data.autoResolutionMs);
      input.timer.unref();
    }
    // turn/start can still be in flight. Never publish its question until the turn ID is validated.
    if (run.turnId) { this.notifyRun(run); for (const waiter of run.waiters) waiter(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.environmentProbeController?.abort();
    if (this.environmentProbe) await this.environmentProbe;
    if (this.active?.state === "running") this.finish(this.active, "failed", "bridge_stopped");
    await this.recycleChild(false);
  }

  private clearInput(run: Run): void {
    if (run.input?.timer) clearTimeout(run.input.timer);
    delete run.input;
  }

  private recordElicitation(run: Run, phase: ElicitationEvent["phase"], action?: ElicitationEvent["action"], reason?: string): boolean {
    try {
      if (!this.opts.onElicitation || !run.elicitation_evidence) throw new Error("Evidence unavailable");
      this.opts.onElicitation(this.publicResult(run), { evidence: run.elicitation_evidence, phase, ...(action ? { action } : {}), ...(reason ? { reason } : {}) });
      return true;
    } catch {
      this.persistenceFailed = true;
      this.failChild("elicitation_recording_failed", run.epoch);
      return false;
    }
  }

  private onElicitationRequest(value: JsonObject, epoch: number): void {
    const run = this.active;
    if (!run || run.state !== "running" || run.epoch !== epoch) return this.failChild("orphan_elicitation_request", epoch);
    run.elicitation_evidence = captureElicitation(value);
    // Capture precedes every terminal/unsupported decision. No raw body/token.
    if (!this.recordElicitation(run, "captured")) return;
    const parsed = run.elicitation_evidence.classification === "supported_form" ? formParams.safeParse(value.params) : undefined;
    const id = value.id;
    const validId = typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 128 || typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
    if (!parsed?.success || !validId || parsed.data.threadId !== run.threadId ||
        (run.turnId && parsed.data.turnId !== run.turnId) || run.input || run.approval || run.elicitation ||
        run.inputIds.has(id as string | number) || (run.elicitationCount ?? 0) >= 8) {
      return this.failChild(parsed?.success ? "invalid_elicitation_correlation" : "mcp_elicitation_unsupported", epoch);
    }
    const p = parsed.data, expires = Date.now() + 5 * 60_000;
    run.inputIds.add(id as string | number);
    run.elicitationCount = (run.elicitationCount ?? 0) + 1;
    const timer = setTimeout(() => this.failChild("elicitation_expired", epoch), expires - Date.now()); timer.unref();
    run.elicitation = { rpcId: id as string | number, turnId: p.turnId, nonce: randomBytes(16).toString("hex"), message: p.message, schema: p.requestedSchema, expires, timer };
    if (!this.recordElicitation(run, "pending")) return;
    if (run.turnId) this.notifyRun(run);
    for (const waiter of run.waiters) waiter();
  }

  async elicitationReply(taskId: string, runId: string, responseId: string, action: unknown, content?: unknown): Promise<CodexRunResult> {
    const run = this.runs.get(runId), pending = run?.elicitation;
    if (run && pending && Date.now() >= pending.expires) this.failChild("elicitation_expired", run.epoch);
    if (!run || run.task_id !== taskId || run !== this.active || run.state !== "running" || this.closed || this.persistenceFailed ||
        run.epoch !== this.activeEpoch || !pending || pending.nonce !== responseId || pending.turnId !== run.turnId || Date.now() >= pending.expires) {
      throw new CodexAppServerError("ELICITATION_REQUEST_NOT_FOUND", "No matching live MCP elicitation exists.");
    }
    if (typeof action !== "string" || !["accept", "decline", "cancel"].includes(action) ||
        (action === "accept" ? !validElicitationContent(pending.schema, content) : content !== undefined)) {
      throw new CodexAppServerError("INVALID_ELICITATION_REPLY", "Explicit accept with exact valid content, or decline/cancel without content, is required.");
    }
    const decision = action as "accept" | "decline" | "cancel";
    // Burn before recording/writing. Never retransmit on ambiguous failure.
    clearTimeout(pending.timer); delete run.elicitation;
    run.elicitation_response = { action: decision, transport_write_acknowledged: false, delivery_proven: false,
      server_acceptance_proven: false, run_resumption_proven: false, goal_verified: false };
    if (!this.recordElicitation(run, "response_attempted", decision)) throw new CodexAppServerError("ELICITATION_RECORDING_FAILED", "Reply was not sent.");
    const child = this.child;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (failed = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (failed || this.child !== child || this.activeEpoch !== run.epoch || run.state !== "running") {
          this.failChild("elicitation_reply_failed", run.epoch);
          reject(new CodexAppServerError("ELICITATION_REPLY_FAILED", "Transport delivery is unproven; do not retry."));
        } else resolve();
      };
      const timer = setTimeout(() => finish(true), Math.min(REQUEST_TIMEOUT_MS, pending.expires - Date.now())); timer.unref();
      if (!child?.stdin.writable) return finish(true);
      try { child.stdin.write(JSON.stringify({ id: pending.rpcId, result: { action: decision, ...(decision === "accept" ? { content } : {}) } }) + "\n", e => finish(Boolean(e))); }
      catch { finish(true); }
    });
    run.elicitation_response.transport_write_acknowledged = true;
    if (!this.recordElicitation(run, "write_acknowledged", decision)) throw new CodexAppServerError("ELICITATION_RECORDING_FAILED", "Write acknowledgment occurred; outcome is unverified. Do not retry.");
    return this.publicResult(run);
  }

  private clearApproval(run: Run): void {
    const pending = run.approval;
    delete run.approval;
    const delivery = run.approval_diagnostic?.native_delivery;
    if (pending && delivery && ["prepare", "compile", "sign", "launch", "pending_owner"].includes(delivery.phase)) delivery.phase = "cancelled";
    if (pending) { clearTimeout(pending.timer); pending.controller.abort(); }
  }

  private onLocalApproval(value: JsonObject, epoch: number): boolean {
    const run = this.active;
    if (value.method !== "item/commandExecution/requestApproval") return false;
    const rpcId = value.id;
    const validId = (typeof rpcId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(rpcId)) ||
      (typeof rpcId === "number" && Number.isSafeInteger(rpcId) && rpcId >= 0);
    if (!run || !validId || run.epoch !== epoch || run.state !== "running" || !isObject(value.params)) return false;
    if (run.approval || run.input || run.elicitation || run.inputIds.has(rpcId as string | number)) {
      this.failChild("approval_request_changed", epoch); return true;
    }
    const params = value.params;
    if (params.threadId !== run.threadId || typeof params.turnId !== "string" || (run.turnId && params.turnId !== run.turnId)) return false;
    if (Buffer.byteLength(JSON.stringify(params)) > 16384 || run.inputIds.size >= 16) return false;
    const networkRequested = params.networkApprovalContext != null ||
      (isObject(params.additionalPermissions) && isObject(params.additionalPermissions.network) && params.additionalPermissions.network.enabled === true) ||
      params.proposedNetworkPolicyAmendments != null;
    const scope = networkRequested ? validateManagedNetworkApproval(params, this.opts.workspaceRoot) :
      validateLocalApproval(params, this.opts.workspaceRoot, stage => { run.approval_diagnostic = approvalDiagnostic(params, stage, localApprovalSchemaDiagnostic(params)); });
    if (networkRequested) {
      run.approval_diagnostic = approvalDiagnostic(params, "network", localApprovalSchemaDiagnostic(params));
      run.approval_scope_reason = params.networkApprovalContext == null ? "MANAGED_NETWORK_SCOPE_REQUIRED" :
        !scope ? "MANAGED_NETWORK_SCOPE_INVALID" : !this.allowedNetworkHosts.has(scope.type === "managed_network" ? scope.host : "") ?
          "MANAGED_NETWORK_NOT_PRELISTED" : undefined;
      if (scope && run.networkApprovals >= MAX_NETWORK_APPROVALS_PER_TURN) {
        run.approval_scope_reason = "MANAGED_NETWORK_APPROVAL_LIMIT"; return false;
      }
    }
    if (!scope) {
      if (!networkRequested) run.approval_scope_reason = localApprovalScopeReason(params);
      if (run.approval_scope_reason === "INLINE_PERMISSION_SCOPE_REQUIRED") {
        run.approvalScopeDiagnostic = localApprovalSchemaDiagnostic(params);
      }
      return false;
    }
    run.inputIds.add(rpcId as string | number);
    const timer = setTimeout(() => {
      if (run.approval?.timer !== timer || this.active !== run) return;
      const delivery = run.approval_diagnostic?.native_delivery;
      const code = { prepare: "NATIVE_HELPER_PREPARE_TIMEOUT", compile: "NATIVE_HELPER_COMPILE_TIMEOUT", sign: "NATIVE_HELPER_SIGN_TIMEOUT", launch: "NATIVE_HELPER_LAUNCH_TIMEOUT" } as const;
      if (delivery) {
        delivery.failure_code = code[delivery.phase as keyof typeof code] ?? "NATIVE_HELPER_LAUNCH_TIMEOUT";
        delivery.phase = "failed";
      }
      this.failChild("local_approval_unavailable", epoch);
    }, NATIVE_HELPER_STARTUP_TIMEOUT_MS);
    timer.unref();
    run.approval = { rpcId: rpcId as string | number, turnId: params.turnId, params: structuredClone(params), scope,
      controller: new AbortController(), timer, expires: Date.now() + OWNER_DIALOG_HELPER_TIMEOUT_MS, started: false };
    if (run.turnId) this.openLocalApproval(run);
    if (run.approval) for (const waiter of run.waiters) waiter();
    return true;
  }

  private openLocalApproval(run: Run): void {
    const pending = run.approval;
    if (!pending || pending.started || run.turnId !== pending.turnId) return;
    if (pending.scope.type === "managed_network" && this.allowedNetworkHosts.has(pending.scope.host)) {
      this.completeLocalApproval(run, pending, "approved");
      return;
    }
    pending.started = true;
    // Preserve the existing late-turn window; readiness never refreshes it.
    run.timer?.refresh();
    run.approval_diagnostic = approvalDiagnostic(pending.params, "decision");
    run.approval_diagnostic.reason = "native_delivery";
    const delivery: NonNullable<ApprovalDiagnostic["native_delivery"]> = {
      phase: "prepare", readiness: "unobserved", user_receipt: "unknown",
    };
    run.approval_diagnostic.native_delivery = delivery;
    const current = () => this.active === run && run.state === "running" && run.epoch === this.activeEpoch &&
      run.approval === pending && run.turnId === pending.turnId && !pending.controller.signal.aborted;
    const startupExpires = pending.expires - OWNER_DIALOG_HELPER_TIMEOUT_MS + NATIVE_HELPER_STARTUP_TIMEOUT_MS;
    const onPhase = (phase: NativeHelperPhase) => {
      if (!current() || delivery.readiness === "helper_reported" ||
          Date.now() >= startupExpires ||
          !["prepare", "compile", "sign", "launch", "pending_owner"].includes(phase)) return;
      delivery.phase = phase;
      if (phase === "pending_owner") {
        delivery.readiness = "helper_reported";
        pending.expires = Math.min(pending.expires, Date.now() + OWNER_DIALOG_TIMEOUT_MS);
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          if (!current()) return;
          delivery.phase = "expired";
          this.failChild("local_approval_expired", run.epoch);
        }, Math.max(0, pending.expires - Date.now()));
        pending.timer.unref();
        this.notifyRun(run);
      }
      for (const waiter of run.waiters) waiter();
    };
    void nativeLocalApproval(pending.scope, run.task_id, run.run_id, pending.controller.signal, onPhase).then(decision => {
      this.completeLocalApproval(run, pending, decision);
    }).catch(error => {
      if (!current()) return;
      delivery.phase = "failed";
      delivery.failure_code = safeNativeFailureCode(error);
      this.failChild("local_approval_unavailable", run.epoch);
    });
  }

  private completeLocalApproval(run: Run, pending: NonNullable<Run["approval"]>, decision: string): void {
    const current = () => !this.closed && !this.persistenceFailed && this.active === run && run.state === "running" &&
      run.epoch === this.activeEpoch && run.approval === pending && run.turnId === pending.turnId && !pending.controller.signal.aborted;
    if (!current()) return;
    const delivery = run.approval_diagnostic?.native_delivery;
    if (decision === "approved" && pending.started && delivery?.readiness !== "helper_reported") {
      if (delivery) { delivery.phase = "failed"; delivery.failure_code = "NATIVE_HELPER_NOT_READY"; }
      this.failChild("local_approval_unavailable", run.epoch);
      return;
    }
    if (decision !== "approved") {
      if (delivery) delivery.phase = decision === "timed_out" ? "expired" : decision === "cancelled" ? "cancelled" : decision === "unavailable" ? "unavailable" : "denied";
      this.failChild(decision === "unavailable" ? "local_approval_unavailable" : decision === "timed_out" ? "local_approval_expired" : decision === "cancelled" ? "local_approval_cancelled" : "local_approval_denied", run.epoch);
      return;
    }
    const fresh = pending.scope.type === "managed_network" ? validateManagedNetworkApproval(pending.params, this.opts.workspaceRoot) : validateLocalApproval(pending.params, this.opts.workspaceRoot);
    if (!current() || Date.now() >= pending.expires || !fresh || fresh.fingerprint !== pending.scope.fingerprint) {
      if (current()) this.failChild("local_approval_changed", run.epoch);
      return;
    }
    // Burn before write. Even backpressure/failure cannot authorize a second response.
    if (pending.scope.type === "managed_network") {
      if (run.networkApprovals >= MAX_NETWORK_APPROVALS_PER_TURN) { this.failChild("network_approval_limit", run.epoch); return; }
      run.networkApprovals++;
    }
    if (delivery) delivery.phase = "approved";
    this.clearApproval(run);
    const child = this.child;
    const live = () => this.active === run && this.child === child && this.activeEpoch === run.epoch;
    const timer = setTimeout(() => { if (live()) this.failChild("approval_reply_timeout", run.epoch); }, REQUEST_TIMEOUT_MS);
    timer.unref();
    try {
      if (!child?.stdin.writable) throw new Error("closed");
      child.stdin.write(JSON.stringify({ id: pending.rpcId, result: { decision: "accept" } }) + "\n", error => {
        clearTimeout(timer);
        if (error && live()) this.failChild("protocol_write_failed", run.epoch);
      });
    } catch { clearTimeout(timer); if (live()) this.failChild("protocol_write_failed", run.epoch); }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.initialized && this.child) return;
    if (this.child) await this.recycleChild();
    if (this.closed) throw new Error("Codex App Server client is closed.");
    const epoch = ++this.epochCounter;
    const child = spawn(this.binary, ["app-server"], {
      cwd: this.opts.workspaceRoot,
      env: codexEnvironment(this.opts.workspaceRoot),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.activeEpoch = epoch;
    this.stdoutBuffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child && this.activeEpoch === epoch) this.onStdout(chunk, epoch);
    });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => {
      if (this.child === child && this.activeEpoch === epoch) {
        this.failChild("protocol_write_failed", epoch);
      }
    });
    child.once("error", () => {
      if (this.child === child && this.activeEpoch === epoch) this.failChild("child_error", epoch);
    });
    child.once("exit", () => {
      if (this.child === child && this.activeEpoch === epoch) this.failChild("child_exit", epoch);
    });

    try {
      const response = await this.request("initialize", {
        clientInfo: {
          name: "codex-with-chatgpt",
          title: "Codex with ChatGPT",
          version: "1",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      if (!isObject(response)) throw new Error("Invalid initialize response.");
      this.notify("initialized", epoch);
      this.initialized = true;
    } catch (error) {
      this.failChild("initialize_failed", epoch);
      throw error;
    }
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const child = this.child;
    const epoch = this.activeEpoch;
    if (!child || !child.stdin.writable || !epoch) {
      return Promise.reject(new Error("Codex App Server is unavailable."));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(String(id));
        if (!pending || pending.epoch !== epoch) return;
        this.pending.delete(String(id));
        reject(new Error("Codex App Server request timed out."));
        this.failChild("request_timeout", epoch);
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(String(id), { resolve, reject, timer, epoch });
      this.write({ id, method, params }, epoch);
    });
  }

  private notify(method: string, epoch: number): void {
    this.write({ method }, epoch);
  }

  private write(message: JsonObject, epoch: number): void {
    const child = this.child;
    if (!child || this.activeEpoch !== epoch || !child.stdin.writable) {
      this.failChild("protocol_write_failed", epoch);
      return;
    }
    try {
      child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error && this.child === child && this.activeEpoch === epoch) {
          this.failChild("protocol_write_failed", epoch);
        }
      });
    } catch {
      this.failChild("protocol_write_failed", epoch);
    }
  }

  private onStdout(chunk: Buffer, epoch: number): void {
    if (this.activeEpoch !== epoch) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length > MAX_LINE_BYTES) {
        return this.failChild("oversized_protocol_line", epoch);
      }
      if (!line.length) continue;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        this.onMessage(JSON.parse(text) as unknown, epoch);
      } catch {
        return this.failChild("malformed_protocol", epoch);
      }
    }
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.failChild("oversized_protocol_line", epoch);
    }
  }

  private onMessage(value: unknown, epoch: number): void {
    if (this.activeEpoch !== epoch) return;
    if (!isObject(value)) return this.failChild("malformed_protocol", epoch);
    if (typeof value.method === "string") {
      if (value.method.startsWith("mcpServer/elicitation/")) return this.onElicitationRequest(value, epoch);
      if (value.method === "item/tool/requestUserInput") return this.onInputRequest(value, epoch);
      if (value.id !== undefined) {
        // Approval replies can escape the sandbox. Readers never enter any
        // local command, file-change, permissions, or network approval path.
        if (APPROVAL_METHODS.has(value.method) && this.active?.execution_mode === "read_only") {
          this.finish(this.active, "blocked", "read_only_approval_denied");
          this.failChild("read_only_approval_denied", epoch);
          return;
        }
        if (this.onLocalApproval(value, epoch)) return;
        const reason = APPROVAL_METHODS.has(value.method)
          ? "approval_required"
          : "unknown_server_request";
        this.opts.logger.info("Blocked Codex server request", {
          reason, scopeReason: this.active?.approval_scope_reason,
        });
        if (this.active?.state === "running" && this.active.epoch === epoch) {
          this.finish(this.active, "blocked", reason);
        }
        this.failChild(reason, epoch);
        return;
      }
      if (value.method === "serverRequest/resolved") {
        const run = this.active;
        const params = value.params;
        if (run?.elicitation && isObject(params) && params.threadId === run.threadId && params.requestId === run.elicitation.rpcId) {
          return this.failChild("elicitation_resolved_without_reply", epoch);
        }
        if (run?.approval && run.epoch === epoch && isObject(params) && params.threadId === run.threadId &&
            params.requestId === run.approval.rpcId && (params.turnId === undefined || params.turnId === run.approval.turnId)) this.clearApproval(run);
        if (run?.input && run.epoch === epoch && isObject(params) && params.threadId === run.threadId &&
            params.requestId === run.input.rpcId && (params.turnId === undefined || params.turnId === run.input.turnId)) {
          this.clearInput(run);
        }
      } else if (value.method === "item/started") {
        this.observeItem(value.params, epoch, false);
        this.observeCommandEvidence(value.params, epoch, false);
      } else if (value.method === "item/completed") {
        // Observe before existing approval cleanup: WAITING cannot advance progress.
        this.observeItem(value.params, epoch, true);
        this.observeCommandEvidence(value.params, epoch, true);
        const run = this.active;
        const params = value.params;
        if (run?.approval && isObject(params) && params.threadId === run.threadId && params.turnId === run.turnId &&
            isObject(params.item) && params.item.id === run.approval.params.itemId) this.clearApproval(run);
        if (!this.onItemCompleted(value.params, epoch)) {
          this.failChild("malformed_protocol", epoch);
        }
      } else if (value.method === "turn/completed") {
        if (!this.onTurnCompleted(value.params, epoch)) {
          this.failChild("malformed_protocol", epoch);
        }
      }
      return;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return this.failChild("malformed_protocol", epoch);
    const pending = this.pending.get(String(value.id));
    if (!pending || pending.epoch !== epoch) {
      return this.failChild("unknown_response", epoch);
    }
    this.pending.delete(String(value.id));
    clearTimeout(pending.timer);
    const hasError = "error" in value;
    const hasResult = "result" in value;
    if (hasError === hasResult) {
      pending.reject(new Error("Malformed Codex App Server response."));
      this.failChild("malformed_protocol", epoch);
      return;
    }
    if (hasError) pending.reject(new Error("Codex App Server request failed."));
    else pending.resolve(value.result);
  }

  private observeCommandEvidence(value: unknown, epoch: number, completed: boolean): void {
    const run = this.active;
    if (!this.opts.onCommandObservation || !run || run.state !== "running" || run.epoch !== epoch || !run.turnId ||
        !isObject(value) || value.threadId !== run.threadId || value.turnId !== run.turnId ||
        !isObject(value.item) || value.item.type !== "commandExecution") return;
    const item = value.item;
    if (typeof item.id !== "string" || !item.id || Buffer.byteLength(item.id) > 256 || /[\p{Cc}\p{Cf}]/u.test(item.id) ||
        typeof item.command !== "string" || Buffer.byteLength(item.command) > 32 * 1024 || typeof item.cwd !== "string" ||
        typeof item.status !== "string" || (!completed && item.status !== "inProgress")) return;
    try {
      const cwd = fs.realpathSync.native(item.cwd);
      const root = this.opts.workspaceRoot;
      if (cwd !== root && !cwd.startsWith(root + path.sep)) return;
      this.opts.onCommandObservation(this.publicResult(run), { itemId: item.id, completed, command: item.command, cwd,
        status: item.status, exitCode: typeof item.exitCode === "number" && Number.isInteger(item.exitCode) ? item.exitCode : null,
        output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null, observedAt: new Date().toISOString() });
    } catch { this.opts.logger.warn("Command evidence unavailable; no test pass can be inferred from completion."); }
  }

  private observeItem(value: unknown, epoch: number, completed: boolean): void {
    const run = this.active;
    if (!run || run.state !== "running" || run.epoch !== epoch || !run.turnId || run.progressDisabled ||
        !isObject(value) || value.threadId !== run.threadId || value.turnId !== run.turnId ||
        !isObject(value.item) || value.item.type !== "commandExecution") return;
    const item = value.item;
    // IDs are private correlation keys, not labels or cursor material. No coercion.
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 256 ||
        Buffer.byteLength(item.id, "utf8") > 256 || /[\p{Cc}\p{Cf}]/u.test(item.id)) return;
    const prior = run.progressItems.get(item.id);
    if (prior === "closed") return;
    if (!prior && run.progressItems.size >= MAX_PROGRESS_ITEMS) {
      run.progressItems.clear();
      run.progressDisabled = true;
      delete run.progress;
      return;
    }
    const waiting = Boolean(run.approval || run.input || run.elicitation);
    if (!completed) {
      if (!prior) run.progressItems.set(item.id, !waiting && item.status === "inProgress" ? "started" : "closed");
      return;
    }
    // Tombstone unpaired, malformed, failed, and waiting completions; never replay them.
    run.progressItems.set(item.id, "closed");
    if (prior !== "started" || waiting || item.status !== "completed" || item.exitCode !== 0) return;
    run.progressCount++;
    run.progress = {
      cursor: (run.progress?.cursor.slice(0, 32) ?? randomBytes(16).toString("hex")) + run.progressCount.toString(16).padStart(4, "0"),
      phase: "command_completed",
    };
  }

  private progressResult(run: Run): { progress?: CodexProgressObservation } {
    return run.progress && !this.closed && !this.persistenceFailed && run.epoch === this.activeEpoch
      ? { progress: { ...run.progress } } : {};
  }

  private onItemCompleted(value: unknown, epoch: number): boolean {
    if (
      !isObject(value) ||
      typeof value.threadId !== "string" ||
      typeof value.turnId !== "string" ||
      !isObject(value.item) ||
      typeof value.item.type !== "string"
    ) return false;
    const run = this.active;
    if (!run || run.epoch !== epoch || value.threadId !== run.threadId) return true;
    if (run.turnId && value.turnId !== run.turnId) return true;
    if (value.item.type === "agentMessage") {
      if (typeof value.item.text !== "string") return false;
      run.lastAgentMessage = value.item.text;
    }
    return true;
  }

  private onTurnCompleted(value: unknown, epoch: number): boolean {
    const run = this.active;
    if (
      !isObject(value) ||
      typeof value.threadId !== "string" ||
      !isObject(value.turn) ||
      typeof value.turn.id !== "string" ||
      typeof value.turn.status !== "string" ||
      !["completed", "interrupted", "failed"].includes(value.turn.status) ||
      !Array.isArray(value.turn.items)
    ) return false;
    if (!run || run.epoch !== epoch || value.threadId !== run.threadId) return true;
    if (run.turnId && value.turn.id !== run.turnId) return true;
    if (run.elicitation) { this.failChild("elicitation_completed_without_reply", epoch); return true; }
    for (const item of value.turn.items) {
      if (isObject(item) && item.type === "agentMessage") {
        if (typeof item.text !== "string") return false;
        run.lastAgentMessage = item.text;
      }
    }
    this.finish(
      run,
      value.turn.status === "completed" ? "completed" : "failed",
      value.turn.status === "completed" ? undefined : "codex_turn_failed"
    );
    return true;
  }

  private readonly notified = new WeakMap<Run, Set<string>>();

  private notifyRun(run: Run): void {
    if (run.state === "running" && run.approval && run.approval_diagnostic?.native_delivery?.readiness !== "helper_reported") return;
    const result = this.publicResult(run);
    if (result.state === "running") return;
    // Per-run bounded ordinals, never a reply nonce or raw request ID.
    const id = run.state !== "running" ? "terminal" : run.elicitation ? `elicitation:${run.elicitationCount}`
      : run.input ? `input:${run.inputIds.size}` : run.approval ? `approval:${run.inputIds.size}` : undefined;
    if (!id) return;
    const seen = this.notified.get(run) ?? new Set<string>();
    if (seen.has(id)) return;
    seen.add(id);
    this.notified.set(run, seen);
    try { this.opts.onRunNotification?.(result, id); }
    catch {
      // Best-effort notice failure cannot change execution. Required journal and
      // elicitation hooks retain their separate fail-closed behavior.
      this.opts.logger.warn("Run notification unavailable; inspect task_status.");
    }
  }

  private finish(
    run: Run,
    state: Exclude<CodexRunState, "running">,
    reason?: string
  ): void {
    if (run.state !== "running") return;
    if (run.timer) clearTimeout(run.timer);
    if (run.elicitation) {
      clearTimeout(run.elicitation.timer); delete run.elicitation;
    }
    if (run.elicitation_evidence && !this.persistenceFailed && !this.recordElicitation(run, "channel_closed", undefined, reason ?? "run_completed")) return;
    this.clearInput(run);
    this.clearApproval(run);
    run.state = state;
    if (reason) run.reason = reason;
    if (state === "completed") {
      run.summary = redactAndTruncate(run.lastAgentMessage ?? "", this.limits.maxSummaryBytes).text;
    }
    try {
      this.opts.onRunTerminal?.(this.publicResult(run));
    } catch {
      this.persistenceFailed = true;
      run.state = "failed";
      run.reason = "task_journal_write_failed";
      delete run.summary;
      this.opts.logger.warn("Durable terminal recording failed; further execution is blocked.");
    }
    this.notifyRun(run);
    if (this.active === run) this.active = null;
    for (const waiter of run.waiters) waiter();
    run.waiters.clear();
  }

  private publicResult(run: Run): CodexRunResult {
    // ADR 0003: only the explicitly authorized observeRun path may disclose progress.
    // Generic start/wait/reply/approval and journal/notification results never carry it.
    return {
      ...(run.checkpoint_continuation ? { checkpoint_continuation: true as const, original_context_restored: false as const } : {}),
      task_id: run.task_id,
      execution_mode: run.execution_mode,
      iteration: run.iteration,
      state: run.state,
      ...(run.reason === "read_only_approval_denied" ? { resumable: false } : {}),
      ...(run.elicitation_evidence ? { elicitation_evidence: structuredClone(run.elicitation_evidence) } : {}),
      ...(run.elicitation_response ? { elicitation_response: { ...run.elicitation_response } } : {}),
      ...(run.state === "running" && run.elicitation && run.turnId === run.elicitation.turnId ? {
        state: "blocked" as const, reason: "mcp_elicitation_required", resumable: true,
        elicitation_request_id: run.elicitation.nonce,
        elicitation_prompt: { message: run.elicitation.message, requestedSchema: structuredClone(run.elicitation.schema), expires_at: new Date(run.elicitation.expires).toISOString(), untrusted_data: true as const },
      } : {}),
      ...(run.approval_diagnostic ? { approval_diagnostic: structuredClone(run.approval_diagnostic) } : {}),
      // Unsupported request shape, not a claim about the installed version.
      ...(run.state === "blocked" && run.reason === "approval_required" ? {
        resumable: false, approval_type: "unsupported" as const,
        approval_scope_error: "UNSUPPORTED_APPROVAL_SCOPE" as const,
        ...(run.approval_scope_reason ? { approval_scope_reason: run.approval_scope_reason } : {}),
        ...(run.approvalScopeDiagnostic ? { approval_scope_diagnostic: structuredClone(run.approvalScopeDiagnostic) } : {}),
      } : {}),
      ...(run.state === "running" && run.approval && run.turnId === run.approval.turnId ? {
        state: "blocked" as const, reason: "approval_required", resumable: true,
        approval_type: run.approval.scope.type, waiting_for_local_approval: true as const,
        ...(run.approval.scope.type === "managed_network" ? { approval_scope_reason: run.approval_scope_reason } : {}),
      } : {}),
      ...(run.state === "running" && run.input && run.turnId === run.input.turnId ? {
        state: "blocked" as const, reason: "user_input_required", resumable: true as const,
        input_request_id: run.input.nonce, questions: structuredClone(run.input.questions),
      } : {}),
      run_id: run.run_id,
      ...(run.summary !== undefined ? { summary: run.summary } : {}),
      ...(run.reason !== undefined ? { reason: run.reason } : {}),
    };
  }

  private retainRun(run: Run): void {
    while (this.runs.size >= MAX_RUNS) {
      const terminal = [...this.runs.entries()].find(
        ([, candidate]) => candidate.state !== "running"
      );
      if (!terminal) {
        throw new CodexAppServerError("RUN_CAPACITY", "Codex run retention is full.");
      }
      this.runs.delete(terminal[0]);
    }
    this.runs.set(run.run_id, run);
  }

  private expireTasks(): void {
    for (const [taskId, task] of this.tasks) {
      this.expiredTasks.delete(taskId);
      this.expiredTasks.set(taskId, task.executionMode);
      while (this.expiredTasks.size > MAX_EXPIRED_TASKS) {
        const oldest = this.expiredTasks.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.expiredTasks.delete(oldest);
      }
    }
    this.tasks.clear();
  }

  private rejectPending(epoch: number, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.epoch !== epoch) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex App Server unavailable: ${reason}.`));
      this.pending.delete(id);
    }
  }

  private failChild(reason: string, epoch: number): void {
    if (!epoch || this.activeEpoch !== epoch) return;
    if (this.active?.state === "running" && this.active.epoch === epoch) {
      this.finish(this.active, "failed", reason);
    }
    void this.recycleChild().catch(() => {
      this.opts.logger.warn("Codex App Server child shutdown failed");
    });
    this.opts.logger.warn("Codex App Server child stopped", { reason });
  }

  private async recycleChild(expire = true): Promise<void> {
    if (this.active?.state === "running") {
      throw new CodexAppServerError("TURN_ACTIVE", "An active Codex turn prevents child rollover.");
    }
    if (this.stopping) return this.stopping;
    const child = this.child;
    const epoch = this.activeEpoch;
    if (expire) this.expireTasks();
    this.rejectPending(epoch, "child_rollover");
    this.initialized = false;
    this.activeEpoch = 0;
    this.stdoutBuffer = Buffer.alloc(0);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }

    this.stopping = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        child.removeListener("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = (): void => finish();
      child.once("exit", onExit);
      try { child.kill(); } catch {
        finish(new Error("Codex App Server child shutdown failed."));
        return;
      }
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {
          finish(new Error("Codex App Server child shutdown failed."));
          return;
        }
        timer = setTimeout(() => finish(new CodexAppServerError(
          "CHILD_STOP_TIMEOUT", "Codex App Server child did not exit; execution remains blocked."
        )), CHILD_STOP_TIMEOUT_MS);
        timer.unref();
      }, CHILD_STOP_TIMEOUT_MS);
      timer.unref();
    }).finally(() => {
      if (child.exitCode !== null || child.signalCode !== null) this.child = null;
      this.stopping = null;
    });
    await this.stopping;
  }
}
