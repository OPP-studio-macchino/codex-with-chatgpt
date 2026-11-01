import { expect, it } from "vitest";
import { executionSandbox } from "../src/codex/execution-mode.js";

it.each([undefined, null, "writer", "workspace-write", "", false, true, 0, 1, [], {},
  { execution_mode: "workspace_write" }, new String("workspace_write")])("rejects malformed direct sandbox helper input: %j", mode => {
  expect(() => executionSandbox(mode as any)).toThrow();
});

it("returns only bounded reader and explicit writer policies", () => {
  expect(executionSandbox("read_only")).toEqual({ type: "readOnly", networkAccess: false });
  expect(executionSandbox("workspace_write")).toEqual({ type: "workspaceWrite", writableRoots: [],
    networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  // A caller cannot mutate a shared policy and expand later requests.
  (executionSandbox("workspace_write").writableRoots as string[]).push("/unrelated");
  expect(executionSandbox("workspace_write").writableRoots).toEqual([]);
});
