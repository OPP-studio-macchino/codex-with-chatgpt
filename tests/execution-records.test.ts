import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { isolateStateDir } from "./helpers.js";

let stateDir: string;

beforeEach(() => {
  stateDir = isolateStateDir();
});

describe("execution record boundary", () => {
  it("redacts summaries and sensitive changed paths before persistence", () => {
    const token = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    appendExecutionRecord("workspace-test", {
      taskId: "c2c_safe",
      iteration: 1,
      changedFiles: ["src/app.ts", ".env.production"],
      tests: `failed with ${token}`,
      exitStatus: "failed",
      timestamp: new Date().toISOString(),
      notes: `Authorization: Bearer ${token}`,
    });

    const serialized = JSON.stringify(readExecutionRecords("workspace-test"));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(".env.production");
    expect(serialized).toContain("[REDACTED");
  });

  it("redacts long credential values before bounded persistence", () => {
    const secret = "S".repeat(620);
    appendExecutionRecord("workspace-long-redaction", {
      taskId: "c2c_long_redaction",
      iteration: 1,
      changedFiles: 0,
      tests: `password = "${secret}"`,
      exitStatus: "failed",
      timestamp: new Date().toISOString(),
      notes: `client_secret = \`${secret}\``,
    });
    const serialized = JSON.stringify(readExecutionRecords("workspace-long-redaction"));
    expect(serialized).not.toContain("S".repeat(32));
    expect(serialized).toContain("[REDACTED]");
  });

  it("drops unknown legacy fields instead of returning them through MCP", () => {
    const workspaceId = "workspace-legacy";
    appendExecutionRecord(workspaceId, {
      taskId: "c2c_legacy",
      iteration: 2,
      changedFiles: 1,
      tests: "passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const file = path.join(stateDir, "executions", `${workspaceId}.jsonl`);
    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
    fs.appendFileSync(
      file,
      JSON.stringify({
        taskId: "c2c_legacy2",
        iteration: 3,
        changedFiles: 1,
        tests: "passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        arbitraryProviderPayload: secret,
      }) + "\n"
    );

    const records = readExecutionRecords(workspaceId, 10);
    const serialized = JSON.stringify(records);
    expect(records).toHaveLength(2);
    expect(serialized).not.toContain("arbitraryProviderPayload");
    expect(serialized).not.toContain(secret);
  });

  it("rejects invalid metadata", () => {
    expect(() =>
      appendExecutionRecord("workspace-invalid", {
        taskId: "bad task id",
        iteration: 1,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      })
    ).toThrow(/task id/i);
  });

  it("rejects workspace-id traversal and refuses symlinked record files", () => {
    expect(() => readExecutionRecords("../outside", 1)).toThrow(/workspace id/i);

    const workspaceId = "workspace-symlink";
    const external = path.join(stateDir, "external.jsonl");
    fs.writeFileSync(external, "private external content\n");
    const recordsDir = path.join(stateDir, "executions");
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.symlinkSync(external, path.join(recordsDir, `${workspaceId}.jsonl`));

    expect(readExecutionRecords(workspaceId)).toEqual([]);
    appendExecutionRecord(workspaceId, {
      taskId: "c2c_safe",
      iteration: 1,
      changedFiles: 0,
      tests: null,
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    expect(fs.readFileSync(external, "utf8")).toBe("private external content\n");
    expect(fs.lstatSync(path.join(recordsDir, `${workspaceId}.jsonl`)).isSymbolicLink()).toBe(false);
  });

  it("retains at most 100 bounded records", () => {
    const workspaceId = "workspace-bounded";
    for (let index = 0; index < 105; index++) {
      appendExecutionRecord(workspaceId, {
        taskId: `c2c_${index}`,
        iteration: index,
        changedFiles: index,
        tests: "passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });
    }
    const records = readExecutionRecords(workspaceId, 100);
    expect(records).toHaveLength(100);
    expect(records[0].taskId).toBe("c2c_5");
    expect(records.at(-1)?.changedFiles).toBe(104);
  });

  it("truncates oversized changed-path lists", () => {
    const workspaceId = "workspace-path-limit";
    appendExecutionRecord(workspaceId, {
      taskId: "c2c_paths",
      iteration: 1,
      changedFiles: Array.from({ length: 60 }, (_, file) => `src/${file}.ts`),
      tests: "passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    expect(readExecutionRecords(workspaceId, 1)[0].changedFiles).toHaveLength(51);
  });
});
