import { expect, it } from "vitest";
import fs from "node:fs";
import { EXECUTION_NOTE } from "../src/mcp/usage-contract.js";

it("requires yielding instead of repeated same-response polling", () => {
  expect(EXECUTION_NOTE).toContain("short-poll codex_turn_wait once");
  expect(EXECUTION_NOTE).toContain("timeout_shield.yield_required=true");
  expect(EXECUTION_NOTE).toContain("do not call another C2C wait/status tool in the same assistant response");
  expect(EXECUTION_NOTE).toContain("resume with timeout_shield.resume_tool");
  expect(EXECUTION_NOTE).toContain("cannot observe the ChatGPT host timer");
});

it("server marks running and owner-wait states with fail-safe shield metadata", () => {
  const source = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  for (const state of ["queued", "running", "inspecting", "awaiting_owner", "selecting_folder", "verifying"]) {
    expect(source).toContain(`"${state}"`);
  }
  expect(source).toContain("do_not_poll_again_in_same_response: true");
  expect(source).toContain("host_timeout_observable: false");
  expect(source).toContain("recommended_next_check_ms: TIMEOUT_SHIELD_NEXT_CHECK_MS");
});
