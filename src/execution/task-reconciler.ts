import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Workspace } from "../workspace/manager.js";
import { TaskJournal, TaskJournalError, type ReconciliationTarget } from "./task-journal.js";

export interface ReconciliationEvidence {
  digest: string;
  head: string;
  fileCount: number;
  changedCount: number;
  processScope: "same-user-cwd";
  fileScope: "tracked-and-nonignored-untracked";
}
export interface OwnerRecoveryPrompt {
  workspaceName: string;
  workspaceRoot: string;
  taskId: string;
  runId: string;
  evidence: ReconciliationEvidence;
}
export type OwnerDecision = "approved" | "denied" | "timed_out" | "unavailable";
export interface ReconciliationOptions {
  journal: TaskJournal;
  inspect: (workspace: Workspace, signal: AbortSignal) => Promise<ReconciliationEvidence>;
  approve: (prompt: OwnerRecoveryPrompt, signal: AbortSignal) => Promise<OwnerDecision>;
  isBusy: (workspaceId: string) => boolean;
}
type JobState = "inspecting" | "awaiting_owner" | "verifying" | "reconciled" | "denied" | "blocked" | "cancelled";
interface Job {
  id: string;
  workspaceId: string;
  taskId: string;
  runId: string;
  state: JobState;
  code?: string;
  evidence?: ReconciliationEvidence;
  consumed: boolean;
  controller: AbortController;
  timer?: NodeJS.Timeout;
}
function error(code: string): never { throw new TaskJournalError(code, code.replaceAll("_", " ")); }
function final(state: JobState): boolean { return ["reconciled", "denied", "blocked", "cancelled"].includes(state); }
function validEvidence(value: ReconciliationEvidence): boolean {
  return Boolean(value) && /^[a-f0-9]{64}$/.test(value.digest) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.head) &&
    Number.isInteger(value.fileCount) && value.fileCount >= 0 && value.fileCount <= 4000 &&
    Number.isInteger(value.changedCount) && value.changedCount >= 0 && value.changedCount <= 2000 &&
    value.processScope === "same-user-cwd" && value.fileScope === "tracked-and-nonignored-untracked";
}

/** Native owner approval is the only production writer path; status never consumes or executes. */
export class TaskReconciler {
  private jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly opts: ReconciliationOptions) {}

  start(workspace: Workspace, taskId: string, runId: string): object {
    if (this.closed) error("RECONCILIATION_CLOSED");
    if (this.opts.isBusy(workspace.id)) error("WORKSPACE_BUSY");
    const target = this.opts.journal.reconciliationTarget(workspace.id, taskId, runId);
    const active = [...this.jobs.values()].find(j => j.workspaceId === workspace.id && !final(j.state));
    if (active) {
      if (active.taskId !== taskId || active.runId !== runId) error("RECONCILIATION_BUSY");
      return this.publicJob(active);
    }
    if (this.jobs.size >= 64) error("RECONCILIATION_CAPACITY");
    const job: Job = { id: randomBytes(16).toString("hex"), workspaceId: workspace.id, taskId, runId,
      state: "inspecting", consumed: false, controller: new AbortController() };
    this.jobs.set(job.id, job);
    job.timer = setTimeout(() => {
      if (!final(job.state)) { job.state = "blocked"; job.code = "RECONCILIATION_TIMEOUT"; job.controller.abort(); }
    }, 120_000);
    job.timer.unref();
    queueMicrotask(() => { void this.perform(job, workspace, target); });
    return this.publicJob(job);
  }

  status(workspaceId: string, requestId: string): object {
    const job = this.jobs.get(requestId);
    if (!job || job.workspaceId !== workspaceId) error("RECONCILIATION_NOT_FOUND");
    return this.publicJob(job);
  }

  private check(job: Job): void {
    if (this.closed || job.controller.signal.aborted || final(job.state)) error("RECONCILIATION_CANCELLED");
    if (this.opts.isBusy(job.workspaceId)) error("WORKSPACE_BUSY");
  }

  private async perform(job: Job, workspace: Workspace, target: ReconciliationTarget): Promise<void> {
    try {
      this.check(job);
      const before = await this.opts.inspect(workspace, job.controller.signal);
      this.check(job);
      if (!validEvidence(before)) error("RECONCILIATION_EVIDENCE_INVALID");
      job.evidence = before;
      job.state = "awaiting_owner";
      const decision = await this.opts.approve({ workspaceName: workspace.name, workspaceRoot: workspace.root,
        taskId: job.taskId, runId: job.runId, evidence: before }, job.controller.signal);
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
      const after = await this.opts.inspect(workspace, job.controller.signal);
      this.check(job);
      if (performance.now() - approvedMonotonic > 60_000) error("OWNER_APPROVAL_EXPIRED");
      if (!validEvidence(after) || after.digest !== before.digest) error("RECONCILIATION_EVIDENCE_CHANGED");
      this.opts.journal.reconcileConfirmed(target, before.digest, approvedAt);
      job.state = "reconciled";
    } catch (e) {
      if (!final(job.state)) {
        job.state = "blocked";
        job.code = e instanceof TaskJournalError ? e.code : "RECONCILIATION_FAILED";
      }
    } finally { if (job.timer) clearTimeout(job.timer); }
  }

  private publicJob(job: Job): object {
    return { reconciliation_id: job.id, workspace_id: job.workspaceId, task_id: job.taskId, run_id: job.runId,
      state: job.state, ...(job.code ? { code: job.code } : {}),
      ...(job.evidence ? { evidence: job.evidence } : {}),
      original_outcome_known: false, original_task_replayed: false,
      next_action: job.state === "awaiting_owner" ? "REVIEW_LOCAL_APPROVAL" : job.state === "reconciled" ? "REVIEW_REMAINING_BLOCKERS_THEN_NEW_TASK" :
        final(job.state) ? "INSPECT_BLOCKER_NO_REPLAY" : "CHECK_RECONCILIATION_STATUS" };
  }

  cancelPending(): void {
    for (const job of this.jobs.values()) {
      if (!final(job.state)) { job.state = "cancelled"; job.code = "RECONCILIATION_CANCELLED"; job.controller.abort(); }
      if (job.timer) clearTimeout(job.timer);
    }
  }

  close(): void { this.closed = true; this.cancelPending(); }
}
