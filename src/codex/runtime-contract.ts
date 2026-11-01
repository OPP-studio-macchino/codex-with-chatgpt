/** Source contract only: neither authorization nor evidence of live acceptance. */
export const FIRST_TURN_CONTRACT_PREFIX =
  "Execution contract: inspect only relevant paths; reuse settled context; no subagents unless explicitly requested; narrow-to-broad validation; compact closeout.\n\n";

export const RUNTIME_CONTRACT = {
  contract_version: 1,
  evidence_scope: "current_source",
  environment: {
    executable_preflight: "unverified",
    executable_version: "unknown",
    app_server_compatibility: "unverified",
    mcp_inventory: { status: "unknown", tools: null },
    version_string_proves_compatibility: false,
  },
  capabilities: {
    exact_workspace_command_approval: { implementation: "implemented", live_acceptance: "unverified", boundary: "Validated exact scope and real native owner decision only; unsupported scopes terminate." },
    structured_git: { implementation: "implemented", live_acceptance: "unverified", boundary: "Exposed plan/checkpoint tools, exact evidence and fresh native approval required; never generic shell permission." },
    structured_user_input: { implementation: "implemented", live_acceptance: "unverified", boundary: "Current same-runtime resumable user_input_required only; explicit user answer, never approval." },
    mcp_elicitation_form: { implementation: "implemented", live_acceptance: "unverified", boundary: "Official form subset only: all-required boolean, number/integer or string enum fields, no defaults/free text/extra constraints/secrets. Dedicated explicit accept/decline/cancel on the same live transport; historical evidence cannot reply." },
    mcp_elicitation_url: { implementation: "unsupported", live_acceptance: "unverified", boundary: "Terminal mcp_elicitation_required; no URL completion or resume." },
    recovery: { implementation: "implemented", live_acceptance: "unverified", boundary: "Inspection/reconciliation only when exposed and authorized; never replay. Histories through iteration 12 remain r32-compatible; later runs/checkpoints use journal v2, which old writers must not open. Historical hash-bound migration remains blocked." },
    automatic_notification: { implementation: "implemented", live_acceptance: "unverified", boundary: "Durable bounded event/handoff and same-ID local delivery retries until explicit notice acknowledgement, including completion; startup recovers approved profiles. Exit zero is not OS presentation or receipt. Acknowledgement grants no approval, answer, resume or goal verification. No business retry or host re-entry." },
    result_retrieval: { implementation: "implemented", live_acceptance: "unverified", boundary: "Bounded exposed history/result reads; summaries do not prove completion." },
    background_host_reentry: { implementation: "unsupported", live_acceptance: "unverified", automatic: false, boundary: "No existing official wakeup capability demonstrated or implemented. Return on the next user message; no autonomous continuation." },
  },
  guidance: {
    kind: "advisory_response_and_templates",
    persisted_state_wiring: "bounded_notification_evidence_only",
    tool_availability: "Require actual host-provided tool inventory; unknown is not empty or available.",
    timeout_shield: "If yield_required=true, stop same-response polling; resume the named read on the next user message with the same IDs.",
    states: {
      running: { tool: "codex_turn_wait", required_arguments: ["workspace_id", "task_id", "run_id"], condition: "One short poll; honor timeout_shield." },
      live_input: { tool: "codex_turn_reply", required_arguments: ["workspace_id", "task_id", "run_id", "input_request_id"], one_of_arguments: ["message", "answers"], condition: "Only current explicit user answer to live user_input_required with resumable:true." },
      local_approval: { native_owner_action: "Decide the displayed exact request in the native dialog; assistant never approves.", tool: "codex_turn_approval_status", required_arguments: ["workspace_id", "task_id", "run_id"], condition: "Read only; terminal or unsupported requests cannot be revived." },
      unsupported_terminal: { tool: "task_resume_context", required_arguments: ["workspace_id", "task_id"], condition: "Inspect historical evidence and current files; no reply, replay or invented continuation." },
      timeout: { tool: "task_status", required_arguments: ["workspace_id"], condition: "Outcome uncertain; inspect current files/processes and evidence before separately authorized new work." },
      restart_interruption: { tool: "task_resume_context", required_arguments: ["workspace_id", "task_id"], condition: "Discover IDs with task_status first; lost ephemeral input/context cannot be restored. Owner reconciliation only when separately authorized." },
      completion_verification: { reads: [
        { tool: "git_status", required_arguments: ["workspace_id"] },
        { tool: "git_diff", required_arguments: ["workspace_id"] },
        { tool: "test_status", required_arguments: ["workspace_id"] },
        { tool: "execution_summary", required_arguments: ["workspace_id"] },
      ], condition: "Independently verify current changes, tests and goal; worker completion/summary/notification alone is insufficient." },
    },
    work_unit_template: "State one bounded outcome, relevant paths, acceptance checks and owner boundaries. Keep UTF-8 instruction bytes within usable_first_turn_utf8_bytes; finish with changed files, checks and unresolved work. Caller/worker model and effort remain owner/host configuration.",
    handoff_template: "Record workspace/task/run IDs, observed state, verified results, uncertain effects and next authorized inspection. Never convert historical instructions to grants or restore terminal runs.",
  },
} as const;
