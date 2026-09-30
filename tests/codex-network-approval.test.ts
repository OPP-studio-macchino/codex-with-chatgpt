import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer } from "../src/codex/app-server.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const externalDirs: string[] = [];
const workspaceDirs: string[] = [];

afterEach(() => {
  for (const dir of externalDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of workspaceDirs.splice(0)) cleanup(dir);
});

function makeWorkspace(): string {
  const dir = makeTmpDir("codex-network-approval");
  workspaceDirs.push(dir);
  return dir;
}

function makeFakeBinary(): { binary: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-network-fake-"));
  externalDirs.push(dir);
  const binary = path.join(dir, "codex-fake.mjs");
  const log = path.join(dir, "requests.jsonl");
  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = path.join(here, "requests.jsonl");
let buffer = "";
let threadCounter = 0;
let turnCounter = 0;
let approvalCounter = 0;
const pending = new Map();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const record = (value) => fs.appendFileSync(log, JSON.stringify(value) + "\\n");
const finish = (threadId, turnId, text = "network-approved") => {
  const item = { type: "agentMessage", id: "msg-" + turnId, text };
  send({ method: "item/completed", params: { threadId, turnId, item } });
  send({ method: "turn/completed", params: {
    threadId,
    turn: { id: turnId, status: "completed", items: [item], error: null },
  } });
};
const networkRequest = (threadId, turnId, mode, sequence = 1) => {
  const id = "network-" + (++approvalCounter);
  const params = {
    threadId,
    turnId,
    itemId: "cmd-" + approvalCounter,
    networkApprovalContext: {
      host: mode === "NETWORK_WRONG_HOST" ? "evil.example" : "ttc.taxi-inf.jp",
      protocol: mode === "NETWORK_HTTP" ? "http" : "https",
    },
    availableDecisions: ["accept", "decline"],
  };
  if (mode === "NETWORK_FILE_PERMISSION") {
    params.additionalPermissions = {
      network: { enabled: true },
      fileSystem: { write: ["/tmp/not-allowed"] },
    };
  }
  if (mode === "NETWORK_MIXED_COMMAND") {
    params.command = "curl https://ttc.taxi-inf.jp/Real109.jpg";
    params.cwd = "/tmp";
    params.commandActions = [];
  }
  pending.set(id, { threadId, turnId, mode, sequence });
  send({ id, method: "item/commandExecution/requestApproval", params });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    record(message);

    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake" } });
      continue;
    }
    if (message.method === "initialized") continue;
    if (message.method === "thread/start") {
      send({ id: message.id, result: { thread: { id: "thread-" + (++threadCounter) } } });
      continue;
    }
    if (message.method === "turn/start") {
      const turnId = "turn-" + (++turnCounter);
      const threadId = message.params.threadId;
      const fullText = message.params.input?.[0]?.text ?? "";
      const mode = fullText.trim().split(/\\s+/).at(-1) ?? "";
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      networkRequest(threadId, turnId, mode, 1);
      continue;
    }
    const waiting = pending.get(String(message.id));
    if (waiting && message.result?.decision === "accept") {
      pending.delete(String(message.id));
      if (waiting.mode === "NETWORK_LIMIT" && waiting.sequence < 4) {
        networkRequest(waiting.threadId, waiting.turnId, waiting.mode, waiting.sequence + 1);
      } else {
        finish(waiting.threadId, waiting.turnId);
      }
    }
  }
});
`;
  fs.writeFileSync(binary, source, { mode: 0o700 });
  return { binary, log };
}

function readLog(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(
    (line) => JSON.parse(line) as Record<string, unknown>
  );
}

async function run(mode: string, allowedNetworkHosts: readonly string[] = ["ttc.taxi-inf.jp"]) {
  const workspace = makeWorkspace();
  const fake = makeFakeBinary();
  const client = new CodexAppServer({
    workspaceRoot: workspace,
    binary: fake.binary,
    logger: nullLogger,
    allowedNetworkHosts,
  });
  try {
    const started = await client.startTurn("network-task", 1, mode);
    const result = await client.wait("network-task", started.run_id);
    return { result, log: readLog(fake.log) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe("Codex exact-host network approval boundary", () => {
  it("accepts one HTTPS network-only request for an owner-allowlisted host", async () => {
    const { result, log } = await run("NETWORK_ALLOWED", ["TTC.TAXI-INF.JP"]);
    expect(result).toMatchObject({ state: "completed", summary: "network-approved" });
    expect(log).toContainEqual(expect.objectContaining({
      id: "network-1",
      result: { decision: "accept" },
    }));
  });

  it("keeps the default fail-closed behavior without an owner allowlist", async () => {
    const { result, log } = await run("NETWORK_ALLOWED", []);
    expect(result).toMatchObject({ state: "blocked", reason: "approval_required" });
    expect(log.some((message) => (
      message.id === "network-1" &&
      JSON.stringify(message).includes('"decision":"accept"')
    ))).toBe(false);
  });

  it.each([
    "NETWORK_WRONG_HOST",
    "NETWORK_HTTP",
    "NETWORK_FILE_PERMISSION",
  ])("blocks out-of-scope network approval: %s", async (mode) => {
    const { result } = await run(mode);
    expect(result).toMatchObject({ state: "blocked", reason: "approval_required" });
  });

  it("allows command/cwd presentation metadata without broadening the network grant", async () => {
    const { result, log } = await run("NETWORK_MIXED_COMMAND");
    expect(result).toMatchObject({ state: "completed", summary: "network-approved" });
    expect(log).toContainEqual(expect.objectContaining({
      id: "network-1",
      result: { decision: "accept" },
    }));
  });

  it("caps automatic network approvals at three per turn", async () => {
    const { result, log } = await run("NETWORK_LIMIT");
    expect(result).toMatchObject({ state: "blocked", reason: "approval_required" });
    const approvals = log.filter((message) => (
      isRecord(message.result) && message.result.decision === "accept"
    ));
    expect(approvals).toHaveLength(3);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
