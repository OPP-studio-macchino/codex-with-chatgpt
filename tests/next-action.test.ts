import { expect, it } from "vitest";
import { selectNextAction, projectNextAction, type NextActionContext } from "../src/codex/next-action.js";

const ws = "a".repeat(24), run = "b".repeat(32), nonce = "c".repeat(32);
const tools = new Set(["codex_turn_wait", "codex_turn_reply", "codex_turn_approval_status", "task_status", "task_resume_context", "git_status", "git_diff", "test_status", "execution_summary"]);
const context: NextActionContext = { workspace_id: ws, task_id: "task", run_id: run, source: "current_runtime", registered_tools: tools };
const base = { workspace_id: ws, task_id: "task", run_id: run };
const question = { ...base, state: "blocked", reason: "user_input_required", resumable: true, input_request_id: nonce, questions: [{ id: "choice", question: "Choose" }] };

it("preserves same-run identity and exact authoritative Timeout Shield", () => {
  const shield = { version: 1, yield_required: true, do_not_poll_again_in_same_response: true, resume_tool: "codex_turn_wait", recommended_next_check_ms: 5000, host_timeout_observable: false };
  const result = selectNextAction({ ...base, state: "running", timeout_shield: shield }, context);
  expect(result).toMatchObject({ contract_version: 1, kind: "wait_same_run", tool: "codex_turn_wait", arguments: base,
    yield_required: true, do_not_poll_again_in_same_response: true, timeout_shield: shield, automatic_host_reentry: false });
  expect(result.timeout_shield).not.toBe(shield);
});

it("only advertises a live complete question channel, with answer fields missing", () => {
  const live = selectNextAction(question, context);
  expect(live).toMatchObject({ kind: "present_live_question", tool: "codex_turn_reply", arguments: { ...base, input_request_id: nonce },
    required_missing_user_fields: ["message", "answers"], ready_to_execute: false, advisory_only: true, grants_authority: false });
  expect(live.arguments).not.toHaveProperty("message"); expect(live.arguments).not.toHaveProperty("answers");
  expect(selectNextAction(question, { ...context, source: "journal" }).tool).not.toBe("codex_turn_reply");
});

it.each([
  { resumable: false }, { input_request_id: undefined }, { input_request_id: "stale" },
  { questions: [] }, { questions: [null] }, { recovered_from_journal: true }, { from_previous_runtime: true },
])("never invents a live question from incomplete or historical data: %j", extra => {
  expect(selectNextAction({ ...question, ...extra }, context).kind).toBe("inspect_evidence");
});

it.each(["workspace_command", "managed_network"])("native %s approval only reads exact status and never fills a decision or synthesizes a request", approval_type => {
  const result = selectNextAction({ ...base, state: "blocked", reason: "approval_required", resumable: true,
    waiting_for_local_approval: true, approval_type }, context);
  expect(result).toMatchObject({ kind: "native_owner_decision", tool: "codex_turn_approval_status", arguments: base, ready_to_execute: false });
  expect(result.arguments).not.toHaveProperty("decision"); expect(result.arguments).not.toHaveProperty("message");
});

it("reports native startup without asking for a decision or claiming receipt", () => {
  const result = selectNextAction({ ...base, state: "blocked", reason: "approval_required", resumable: true,
    waiting_for_local_approval: true, approval_type: "managed_network",
    approval_diagnostic: { native_delivery: { phase: "compile", readiness: "unobserved", user_receipt: "unknown" } } }, context);
  expect(result).toMatchObject({ tool: "codex_turn_approval_status", ready_to_execute: false,
    native_owner_action: "Wait for helper readiness; no owner decision is requested yet." });
});

it.each([
  { state: "blocked", reason: "approval_required", resumable: false, approval_type: "unsupported" },
  { state: "blocked", reason: "mcp_elicitation_required" },
  { state: "failed", reason: "turn_timeout" },
  { execution_state: "interrupted", outcome_known: false, from_previous_runtime: true },
  { state: "lost_context" },
])("terminal/unknown state is inspection, never revival: %j", state => {
  const result = selectNextAction({ ...base, ...state }, context);
  expect(result.kind).toBe("inspect_evidence");
  expect(["codex_turn_start", "codex_turn_reply", "completion_notify"]).not.toContain(result.tool);
  expect(result.verification.goal).toBe("unverified");
});

it("known timeout/completion outcomes never imply tests, effects or goal completion", () => {
  const failed = selectNextAction({ ...base, state: "failed", reason: "turn_timeout" }, context);
  expect(failed.verification).toMatchObject({ execution_outcome_known: true, code_effects: "unverified", goal: "unverified" });
  const completed = selectNextAction({ ...base, state: "completed", outcome_known: true, tests: null }, context);
  expect(completed).toMatchObject({ kind: "verify_completion", verification: { execution_outcome_known: true, tests: "unknown_until_explicit_record_review", goal: "unverified" } });
  expect((completed as any).verification_reads.map((read: any) => read.tool)).toEqual(["git_status", "git_diff", "test_status", "execution_summary"]);
  expect(completed.tool).not.toBe("completion_notify");
});

it.each([
  { workspace_id: "d".repeat(24) }, { task_id: "another" }, { run_id: "e".repeat(32) }, { run_id: undefined },
])("mismatched or missing IDs are not fabricated: %j", extra => {
  const result = selectNextAction({ ...question, ...extra }, context);
  expect(result.kind).toBe("inspect_evidence");
  expect(result.arguments).not.toHaveProperty("run_id");
  expect(result.arguments).not.toHaveProperty("input_request_id");
});

it("unregistered tools are not advertised, host tool availability remains unknown", () => {
  const result = selectNextAction(question, { ...context, registered_tools: new Set() });
  expect(result).toMatchObject({ kind: "inspect_evidence", tool: null, arguments: {}, host_tool_availability: "unknown", server_registration_only: true });
  expect(selectNextAction({ ...base, state: "completed" }, { ...context, registered_tools: new Set(["git_status"]) })).toMatchObject({ kind: "verify_completion", unavailable_verification_tools: ["git_diff", "test_status", "execution_summary"] });
});

it("projects each journal row independently and preserves legacy fields without mutation", () => {
  const value = { workspace_id: ws, tasks: [
    { ...base, execution_state: "running", from_previous_runtime: false, next_action: "WAIT_FOR_RUN" },
    { ...base, task_id: "second", run_id: "e".repeat(32), execution_state: "completed", outcome_known: true, next_action: "INSPECT_RESULT" },
  ] };
  const before = JSON.stringify(value);
  const result = projectNextAction(value, { ...context, task_id: undefined, run_id: undefined, source: "journal" });
  const rows = result.tasks as any[];
  expect(rows[0]).toMatchObject({ next_action: "WAIT_FOR_RUN", next_action_guidance: { evidence_source: "journal_current_runtime", binding: base, kind: "inspect_evidence" } });
  expect(rows[1].next_action_guidance.binding).toEqual({ workspace_id: ws, task_id: "second", run_id: "e".repeat(32) });
  expect(rows[1].next_action_guidance.kind).toBe("verify_completion");
  expect(JSON.stringify(value)).toBe(before);
});

it("stale pending input that does not match a verified same-runtime task row is inspection only", () => {
  const value = { workspace_id: ws, tasks: [{ ...base, execution_state: "running", from_previous_runtime: false }],
    live_pending_input: { ...question, run_id: "e".repeat(32) } };
  const result = projectNextAction(value, { ...context, run_id: undefined, source: "journal" });
  expect(result.next_action).toMatchObject({ kind: "inspect_evidence" });
  expect((result.live_pending_input as any).next_action.tool).not.toBe("codex_turn_reply");
});
