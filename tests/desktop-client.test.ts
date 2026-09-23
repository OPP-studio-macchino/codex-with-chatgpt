import { describe, expect, it } from "vitest";
import { DesktopAgentClient } from "../src/desktop/client.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

describe("DesktopAgentClient request deadline", () => {
  it("injects a bounded local deadline and overrides caller input", async () => {
    const root = makeTmpDir("desktop-client-deadline");
    try {
      const rpcPath = write(root, "rpc.mjs", `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
process.stdout.write(JSON.stringify({ ok: true, result: request }) + "\\n");
`);
      const configPath = write(root, "config.json", "{}\\n");
      const client = new DesktopAgentClient({ rpcPath, configPath, logger: nullLogger, nodeBinary: process.execPath });
      const before = Date.now();
      const result = await client.call({ op: "probe", requestDeadlineAt: "2099-01-01T00:00:00.000Z" }) as { requestDeadlineAt: string };
      const after = Date.now();
      const deadline = Date.parse(result.requestDeadlineAt);
      expect(Number.isFinite(deadline)).toBe(true);
      expect(deadline).toBeGreaterThanOrEqual(before + 12_000);
      expect(deadline).toBeLessThanOrEqual(after + 13_500);
      expect(result.requestDeadlineAt).not.toBe("2099-01-01T00:00:00.000Z");
    } finally {
      cleanup(root);
    }
  });
  it("gives processRun a bounded deadline before its longer outer kill", async () => {
    const root = makeTmpDir("desktop-client-process-deadline");
    try {
      const rpcPath = write(root, "rpc.mjs", `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
process.stdout.write(JSON.stringify({ ok: true, result: request }) + "\\n");
`);
      const configPath = write(root, "config.json", "{}\\n");
      const client = new DesktopAgentClient({ rpcPath, configPath, logger: nullLogger, nodeBinary: process.execPath });
      const before = Date.now();
      const result = await client.call({ op: "processRun", requestDeadlineAt: "2099-01-01T00:00:00.000Z" }) as { requestDeadlineAt: string };
      const after = Date.now();
      const deadline = Date.parse(result.requestDeadlineAt);
      expect(deadline).toBeGreaterThanOrEqual(before + 119_000);
      expect(deadline).toBeLessThanOrEqual(after + 120_500);
      expect(result.requestDeadlineAt).not.toBe("2099-01-01T00:00:00.000Z");
    } finally {
      cleanup(root);
    }
  });

});
