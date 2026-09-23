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
      if (text.endsWith("APPROVAL")) {
        send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
        continue;
      }
      if (text.endsWith("UNKNOWN")) {
        send({ id: "unknown-1", method: "server/unknown", params: {} });
        continue;
      }
      if (text.endsWith("EXIT")) process.exit(0);
      const item = { type: "agentMessage", id: "msg-1", text: text.endsWith("LONG_SUMMARY") ? "x".repeat(40 * 1024) : "done:" + text };
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

function makeClient(workspace: string, binary: string, completionNotifier?: () => void): CodexAppServer {
  return new CodexAppServer({ workspaceRoot: workspace, binary, logger: nullLogger, completionNotifier });
}

async function withEnv(values: Record<string, string | undefined>, action: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  it("uses economy defaults for local limits and summaries", async () => {
    await withEnv({
      C2C_CODEX_MAX_INSTRUCTION_BYTES: undefined,
      C2C_CODEX_MAX_SUMMARY_BYTES: undefined,
      C2C_CODEX_MAX_ITERATIONS: undefined,
      C2C_CODEX_ECONOMY_MODE: undefined,
    }, async () => {
      const workspace = makeWorkspace();
      const fake = makeFakeBinary();
      const client = makeClient(workspace, fake.binary);
      try {
        await expect(client.startTurn("default-iterations", 5, "nope")).rejects.toMatchObject({
          code: "INVALID_ITERATION",
        } satisfies Partial<CodexAppServerError>);
        await expect(client.startTurn("default-bytes", 1, "x".repeat(8 * 1024 + 1))).rejects.toMatchObject({
          code: "INVALID_INSTRUCTION",
        } satisfies Partial<CodexAppServerError>);
        expect((await completed(client, "default-summary", 1, "LONG_SUMMARY")).summary).toHaveLength(8 * 1024);
      } finally {
        await client.close();
      }
    });
  });

  it("accepts valid local overrides and rejects invalid ones with one redacted warning", async () => {
    await withEnv({
      C2C_CODEX_MAX_INSTRUCTION_BYTES: "1024",
      C2C_CODEX_MAX_SUMMARY_BYTES: "1024",
      C2C_CODEX_MAX_ITERATIONS: "5",
    }, async () => {
      const workspace = makeWorkspace();
      const fake = makeFakeBinary();
      const client = makeClient(workspace, fake.binary);
      try {
        expect((await completed(client, "override", 1, "x".repeat(800))).summary).toContain("x");
        for (let iteration = 2; iteration <= 5; iteration++) {
          await completed(client, "override", iteration, "next");
        }
      } finally {
        await client.close();
      }
    });

    await withEnv({ C2C_CODEX_MAX_ITERATIONS: "invalid", C2C_CODEX_ECONOMY_MODE: "invalid" }, async () => {
      const workspace = makeWorkspace();
      const fake = makeFakeBinary();
      const warnings: string[] = [];
      const client = new CodexAppServer({
        workspaceRoot: workspace,
        binary: fake.binary,
        logger: { warn: (message: string) => warnings.push(message) } as unknown as typeof nullLogger,
      });
      try {
        await expect(client.startTurn("invalid", 5, "nope")).rejects.toMatchObject({
          code: "INVALID_ITERATION",
        } satisfies Partial<CodexAppServerError>);
        expect(warnings).toEqual(["Invalid C2C Codex economy configuration; safe defaults applied."]);
      } finally {
        await client.close();
      }
    });
  });

  it("prepends the economy contract only for a new task and permits opting out", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      await completed(client, "economy", 1, "first");
      await completed(client, "economy", 2, "second");
      const starts = readLog(fake.log).filter((entry) => entry.value.method === "turn/start");
      expect((starts[0]!.value.params as any).input[0].text).toContain("Execution contract:");
      expect((starts[1]!.value.params as any).input[0].text).toBe("second");
    } finally {
      await client.close();
    }

    await withEnv({ C2C_CODEX_ECONOMY_MODE: "0" }, async () => {
      const optOutWorkspace = makeWorkspace();
      const optOutFake = makeFakeBinary();
      const optOutClient = makeClient(optOutWorkspace, optOutFake.binary);
      try {
        await completed(optOutClient, "opt-out", 1, "first");
        const start = readLog(optOutFake.log).find((entry) => entry.value.method === "turn/start")!;
        expect((start.value.params as any).input[0].text).toBe("first");
      } finally {
        await optOutClient.close();
      }
    });
  });

  it("notifies exactly once for completion and never for blocked or failed turns", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    let notifications = 0;
    const client = makeClient(workspace, fake.binary, () => { notifications++; });
    try {
      const completedRun = await completed(client, "notify-complete", 1, "ok");
      expect(notifications).toBe(1);
      await expect(client.wait("notify-complete", completedRun.run_id))
        .resolves.toMatchObject({ state: "completed" });
      expect(notifications).toBe(1);

      const blocked = await client.startTurn("notify-blocked", 1, "APPROVAL");
      await expect(client.wait("notify-blocked", blocked.run_id)).resolves.toMatchObject({ state: "blocked" });

      const failed = await client.startTurn("notify-failed", 1, "EXIT");
      await expect(client.wait("notify-failed", failed.run_id)).resolves.toMatchObject({ state: "failed" });
      expect(notifications).toBe(1);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("enforces the remote thread and turn policy floor", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      const result = await completed(client, "task-policy", 1, "hello");
      expect(result.summary).toContain("done:Execution contract:");
      expect(result.summary).toContain("hello");
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
      const runIds: string[] = [];
      for (let i = 1; i <= 100; i++) {
        runIds.push((await completed(client, `bulk-${i}`, 1, `bulk-${i}`)).run_id);
      }
      await expect(client.wait("bulk-1", runIds[0]!)).rejects.toMatchObject({
        code: "RUN_NOT_FOUND",
      } satisfies Partial<CodexAppServerError>);
      await expect(client.wait("bulk-100", runIds.at(-1)!)).resolves.toMatchObject({
        state: "completed",
      });
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

  it("records a terminal result once, retries failed writes, and serializes concurrent waits", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      const first = await client.startTurn("record-retry", 1, "ok");
      let attempts = 0;
      await expect(
        client.waitAndRecordTerminalResult("record-retry", first.run_id, () => {
          attempts++;
          throw new Error("injected write failure");
        })
      ).rejects.toThrow("injected write failure");
      expect(attempts).toBe(1);

      await client.waitAndRecordTerminalResult("record-retry", first.run_id, () => {
        attempts++;
      });
      await client.waitAndRecordTerminalResult("record-retry", first.run_id, () => {
        attempts++;
      });
      expect(attempts).toBe(2);

      const second = await client.startTurn("record-concurrent", 1, "ok");
      let writes = 0;
      const write = async () => {
        writes++;
        await new Promise((resolve) => setTimeout(resolve, 25));
      };
      await Promise.all([
        client.waitAndRecordTerminalResult("record-concurrent", second.run_id, write),
        client.waitAndRecordTerminalResult("record-concurrent", second.run_id, write),
      ]);
      expect(writes).toBe(1);
    } finally {
      await client.close();
    }
  });

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
      expect(next.summary).toContain("done:Execution contract:");
      expect(next.summary).toContain("ok");
    } finally {
      await client.close();
    }
  });
});
