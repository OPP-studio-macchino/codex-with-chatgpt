import { REGISTRATION_TIMEOUT_MS } from "../security/owner-dialog-timeouts.js";
import { randomBytes } from "node:crypto";
import { redactAndTruncate } from "../security/redaction.js";
import { WorkspaceProfiles, WorkspaceProfilesError, type WorkspaceProfileSummary } from "./profiles.js";

export type FolderDecision = "approved" | "denied" | "timed_out" | "unavailable";
export interface FolderApprovalPrompt { workspaceName: string; workspaceRoot: string; profileId: string; }
export interface WorkspaceRemovalPrompt { workspaceName: string; profileId: string; }
export interface FolderOwner {
  readonly supported: boolean;
  choose(signal: AbortSignal): Promise<string | null>;
  approve(prompt: FolderApprovalPrompt | WorkspaceRemovalPrompt, signal: AbortSignal): Promise<FolderDecision>;
}
export type WorkspaceUnregistrationSafety = "clear" | "blocking" | "unknown";
type State = "queued" | "selecting_folder" | "awaiting_owner" | "registered" | "already_registered" | "unregistered" | "denied" | "blocked" | "cancelled";
interface Job {
  id: string; kind: "register" | "unregister"; state: State; code?: string; message?: string; profile?: WorkspaceProfileSummary;
  profileId?: string; controller: AbortController; timer?: NodeJS.Timeout; consumed: boolean;
}
function terminal(state: State): boolean { return ["registered", "already_registered", "unregistered", "denied", "blocked", "cancelled"].includes(state); }
function fail(code: string, message: string): never { throw new WorkspaceProfilesError(code, message); }


/** No caller-supplied folder/approval. A native owner interaction supplies both. */
export class WorkspaceRegistration {
  private readonly jobs = new Map<string, Job>();
  private readonly expired = new Map<string, Job["kind"]>();
  private closed = false;
  constructor(private readonly profiles: WorkspaceProfiles, private readonly owner: FolderOwner,
    private readonly unregistrationSafety: (workspaceId: string) => WorkspaceUnregistrationSafety = () => "clear") {}

  start(): object {
    if (this.closed) fail("WORKSPACE_REGISTRATION_CLOSED", "Registration is closed; no owner decision was used.");
    if (!this.owner.supported) fail("WORKSPACE_REGISTRATION_UNAVAILABLE", "Native folder registration is not supported on this host. No changes were made.");
    const pending = [...this.jobs.values()].find(j => !terminal(j.state));
    if (pending) {
      if (pending.kind === "register") return this.publicJob(pending);
      fail("WORKSPACE_REGISTRATION_PENDING", "Another workspace registration operation is awaiting its owner decision.");
    }
    this.evictTerminalHistory();
    if (this.jobs.size >= 64) fail("WORKSPACE_REGISTRATION_CAPACITY", "Registration history is full for this runtime. Existing projects remain available.");
    const job: Job = { id: randomBytes(16).toString("hex"), kind: "register", state: "queued", controller: new AbortController(), consumed: false };
    this.jobs.set(job.id, job);
    job.timer = setTimeout(() => {
      if (!terminal(job.state)) {
        job.state = "blocked"; job.code = "WORKSPACE_REGISTRATION_TIMEOUT"; job.controller.abort();
      }
    }, REGISTRATION_TIMEOUT_MS);
    job.timer.unref();
    setImmediate(() => { void this.perform(job); });
    return this.publicJob(job);
  }

  status(registrationId: string): object {
    const job = this.jobs.get(registrationId);
    if (!job) fail(this.expired.has(registrationId) ? "WORKSPACE_REGISTRATION_NOT_RETAINED" : "WORKSPACE_REGISTRATION_NOT_FOUND",
      this.expired.has(registrationId) ? "This registration result expired from bounded runtime history; inspect the approved project list before requesting again." : "This registration ID was never issued by this runtime; no project state was changed.");
    return this.publicJob(job);
  }

  unregisterStart(profileId: string): object {
    if (this.closed) fail("WORKSPACE_REGISTRATION_CLOSED", "Registration is closed; no owner decision was used.");
    if (!this.owner.supported) fail("WORKSPACE_UNREGISTRATION_UNAVAILABLE", "Native workspace unregistration is not supported on this host. No changes were made.");
    const pending = [...this.jobs.values()].find(j => !terminal(j.state));
    if (pending) {
      if (pending.kind === "unregister" && pending.profileId === profileId) return this.publicJob(pending);
      fail("WORKSPACE_REGISTRATION_PENDING", "Another workspace registration operation is awaiting its owner decision.");
    }
    this.evictTerminalHistory();
    if (this.jobs.size >= 64) fail("WORKSPACE_REGISTRATION_CAPACITY", "Registration history is full for this runtime. Existing projects remain available.");
    const candidate = this.profiles.prepareRemoval(profileId);
    this.requireSafeToRemove(candidate.workspace.id);
    const job: Job = { id: randomBytes(16).toString("hex"), kind: "unregister", state: "queued", profileId: candidate.profileId,
      profile: this.profiles.list().find(p => p.id === candidate.profileId), controller: new AbortController(), consumed: false };
    this.jobs.set(job.id, job);
    job.timer = setTimeout(() => {
      if (!terminal(job.state)) {
        job.state = "blocked"; job.code = "WORKSPACE_UNREGISTRATION_TIMEOUT"; job.controller.abort();
      }
    }, REGISTRATION_TIMEOUT_MS);
    job.timer.unref();
    setImmediate(() => { void this.performRemoval(job, candidate); });
    return this.publicJob(job);
  }

  unregisterStatus(registrationId: string): object {
    const job = this.jobs.get(registrationId);
    if (!job || job.kind !== "unregister") fail(this.expired.get(registrationId) === "unregister" ? "WORKSPACE_UNREGISTRATION_NOT_RETAINED" : "WORKSPACE_UNREGISTRATION_NOT_FOUND",
      this.expired.get(registrationId) === "unregister" ? "This unregistration result expired from bounded runtime history; inspect the approved project list before requesting again." : "This unregistration ID was never issued by this runtime; no project state was changed.");
    return this.publicJob(job);
  }

  private check(job: Job): void {
    if (this.closed || job.controller.signal.aborted || terminal(job.state)) fail("WORKSPACE_REGISTRATION_CANCELLED", "No late approval may be applied.");
  }

  private requireSafeToRemove(workspaceId: string): void {
    const safety = this.unregistrationSafety(workspaceId);
    if (safety === "blocking") fail("WORKSPACE_UNREGISTRATION_TASK_ACTIVE", "This workspace has a running or waiting task; finish or recover it before unregistering.");
    if (safety !== "clear") fail("WORKSPACE_UNREGISTRATION_TASK_UNKNOWN", "This workspace task state cannot be safely verified; no registration was removed.");
  }

  private async perform(job: Job): Promise<void> {
    try {
      this.check(job); job.state = "selecting_folder";
      const selected = await this.owner.choose(job.controller.signal);
      this.check(job);
      if (selected === null) { job.state = "cancelled"; job.code = "OWNER_CANCELLED_FOLDER_SELECTION"; return; }
      const candidate = this.profiles.prepareAddition(selected);
      if (candidate.alreadyRegistered) {
        job.profile = this.profiles.list().find(p => p.id === candidate.profileId);
        job.state = "already_registered"; return;
      }
      job.state = "awaiting_owner";
      const decision = await this.owner.approve({ workspaceRoot: candidate.workspace.root,
        workspaceName: candidate.workspace.name, profileId: candidate.profileId }, job.controller.signal);
      this.check(job);
      if (decision !== "approved") {
        job.state = "denied";
        job.code = decision === "timed_out" ? "OWNER_APPROVAL_TIMEOUT" : decision === "unavailable" ? "OWNER_APPROVAL_UNAVAILABLE" : "OWNER_DENIED";
        return;
      }
      if (job.consumed) fail("APPROVAL_ALREADY_USED", "Owner approval was already consumed.");
      job.consumed = true; // Consume before directory/config revalidation and persistence.
      job.profile = this.profiles.commitApprovedAddition(candidate);
      job.state = "registered";
    } catch (e) {
      if (!terminal(job.state)) {
        job.state = "blocked";
        job.code = e instanceof WorkspaceProfilesError ? e.code : "WORKSPACE_REGISTRATION_FAILED";
        job.message = e instanceof WorkspaceProfilesError ? redactAndTruncate(e.message, 512).text : "Project registration failed before success could be confirmed. Inspect the approved project list before trying again.";
      }
    } finally { if (job.timer) clearTimeout(job.timer); }
  }

  private async performRemoval(job: Job, candidate: ReturnType<WorkspaceProfiles["prepareRemoval"]>): Promise<void> {
    try {
      this.check(job); job.state = "awaiting_owner";
      const decision = await this.owner.approve({ workspaceName: candidate.workspace.name, profileId: candidate.profileId }, job.controller.signal);
      this.check(job);
      if (decision !== "approved") {
        job.state = "denied";
        job.code = decision === "timed_out" ? "OWNER_APPROVAL_TIMEOUT" : decision === "unavailable" ? "OWNER_APPROVAL_UNAVAILABLE" : "OWNER_DENIED";
        return;
      }
      if (job.consumed) fail("APPROVAL_ALREADY_USED", "Owner approval was already consumed.");
      job.consumed = true;
      this.requireSafeToRemove(candidate.workspace.id);
      job.profile = this.profiles.commitApprovedRemoval(candidate);
      job.state = "unregistered";
    } catch (e) {
      if (!terminal(job.state)) {
        job.state = "blocked";
        job.code = e instanceof WorkspaceProfilesError ? e.code : "WORKSPACE_UNREGISTRATION_FAILED";
        job.message = e instanceof WorkspaceProfilesError ? redactAndTruncate(e.message, 512).text : "Project unregistration failed before success could be confirmed. Inspect the approved project list before trying again.";
      }
    } finally { if (job.timer) clearTimeout(job.timer); }
  }

  private publicJob(job: Job): object {
    const success = job.state === "registered" || job.state === "already_registered" || job.state === "unregistered";
    return { registration_id: job.id, operation: job.kind, state: job.state, ...(job.code ? { code: job.code } : {}),
      ...(job.profile ? { profile: job.profile } : {}), ...(job.message ? { message: job.message } : {}),
      selection_changed: false, restart_required: false,
      desktop_roots_changed: false, network_permissions_added: false,
      next_action: job.state === "unregistered" ? "INSPECT_APPROVED_WORKSPACE_LIST" : success ? "USE_RETURNED_WORKSPACE_ID_WITHOUT_RECONNECTING" :
        job.state === "selecting_folder" ? "SELECT_PROJECT_FOLDER_ON_MAC" :
        job.state === "awaiting_owner" ? "REVIEW_PROJECT_ACCESS_ON_MAC" :
        terminal(job.state) ? "INSPECT_REGISTRATION_REASON_NO_RECONNECT_LOOP" : "CHECK_REGISTRATION_STATUS" };
  }

  private evictTerminalHistory(): void {
    while (this.jobs.size >= 64) {
      const oldestTerminal = [...this.jobs.values()].find(job => terminal(job.state));
      if (!oldestTerminal) return;
      if (oldestTerminal.timer) clearTimeout(oldestTerminal.timer);
      this.jobs.delete(oldestTerminal.id);
      this.expired.delete(oldestTerminal.id);
      this.expired.set(oldestTerminal.id, oldestTerminal.kind);
      if (this.expired.size > 64) this.expired.delete(this.expired.keys().next().value!);
    }
  }

  cancelPending(): void {
    for (const job of this.jobs.values()) {
      if (!terminal(job.state)) {
        job.state = "cancelled"; job.code = "WORKSPACE_REGISTRATION_CANCELLED"; job.controller.abort();
      }
      if (job.timer) clearTimeout(job.timer);
    }
  }
  close(): void { this.closed = true; this.cancelPending(); }
}
