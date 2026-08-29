import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import { Workspace } from "../src/workspace/manager.js";
import { searchWorkspace, resetRipgrepCache, findRipgrep } from "../src/workspace/search.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";

let root: string;
let ws: Workspace;

beforeAll(() => {
  root = makeTmpDir("search-ws");
  write(root, "src/auth.ts", "export function login() { return 'needle-alpha'; }\n");
  write(root, "src/deep/nested.ts", "// needle-alpha appears here too\n");
  write(root, "README.md", "This project contains needle-alpha documentation.\n");
  write(root, ".env", "NEEDLE-ALPHA=secret\n");
  write(root, ".c2cignore", "private/\n");
  write(root, "private/notes.txt", "needle-alpha must remain private\n");
  write(
    root,
    "src/accidental.ts",
    'export const api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"; // redact-me\n'
  );
  write(root, "node_modules/pkg/index.js", "needle-alpha in dependencies\n");
  for (let i = 0; i < 30; i++) {
    write(root, `many/file-${i}.txt`, "needle-beta\nneedle-beta\n");
  }
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
});

afterEach(() => {
  delete process.env.C2C_DISABLE_RG;
  delete process.env.C2C_RG_PATH;
  resetRipgrepCache();
});

function engines(): ("ripgrep" | "node")[] {
  return findRipgrep() ? ["ripgrep", "node"] : ["node"];
}

describe.each(engines())("search engine: %s", (engine) => {
  const configure = (): void => {
    if (engine === "node") process.env.C2C_DISABLE_RG = "1";
    resetRipgrepCache();
  };

  it("finds matches with paths and line numbers", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    expect(result.engine).toBe(engine);
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("src/deep/nested.ts");
    expect(paths).toContain("README.md");
    const authMatch = result.matches.find((match) => match.path === "src/auth.ts");
    expect(authMatch?.line).toBe(1);
  });

  it("never returns sensitive or noise files", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    const paths = result.matches.map((match) => match.path);
    expect(paths.some((p) => p.includes(".env"))).toBe(false);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes("private/"))).toBe(false);
  });

  it("redacts credential-shaped values in matching lines", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "redact-me" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].text).not.toContain("sk-proj-");
    expect(result.matches[0].text).toContain("[REDACTED");
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  it("respects the limit", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-beta", limit: 10 });
    expect(result.matches.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("supports glob filters", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", glob: "*.md" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.endsWith(".ts"))).toBe(false);
  });

  it("restricts search to a subdirectory", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", path: "src" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).not.toContain("README.md");
  });
});

describe("regex fallback safety", () => {
  it("ignores a workspace-provided ripgrep override", () => {
    const candidate = write(root, "rg-fixture", "#!/bin/sh\nexit 0\n");
    fs.chmodSync(candidate, 0o700);
    process.env.C2C_RG_PATH = candidate;
    resetRipgrepCache();
    expect(findRipgrep()).not.toBe(fs.realpathSync.native(candidate));
  });

  it("fails closed when ripgrep is unavailable", async () => {
    process.env.C2C_DISABLE_RG = "1";
    resetRipgrepCache();
    await expect(searchWorkspace(ws, { query: "(a+)+$", regex: true })).rejects.toMatchObject({
      code: "UNSUPPORTED_REGEX",
    });
  });
});
