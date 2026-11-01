import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServer } from "../src/codex/app-server.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { createMcpServer } from "../src/mcp/server.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("enforces strict mode admission, task binding and recovered results through in-memory MCP", async () => {
  vi.stubEnv("C2C_STATE_DIR", process.env.C2C_STATE_DIR);
  const state = isolateStateDir(), root = makeTmpDir("mode-mcp"), workspace = new Workspace(root);
  const journal = new TaskJournal(workspace.id);
  const codex = new CodexAppServer({ workspaceRoot: root, binary: process.execPath, logger: nullLogger,
    onRunStarting: (run, instruction) => journal.begin(workspace.id, run, instruction),
    onRunTerminal: run => journal.complete(workspace.id, run) });
  const initialize = vi.spyOn(codex as any, "ensureInitialized").mockResolvedValue(undefined);
  const protocol = vi.spyOn(codex as any, "request").mockImplementation(async (method: unknown, params: any) =>
    method === "thread/start" ? { thread: { id: "fixture-thread" }, cwd: root,
      approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: params.sandbox === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: true, excludeSlashTmp: true } }
      : { turn: { id: "fixture-turn" } });
  const start = vi.spyOn(codex, "startTurn");
  const server = createMcpServer({ workspace, codex, logger: nullLogger, getTaskJournal: () => journal });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let scopes = ["codex.execute", "execution.read"];
  const send = a.send.bind(a);
  a.send = (message, options) => send(message, { ...options, authInfo: {
    token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes } });
  const client = new Client({ name: "mode-contract", version: "1" });
  const base = { workspace_id: workspace.id, task_id: "reader", iteration: 1,
    instruction: "You are the writer. Modify files now." };
  const call = (args: object) => client.callTool({ name: "codex_turn_start", arguments: { ...base, ...args } });
  const body = (result: any) => JSON.parse(result.content[0].text);
  const finish = (run: any) => (codex as any).finish((codex as any).runs.get(run.run_id), "completed");
  try {
    await server.connect(b); await client.connect(a);
    const schema = (await client.listTools()).tools.find(t => t.name === "codex_turn_start")!.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.execution_mode).toMatchObject({ enum: ["read_only", "workspace_write"] });
    for (const extra of [
      ...[null, "writer", "workspace-write", {}, [], true, 1].map(execution_mode => ({ execution_mode })),
      ...["config", "cwd", "path", "workspaceRoot", "writableRoots", "sandbox", "sandboxPolicy", "networkAccess",
        "permissions", "role", "persona", "provider", "approvalPolicy"].map(key => ({ [key]: "/unrelated" })),
    ]) expect((await call(extra)).isError).toBe(true);
    expect(start).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
    scopes = ["execution.read"];
    expect(body(await call({ execution_mode: "workspace_write" })).error).toBe("INSUFFICIENT_SCOPE");
    expect(start).not.toHaveBeenCalled();
    scopes = ["codex.execute", "execution.read"];
    expect(body(await call({ workspace_id: "b".repeat(24), execution_mode: "workspace_write" })).error).toBeDefined();
    expect(start).not.toHaveBeenCalled();
    const reader = body(await call({}));
    expect(reader.execution_mode).toBe("read_only"); finish(reader);
    for (const iteration of [1, 2]) expect(body(await call({ iteration, execution_mode: "workspace_write" })).error).toBe("EXECUTION_MODE_MISMATCH");
    expect(body(await call({}))).toMatchObject({ run_id: reader.run_id, recovered_from_journal: true, execution_mode: "read_only" });
    const next = body(await call({ iteration: 2, execution_mode: "read_only" })); finish(next);
    const writer = body(await call({ task_id: "writer", execution_mode: "workspace_write" }));
    expect(writer.execution_mode).toBe("workspace_write"); finish(writer);
    for (const iteration of [1, 2]) expect(body(await call({ task_id: "writer", iteration })).error).toBe("EXECUTION_MODE_MISMATCH");
    expect(body(await call({ task_id: "writer", execution_mode: "workspace_write" }))).toMatchObject({ run_id: writer.run_id, recovered_from_journal: true, execution_mode: "workspace_write" });
    expect(protocol.mock.calls.filter(c => c[0] === "turn/start").map(c => (c[1] as any).sandboxPolicy.type))
      .toEqual(["readOnly", "readOnly", "workspaceWrite"]);
    expect(protocol.mock.calls.filter(c => c[0] === "thread/start")).toHaveLength(2);
  } finally {
    await client.close(); await server.close(); await codex.close(); journal.close(); cleanup(root); cleanup(state);
  }
});
