import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { gitPublishPlan, gitPublishCheckpoint } from "../src/workspace/git.js";
import { Workspace } from "../src/workspace/manager.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { TaskReconciler } from "../src/execution/task-reconciler.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { nullLogger } from "../src/logger/index.js";

// The only substituted subprocess is push. All inspection/stage/commit/ref
// operations use harmless real repositories and the production fixed argv.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync;
const dirs: string[] = [], closes: Array<() => void> = [];
const originalState = process.env.C2C_STATE_DIR;
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
  for (const dir of dirs.splice(0)) cleanup(dir);
  vi.mocked(spawnSync).mockImplementation(realSpawn); vi.clearAllMocks(); vi.restoreAllMocks();
  if (originalState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = originalState;
});
function setup() {
  const root = makeTmpDir("git-publish"); dirs.push(root); makeGitRepo(root);
  git(root, "config", "user.name", "fixture"); git(root, "config", "user.email", "fixture@example.com");
  git(root, "remote", "add", "origin", "https://github.com/example/fixture.git");
  write(root, "hello.txt", "changed content\n");
  const workspace = new Workspace(root);
  const fields = { workspace_id: workspace.id, paths: ["hello.txt"], commit_message: "Publish reviewed change", remote: "origin", branch: "main" };
  return { root, workspace, fields };
}
function actionFixture(s: ReturnType<typeof setup>) {
  const state = makeTmpDir("git-publish-journal"); dirs.push(state); process.env.C2C_STATE_DIR = state;
  // Real journal durability needs a filesystem with Unix modes (the default
  // checkout may be exFAT). Existing journal fixtures use the same mode shim.
  const lstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    const stat = lstat(file, options as never) as fs.Stats;
    if (String(file).startsWith(state)) stat.mode = (stat.mode & ~0o777) | (stat.isDirectory() ? 0o700 : 0o600);
    return stat;
  }) as typeof fs.lstatSync);
  const journal = new TaskJournal(s.workspace.id); closes.push(() => journal.close());
  const prior = { task_id: "publish", iteration: 1, run_id: "a".repeat(32), state: "running" as const };
  journal.begin(s.workspace.id, prior, "prior task"); journal.complete(s.workspace.id, { ...prior, state: "completed" });
  const evidence = { digest: "e".repeat(64), head: git(s.root, "rev-parse", "HEAD").trim(), fileCount: 2, changedCount: 1,
    processScope: "same-user-cwd" as const, fileScope: "git-index-status-and-dirty-worktree-excluding-appledouble" as const };
  const inspect = vi.fn(async () => evidence);
  const reconciler = new TaskReconciler({ journal, inspect, approve: async () => "approved", isBusy: () => false });
  closes.push(() => reconciler.close());
  const file = path.join(state, "task-journal", `${s.workspace.id}.json`);
  const approve = async (instruction: string) => {
    const job = reconciler.prepareCheckpoint(s.workspace, "publish", 2, instruction) as { reconciliation_id: string };
    await expect.poll(() => (reconciler.status(s.workspace.id, job.reconciliation_id) as { state: string }).state).toBe("reconciled");
  };
  const apply = (fingerprint: string, fields = s.fields) => gitPublishCheckpoint(s.workspace, reconciler, fields, fingerprint, "publish", 2);
  return { journal, reconciler, inspect, evidence, file, approve, apply };
}
function interceptPush(root: string, failed = false) {
  const push = vi.fn();
  vi.mocked(spawnSync).mockImplementation(((binary: string, argv: string[], options: any) => {
    if (!argv.includes("push")) return realSpawn(binary, argv, options);
    push(binary, argv, options);
    if (!failed) {
      const refspec = argv.at(-1)!;
      realSpawn(binary, ["update-ref", "refs/remotes/origin/main", refspec.split(":")[0]], { ...options, cwd: root });
    }
    return { status: failed ? 1 : 0, stdout: "", stderr: failed ? "https://credential:secret@example.com" : "" };
  }) as typeof spawnSync);
  return push;
}

it("plans read-only, binds all fields and neither leaks the URL nor accepts caller argv", () => {
  const s = setup(), before = git(s.root, "status", "--porcelain"), head = git(s.root, "rev-parse", "HEAD");
  const plan = gitPublishPlan(s.workspace, s.fields);
  expect(gitPublishPlan(s.workspace, s.fields)).toEqual(plan);
  expect(plan.instruction).toContain(plan.fingerprint); expect(plan.head).toBe(head.trim());
  expect(JSON.stringify(plan)).not.toContain("https://");
  expect(git(s.root, "status", "--porcelain")).toBe(before); expect(git(s.root, "rev-parse", "HEAD")).toBe(head);
  expect(gitPublishPlan(s.workspace, { ...s.fields, commit_message: "Different exact message" }).fingerprint).not.toBe(plan.fingerprint);
  expect(() => gitPublishPlan(s.workspace, { ...s.fields, argv: ["--force"] } as never)).toThrow();
});
it.each(["../hello.txt", "/hello.txt", "src/../hello.txt", ".git/config", ".env", "secrets/token.txt", "._hello.txt", "hello.txt;id", "$(id)", "hello.txt > stolen", "hello.txt\\x"])("rejects unsafe path %s", file => {
  const s = setup(); expect(() => gitPublishPlan(s.workspace, { ...s.fields, paths: [file] })).toThrow();
});
it("rejects duplicates, missing files, directories, source and parent symlinks", () => {
  const s = setup();
  for (const paths of [["hello.txt", "hello.txt"], ["missing"], ["src"]]) expect(() => gitPublishPlan(s.workspace, { ...s.fields, paths })).toThrow();
  fs.symlinkSync("hello.txt", path.join(s.root, "alias")); fs.symlinkSync("src", path.join(s.root, "linked"));
  for (const file of ["alias", "linked/index.ts"]) expect(() => gitPublishPlan(s.workspace, { ...s.fields, paths: [file] })).toThrow();
});
it.each(["unsafe\nmessage", "token=private", "password: private", "$(id)", "message;id", "x".repeat(201)])("rejects message %s", commit_message => {
  const s = setup(); expect(() => gitPublishPlan(s.workspace, { ...s.fields, commit_message })).toThrow();
});
it.each(["--force", "main:other", "main..other", "main.lock", "main/../other", "other"])("rejects wrong/unsafe branch %s", branch => {
  const s = setup(); expect(() => gitPublishPlan(s.workspace, { ...s.fields, branch })).toThrow();
});
it.each(["file:///tmp/repo", "ssh://github.com/example/repo", "https://user:password@github.com/repo", "https://localhost/repo", "https://127.0.0.1/repo"])("refuses remote transport %s", url => {
  const s = setup(); git(s.root, "remote", "set-url", "origin", url); expect(() => gitPublishPlan(s.workspace, s.fields)).toThrow();
});
it("refuses unrelated pre-staged content including mode-only changes", () => {
  const s = setup(); write(s.root, "src/index.ts", "unrelated\n"); git(s.root, "add", "src/index.ts");
  expect(() => gitPublishPlan(s.workspace, s.fields)).toThrow("GIT PUBLISH UNRELATED STAGED PATH");
  git(s.root, "reset", "HEAD", "src/index.ts"); git(s.root, "update-index", "--chmod=+x", "src/index.ts");
  expect(() => gitPublishPlan(s.workspace, s.fields)).toThrow("GIT PUBLISH UNRELATED STAGED PATH");
});
it.each(["head", "file", "index", "config", "remote", "executable"])("rejects changed %s before any mutation", async kind => {
  const s = setup(), f = actionFixture(s), plan = gitPublishPlan(s.workspace, s.fields); await f.approve(plan.instruction);
  if (kind === "head") git(s.root, "commit", "--allow-empty", "-m", "moved");
  if (kind === "file") write(s.root, "hello.txt", "changed again\n");
  if (kind === "index") git(s.root, "add", "hello.txt");
  if (kind === "config") git(s.root, "config", "user.name", "different");
  if (kind === "remote") git(s.root, "remote", "set-url", "origin", "https://github.com/example/other.git");
  if (kind === "executable") {
    const stat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      const result = stat(file, options as never) as fs.Stats; if (file === "/usr/bin/git") result.mode |= 0o002; return result;
    }) as typeof fs.lstatSync);
  }
  vi.mocked(spawnSync).mockClear(); await expect(f.apply(plan.fingerprint)).rejects.toThrow();
  expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => (args as string[]).includes("add"))).toBe(false);
});
it("revalidates after evidence inspection and refuses mismatched reconciliation", async () => {
  const s = setup(), f = actionFixture(s), plan = gitPublishPlan(s.workspace, s.fields); await f.approve(plan.instruction);
  f.inspect.mockImplementationOnce(async () => { write(s.root, "hello.txt", "inspection race\n"); return f.evidence; });
  await expect(f.apply(plan.fingerprint)).rejects.toThrow("GIT PUBLISH PLAN CHANGED");
  const fresh = gitPublishPlan(s.workspace, s.fields);
  f.inspect.mockResolvedValue({ ...f.evidence, digest: "d".repeat(64) });
  await expect(f.reconciler.executeCheckpointAction(s.workspace, "publish", 2, plan.instruction, () => {}, () => true)).rejects.toThrow("RECONCILIATION EVIDENCE CHANGED");
  expect(fresh.fingerprint).not.toBe(plan.fingerprint);
});
it("requires exact approved instruction, stages 100644, commits exact paths, preserves WIP and never forces or uses a shell", async () => {
  const s = setup();
  write(s.root, "src/index.ts", "unrelated WIP\n"); write(s.root, "untracked.txt", "preserve\n"); write(s.root, "._metadata", "preserve metadata\n");
  git(s.root, "update-index", "--chmod=+x", "hello.txt");
  const f = actionFixture(s), plan = gitPublishPlan(s.workspace, s.fields); await f.approve(plan.instruction);
  await expect(f.apply(gitPublishPlan(s.workspace, { ...s.fields, commit_message: "wrong" }).fingerprint, { ...s.fields, commit_message: "wrong" })).rejects.toThrow("TASK REQUEST MISMATCH");
  const push = interceptPush(s.root); const before = git(s.root, "rev-parse", "HEAD").trim();
  const result = await f.apply(plan.fingerprint);
  expect(result).toMatchObject({
    previous_head: before, pushed: true, checkpoint_consumed: true, remote_tracking_verified: true,
    staged_files: ["hello.txt"], staged_modes: [{ path: "hello.txt", mode: "100644" }],
    committed_files: ["hello.txt"], committed_modes: [{ path: "hello.txt", mode: "100644" }],
  });
  expect(git(s.root, "diff-tree", "--no-commit-id", "--name-only", "-r", before, result.commit).trim()).toBe("hello.txt");
  expect(git(s.root, "ls-tree", "HEAD", "hello.txt")).toMatch(/^100644 blob /);
  expect(fs.readFileSync(path.join(s.root, "src/index.ts"), "utf8")).toBe("unrelated WIP\n");
  expect(fs.readFileSync(path.join(s.root, "untracked.txt"), "utf8")).toBe("preserve\n");
  expect(fs.readFileSync(path.join(s.root, "._metadata"), "utf8")).toBe("preserve metadata\n");
  const [, argv, options] = push.mock.calls[0];
  expect(argv.slice(-3)).toEqual(["--", "origin", `${result.commit}:refs/heads/main`]);
  expect(argv.some((arg: string) => /force|lease|delete/.test(arg))).toBe(false); expect(options.shell).toBeUndefined();
  expect(argv).toContain("credential.useHttpPath=false"); expect(argv).not.toContain("credential.useHttpPath=true");
  expect(options.env.GIT_CONFIG_GLOBAL).toBe("/dev/null"); expect(options.env.GIT_NO_LAZY_FETCH).toBe("1");
  const disk = JSON.parse(fs.readFileSync(f.file, "utf8"));
  expect(disk.checkpoints[0]).toMatchObject({ status: "consumed", consumed_action_id: result.action_id });
  expect(disk.checkpoints[0].consumed_run_id).toBeUndefined(); expect(disk.runs).toHaveLength(1);
  await expect(f.apply(plan.fingerprint)).rejects.toThrow(); expect(push).toHaveBeenCalledTimes(1);
  expect(() => f.journal.checkStart(s.workspace.id, "publish", 3, "next")).toThrow();
});
it("durably burns before stage, never retries after push failure, reopens consumed action snapshots", async () => {
  const s = setup(), f = actionFixture(s), plan = gitPublishPlan(s.workspace, s.fields); await f.approve(plan.instruction);
  const push = interceptPush(s.root, true), intercepted = vi.mocked(spawnSync).getMockImplementation()!;
  vi.mocked(spawnSync).mockImplementation(((binary: string, argv: string[], options: any) => {
    if (argv.includes("add")) expect(JSON.parse(fs.readFileSync(f.file, "utf8")).checkpoints[0].status).toBe("consumed");
    return intercepted(binary, argv, options);
  }) as typeof spawnSync);
  await expect(f.apply(plan.fingerprint)).rejects.toThrow("GIT PUBLISH PUSH FAILED NEW APPROVAL REQUIRED");
  const fresh = gitPublishPlan(s.workspace, s.fields);
  await expect(f.apply(fresh.fingerprint)).rejects.toThrow("CHECKPOINT UNAVAILABLE"); expect(push).toHaveBeenCalledTimes(1);
  f.reconciler.close(); f.journal.close();
  const reopened = new TaskJournal(s.workspace.id); closes.push(() => reopened.close());
  expect(reopened.checkpointStatus(s.workspace.id, "publish")[0]).toMatchObject({ status: "consumed" });
});
it("cannot mutate when durable consumption fails", async () => {
  const s = setup(), f = actionFixture(s), plan = gitPublishPlan(s.workspace, s.fields); await f.approve(plan.instruction);
  vi.spyOn(f.journal, "consumeCheckpointAction").mockImplementation(() => { throw new Error("disk unavailable"); });
  vi.mocked(spawnSync).mockClear(); await expect(f.apply(plan.fingerprint)).rejects.toThrow("disk unavailable");
  expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => (args as string[]).includes("add"))).toBe(false);
});
it("MCP exposes strict tools and requires scope plus authenticated trusted tunnel for mutation", async () => {
  const s = setup(), f = actionFixture(s);
  const server = createMcpServer({ workspace: s.workspace, logger: nullLogger, getTaskReconciler: () => f.reconciler });
  const [a, b] = InMemoryTransport.createLinkedPair(); const send = a.send.bind(a);
  let authInfo: any;
  a.send = (message, options) => send(message, { ...options, authInfo });
  const client = new Client({ name: "publish-boundary", version: "1" }); await server.connect(b); await client.connect(a);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === "git_publish_plan")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const applyTool = tools.find(t => t.name === "git_publish_checkpoint")!;
    expect(applyTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(applyTool.inputSchema.additionalProperties).toBe(false); expect(applyTool.inputSchema.required).toContain("workspace_id");
    const plan = gitPublishPlan(s.workspace, s.fields), args = { ...s.fields, fingerprint: plan.fingerprint, task_id: "publish", next_iteration: 2 };
    const call = async (name: string, arguments_: object) => {
      const result = await client.callTool({ name, arguments: arguments_ }); return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    expect((await call("git_publish_checkpoint", args)).error).toBe("TRUSTED_TUNNEL_REQUIRED");
    authInfo = { token: "oauth", clientId: "reader", scopes: ["codex.execute", "git.read"] };
    expect((await call("git_publish_checkpoint", args)).error).toBe("TRUSTED_TUNNEL_REQUIRED");
    authInfo = { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["git.read"] };
    expect((await call("git_publish_checkpoint", args)).error).toBe("INSUFFICIENT_SCOPE");
    expect((await call("git_publish_plan", s.fields)).fingerprint).toBe(plan.fingerprint);
    authInfo.scopes = ["codex.execute"];
    expect((await call("git_publish_plan", s.fields)).error).toBe("INSUFFICIENT_SCOPE");
    expect((await call("git_publish_checkpoint", args)).error).toBe("CHECKPOINT_UNAVAILABLE");
  } finally { await client.close(); await server.close(); }
});
