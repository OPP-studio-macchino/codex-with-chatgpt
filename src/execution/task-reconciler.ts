import { RECONCILIATION_TIMEOUT_MS } from "../security/owner-dialog-timeouts.js";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Workspace } from "../workspace/manager.js";
import { TaskJournal, TaskJournalError, type ReconciliationTarget, type CheckpointTarget } from "./task-journal.js";
import type { CodexAppServer, CodexRunResult } from "../codex/app-server.js";
import { processEvidenceSchema, reconciliationCode, quarantine, incompleteProcessEvidence, type ProcessEvidence, type DiagnosticContext } from "./reconciliation-processes.js";

export interface ReconciliationEvidence {
  processes?: ProcessEvidence;
  digest: string;
  head: string;
  fileCount: number;
  changedCount: number;
  branch?: string;
  staged?: boolean;
  processScope: "same-user-cwd";
  fileScope: "git-index-status-and-dirty-worktree-excluding-appledouble" | "tracked-and-nonignored-untracked";
}
export interface OwnerRecoveryPrompt {
  workspaceName: string;
  workspaceRoot: string;
  taskId: string;
  runId?: string;
  evidence: ReconciliationEvidence;
  checkpoint?: CheckpointTarget;
  workspaceRecovery?: { workspaceId: string; records: ReconciliationTarget[]; identitySha256: string };
}
export type OwnerDecision = "approved" | "denied" | "timed_out" | "unavailable";
export interface ReconciliationOptions {
  journal: TaskJournal;
  inspect: (workspace: Workspace, signal: AbortSignal, historical?: DiagnosticContext["historical"], onObservation?: (processes: ProcessEvidence) => void) => Promise<ReconciliationEvidence>;
  approve: (prompt: OwnerRecoveryPrompt, signal: AbortSignal) => Promise<OwnerDecision>;
  isBusy: (workspaceId: string) => boolean;
  identity?: (workspaceId: string) => string;
}
type JobState = "inspecting" | "awaiting_owner" | "verifying" | "reconciled" | "denied" | "blocked" | "cancelled";
interface Job {
  id: string;
  workspaceId: string;
  taskId: string;
  runId?: string;
  state: JobState;
  code?: string;
  evidence?: ReconciliationEvidence;
  processes?: ProcessEvidence;
  consumed: boolean;
  controller: AbortController;
  timer?: NodeJS.Timeout;
  checkpoint?: CheckpointTarget;
  recoveryTargets?: ReconciliationTarget[];
  failureTargets?: ReconciliationTarget[];
  auditRecorded?: boolean;
}
function error(code: string): never { throw new TaskJournalError(code, code.replaceAll("_", " ")); }
function final(state: JobState): boolean { return ["reconciled", "denied", "blocked", "cancelled"].includes(state); }
function validEvidence(value: ReconciliationEvidence): boolean {
  return Boolean(value) && (value.processes === undefined || (processEvidenceSchema.safeParse(value.processes).success && value.processes.quiescence === "QUIESCENT")) &&
    /^[a-f0-9]{64}$/.test(value.digest) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.head) &&
    Number.isInteger(value.fileCount) && value.fileCount >= 0 && value.fileCount <= 4000 &&
    Number.isInteger(value.changedCount) && value.changedCount >= 0 && value.changedCount <= 2000 &&
    value.processScope === "same-user-cwd" && ["git-index-status-and-dirty-worktree-excluding-appledouble", "tracked-and-nonignored-untracked"].includes(value.fileScope);
}

/** Native owner approval is the only production writer path; status never consumes or executes. */
export class TaskReconciler {
  private jobs = new Map<string, Job>();
  private closed = false;
  private continuations = new Set<AbortController>();
  private generation = 0;
  constructor(private readonly opts: ReconciliationOptions) {}

  startWorkspaceRecovery(workspace: Workspace): object {
    if (this.closed) error("RECONCILIATION_CLOSED");
    if (!this.opts.identity) error("RECONCILIATION_EVIDENCE_INVALID");
    if (this.opts.isBusy(workspace.id)) error("WORKSPACE_BUSY");
    if ([...this.jobs.values()].some(j => j.workspaceId === workspace.id && !final(j.state))) error("RECONCILIATION_BUSY");
    const targets = this.opts.journal.workspaceBlockers(workspace.id);
    if (!targets.length) return this.opts.journal.workspaceRecoveryStatus(workspace.id);
    return this.enqueue(workspace, targets[0].task_id, targets[0].run_id, targets[0], undefined, targets);
  }

  workspaceRecoveryStatus(workspaceId: string, id?: string): object {
    const job = id ? this.jobs.get(id) : undefined;
    if (job && (job.workspaceId !== workspaceId || !job.recoveryTargets)) error("RECONCILIATION_NOT_FOUND");
    return job ? this.publicJob(job) : this.opts.journal.workspaceRecoveryStatus(workspaceId, id);
  }

  start(workspace: Workspace, taskId: string, runId: string): object {
    if (this.closed) error("RECONCILIATION_CLOSED");
    if (this.opts.isBusy(workspace.id)) error("WORKSPACE_BUSY");
    const target = this.opts.journal.reconciliationTarget(workspace.id, taskId, runId);
    return this.enqueue(workspace, taskId, runId, target);
  }

  prepareCheckpoint(workspace: Workspace, taskId: string, next: number, instruction: string,
    missing?: { iteration: number; run_id: string }): object {
    if (this.closed) error("RECONCILIATION_CLOSED");
    if (this.opts.isBusy(workspace.id)) error("WORKSPACE_BUSY");
    const target = this.opts.journal.checkpointTarget(workspace.id, taskId, next, instruction, missing);
    return this.enqueue(workspace, taskId, missing?.run_id, target, instruction);
  }

  private enqueue(workspace: Workspace, taskId: string, runId: string | undefined, target: ReconciliationTarget | CheckpointTarget, instruction?: string, recoveryTargets?: ReconciliationTarget[]): object {
    const active = [...this.jobs.values()].find(j => j.workspaceId === workspace.id && !final(j.state));
    if (active) {
      if (active.taskId !== taskId || active.runId !== runId || JSON.stringify(active.checkpoint) !== JSON.stringify("next_iteration" in target ? target : undefined)) error("RECONCILIATION_BUSY");
      return this.publicJob(active);
    }
    if (this.jobs.size >= 64) error("RECONCILIATION_CAPACITY");
    const job: Job = { id: randomBytes(16).toString("hex"), workspaceId: workspace.id, taskId, runId,
      state: "inspecting", consumed: false, controller: new AbortController(),
      ...("next_iteration" in target ? { checkpoint: target } : { failureTargets: recoveryTargets ?? [target] }), recoveryTargets };
    this.jobs.set(job.id, job);
    job.timer = setTimeout(() => {
      if (!final(job.state)) { this.stopJob(job, "blocked", "RECONCILIATION_TIMEOUT"); }
    }, RECONCILIATION_TIMEOUT_MS);
    job.timer.unref();
    queueMicrotask(() => { void this.perform(job, workspace, target, instruction); });
    return this.publicJob(job);
  }

  status(workspaceId: string, requestId: string): object {
    const job = this.jobs.get(requestId);
    if (!job || job.workspaceId !== workspaceId) error("RECONCILIATION_NOT_FOUND");
    return this.publicJob(job);
  }

  private currentIdentity(workspaceId: string): string {
    try {
      const identity = this.opts.identity!(workspaceId);
      if (typeof identity !== "string" || !identity || Buffer.byteLength(identity) > 65536) error("WORKSPACE_RECOVERY_CHANGED");
      return identity;
    } catch { error("WORKSPACE_RECOVERY_CHANGED"); }
  }

  private check(job: Job): void {
    if (this.closed || job.controller.signal.aborted || final(job.state)) error("RECONCILIATION_CANCELLED");
    if (this.opts.isBusy(job.workspaceId)) error("WORKSPACE_BUSY");
  }

  private async perform(job: Job, workspace: Workspace, target: ReconciliationTarget | CheckpointTarget, instruction?: string): Promise<void> {
    try {
      this.check(job);
      const identity = job.recoveryTargets ? this.currentIdentity(workspace.id) : undefined;
      const historical = job.runId && !job.checkpoint ? this.opts.journal.reconciliationProcessContext(workspace.id, job.taskId, job.runId) : undefined;
      const before = await this.opts.inspect(workspace, job.controller.signal, historical, processes => this.observeProcesses(job, processes));
      this.check(job);
      this.processObservation(job, before);
      if (identity !== undefined && identity !== this.currentIdentity(workspace.id)) error("WORKSPACE_RECOVERY_CHANGED");
      if (!validEvidence(before)) error("RECONCILIATION_EVIDENCE_INVALID");
      job.evidence = before;
      job.state = "awaiting_owner";
      const decision = await this.opts.approve({ workspaceName: workspace.name, workspaceRoot: workspace.root,
        taskId: job.taskId, runId: job.runId, evidence: before, checkpoint: job.checkpoint,
        ...(job.recoveryTargets ? { workspaceRecovery: { workspaceId: workspace.id, records: job.recoveryTargets,
          identitySha256: createHash("sha256").update(identity!).digest("hex") } } : {}) }, job.controller.signal);
      this.check(job);
      if (decision !== "approved") {
        job.state = "denied";
        job.code = decision === "timed_out" ? "OWNER_APPROVAL_TIMEOUT" : decision === "unavailable" ? "OWNER_APPROVAL_UNAVAILABLE" : "OWNER_DENIED";
        return;
      }
      if (job.consumed) error("APPROVAL_ALREADY_USED");
      job.consumed = true; // burn before reinspection/commit; failure requires a new owner decision.
      const approvedAt = new Date().toISOString();
      const approvedMonotonic = performance.now();
      job.state = "verifying";
      const after = await this.opts.inspect(workspace, job.controller.signal, historical, processes => this.observeProcesses(job, processes));
      this.check(job);
      this.processObservation(job, after);
      if (performance.now() - approvedMonotonic > 60_000) error("OWNER_APPROVAL_EXPIRED");
      if (!validEvidence(after) || after.digest !== before.digest || (identity !== undefined && identity !== this.currentIdentity(workspace.id))) error(job.recoveryTargets ? "WORKSPACE_RECOVERY_CHANGED" : "RECONCILIATION_EVIDENCE_CHANGED");
      if (job.recoveryTargets) this.opts.journal.recordWorkspaceRecovery(workspace.id, job.id, job.recoveryTargets, "recovered", undefined,
        createHash("sha256").update(before.digest).update(identity!).digest("hex"), approvedAt, job.processes);
      else if ("next_iteration" in target) this.opts.journal.approveCheckpoint(target, instruction!, before.digest, approvedAt, job.id);
      else this.opts.journal.reconcileConfirmed(target, before.digest, approvedAt);
      job.state = "reconciled";
      if (job.recoveryTargets) job.auditRecorded = true;
    } catch (e) {
      if (e instanceof TaskJournalError && !job.auditRecorded) {
        const parsed = processEvidenceSchema.safeParse(e.details);
        if (parsed.success) job.processes = parsed.data;
      }
      if (!final(job.state)) {
        job.state = "blocked";
        job.code = reconciliationCode(e instanceof TaskJournalError ? e.code : undefined);
      }
    } finally {
      if (job.timer) clearTimeout(job.timer);
      this.recordFailure(job);
    }
  }

  private observeProcesses(job: Job, processes: ProcessEvidence): void {
    if (job.auditRecorded) return;
    const parsed = processEvidenceSchema.safeParse(processes);
    if (!parsed.success) error("RECONCILIATION_EVIDENCE_INVALID");
    job.processes = parsed.data;
  }

  private stopJob(job: Job, state: "blocked" | "cancelled", code: "RECONCILIATION_TIMEOUT" | "RECONCILIATION_CANCELLED"): void {
    job.state = state; job.code = code;
    // The inspector publishes bounded observations synchronously, including abort.
    // Persist the latest observation before returning, even if its Promise never settles.
    job.controller.abort();
    if (job.processes) job.processes = incompleteProcessEvidence(job.processes, code);
    job.evidence = undefined;
    this.recordFailure(job);
  }

  private processObservation(job: Job, evidence: ReconciliationEvidence): void {
    if (evidence.processes === undefined) return; // Existing trusted in-process test providers remain compatible.
    const parsed = processEvidenceSchema.safeParse(evidence.processes);
    if (!parsed.success) error("RECONCILIATION_EVIDENCE_INVALID");
    job.processes = parsed.data;
    if (parsed.data.quiescence !== "QUIESCENT") error(parsed.data.code!);
  }

  private recordFailure(job: Job): void {
    if (!job.failureTargets || job.state === "reconciled" || job.auditRecorded) return;
    job.auditRecorded = true;
    try {
      this.opts.journal.recordWorkspaceRecovery(job.workspaceId, job.id, job.failureTargets,
        job.state === "denied" ? "denied" : job.state === "cancelled" ? "cancelled" : "blocked",
        reconciliationCode(job.code), undefined, undefined, job.processes);
    } catch { job.state = "blocked"; job.code = "TASK_JOURNAL_UNAVAILABLE"; }
  }

  private publicJob(job: Job): object {
    const originalRunId = job.runId ?? job.checkpoint?.known_records.at(-1)?.run_id;
    const terminal = originalRunId ? this.opts.journal.observedTaskOutcome(job.workspaceId, job.taskId, originalRunId)
      : { known: false, state: "unknown", run_id: null, reason: null };
    const checkpoint = job.checkpoint && job.state === "reconciled" ? this.opts.journal.checkpointStatus(job.workspaceId, job.taskId)
      .find(c => (c as { checkpoint_id: string }).checkpoint_id === job.id) as { status: string } | undefined : undefined;
    return { reconciliation_id: job.id, ...(job.recoveryTargets ? { recovery_id: job.id, blockers: this.opts.journal.workspaceBlockers(job.workspaceId) } : {}), workspace_id: job.workspaceId, task_id: job.taskId, ...(job.checkpoint ? { reported_missing_run: job.checkpoint.reported_missing_run } : { run_id: job.runId }),
      state: job.recoveryTargets && job.state === "reconciled" ? "recovered" : job.state, ...(job.code ? { code: job.code } : {}),
      ...(job.evidence ? { evidence: job.evidence } : {}),
      ...(job.processes ? { processes: job.processes } : {}),
      quarantine: quarantine(job.processes, job.state === "reconciled" && !job.checkpoint && this.opts.journal.workspaceBlockers(job.workspaceId).length === 0),
      // Legacy outcome/quarantine fields described effect resolution, not the
      // recorded terminal result. Keep them conservative; make the scopes explicit.
      original_outcome_known: false, original_outcome_scope: "effects-and-historical-resolution",
      original_execution_result: terminal, original_task_replayed: false,
      process_safety: job.processes?.quiescence ?? "UNKNOWN", goal_verification: "UNVERIFIED",
      workspace_integrity: job.evidence ? "INSPECTED" : "UNVERIFIED",
      ...(job.code === "RECONCILIATION_CWD_UNRESOLVED" ? { recovery_guidance: {
        action: "INSPECT_CWD_FAILURE_AND_OWNER_SESSION", automatic_retry: false, approval_required_now: false,
        processes: job.processes?.snapshot_diagnostics?.entries.filter(e => e.reason === "cwd_unresolved") ?? [],
        conditions: ["Identify the owner session and assess unsaved work before any graceful closure.",
          "Re-scan only after cwd is observable or the same process birth identity has ended.",
          "Do not create a replacement directory at a missing cwd, ignore a process by name, or reuse an expired approval.",
          "Fresh complete quiescence and workspace integrity checks precede a new native owner approval."],
      } } : {}),
      ...(job.checkpoint ? { purpose: "checkpoint_continuation", next_iteration: job.checkpoint.next_iteration, original_context_restored: false } : {}),
      ...(checkpoint ? { checkpoint_status: checkpoint.status } : {}),
      next_action: job.state === "awaiting_owner" ? "REVIEW_LOCAL_APPROVAL" : job.state === "reconciled" ? job.checkpoint ? checkpoint?.status === "approved" ? "START_APPROVED_SAME_TASK_ITERATION" : "INSPECT_CHECKPOINT_STATUS" : "REVIEW_REMAINING_BLOCKERS_THEN_NEW_TASK" :
        final(job.state) ? "INSPECT_BLOCKER_NO_REPLAY" : "CHECK_RECONCILIATION_STATUS" };
  }

  /** No public approval flag. Reinspection precedes the synchronous consume/write-ahead hook. */
  async continueCheckpoint(workspace: Workspace, taskId: string, next: number, instruction: string,
    codex: Pick<CodexAppServer, "startCheckpointTurn">, executionMode?: CodexRunResult["execution_mode"]): Promise<CodexRunResult> {
    if (this.closed) error("RECONCILIATION_CLOSED");
    const mode = this.opts.journal.checkExecutionMode(workspace.id, taskId, executionMode);
    if (this.opts.isBusy(workspace.id)) error("WORKSPACE_BUSY");
    const checkpoint = this.opts.journal.approvedCheckpoint(workspace.id, taskId, next, instruction);
    if (this.continuations.size) error("WORKSPACE_BUSY");
    const generation = this.generation;
    const controller = new AbortController();
    this.continuations.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const evidence = await this.opts.inspect(workspace, controller.signal);
      if (this.closed || generation !== this.generation || controller.signal.aborted || this.opts.isBusy(workspace.id)) error("RECONCILIATION_CANCELLED");
      if (!validEvidence(evidence) || evidence.digest !== checkpoint.evidence_sha256) error("RECONCILIATION_EVIDENCE_CHANGED");
      return await codex.startCheckpointTurn(taskId, next, instruction, run => {
        if (this.closed || generation !== this.generation || controller.signal.aborted) error("RECONCILIATION_CANCELLED");
        this.opts.journal.beginCheckpoint(workspace.id, run, instruction, checkpoint.checkpoint_id, evidence.digest);
      }, mode);
    } finally { clearTimeout(timeout); this.continuations.delete(controller); }
  }

  /** Reinspect, synchronously revalidate and durably burn before a non-Codex mutation. */
  async executeCheckpointAction<T>(workspace: Workspace, taskId: string, next: number, instruction: string,
    revalidate: () => void, execute: (actionId: string) => T): Promise<T> {
    if (this.closed) error("RECONCILIATION_CLOSED");
    if (this.opts.isBusy(workspace.id) || this.continuations.size) error("WORKSPACE_BUSY");
    const checkpoint = this.opts.journal.approvedCheckpoint(workspace.id, taskId, next, instruction);
    const generation = this.generation;
    const controller = new AbortController();
    this.continuations.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const evidence = await this.opts.inspect(workspace, controller.signal);
      if (this.closed || generation !== this.generation || controller.signal.aborted || this.opts.isBusy(workspace.id)) error("RECONCILIATION_CANCELLED");
      if (!validEvidence(evidence) || evidence.digest !== checkpoint.evidence_sha256) error("RECONCILIATION_EVIDENCE_CHANGED");
      revalidate();
      const actionId = randomBytes(16).toString("hex");
      this.opts.journal.consumeCheckpointAction(workspace.id, taskId, next, instruction,
        checkpoint.checkpoint_id, evidence.digest, actionId);
      return execute(actionId);
    } finally { clearTimeout(timeout); this.continuations.delete(controller); }
  }

  cancelPending(): void {
    this.generation++;
    for (const controller of this.continuations) controller.abort();
    for (const job of this.jobs.values()) {
      if (!final(job.state)) { this.stopJob(job, "cancelled", "RECONCILIATION_CANCELLED"); }
      if (job.timer) clearTimeout(job.timer);
    }
    try { this.opts.journal.revokeCheckpoints(); } catch { this.closed = true; }
  }

  close(): void { this.closed = true; this.cancelPending(); }
}
