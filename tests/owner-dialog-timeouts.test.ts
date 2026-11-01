import fs from "node:fs";
import { expect, it } from "vitest";
import { OWNER_DIALOG_TIMEOUT_SECONDS, OWNER_DIALOG_TIMEOUT_MS, OWNER_DIALOG_HELPER_TIMEOUT_MS, OWNER_DIALOG_REQUEST_TIMEOUT_MS,
  RECONCILIATION_TIMEOUT_MS, REGISTRATION_TIMEOUT_MS, CODEX_TURN_TIMEOUT_MS } from "../src/security/owner-dialog-timeouts.js";

it("bounds owner dialogs at exactly 2700 seconds with sufficient enclosing deadlines", () => {
  expect(OWNER_DIALOG_TIMEOUT_SECONDS).toBe(2700);
  expect(OWNER_DIALOG_TIMEOUT_MS).toBe(2_700_000);
  expect(OWNER_DIALOG_HELPER_TIMEOUT_MS).toBe(2_705_000);
  expect(OWNER_DIALOG_REQUEST_TIMEOUT_MS).toBe(2_710_000);
  expect(RECONCILIATION_TIMEOUT_MS).toBe(3_000_000);
  expect(CODEX_TURN_TIMEOUT_MS).toBe(3_000_000);
  expect(REGISTRATION_TIMEOUT_MS).toBe(5_590_000);
  expect(REGISTRATION_TIMEOUT_MS).toBeGreaterThan(2 * OWNER_DIALOG_HELPER_TIMEOUT_MS + 2 * (15_000 + 15_000));
});

it("uses the shared helper deadline and describes a 45-minute local owner response", () => {
  const local = fs.readFileSync(new URL("../src/codex/local-approval.ts", import.meta.url), "utf8");
  expect(local).toContain("この承認ダイアログは45分で自動的に拒否");
  expect(local).toContain("[presentation.message], OWNER_DIALOG_HELPER_TIMEOUT_MS, signal");
  const recovery = fs.readFileSync(new URL("../src/execution/reconciliation-approval.ts", import.meta.url), "utf8");
  expect(recovery).toContain("executeFolderScript(WORKSPACE_RECOVERY_APPROVAL_SCRIPT, [message], OWNER_DIALOG_HELPER_TIMEOUT_MS, signal)");
});
