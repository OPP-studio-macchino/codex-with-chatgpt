import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { TaskJournal, TaskJournalError } from "../src/execution/task-journal.js";
import type { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { getStateDir } from "../src/config/paths.js";

afterEach(() => vi.restoreAllMocks());
it("reads bounded same-workspace legacy diagnostics without writes, execution or invented runs", async () => {
  const id = "a".repeat(24), other = "b".repeat(24);
  const file = path.join(getStateDir(), "executions", `${id}.jsonl`);
  const data = Buffer.from([1, 2, 3].map(iteration => JSON.stringify({ taskId: "saved", iteration,
    exitStatus: "ok", timestamp: "2026-09-30T00:00:00Z", notes: "private historical instructions",
    tests: "PASS", runId: String(iteration).repeat(32) })).join("\n"));
  const exists = vi.spyOn(fs, "existsSync").mockImplementation(p => p === file);
  const open = vi.spyOn(fs, "openSync").mockReturnValue(999);
  vi.spyOn(fs, "fstatSync").mockReturnValue({ isFile: () => true, size: data.length } as fs.Stats);
  vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer) => { data.copy(buffer as Buffer); return data.length; });
  vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  const writes = ["mkdirSync", "chmodSync", "writeFileSync", "renameSync", "rmSync"].map(name =>
    vi.spyOn(fs, name as "mkdirSync").mockImplementation(() => { throw new Error("No writes allowed"); }));
  let code = "TASK_NOT_FOUND";
  const status = vi.fn((): object => { throw new TaskJournalError(code, code); });
  const getCodex = vi.fn(() => { throw new Error("No executor allowed"); });
  const server = createMcpServer({ workspace: { id } as Workspace, logger: nullLogger, getCodex,
    resolveWorkspace: workspaceId => ({ workspace: { id: workspaceId ?? id } as Workspace, codexNetworkHosts: [] }),
    getTaskJournal: () => ({ status, checkpointStatus: () => [] } as unknown as TaskJournal) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const send = a.send.bind(a);
  let scopes = ["execution.read"];
  a.send = (message, options) => send(message, { ...options, authInfo: { token: "reader", clientId: "reader", scopes } });
  const client = new Client({ name: "legacy-diagnostics", version: "1" });
  await server.connect(b); await client.connect(a);
  try {
    for (const name of ["task_status", "task_resume_context"]) {
      const call = (task_id = "saved", workspace_id = id) => client.callTool({ name, arguments: { task_id, workspace_id } });
      const result = await call();
      expect(result.isError).not.toBe(true);
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(body.tasks[0]).toMatchObject({ source: "legacy_execution_records", execution_state: "legacy_history_only",
        recovery_status: "recovery_required", outcome_known: false, can_resume_original_context: false,
        tests: null, goal_status: "unverified", history_complete: false });
      expect(body.tasks[0].known_records.map((r: { iteration: number }) => r.iteration)).toEqual([1, 2, 3]);
      expect(body.tasks[0].known_records[0]).toMatchObject({ run_id: "1".repeat(32), process_exit_status: "ok" });
      expect(JSON.stringify(body)).not.toMatch(/private historical|PASS/);
      if (name === "task_resume_context") expect(body).toMatchObject({ auto_replay: false, grants_authority: false });
      expect((await call("absent")).isError).toBe(true);
      expect((await call("saved", other)).isError).toBe(true);
      for (const refusal of ["TASK_JOURNAL_INVALID", "TASK_JOURNAL_UNAVAILABLE", "TASK_WORKSPACE_MISMATCH", "TASK_RECOVERY_REQUIRED"]) {
        code = refusal; exists.mockClear();
        expect(JSON.stringify((await call()).content)).toContain(refusal);
        expect(exists).not.toHaveBeenCalled();
      }
      code = "TASK_NOT_FOUND";
      status.mockReturnValueOnce({ tasks: [{ source: "authoritative" }] }); exists.mockClear();
      expect(JSON.stringify((await call()).content)).toContain("authoritative");
      expect(exists).not.toHaveBeenCalled();
      scopes = []; expect(JSON.stringify((await call()).content)).toContain("INSUFFICIENT_SCOPE"); scopes = ["execution.read"];
    }
    expect(getCodex).not.toHaveBeenCalled();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } finally { await client.close(); await server.close(); }
});
