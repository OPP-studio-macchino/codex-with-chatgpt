import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer, CodexAppServerError } from "../src/codex/app-server.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const externalDirs: string[] = [];
const workspaceDirs: string[] = [];

afterEach(() => {
  for (const dir of externalDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of workspaceDirs.splice(0)) cleanup(dir);
});

function makeWorkspace(): string {
  const dir = makeTmpDir("codex-workspace");
  workspaceDirs.push(dir);
  return dir;
}

function makeFakeBinary(ignoreSigterm = false): { binary: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-fake-codex-"));
  externalDirs.push(dir);
  const binary = path.join(dir, "codex-fake.mjs");
  const log = path.join(dir, "requests.jsonl");
  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
${ignoreSigterm ? 'process.on("SIGTERM", () => {});' : ""}
const here = path.dirname(fileURLToPath(import.meta.url));
const log = path.join(here, "requests.jsonl");
let buffer = "";
let threadCounter = 0;
let turnCounter = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const record = (value) => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, value }) + "\\n");
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
      const id = "thread-" + process.pid + "-" + (++threadCounter);
      send({ id: message.id, result: { thread: { id } } });
      continue;
    }
    if (message.method === "turn/start") {
      const turnId = "turn-" + process.pid + "-" + (++turnCounter);
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      const threadId = message.params.threadId;
      const text = message.params.input?.[0]?.text ?? "";
      if (text === "APPROVAL") {
        send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
        continue;
      }
      if (text === "UNKNOWN") {
        send({ id: "unknown-1", method: "server/unknown", params: {} });
        continue;
      }
      if (text === "EXIT") process.exit(0);
      const item = { type: "agentMessage", id: "msg-1", text: "done:" + text };
      send({ method: "item/completed", params: { threadId, turnId, item } });
      send({ method: "turn/completed", params: {
        threadId,
        turn: { id: turnId, status: "completed", items: [item], error: null },
      } });
    }
  }
});
`;
  fs.writeFileSync(binary, source, { mode: 0o700 });
  return { binary, log };
}

type Logged = { pid: number; value: Record<string, unknown> };

function readLog(file: string): Logged[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(
    (line) => JSON.parse(line) as Logged
  );
}

function makeClient(workspace: string, binary: string): CodexAppServer {
  return new CodexAppServer({ workspaceRoot: workspace, binary, logger: nullLogger });
}

async function completed(
  client: CodexAppServer,
  task: string,
  iteration: number,
  instruction: string
) {
  const started = await client.startTurn(task, iteration, instruction);
  const result = await client.wait(task, started.run_id);
  expect(result.state).toBe("completed");
  return result;
}

describe("Codex App Server execution boundary", () => {
  it("enforces the remote thread and turn policy floor", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      const result = await completed(client, "task-policy", 1, "hello");
      expect(result.summary).toBe("done:hello");
      const messages = readLog(fake.log).map((entry) => entry.value);
      const thread = messages.find((value) => value.method === "thread/start") as any;
      const turn = messages.find((value) => value.method === "turn/start") as any;
      expect(thread.params).toMatchObject({
        cwd: workspace,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
        ephemeral: true,
      });
      expect(turn.params).toMatchObject({
        cwd: workspace,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      expect(messages.some((value) => value.method === "thread/delete")).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("recycles after eight ephemeral tasks and expires old task context", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      const first = await completed(client, "task-1", 1, "one");
      for (let i = 2; i <= 9; i++) {
        await completed(client, `task-${i}`, 1, `value-${i}`);
      }
      const logs = readLog(fake.log);
      const threadStarts = logs.filter((entry) => entry.value.method === "thread/start");
      const perPid = new Map<number, number>();
      for (const entry of threadStarts) {
        perPid.set(entry.pid, (perPid.get(entry.pid) ?? 0) + 1);
      }
      expect(Math.max(...perPid.values())).toBeLessThanOrEqual(8);
      expect(perPid.size).toBe(2);
      const same = await client.startTurn("task-1", 1, "ignored-idempotent");
      expect(same.run_id).toBe(first.run_id);
      await expect(client.startTurn("task-1", 2, "continue")).rejects.toMatchObject({
        code: "TASK_CONTEXT_EXPIRED",
      } satisfies Partial<CodexAppServerError>);
    } finally {
      await client.close();
    }
  });

  it("bounds every child to eight threads across one hundred tasks", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      for (let i = 1; i <= 100; i++) {
        await completed(client, `bulk-${i}`, 1, `bulk-${i}`);
      }
      const threadStarts = readLog(fake.log).filter((entry) => entry.value.method === "thread/start");
      const perPid = new Map<number, number>();
      for (const entry of threadStarts) {
        perPid.set(entry.pid, (perPid.get(entry.pid) ?? 0) + 1);
      }
      expect(threadStarts).toHaveLength(100);
      expect(Math.max(...perPid.values())).toBeLessThanOrEqual(8);
      expect(perPid.size).toBeGreaterThan(1);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("reaps an unresponsive child before rollover, failure recovery, and close", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary(true);
    const client = makeClient(workspace, fake.binary);
    try {
      for (let i = 1; i <= 9; i++) await completed(client, `stop-${i}`, 1, "ok");
      let pids = [...new Set(readLog(fake.log).map((entry) => entry.pid))];
      expect(pids).toHaveLength(2);
      expect(() => process.kill(pids[0]!, 0)).toThrow();

      const started = await client.startTurn("stop-9", 2, "APPROVAL");
      expect(await client.wait("stop-9", started.run_id)).toMatchObject({ state: "blocked" });
      await completed(client, "after-block", 1, "ok");
      pids = [...new Set(readLog(fake.log).map((entry) => entry.pid))];
      expect(pids).toHaveLength(3);
      expect(() => process.kill(pids[1]!, 0)).toThrow();
      await client.close();
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await client.close().catch(() => undefined);
      for (const pid of new Set(readLog(fake.log).map((entry) => entry.pid))) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
      }
    }
  }, 10_000);

  it("blocks approvals and unknown server requests without auto-response", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      const approvalStart = await client.startTurn("approval-task", 1, "APPROVAL");
      const approval = await client.wait("approval-task", approvalStart.run_id);
      expect(approval).toMatchObject({ state: "blocked", reason: "approval_required" });

      const second = await client.startTurn("unknown-task", 1, "UNKNOWN");
      const unknown = await client.wait("unknown-task", second.run_id);
      expect(unknown).toMatchObject({ state: "blocked", reason: "unknown_server_request" });

      const logs = readLog(fake.log);
      const outboundMethods = logs.map((entry) => String(entry.value.method ?? ""));
      expect(outboundMethods).not.toContain("item/commandExecution/approve");
      expect(outboundMethods).not.toContain("thread/delete");
    } finally {
      await client.close();
    }
  });

  it("survives an early child exit and can start a fresh task", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      await expect(client.startTurn("exit-task", 1, "EXIT")).resolves.toMatchObject({ state: "running" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const next = await completed(client, "after-exit", 1, "ok");
      expect(next.summary).toBe("done:ok");
    } finally {
      await client.close();
    }
  });
});
