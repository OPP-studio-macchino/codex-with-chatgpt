import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactAndTruncate } from "../security/redaction.js";
import type { Logger } from "../logger/index.js";

const REQUEST_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 20 * 60_000;
const WAIT_TIMEOUT_MS = 20_000;
const CHILD_STOP_TIMEOUT_MS = 1_000;
const MAX_LINE_BYTES = 10 * 1024 * 1024;
const MAX_INSTRUCTION_BYTES = 16 * 1024;
const MAX_SUMMARY_BYTES = 32 * 1024;
const MAX_THREADS_PER_CHILD = 8;
const MAX_RUNS = 96;
const MAX_EXPIRED_TASKS = 96;

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);
const USER_INPUT_METHODS = new Set([
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

type JsonObject = Record<string, unknown>;
export type CodexRunState = "running" | "completed" | "blocked" | "failed";

export interface CodexRunResult {
  task_id: string;
  iteration: number;
  state: CodexRunState;
  run_id: string;
  summary?: string;
  reason?: string;
}

interface Run extends CodexRunResult {
  threadId: string;
  turnId?: string;
  epoch: number;
  timer?: NodeJS.Timeout;
  waiters: Set<() => void>;
  lastAgentMessage?: string;
}

interface Task {
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
  workspaceRoot: string;
  binary?: string;
  logger: Logger;
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
  private expiredTasks = new Map<string, true>();
  private runs = new Map<string, Run>();
  private active: Run | null = null;
  private starting = false;
  private closed = false;

  constructor(private readonly opts: CodexAppServerOptions) {
    this.binary = resolveCodexBinary(opts.workspaceRoot, opts.binary);
  }

  async startTurn(taskId: string, iteration: number, instruction: string): Promise<CodexRunResult> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(taskId)) {
      throw new CodexAppServerError("INVALID_TASK_ID", "task_id has an invalid format.");
    }
    if (!Number.isInteger(iteration) || iteration < 1 || iteration > 12) {
      throw new CodexAppServerError("INVALID_ITERATION", "iteration must be an integer from 1 to 12.");
    }
    if (!instruction || Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES) {
      throw new CodexAppServerError("INVALID_INSTRUCTION", "instruction must be 1 to 16384 UTF-8 bytes.");
    }

    const retained = [...this.runs.values()].find(
      (run) => run.task_id === taskId && run.iteration === iteration
    );
    if (retained) return this.publicResult(retained);
    if (this.closed) throw new CodexAppServerError("CLOSED", "Codex App Server client is closed.");
    if (this.active?.state === "running" || this.starting) {
      throw new CodexAppServerError("TURN_ACTIVE", "Only one Codex turn may be active at a time.");
    }

    const task = this.tasks.get(taskId);
    if (!task && this.expiredTasks.has(taskId)) {
      throw new CodexAppServerError("TASK_CONTEXT_EXPIRED", "The ephemeral Codex task context has expired.");
    }
    if (task && iteration !== task.lastIteration + 1) {
      throw new CodexAppServerError("INVALID_ITERATION", "iteration must advance exactly once for an existing task.");
    }
    if (!task && iteration !== 1) {
      throw new CodexAppServerError("INVALID_ITERATION", "A new task must start at iteration 1.");
    }

    this.starting = true;
    try {
      if (!task && this.tasks.size >= MAX_THREADS_PER_CHILD) await this.recycleChild();
      await this.ensureInitialized();

      let currentTask = this.tasks.get(taskId);
      if (!currentTask) {
        const response = await this.request("thread/start", {
          cwd: this.opts.workspaceRoot,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
          ephemeral: true,
        });
        if (!isObject(response) || !isObject(response.thread) || typeof response.thread.id !== "string") {
          throw new Error("Invalid thread/start response.");
        }
        currentTask = {
          threadId: response.thread.id,
          lastIteration: 0,
        };
        this.tasks.set(taskId, currentTask);
      }

      const run: Run = {
        task_id: taskId,
        iteration,
        state: "running",
        run_id: randomBytes(16).toString("hex"),
        threadId: currentTask.threadId,
        epoch: this.activeEpoch,
        waiters: new Set(),
      };
      this.retainRun(run);
      this.active = run;
      currentTask.lastIteration = iteration;

      try {
        const response = await this.request("turn/start", {
          threadId: currentTask.threadId,
          input: [{ type: "text", text: instruction, text_elements: [] }],
          cwd: this.opts.workspaceRoot,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        });
        if (!isObject(response) || !isObject(response.turn) || typeof response.turn.id !== "string") {
          throw new Error("Invalid turn/start response.");
        }
        run.turnId = response.turn.id;
        run.timer = setTimeout(() => {
          if (this.active === run && run.state === "running") {
            this.finish(run, "failed", "turn_timeout");
            this.failChild("turn_timeout", run.epoch);
          }
        }, TURN_TIMEOUT_MS);
        run.timer.unref();
      } catch (error) {
        if (run.state === "running") this.finish(run, "failed", "turn_start_failed");
        this.failChild("turn_start_failed", run.epoch);
        throw error;
      }
      return this.publicResult(run);
    } finally {
      this.starting = false;
    }
  }

  async wait(taskId: string, runId: string): Promise<CodexRunResult> {
    const run = this.runs.get(runId);
    if (!run || run.task_id !== taskId) {
      throw new CodexAppServerError("RUN_NOT_FOUND", "No matching local Codex run was found.");
    }
    if (run.state === "running") {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (): void => {
          if (timer) clearTimeout(timer);
          run.waiters.delete(done);
          resolve();
        };
        timer = setTimeout(done, WAIT_TIMEOUT_MS);
        timer.unref();
        run.waiters.add(done);
      });
    }
    return this.publicResult(run);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.active?.state === "running") this.finish(this.active, "failed", "bridge_stopped");
    await this.recycleChild(false);
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
      if (value.id !== undefined) {
        const reason = APPROVAL_METHODS.has(value.method)
          ? "approval_required"
          : USER_INPUT_METHODS.has(value.method)
            ? "user_input_required"
            : "unknown_server_request";
        if (this.active?.state === "running" && this.active.epoch === epoch) {
          this.finish(this.active, "blocked", reason);
        }
        this.failChild(reason, epoch);
        return;
      }
      if (value.method === "item/completed") {
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
    if (value.id === undefined) return this.failChild("malformed_protocol", epoch);
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

  private finish(
    run: Run,
    state: Exclude<CodexRunState, "running">,
    reason?: string
  ): void {
    if (run.state !== "running") return;
    if (run.timer) clearTimeout(run.timer);
    run.state = state;
    if (reason) run.reason = reason;
    if (state === "completed") {
      run.summary = redactAndTruncate(run.lastAgentMessage ?? "", MAX_SUMMARY_BYTES).text;
    }
    if (this.active === run) this.active = null;
    for (const waiter of run.waiters) waiter();
    run.waiters.clear();
  }

  private publicResult(run: Run): CodexRunResult {
    return {
      task_id: run.task_id,
      iteration: run.iteration,
      state: run.state,
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
    for (const taskId of this.tasks.keys()) {
      this.expiredTasks.delete(taskId);
      this.expiredTasks.set(taskId, true);
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
