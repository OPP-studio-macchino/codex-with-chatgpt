import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Workspace, WorkspaceError } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

let root: string;
let outside: string;
let ws: Workspace;
let stateDir: string;

beforeAll(() => {
  stateDir = isolateStateDir();
  root = makeTmpDir("ws");
  outside = makeTmpDir("outside");
  write(root, "hello.txt", "hello world\n");
  write(root, "src/app.ts", "const x = 1;\n");
  write(root, ".env", "SECRET=topsecret\n");
  write(root, ".env.production", "SECRET=prod\n");
  write(root, ".env.example", "SECRET=changeme\n");
  write(root, "certs/server.pem", "PRIVATE KEY\n");
  write(root, "keys/id_rsa", "PRIVATE KEY\n");
  write(root, "nested/.ssh/config", "Host *\n");
  write(root, ".git/config", "[core]\n\trepositoryformatversion = 0\n");
  write(root, "artifacts/session.har", "synthetic browser capture\n");
  write(root, "data/users.sqlite", "synthetic database\n");
  write(outside, "secret.txt", "outside data\n");
  write(root, ".c2cignore", "private-notes/\n");
  write(root, "private-notes/todo.md", "secret notes\n");
  // symlink pointing outside the workspace
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
  fs.symlinkSync(outside, path.join(root, "dir-out"));
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
  cleanup(outside);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("path containment", () => {
  it("reads a normal relative path", async () => {
    const result = await ws.readFile("hello.txt");
    expect(result.content).toContain("hello world");
  });

  it("rejects ../ traversal", () => {
    expect(() => ws.resolve("../outside-file")).toThrowError(WorkspaceError);
    expect(() => ws.resolve("../../etc/passwd")).toThrow(/PATH_OUTSIDE|outside/i);
    try {
      ws.resolve("a/../../b");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => ws.resolve("/etc/passwd")).toThrowError(WorkspaceError);
    expect(() => ws.resolve(outside)).toThrowError(WorkspaceError);
  });

  it("allows absolute paths inside the workspace", () => {
    const resolved = ws.resolve(path.join(root, "hello.txt"));
    expect(resolved.rel).toBe("hello.txt");
  });

  it("rejects windows-style traversal", () => {
    expect(() => ws.resolve("..\\..\\etc\\passwd")).toThrowError(WorkspaceError);
  });

  it("rejects null bytes", () => {
    expect(() => ws.resolve("hello.txt\0.png")).toThrowError(WorkspaceError);
  });

  it("rejects symlinked file escaping the workspace", () => {
    try {
      ws.resolve("link-out.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects paths through a symlinked directory escaping the workspace", () => {
    try {
      ws.resolve("dir-out/secret.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });
});

describe("sensitive files", () => {
  const expectDenied = (p: string): void => {
    try {
      ws.resolve(p);
      expect.unreachable(`expected ${p} to be denied`);
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    }
  };

  it("denies .env and variants", () => {
    expectDenied(".env");
    expectDenied(".env.production");
  });

  it("allows .env.example", () => {
    expect(ws.resolve(".env.example").rel).toBe(".env.example");
  });

  it("denies keys and certificates", () => {
    expectDenied("certs/server.pem");
    expectDenied("keys/id_rsa");
  });

  it("denies .ssh directories anywhere", () => {
    expectDenied("nested/.ssh/config");
  });

  it("honors .c2cignore custom rules", () => {
    expectDenied("private-notes/todo.md");
  });

  it("denies repository metadata and the ignore policy itself", () => {
    expectDenied(".git");
    expectDenied(".git/config");
    expectDenied(".c2cignore");
  });

  it("denies browser captures and local databases", () => {
    expectDenied("artifacts/session.har");
    expectDenied("data/users.sqlite");
  });

  it("hides sensitive files from directory listing", async () => {
    const listing = await ws.listDirectory(".", { limit: 500, depth: 2 });
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.includes("private-notes"))).toBe(false);
  });
});

describe("read_file pagination", () => {
  it("caps unbounded reads at 400 lines and reports the remainder", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    write(root, "big.txt", big);
    const result = await ws.readFile("big.txt");
    expect(result.totalLines).toBe(1000);
    expect(result.endLine).toBe(400);
    expect(result.truncated).toBe(true);
    expect(result.remainingLines).toBe(600);
    expect(result.nextStartLine).toBe(401);
  });

  it("returns an explicit range", async () => {
    const result = await ws.readFile("big.txt", { startLine: 500, endLine: 502 });
    expect(result.content).toBe("line 500\nline 501\nline 502");
    expect(result.startLine).toBe(500);
    expect(result.endLine).toBe(502);
  });

  it("denies binary files", async () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await expect(ws.readFile("blob.bin")).rejects.toMatchObject({ code: "BINARY_FILE" });
  });

  it("reports FILE_NOT_FOUND for missing files", async () => {
    await expect(ws.readFile("nope.txt")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("rejects source files larger than 5 MiB", async () => {
    fs.writeFileSync(path.join(root, "too-large.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    await expect(ws.readFile("too-large.txt")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects a single line that exceeds the bounded response", async () => {
    write(root, "minified.js", "a".repeat(300 * 1024));
    await expect(ws.readFile("minified.js")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("redacts credential-shaped values in otherwise readable files", async () => {
    const token = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    write(root, "accidental-secret.ts", `export const api_key = "${token}";\n`);
    const result = await ws.readFile("accidental-secret.ts");
    expect(result.content).not.toContain(token);
    expect(result.content).toContain("[REDACTED");
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  it("uses one verified descriptor for binary inspection and content", async () => {
    const open = vi.spyOn(fs.promises, "open");
    const result = await ws.readFile("hello.txt");
    expect(result.content).toContain("hello world");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("rejects a leaf swapped to an outside symlink before open", async () => {
    const local = makeTmpDir("leaf-swap");
    const external = makeTmpDir("leaf-swap-outside");
    const target = write(local, "target.txt", "safe local content\n");
    const externalFile = write(external, "secret.txt", "outside-leaf-secret\n");
    const localWs = new Workspace(local);
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags, mode) => {
      fs.renameSync(target, `${target}.safe`);
      fs.symlinkSync(externalFile, target);
      return originalOpen(file, flags, mode);
    });

    await expect(localWs.readFile("target.txt")).rejects.toMatchObject({
      code: "UNSAFE_PATH_MUTATION",
    });
    cleanup(local);
    cleanup(external);
  });

  it("rejects a parent directory swapped to an outside symlink before open", async () => {
    const local = makeTmpDir("parent-swap");
    const external = makeTmpDir("parent-swap-outside");
    const parent = path.join(local, "nested");
    write(local, "nested/target.txt", "safe local content\n");
    write(external, "target.txt", "outside-parent-secret\n");
    const localWs = new Workspace(local);
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags, mode) => {
      fs.renameSync(parent, `${parent}.safe`);
      fs.symlinkSync(external, parent, "dir");
      return originalOpen(file, flags, mode);
    });

    await expect(localWs.readFile("nested/target.txt")).rejects.toMatchObject({
      code: "UNSAFE_PATH_MUTATION",
    });
    cleanup(local);
    cleanup(external);
  });

  it.skipIf(process.platform === "win32")("rejects a regular file swapped to a FIFO", async () => {
    const local = makeTmpDir("fifo-swap");
    const target = write(local, "target.txt", "safe local content\n");
    const localWs = new Workspace(local);
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags, mode) => {
      fs.unlinkSync(target);
      const result = spawnSync("mkfifo", [target]);
      if (result.status !== 0) throw new Error("mkfifo fixture failed");
      return originalOpen(file, flags, mode);
    });

    await expect(localWs.readFile("target.txt")).rejects.toMatchObject({ code: "NOT_A_FILE" });
    cleanup(local);
  });
});

describe("mutable directory traversal", () => {
  it("discards list results when a directory is swapped outside", async () => {
    const local = makeTmpDir("list-dir-swap");
    const external = makeTmpDir("list-dir-swap-outside");
    const target = path.join(local, "nested");
    write(local, "nested/local.txt", "safe\n");
    write(external, "outside-name.txt", "outside-list-secret\n");
    const localWs = new Workspace(local);
    const originalOpenDir = fs.promises.opendir.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, "opendir").mockImplementation(async (dirPath, options) => {
      if (!swapped && path.resolve(String(dirPath)) === target) {
        swapped = true;
        fs.renameSync(target, `${target}.safe`);
        fs.symlinkSync(external, target, "dir");
      }
      return originalOpenDir(dirPath, options);
    });

    const listing = await localWs.listDirectory(".", { depth: 2, limit: 100 });
    expect(JSON.stringify(listing)).not.toContain("outside-name.txt");
    expect(JSON.stringify(listing)).not.toContain("outside-list-secret");
    cleanup(local);
    cleanup(external);
  });
});

describe("workspace identity", () => {
  it("has a stable id and name", () => {
    const again = new Workspace(root);
    expect(again.id).toBe(ws.id);
    expect(ws.id).toMatch(/^[a-f0-9]{24}$/);
    expect(ws.name).toBe(path.basename(root));
  });

  it("reads .c2c.json project name", () => {
    const named = makeTmpDir("named");
    write(named, ".c2c.json", JSON.stringify({ name: "Remi", maxIterations: 12 }));
    const namedWs = new Workspace(named);
    expect(namedWs.name).toBe("Remi");
    expect(namedWs.projectConfig.maxIterations).toBe(12);
    cleanup(named);
  });

  it("rejects a state directory located inside the connected workspace", () => {
    process.env.C2C_STATE_DIR = path.join(root, "local-state");
    try {
      expect(() => new Workspace(root)).toThrow(/state directory must be outside/i);
    } finally {
      process.env.C2C_STATE_DIR = stateDir;
    }
  });

  it("fails closed when .c2cignore cannot be read", () => {
    const unreadable = makeTmpDir("bad-ignore");
    fs.mkdirSync(path.join(unreadable, ".c2cignore"));
    expect(() => new Workspace(unreadable)).toThrow(/Cannot enforce \.c2cignore/);
    cleanup(unreadable);
  });

  it("fails closed when .c2cignore is a symlink", () => {
    const linked = makeTmpDir("linked-ignore");
    const policy = makeTmpDir("outside-policy");
    write(policy, "ignore", "private/\n");
    fs.symlinkSync(path.join(policy, "ignore"), path.join(linked, ".c2cignore"));
    expect(() => new Workspace(linked)).toThrow(/Cannot enforce \.c2cignore/);
    cleanup(linked);
    cleanup(policy);
  });

  it("does not inspect a symlinked project manifest", () => {
    const linked = makeTmpDir("linked-project");
    const outsideManifest = makeTmpDir("outside-manifest");
    write(outsideManifest, "package.json", JSON.stringify({ scripts: { "secret-token": "echo no" } }));
    fs.symlinkSync(path.join(outsideManifest, "package.json"), path.join(linked, "package.json"));
    const linkedWs = new Workspace(linked);
    expect(linkedWs.detectProject()).toMatchObject({ projectType: "unknown", scriptNames: [] });
    cleanup(linked);
    cleanup(outsideManifest);
  });

  it("sanitizes and bounds untrusted project config", () => {
    const configured = makeTmpDir("configured");
    write(
      configured,
      ".c2c.json",
      JSON.stringify({ name: "Safe\u202eName\u0000", maxIterations: 1_000_000 })
    );
    const configuredWs = new Workspace(configured);
    expect(configuredWs.name).not.toContain("\u0000");
    expect(configuredWs.name).not.toContain("\u202e");
    expect(configuredWs.projectConfig.maxIterations).toBeUndefined();
    cleanup(configured);
  });
});
