import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer, type McpContext } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

async function connect(authInfo?: AuthInfo) {
  const previousState = process.env.C2C_STATE_DIR;
  const state = isolateStateDir();
  const fixtureRoot = makeTmpDir("no-mention-workspace");
  const server = createMcpServer({
    workspace: new Workspace(fixtureRoot), logger: nullLogger,
    codex: {} as McpContext["codex"],
    desktopAgent: {} as McpContext["desktopAgent"],
    workspaceProfiles: {} as McpContext["workspaceProfiles"],
    completionNotifier: () => undefined,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = a.send.bind(a);
    a.send = (message, options) => send(message, { ...options, authInfo });
  }
  const client = new Client({ name: "phase01-contract-test", version: "1" });
  await server.connect(b);
  await client.connect(a);
  return { client, close: async () => {
    await client.close(); await server.close(); cleanup(fixtureRoot); cleanup(state);
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
      expect(tool?.description).toContain("Implement changes, fix bugs or run tests");
    } finally { await c.close(); }
  });

  it("preserves every existing tool name, schema and annotation", async () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/mcp-contract-next18.json"), "utf8"));
    const c = await connect();
    try {
      const targetTools = new Set(["workspace_info", "list_directory", "read_file", "search_workspace", "git_status", "git_diff", "test_status", "execution_summary", "network_fetch_image", "codex_turn_start", "codex_turn_wait"]);
      const seen = new Set<string>();
      const actual = Object.fromEntries((await c.client.listTools()).tools.map(({ title, description, ...contract }) => {
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
      expect(actual).toEqual(baseline.tools);
    } finally { await c.close(); }
  });

  it("does not turn natural-language routing into execution authorization", async () => {
    const c = await connect({ token: "reader", clientId: "reader", scopes: ["workspace.read"] });
    try {
      const r = await c.client.callTool({ name: "codex_turn_start", arguments: {
        task_id: "unauthorized", iteration: 1, instruction: "Fix the local bug",
      } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("INSUFFICIENT_SCOPE");
    } finally { await c.close(); }
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
