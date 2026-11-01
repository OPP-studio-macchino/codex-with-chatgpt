import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer, type McpContext } from "../src/mcp/server.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

async function connect(authInfo?: AuthInfo, overrides: Partial<McpContext> = {}) {
  const previousState = process.env.C2C_STATE_DIR;
  const state = isolateStateDir();
  const fixtureRoot = makeTmpDir("no-mention-workspace");
  const workspace = new Workspace(fixtureRoot);
  const codex = new CodexAppServer({ workspaceRoot: fixtureRoot, binary: process.execPath, logger: nullLogger });
  const taskWorkspaces = new Map<string, string>();
  const server = createMcpServer({
    workspace, codex, taskWorkspaces, logger: nullLogger,
    desktopAgent: {} as McpContext["desktopAgent"],
    workspaceProfiles: {} as McpContext["workspaceProfiles"],
    completionNotifier: () => undefined,
    ...overrides,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = a.send.bind(a);
    a.send = (message, options) => send(message, { ...options, authInfo });
  }
  const client = new Client({ name: "phase01-contract-test", version: "1" });
  await server.connect(b);
  await client.connect(a);
  return { client, codex, workspace, fixtureRoot, taskWorkspaces, close: async () => {
    await client.close(); await server.close(); await codex.close(); cleanup(fixtureRoot); cleanup(state);
    if (previousState === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousState;
  } };
}

describe("ordinary-request MCP contract (not host-routing E2E)", () => {
  it("advertises outcome-based use without requiring a product mention", async () => {
    const c = await connect();
    try {
      const instructions = c.client.getInstructions() ?? "";
      expect(instructions).toContain("implement, fix, or test a local repository");
      expect(instructions).toContain("Never ask the user to add @c2c");
      expect(instructions).toContain("Respect explicit requests for another tool");
      expect(instructions).toContain("mail/calendar");
      expect(instructions).toContain("host has not provided");
      expect(instructions).toContain("metadata does not solve concurrent selection races");
      const tool = (await c.client.listTools()).tools.find(t => t.name === "codex_turn_start");
      expect(tool?.description?.split(". ").slice(0, 3)).toEqual([
        "Inspect, implement or test the selected local repository using one bounded official Codex App Server turn",
        "Omitted execution_mode is read_only; mutations require explicit workspace_write on every start",
        "The mode cannot change within a task and grants no authority beyond existing scopes and the approved workspace",
      ]);
    } finally { await c.close(); }
  });

  it("preserves the frozen next18 contracts with only the exact reviewed additions, A01 mode and iteration range", async () => {
    const frozen = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/mcp-contract-next18.json"), "utf8");
    expect(createHash("sha256").update(frozen).digest("hex")).toBe("fc9b18199633a73054345158e2998b807939205f99b2d1750f1f7851728c26db");
    const baseline = JSON.parse(frozen);
    expect(Object.keys(baseline.tools)).toHaveLength(46);
    const workspaceId = { type: "string", pattern: "^[a-f0-9]{24}$" };
    const runProperties = {
      workspace_id: workspaceId,
      task_id: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
      run_id: { type: "string", pattern: "^[a-f0-9]{32}$" },
    };
    const objectSchema = { type: "object", additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" };
    const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const replyAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    // Literal reviewed deltas, never generated from the live tool list. The four
    // formerly presence-only exclusions now have complete schema/annotation pins.
    const additions = {
      codex_run_observation: {
        inputSchema: { ...objectSchema, properties: runProperties, required: ["workspace_id", "task_id", "run_id"] },
        annotations: readAnnotations,
      },
      codex_mcp_elicitation_reply: {
        inputSchema: { ...objectSchema, properties: {
          ...runProperties, elicitation_request_id: { type: "string", pattern: "^[a-f0-9]{32}$" },
          action: { type: "string", enum: ["accept", "decline", "cancel"] }, content: {},
        }, required: ["workspace_id", "task_id", "run_id", "elicitation_request_id", "action"] },
        annotations: replyAnnotations,
      },
      codex_turn_reply: {
        inputSchema: { ...objectSchema, properties: {
          ...runProperties, input_request_id: { type: "string", pattern: "^[a-f0-9]{32}$" },
          message: { type: "string", minLength: 1, maxLength: 2048 },
          answers: { description: "Object mapping question IDs to nonempty arrays of strings; at most 4 questions, 8 answers each, 8192 bytes total." },
        }, required: ["task_id", "run_id", "input_request_id"] },
        annotations: replyAnnotations,
      },
      codex_runtime_status: {
        inputSchema: { ...objectSchema, properties: { workspace_id: workspaceId } },
        annotations: readAnnotations,
      },
      codex_execution_preflight: {
        inputSchema: { ...objectSchema, properties: { workspace_id: workspaceId } },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      codex_turn_approval_status: {
        inputSchema: { ...objectSchema, properties: runProperties, required: ["task_id", "run_id"] },
        annotations: readAnnotations,
      },
    };
    const c = await connect();
    try {
      const targetTools = new Set(["workspace_info", "list_directory", "read_file", "search_workspace", "git_status", "git_diff", "test_status", "execution_summary", "network_fetch_image", "codex_turn_start", "codex_turn_wait"]);
      const seen = new Set<string>();
      const contracts = (await c.client.listTools()).tools.map(({ title, description, ...contract }) => contract);
      expect(new Set(contracts.map(tool => tool.name)).size).toBe(contracts.length);
      for (const [name, expected] of Object.entries(additions)) {
        expect(baseline.tools).not.toHaveProperty(name);
        // The MCP SDK adds a fixed execution declaration and an explicit undefined _meta
        // slot to registered tools. Pin both fields rather than dropping metadata.
        expect(contracts.find(tool => tool.name === name)).toStrictEqual({
          name, ...expected, execution: { taskSupport: "forbidden" }, _meta: undefined,
        });
      }
      const actual = Object.fromEntries(contracts.map(contract => {
        if (contract.name === "workspace_profiles") {
          // The reviewed >100-profile pagination extension changes this one
          // contract. Pin its entire new schema/annotations and retain the
          // previously frozen hashes for every other original tool.
          expect(contract.inputSchema).toEqual({
            type: "object",
            properties: {
              after_profile_id: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" },
              limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
            },
            additionalProperties: false,
            $schema: "http://json-schema.org/draft-07/schema#",
          });
          expect(contract.annotations).toEqual({
            readOnlyHint: true, destructiveHint: false, openWorldHint: false,
          });
          expect(contract.execution).toEqual({ taskSupport: "forbidden" });
          expect(contract._meta).toBeUndefined();
          return [contract.name, baseline.tools[contract.name]];
        }
        if (contract.name === "codex_turn_start") {
          // Pin the authorized ordinal-range change, then compare the unchanged
          // remainder with the original frozen contract (which stays untouched).
          expect(contract.inputSchema.properties?.iteration).toEqual({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
          contract.inputSchema.properties!.iteration = { type: "integer", minimum: 1, maximum: 12 };
          // A01 is exactly one optional enum; compare every remaining field to next18.
          expect(contract.inputSchema.properties?.execution_mode).toEqual({ type: "string", enum: ["read_only", "workspace_write"] });
          expect(contract.inputSchema.required).toEqual(["task_id", "iteration", "instruction"]);
          expect(contract.inputSchema.additionalProperties).toBe(false);
          delete contract.inputSchema.properties!.execution_mode;
        }
        if (targetTools.has(contract.name)) {
          seen.add(contract.name);
          expect(contract.inputSchema.properties?.workspace_id).toEqual({ type: "string", pattern: "^[a-f0-9]{24}$" });
          expect(contract.inputSchema.required ?? []).not.toContain("workspace_id");
          delete contract.inputSchema.properties!.workspace_id;
          if (["workspace_info", "git_status", "test_status"].includes(contract.name)) {
            // The SDK adds additionalProperties:false when the first
            // optional property is added to an empty input schema.
            expect(contract.inputSchema.additionalProperties).toBe(false);
            expect(contract.inputSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
            delete contract.inputSchema.additionalProperties;
          }
        }
        return [contract.name, createHash("sha256").update(JSON.stringify(contract)).digest("hex")];
      }));
      expect(seen).toEqual(targetTools);
      // Remove only additions already checked in full above. Unknown additions,
      // missing baseline tools and all other contract drift fail equality.
      for (const name of Object.keys(additions)) delete actual[name];
      expect(actual).toEqual(baseline.tools);
    } finally { await c.close(); }
  });

  it("does not turn natural-language routing into execution authorization", async () => {
    const c = await connect({ token: "reader", clientId: "reader", scopes: ["workspace.read", "execution.read"] });
    const start = vi.spyOn(c.codex, "startTurn");
    try {
      for (const mode of [{}, { execution_mode: "read_only" }, { execution_mode: "workspace_write" }]) {
        const r = await c.client.callTool({ name: "codex_turn_start", arguments: {
          task_id: "unauthorized", iteration: 1, instruction: "Fix the local bug", ...mode,
        } });
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).toContain("INSUFFICIENT_SCOPE");
      }
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); await c.close(); }
  });

  it.each([
    { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "execution.read"], error: null },
    { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read"], error: "INSUFFICIENT_SCOPE" },
    { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["execution.read"], error: "INSUFFICIENT_SCOPE" },
    { token: "oauth", clientId: "oauth", scopes: ["workspace.read", "execution.read"], error: "TRUSTED_TUNNEL_REQUIRED" },
    { token: "trusted-tunnel", clientId: "oauth", scopes: ["workspace.read", "execution.read"], error: "TRUSTED_TUNNEL_REQUIRED" },
    { token: "oauth", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "execution.read"], error: "TRUSTED_TUNNEL_REQUIRED" },
    { error: "TRUSTED_TUNNEL_REQUIRED" },
  ])("requires dual read scope and both trusted-tunnel identity fields for observation: %j", async ({ error, ...auth }) => {
    const c = await connect("token" in auth ? auth as AuthInfo : undefined, { workspaceProfiles: undefined });
    const observe = vi.spyOn(c.codex, "observeRun");
    const args = { workspace_id: c.workspace.id, task_id: "observation-contract", run_id: "a".repeat(32) };
    c.taskWorkspaces.set(args.task_id, c.workspace.id);
    try {
      const result = await c.client.callTool({ name: "codex_run_observation", arguments: args });
      if (error) {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(error);
        expect(observe).not.toHaveBeenCalled();
      } else {
        expect(result.isError).not.toBe(true);
        expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
          version: 1, ...args, source: "current_runtime", goal_verified: false, state: "unknown",
        });
        expect(observe).toHaveBeenCalledExactlyOnceWith(args.task_id, args.run_id);
      }
    } finally { observe.mockRestore(); await c.close(); }
  });

  it("rejects missing/malformed observation identities and extra authority fields before reading a run", async () => {
    const c = await connect({ token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["workspace.read", "execution.read"] }, { workspaceProfiles: undefined });
    const observe = vi.spyOn(c.codex, "observeRun");
    const args = { workspace_id: c.workspace.id, task_id: "strict-observation", run_id: "a".repeat(32) };
    c.taskWorkspaces.set(args.task_id, c.workspace.id);
    try {
      for (const extra of [
        ...Object.keys(args).flatMap(key => [undefined, null, 1, "/"].map(value => ({ [key]: value }))),
        { execution_mode: "workspace_write" }, { approval: true }, { path: "/private" },
      ]) {
        expect((await c.client.callTool({ name: "codex_run_observation", arguments: { ...args, ...extra } })).isError).toBe(true);
      }
      expect(observe).not.toHaveBeenCalled();
    } finally { observe.mockRestore(); await c.close(); }
  });

  it("prevents OAuth execution.read from disclosing progress via legacy approval status", async () => {
    // ADR 0003: only the trusted-tunnel observation tool can disclose progress.
    // Existing OAuth execution.read still permits legacy status without telemetry.
    const auth = { token: "oauth", clientId: "oauth-reader", scopes: ["execution.read"] };
    const c = await connect(auth, { workspaceProfiles: undefined });
    const internal = c.codex as any;
    const initialize = vi.spyOn(internal, "ensureInitialized").mockImplementation(async () => { internal.activeEpoch = 7; });
    const request = vi.spyOn(internal, "request").mockImplementation(async (method: unknown) => method === "thread/start"
      ? { cwd: c.fixtureRoot, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, thread: { id: "privacy-thread" } }
      : { turn: { id: "privacy-turn" } });
    try {
      // Local deterministic fixture only; no provider, socket or live bridge.
      const run = await c.codex.startTurn("privacy-contract", 1, "Inspect this fixture");
      expect(run.execution_mode).toBe("read_only");
      for (const completed of [false, true]) internal.onStdout(Buffer.from(JSON.stringify({
        method: completed ? "item/completed" : "item/started",
        params: { threadId: "privacy-thread", turnId: "privacy-turn", item: {
          type: "commandExecution", id: "private-item", status: completed ? "completed" : "inProgress", exitCode: completed ? 0 : null,
        } },
      }) + "\n"), 7);
      const args = { task_id: run.task_id, run_id: run.run_id };
      const progress = c.codex.observeRun(run.task_id, run.run_id).progress;
      expect(progress).toEqual({ cursor: expect.stringMatching(/^[a-f0-9]{36}$/), phase: "command_completed" });
      expect(c.codex.approvalStatus(run.task_id, run.run_id)).not.toHaveProperty("progress");
      const protocolCalls = request.mock.calls.length;
      const result = await c.client.callTool({ name: "codex_turn_approval_status", arguments: args });
      expect(result.isError).not.toBe(true);
      const status = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(status).toMatchObject({ ...args, workspace_id: c.workspace.id });
      expect(status).not.toHaveProperty("progress");
      expect(JSON.stringify(status)).not.toContain(progress!.cursor);
      expect(request).toHaveBeenCalledTimes(protocolCalls);
      auth.scopes = [];
      const denied = await c.client.callTool({ name: "codex_turn_approval_status", arguments: args });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain("INSUFFICIENT_SCOPE");
    } finally { await c.close(); initialize.mockRestore(); request.mockRestore(); }
  });

  it("keeps unexecuted fresh-chat evaluations explicitly NOT_RUN", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/no-mention-prompts.json"), "utf8"));
    expect(fixture.kind).toBe("host-routing-evaluation-spec-not-a-router");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of fixture.cases) {
      expect(c.actualStatus).toBe("NOT_RUN");
      if (c.category === "indirect") expect(c.prompt).not.toMatch(/@|c2c|codex/i);
    }
    for (const kind of ["direct", "indirect", "negative", "ambiguous", "explicit-alternative", "host-unavailable"]) {
      expect(fixture.cases.some((c: {category: string}) => c.category === kind)).toBe(true);
    }
  });
});
