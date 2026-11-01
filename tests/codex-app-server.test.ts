import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { CodexAppServer, CodexAppServerError } from "../src/codex/app-server.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;

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

function makeFakeBinary(ignoreSigterm = false, rejectConfig = false, threadOverrides = {}): { binary: string; log: string } {
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
      ${rejectConfig ? 'send({ id: message.id, error: { code: -32602, message: "Unsupported feature config" } }); continue;' : ""}
      const id = "thread-" + process.pid + "-" + (++threadCounter);
      send({ id: message.id, result: { cwd: message.params.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: message.params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, thread: { id }, ...${JSON.stringify(threadOverrides)} } });
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
      if (text.endsWith("HANG")) continue;
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

function makeClient(workspace: string, binary: string): CodexAppServer {
  return new CodexAppServer({ workspaceRoot: workspace, binary, logger: nullLogger });
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
  instruction: string,
  executionMode?: "read_only" | "workspace_write"
) {
  const started = await client.startTurn(task, iteration, instruction, executionMode);
  const result = await client.wait(task, started.run_id);
  expect(result.state).toBe("completed");
  return result;
}

describe("Codex App Server execution boundary", () => {
  it.each([null, "writer", "read-only", "", true, 1, [], { execution_mode: "workspace_write" }])("rejects malformed direct and checkpoint modes before admission: %j", async mode => {
    const fake = makeFakeBinary(), client = makeClient(makeWorkspace(), fake.binary);
    let admitted = false;
    try {
      await expect(client.startTurn("bad-mode", 1, "write files", mode as any)).rejects.toMatchObject({ code: "INVALID_EXECUTION_MODE" });
      await expect(client.startCheckpointTurn("bad-mode", 2, "write files", () => { admitted = true; }, mode as any)).rejects.toMatchObject({ code: "INVALID_EXECUTION_MODE" });
      expect(admitted).toBe(false);
      expect(readLog(fake.log)).toEqual([]);
    } finally { await client.close(); }
  });

  it.each(["read_only", "workspace_write"] as const)("binds duplicates, iterations and checkpoint starts to %s", async mode => {
    const fake = makeFakeBinary(), client = makeClient(makeWorkspace(), fake.binary);
    try {
      const first = await completed(client, "bound-mode", 1, "role: writer; instruction: modify all files", mode);
      expect(await client.startTurn("bound-mode", 1, "ignored duplicate", mode)).toEqual(first);
      const other = mode === "read_only" ? "workspace_write" : "read_only";
      for (const iteration of [1, 2]) {
        await expect(client.startTurn("bound-mode", iteration, "continue", other)).rejects.toMatchObject({ code: "EXECUTION_MODE_MISMATCH" });
      }
      let admitted = false;
      await expect(client.startCheckpointTurn("bound-mode", 2, "continue", () => { admitted = true; }, other)).rejects.toMatchObject({ code: "EXECUTION_MODE_MISMATCH" });
      expect(admitted).toBe(false);
      expect(readLog(fake.log).filter(e => e.value.method === "turn/start")).toHaveLength(1);
    } finally { await client.close(); }
  });

  it.each([
    { sandbox: null }, { sandbox: { type: "dangerFullAccess" } },
    { sandbox: { type: "readOnly", networkAccess: true } },
    { sandbox: { type: "readOnly", networkAccess: false, writableRoots: ["/tmp"] } },
    { sandbox: { type: "workspaceWrite", writableRoots: ["/tmp"], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } },
    { sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true } },
    { sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
    { cwd: "/unrelated" }, { approvalsReviewer: "auto_review" }, { approvalPolicy: "never" },
  ])("rejects unverified effective thread response without a turn or fallback: %j", async overrides => {
    for (const mode of ["read_only", "workspace_write"] as const) {
      const fake = makeFakeBinary(false, false, overrides), client = makeClient(makeWorkspace(), fake.binary);
      try {
        await expect(client.startTurn("bad-policy", 1, "inspect", mode)).rejects.toMatchObject({ code: "UNSUPPORTED_SANDBOX_POLICY" });
        expect(readLog(fake.log).filter(e => e.value.method === "thread/start")).toHaveLength(1);
        expect(readLog(fake.log).some(e => e.value.method === "turn/start")).toBe(false);
      } finally { await client.close(); }
    }
  });

  it("uses economy defaults for local limits and summaries", async () => {
    await withEnv({
      C2C_CODEX_MAX_INSTRUCTION_BYTES: undefined,
      C2C_CODEX_MAX_SUMMARY_BYTES: undefined,
      C2C_CODEX_MAX_ITERATIONS: undefined,
      C2C_CODEX_WAIT_TIMEOUT_MS: undefined,
      C2C_CODEX_ECONOMY_MODE: undefined,
    }, async () => {
      const workspace = makeWorkspace();
      const fake = makeFakeBinary();
      const client = makeClient(workspace, fake.binary);
      try {
        for (let iteration = 1; iteration <= 14; iteration++) {
          expect(await completed(client, "default-iterations", iteration, "continue")).toMatchObject({ state: "completed", iteration });
        }
        expect(readLog(fake.log).filter(entry => entry.value.method === "thread/start")).toHaveLength(1);
        await expect(client.startTurn("default-iterations", 16, "skip")).rejects.toMatchObject({ code: "INVALID_ITERATION" });
        await expect(client.startTurn("default-bytes", 1, "x".repeat(8 * 1024 + 1))).rejects.toMatchObject({
          code: "INVALID_INSTRUCTION",
        } satisfies Partial<CodexAppServerError>);
        expect((await completed(client, "default-summary", 1, "LONG_SUMMARY")).summary).toHaveLength(8 * 1024);
      } finally {
        await client.close();
      }
    });
  });

  it("short-polls a running turn instead of holding a long response open", async () => {
    await withEnv({ C2C_CODEX_WAIT_TIMEOUT_MS: "250" }, async () => {
      const workspace = makeWorkspace();
      const fake = makeFakeBinary();
      const client = makeClient(workspace, fake.binary);
      try {
        const started = await client.startTurn("short-poll", 1, "HANG");
        const startedAt = Date.now();
        const result = await client.wait("short-poll", started.run_id);
        const elapsedMs = Date.now() - startedAt;

        expect(result.state).toBe("running");
        expect(elapsedMs).toBeGreaterThanOrEqual(150);
        expect(elapsedMs).toBeLessThan(1500);
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
      C2C_CODEX_WAIT_TIMEOUT_MS: "250",
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
        for (let iteration = 1; iteration <= 5; iteration++) await completed(client, "invalid", iteration, "continue");
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

  it.each([undefined, "read_only", "workspace_write"] as const)("enforces exact thread and turn policies for %s (mock protocol only)", async mode => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const client = makeClient(workspace, fake.binary);
    try {
      const result = await completed(client, "task-policy", 1, "hello", mode);
      expect(result.execution_mode).toBe(mode ?? "read_only");
      expect(result.summary).toContain("done:Execution contract:");
      expect(result.summary).toContain("hello");
      const messages = readLog(fake.log).map((entry) => entry.value);
      const thread = messages.find((value) => value.method === "thread/start") as any;
      const turn = messages.find((value) => value.method === "turn/start") as any;
      expect(thread.params).toEqual({
        cwd: workspace,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: mode === "workspace_write" ? "workspace-write" : "read-only",
        ephemeral: true,
        config: {
          "features.exec_permission_approvals": true,
          "features.default_mode_request_user_input": true,
          "sandbox_workspace_write.writable_roots": [],
          "sandbox_workspace_write.network_access": false,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      });
      expect(turn.params).toEqual({
        threadId: turn.params.threadId,
        input: [{ type: "text", text: turn.params.input[0].text, text_elements: [] }],
        cwd: workspace,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: mode !== "workspace_write" ? { type: "readOnly", networkAccess: false } : {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      expect(messages.some((value) => value.method === "thread/delete")).toBe(false);
      await completed(client, "task-policy", 2, "next", mode);
      expect(readLog(fake.log).filter((entry) => entry.value.method === "thread/start")).toHaveLength(1);
      const checkpoint = await client.startCheckpointTurn("checkpoint-policy", 2, "checkpoint", () => {}, mode);
      expect((await client.wait("checkpoint-policy", checkpoint.run_id)).state).toBe("completed");
      const threads = readLog(fake.log).filter((entry) => entry.value.method === "thread/start");
      expect(threads).toHaveLength(2);
      expect(threads[1]!.value.params).toEqual(thread.params);
    } finally {
      await client.close();
    }
  });

  it("fails closed when thread feature config is rejected", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary(false, true);
    const client = makeClient(workspace, fake.binary);
    try {
      await expect(client.startTurn("rejected-config", 1, "hello")).rejects.toThrow("Codex App Server request failed.");
      const messages = readLog(fake.log).map((entry) => entry.value);
      const threads = messages.filter((value) => value.method === "thread/start");
      expect(threads).toHaveLength(1);
      expect(threads[0]!.params).toEqual({
        cwd: workspace, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandbox: "read-only", ephemeral: true,
        config: {
          "features.exec_permission_approvals": true,
          "features.default_mode_request_user_input": true,
          "sandbox_workspace_write.writable_roots": [],
          "sandbox_workspace_write.network_access": false,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      });
      expect(messages.filter((value) => value.method === "turn/start")).toEqual([]);
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
      expect(threadStarts).toHaveLength(9);
      for (const entry of threadStarts) {
        expect(entry.value.params).toEqual({
          cwd: workspace, approvalPolicy: "on-request", approvalsReviewer: "user",
          sandbox: "read-only", ephemeral: true,
          config: {
            "features.exec_permission_approvals": true,
            "features.default_mode_request_user_input": true,
            "sandbox_workspace_write.writable_roots": [],
            "sandbox_workspace_write.network_access": false,
            "sandbox_workspace_write.exclude_tmpdir_env_var": true,
            "sandbox_workspace_write.exclude_slash_tmp": true,
          },
        });
      }
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
      let admitted = false;
      await expect(client.startCheckpointTurn("bulk-1", 2, "continue", () => { admitted = true; }, "workspace_write"))
        .rejects.toMatchObject({ code: "EXECUTION_MODE_MISMATCH" });
      expect(admitted).toBe(false);
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
    const owned: Array<{ child: childProcess.ChildProcess; closed: Promise<void> }> = [];
    const observation = vi.mocked(childProcess.spawn).mockImplementation((...args: Parameters<typeof realSpawn>) => {
      const child = realSpawn(...args);
      if (args[0] === fake.binary) owned.push({ child, closed: new Promise(resolve => child.once("close", () => resolve())) });
      return child;
    });
    try {
      for (let i = 1; i <= 9; i++) await completed(client, `stop-${i}`, 1, "ok");
      let pids = [...new Set(readLog(fake.log).map((entry) => entry.pid))];
      expect(pids).toHaveLength(2);
      expect(owned).toHaveLength(2);
      await owned[0]!.closed;
      expect(owned[0]!.child.signalCode).toBe("SIGKILL");

      const started = await client.startTurn("stop-9", 2, "APPROVAL");
      expect(await client.wait("stop-9", started.run_id)).toMatchObject({ state: "blocked" });
      await completed(client, "after-block", 1, "ok");
      pids = [...new Set(readLog(fake.log).map((entry) => entry.pid))];
      expect(pids).toHaveLength(3);
      expect(owned).toHaveLength(3);
      await owned[1]!.closed;
      expect(owned[1]!.child.signalCode).toBe("SIGKILL");
      await client.close();
      await Promise.all(owned.map(entry => entry.closed));
      expect(owned.map(entry => entry.child.pid)).toEqual(pids);
      for (const { child } of owned) expect(child.signalCode).toBe("SIGKILL");
    } finally {
      try {
        await client.close();
      } finally {
        try {
          for (const { child } of owned) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }
          await Promise.all(owned.map(entry => entry.closed));
        } finally { observation.mockImplementation(realSpawn); }
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
      const approvalStart = await client.startTurn("approval-task", 1, "APPROVAL", "workspace_write");
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

  it("does not spawn a child when the write-ahead hook fails", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    const startedFile = fake.log + ".started";
    const source = fs.readFileSync(fake.binary, "utf8");
    fs.writeFileSync(fake.binary, source.replace('const here =', `fs.writeFileSync(${JSON.stringify(startedFile)}, 'spawned');\nconst here =`));
    const client = new CodexAppServer({ workspaceRoot: workspace, binary: fake.binary, logger: nullLogger,
      onRunStarting: () => { throw new Error("disk unavailable"); },
    });
    try {
      await expect(client.startTurn("durable-deny", 1, "ok")).rejects.toMatchObject({ code: "TASK_JOURNAL_UNAVAILABLE" });
      expect(fs.existsSync(startedFile)).toBe(false);
      expect(readLog(fake.log)).toEqual([]);
    } finally { await client.close(); }
  });

  it("does not report durable success when its terminal hook fails", async () => {
    const workspace = makeWorkspace();
    const fake = makeFakeBinary();
    let starts = 0, terminals = 0;
    const client = new CodexAppServer({ workspaceRoot: workspace, binary: fake.binary, logger: nullLogger,
      onRunStarting: () => { starts++; },
      onRunTerminal: () => { terminals++; throw new Error("terminal disk failure"); },
    });
    try {
      const run = await client.startTurn("durable-fail", 1, "ok");
      const result = await client.wait("durable-fail", run.run_id);
      expect(result).toMatchObject({ state: "failed", reason: "task_journal_write_failed" });
      expect(result.summary).toBeUndefined();
      expect(starts).toBe(1); expect(terminals).toBe(1);
      await expect(client.startTurn("after-durable-fail", 1, "ok")).rejects.toMatchObject({ code: "TASK_JOURNAL_UNAVAILABLE" });
    } finally { await client.close(); }
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

describe("background run transitions", () => {
  it.each([
    ["ok", "completed", undefined],
    ["APPROVAL", "blocked", "approval_required"],
    ["UNKNOWN", "blocked", "unknown_server_request"],
    ["EXIT", "failed", "child_exit"],
  ])("notifies %s without polling and never repeats on polls", async (instruction, state, reason) => {
    const fake = makeFakeBinary();
    const events: Array<{ state: string; reason?: string }> = [];
    const client = new CodexAppServer({ workspaceRoot: makeWorkspace(), binary: fake.binary, logger: nullLogger,
      onRunNotification: run => { events.push(run); } });
    try {
      const run = await client.startTurn("notify", 1, instruction!, instruction === "APPROVAL" ? "workspace_write" : undefined);
      const deadline = Date.now() + 3000;
      while (!events.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ state, ...(reason ? { reason } : {}) });
      await client.wait("notify", run.run_id);
      await client.wait("notify", run.run_id);
      expect(events).toHaveLength(1);
    } finally { await client.close(); }
  });
});
