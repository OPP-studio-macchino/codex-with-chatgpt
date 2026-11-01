import { it, expect } from "vitest";
import { CodexAppServer } from "../src/codex/app-server.js";
import { nullLogger } from "../src/logger/index.js";

it.each([undefined, "4", "12", "13", "invalid"])("removes the iteration cap even with retired setting %s", async value => {
  const old = process.env.C2C_CODEX_MAX_ITERATIONS;
  if (value === undefined) delete process.env.C2C_CODEX_MAX_ITERATIONS;
  else process.env.C2C_CODEX_MAX_ITERATIONS = value;
  const client = new CodexAppServer({ workspaceRoot: process.cwd(), binary: process.execPath, logger: nullLogger });
  try {
    expect(client.runtimeStatus()).toMatchObject({
      max_iterations: null, maxIterations: null, hardMaxIterations: null,
      iterationConfiguration: { key: "C2C_CODEX_MAX_ITERATIONS", source: "removed",
        requested: null, effective: null, default: null, hard: null, readAt: "not_applicable",
        requiresRestartOrClientRecreation: false, restoresTaskContext: false },
    });
    // Valid high ordinals reach instruction validation without spawning a child.
    for (const iteration of [13, 10001, Number.MAX_SAFE_INTEGER]) {
      await expect(client.startTurn("limits", iteration, "")).rejects.toMatchObject({ code: "INVALID_INSTRUCTION" });
    }
    for (const iteration of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(client.startTurn("limits", iteration, "")).rejects.toMatchObject({ code: "INVALID_ITERATION" });
    }
  } finally {
    await client.close();
    if (old === undefined) delete process.env.C2C_CODEX_MAX_ITERATIONS; else process.env.C2C_CODEX_MAX_ITERATIONS = old;
  }
});
