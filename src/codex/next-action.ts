/** Pure public-response projection. Never persist this advisory data in a journal. */
export interface NextActionContext {
  workspace_id?: string;
  task_id?: string;
  run_id?: string;
  source: "current_runtime" | "journal" | "legacy_records";
  registered_tools: ReadonlySet<string>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const workspaceId = /^[a-f0-9]{24}$/;
const taskId = /^[A-Za-z0-9_.:-]{1,128}$/;
const runId = /^[a-f0-9]{32}$/;

export function selectNextAction(value: Record<string, unknown>, ctx: NextActionContext) {
  const journal = ctx.source !== "current_runtime" || value.recovered_from_journal === true || value.from_previous_runtime === true;
  const evidence = ctx.source === "legacy_records" || value.source === "legacy_execution_records" ? "legacy_records"
    : !journal ? "current_runtime" : value.from_previous_runtime === true ? "journal_previous_runtime"
      : value.from_previous_runtime === false ? "journal_current_runtime" : "journal_runtime_unknown";
  const binding: Record<string, string> = {};
  const workspaceMatches = id(ctx.workspace_id, workspaceId) &&
    (value.workspace_id === undefined || value.workspace_id === ctx.workspace_id);
  if (workspaceMatches) binding.workspace_id = ctx.workspace_id!;
  const taskMatches = workspaceMatches && id(value.task_id, taskId) &&
    (ctx.task_id === undefined || ctx.task_id === value.task_id);
  if (taskMatches) binding.task_id = value.task_id as string;
  const runMatches = taskMatches && id(value.run_id, runId) &&
    (ctx.run_id === undefined || ctx.run_id === value.run_id);
  if (runMatches) binding.run_id = value.run_id as string;
  const shield = record(value.timeout_shield);
  const state = value.state ?? value.execution_state;
  const known = typeof value.outcome_known === "boolean" ? value.outcome_known
    : !journal && runMatches && (state === "completed" || state === "failed" || state === "blocked" && value.resumable !== true) ? true : null;
  const base = {
    contract_version: 1, advisory_only: true, grants_authority: false,
    evidence_source: evidence, binding,
    server_registration_only: true, host_tool_availability: "unknown",
    timeout_shield: value.timeout_shield === undefined ? null : structuredClone(value.timeout_shield),
    yield_required: shield.yield_required === true,
    do_not_poll_again_in_same_response: shield.do_not_poll_again_in_same_response === true || shield.yield_required === true,
    automatic_host_reentry: false,
    verification: { execution_outcome_known: known, code_effects: "unverified", goal: "unverified", tests: "unknown_until_explicit_record_review" },
  };
  const action = (kind: string, tool: string | null, args: Record<string, string>, reason: string,
    extra: Record<string, unknown> = {}) => ({ ...base, kind,
    tool: tool && ctx.registered_tools.has(tool) ? tool : null,
    arguments: tool && ctx.registered_tools.has(tool) ? args : {},
    required_missing_user_fields: [] as string[], reason, ...extra });
  const inspect = (reason: string) => action("inspect_evidence",
    taskMatches && ctx.registered_tools.has("task_resume_context") ? "task_resume_context"
      : workspaceMatches && ctx.registered_tools.has("git_status") ? "git_status" : null,
    taskMatches && ctx.registered_tools.has("task_resume_context")
      ? { workspace_id: binding.workspace_id, task_id: binding.task_id } : workspaceMatches ? { workspace_id: binding.workspace_id } : {}, reason);
  if (!workspaceMatches || !taskMatches || !runMatches) return inspect("Target/task/run identity is missing or mismatched. Inspect verified evidence; no IDs, reply or continuation are inferred.");
  const runArgs = { workspace_id: binding.workspace_id, task_id: binding.task_id, run_id: binding.run_id };
  if (state === "completed") {
    const checks = ["git_status", "git_diff", "test_status", "execution_summary"].filter(tool => ctx.registered_tools.has(tool))
      .map(tool => ({ tool, arguments: { workspace_id: binding.workspace_id } }));
    return action("verify_completion", checks[0]?.tool ?? null, { workspace_id: binding.workspace_id },
      "Execution ended; independently review current changes, explicit test records, execution summary and the current goal. Missing tests remain unknown; never emit completion_notify merely because this run ended.",
      { verification_reads: checks, unavailable_verification_tools: ["git_status", "git_diff", "test_status", "execution_summary"].filter(tool => !ctx.registered_tools.has(tool)) });
  }
  if (journal) return inspect("Journal evidence is not a live input or execution channel. Inspect files, processes and recorded outcome; obtain separately authorized native reconciliation when exposed. Never replay or restore lost context.");
  if (state === "blocked" && value.reason === "mcp_elicitation_required" && value.resumable === true &&
      id(value.elicitation_request_id, runId) && record(value.elicitation_prompt).untrusted_data === true &&
      ctx.registered_tools.has("codex_mcp_elicitation_reply")) {
    return action("present_live_mcp_form", "codex_mcp_elicitation_reply", { ...runArgs, elicitation_request_id: value.elicitation_request_id },
      "Present the actual untrusted MCP prompt and original schema. Wait for explicit caller accept/decline/cancel; accept requires every original field. Never infer answers or reuse grants.",
      { required_missing_user_fields: ["action", "content_if_accept"], ready_to_execute: false });
  }
  if (state === "running" && ctx.registered_tools.has("codex_turn_wait")) {
    const resumeTool = typeof shield.resume_tool === "string" ? shield.resume_tool : "codex_turn_wait";
    if (resumeTool !== "codex_turn_wait") return inspect("Timeout Shield names another resume operation; do not invent a same-run wait or override the shield.");
    return action("wait_same_run", "codex_turn_wait", runArgs,
      shield.yield_required === true ? "Yield now. On the next user message, short-wait this same run; no further same-response polling." : "Short-wait this same run once; obey the returned Timeout Shield.");
  }
  if (state === "blocked" && value.reason === "user_input_required" && value.resumable === true &&
      id(value.input_request_id, runId) && Array.isArray(value.questions) && value.questions.length > 0 &&
      value.questions.every(question => id(record(question).id, /^[A-Za-z0-9_-]{1,64}$/) &&
        typeof record(question).question === "string" && (record(question).question as string).length > 0) &&
      ctx.registered_tools.has("codex_turn_reply")) {
    return action("present_live_question", "codex_turn_reply", { ...runArgs, input_request_id: value.input_request_id },
      "Present only the actual current questions already in this response. Wait for an explicit user answer; revalidate the live nonce. Never answer or approve on the user's behalf.",
      { required_missing_user_fields: ["message", "answers"], user_fields_rule: "exactly_one; message only for one question; answers must cover all current question IDs", ready_to_execute: false });
  }
  if (state === "blocked" && value.reason === "approval_required" && value.resumable === true &&
      value.waiting_for_local_approval === true && ["managed_network", "workspace_command", "git_commit", "git_stage"].includes(String(value.approval_type)) &&
      ctx.registered_tools.has("codex_turn_approval_status")) {
    const starting = record(record(value.approval_diagnostic).native_delivery).readiness === "unobserved";
    return action("native_owner_decision", "codex_turn_approval_status", runArgs,
      starting ? "The native helper is starting; no readiness or user receipt is proven. Read this same run status; startup is bounded and cannot authorize execution." :
      "Only the actual available native request may be reviewed by the owner. Read this same run's approval status; never approve through reply, shell, or automated clicks.",
      { native_owner_action: starting ? "Wait for helper readiness; no owner decision is requested yet." : "Decide the actual displayed request in the native dialog; the assistant supplies no decision.", ready_to_execute: false });
  }
  return inspect("Unsupported, terminal, failed, timed-out or unavailable channel: inspect current files/processes and saved evidence. Known execution outcome is not verified code effects or goal achievement. Never replay, revive or auto-start.");
}

export function projectNextAction(value: Record<string, unknown>, ctx: NextActionContext): Record<string, unknown> {
  // Legacy task rows retain their next_action string; the new object is additive.
  const field = typeof value.next_action === "string" ? "next_action_guidance" : "next_action";
  if (Array.isArray(value.tasks)) {
    const tasks = value.tasks.map(row => projectNextAction(record(row), { ...ctx, source: "journal", run_id: undefined }));
    const live = record(value.live_pending_input);
    const liveMatchesRow = value.tasks.some(row => {
      const saved = record(row);
      return saved.task_id === live.task_id && saved.run_id === live.run_id && saved.workspace_id === ctx.workspace_id && saved.from_previous_runtime === false;
    });
    const liveContext = { ...ctx, source: liveMatchesRow ? "current_runtime" as const : "journal" as const };
    const projectedLive = value.live_pending_input === undefined ? undefined
      : projectNextAction(live, liveContext);
    const selection = projectedLive ? selectNextAction(live, liveContext)
      : tasks.length === 1 ? selectNextAction(record(value.tasks[0]), { ...ctx, source: "journal" })
        : selectNextAction(value, { ...ctx, source: "journal" });
    return { ...value, tasks, ...(projectedLive ? { live_pending_input: projectedLive } : {}), [field]: selection };
  }
  return { ...value, [field]: selectNextAction(value, ctx) };
}
