import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { gitPushPlan, gitPushCheckpoint, gitPublishPlan } from "../src/workspace/git.js";
import { TaskJournalError } from "../src/execution/task-journal.js";
import { TaskReconciler } from "../src/execution/task-reconciler.js";
import { approvalMessage } from "../src/execution/reconciliation-approval.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => { throw new Error("Unexpected subprocess"); }), execFile: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawnSync).mockReset(); for (const root of roots.splice(0)) cleanup(root); });
function fixture() {
  const root = makeTmpDir("push-hermetic"); roots.push(root);
  fs.mkdirSync(path.join(root, ".git/objects"), { recursive: true });
  const commit = "a".repeat(40), parent = "b".repeat(40);
  write(root, ".git/HEAD", "ref: refs/heads/main\n");
  write(root, ".git/refs/heads/main", commit + "\n");
  write(root, ".git/refs/remotes/origin/main", parent + "\n");
  write(root, ".git/config", "[core]\nrepositoryformatversion = 0\nbare = false\n");
  write(root, ".git/index", "mock index");
  const data = "verified content\n"; write(root, "hello.txt", data);
  const blob = createHash("sha1").update(`blob ${Buffer.byteLength(data)}\0`).update(data).digest("hex");
  const workspace = { id: "a".repeat(24), root, name: "fixture" };
  const fields = { workspace_id: workspace.id, paths: ["hello.txt"], commit_message: "Reviewed commit", remote: "origin", branch: "main" };
  const state = { parents: `${commit} ${parent}\n`, message: fields.commit_message + "\n", names: "hello.txt\0",
    entries: `100644 blob ${blob}\thello.txt\0`, staged: "", tracking: parent, keys: "core.bare\0",
    url: "https://github.com/example/fixture.git\0", failed: false, updateTracking: true, pushCount: 0, beforePush: () => {} };
  vi.mocked(spawnSync).mockImplementation(((_binary: string, argv: string[]) => {
    let stdout = "";
    if (argv.includes("--exec-path")) stdout = "/Library/Developer/CommandLineTools/usr/libexec/git-core\n";
    else if (argv.includes("config")) {
      stdout = argv.includes("--name-only") ? state.keys : argv.at(-1) === "remote.origin.url" ? state.url : "+refs/heads/*:refs/remotes/origin/*\0";
    } else if (argv.includes("rev-list")) stdout = state.parents;
    else if (argv.includes("cat-file")) stdout = "tree " + "c".repeat(40) + "\n\n" + state.message;
    else if (argv.includes("diff-tree")) stdout = state.names;
    else if (argv.includes("ls-tree")) stdout = state.entries;
    else if (argv.includes("diff")) stdout = state.staged;
    else if (argv.includes("ls-files")) stdout = "";
    else if (argv.includes("rev-parse")) stdout = argv.at(-1) === "HEAD" ? commit : state.tracking;
    else if (argv.includes("push")) {
      state.beforePush(); state.pushCount++;
      if (state.failed) return { status: 128, stdout: "", stderr: "credential must never escape" };
      if (state.updateTracking) state.tracking = commit;
    } else throw new Error("Unexpected Git command: " + argv.join(" "));
    return { status: 0, stdout, stderr: "" };
  }) as typeof spawnSync);
  return { workspace, fields, state, commit, parent, root };
}
function action(s: ReturnType<typeof fixture>) {
  const plan = gitPushPlan(s.workspace, s.fields);
  const evidence = { digest: "e".repeat(64), head: s.commit, fileCount: 1, changedCount: 0,
    processScope: "same-user-cwd", fileScope: "git-index-status-and-dirty-worktree-excluding-appledouble" };
  const file = write(s.root, "checkpoint.json", JSON.stringify({ status: "approved" }));
  const journal = {
    approvedCheckpoint: vi.fn((_id, _task, _next, instruction) => {
      if (JSON.parse(fs.readFileSync(file, "utf8")).status !== "approved") throw new TaskJournalError("CHECKPOINT_UNAVAILABLE", "Checkpoint unavailable");
      if (instruction !== plan.instruction) throw new TaskJournalError("TASK_REQUEST_MISMATCH", "Instruction mismatch");
      return { evidence_sha256: evidence.digest, checkpoint_id: "c".repeat(32) };
    }),
    consumeCheckpointAction: vi.fn(() => { fs.writeFileSync(file, JSON.stringify({ status: "consumed" })); }),
  };
  const inspect = vi.fn(async () => evidence);
  const reconciler = new TaskReconciler({ journal: journal as never, inspect: inspect as never, approve: async () => "approved", isBusy: () => false });
  s.state.beforePush = () => expect(JSON.parse(fs.readFileSync(file, "utf8")).status).toBe("consumed");
  const apply = (fingerprint = plan.fingerprint, fields = s.fields) => gitPushCheckpoint(s.workspace as never, reconciler, fields, fingerprint, "same", 2);
  return { plan, apply, journal, inspect, file, reconciler, evidence };
}
it("accepts exact provenance read-only without network or Git subprocess execution", () => {
  const s = fixture(), plan = gitPushPlan(s.workspace, s.fields);
  expect(gitPublishPlan(s.workspace, s.fields).instruction).toMatch(/^C2C Git publish v1:/);
  expect(plan).toMatchObject({ ...s.fields, commit: s.commit, parent: s.parent });
  expect(plan.instruction).toMatch(/^C2C Git push recovery v1:/);
  expect(gitPushPlan(s.workspace, s.fields)).toEqual(plan);
  expect(JSON.stringify(plan)).not.toContain("https://");
  expect(s.state.pushCount).toBe(0);
  expect(() => gitPushPlan(s.workspace, { ...s.fields, argv: ["--force"] } as never)).toThrow();
});
it.each(["merge", "root", "branch", "message", "paths", "mode", "blob", "staged", "tracking", "missing-tracking", "config", "remote", "executable"])("rejects %s", kind => {
  const s = fixture();
  if (kind === "merge") s.state.parents += " " + "d".repeat(40);
  if (kind === "root") s.state.parents = s.commit;
  if (kind === "branch") write(s.root, ".git/HEAD", "ref: refs/heads/other\n");
  if (kind === "message") s.state.message = "wrong\n";
  if (kind === "paths") s.state.names = "other.txt\0";
  if (kind === "mode") s.state.entries = s.state.entries.replace("100644", "100755");
  if (kind === "blob") s.state.entries = s.state.entries.replace(/blob [a-f0-9]{40}/, "blob " + "d".repeat(40));
  if (kind === "staged") s.state.staged = "hello.txt\0";
  if (kind === "tracking") s.state.tracking = s.commit;
  if (kind === "missing-tracking") s.state.tracking = "";
  if (kind === "config") s.state.keys = "credential.helper\0";
  if (kind === "remote") s.state.url = "ssh://github.com/example/fixture.git\0";
  if (kind === "executable") {
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      const stat = lstat(file, options as never) as fs.Stats; if (file === "/usr/bin/git") stat.mode |= 0o002; return stat;
    }) as typeof fs.lstatSync);
  }
  expect(() => gitPushPlan(s.workspace, s.fields)).toThrow();
});
it.each(["file", "index", "config", "remote", "tracking-ref", "head"])("binds changed %s before checkpoint consumption", async kind => {
  const s = fixture(), f = action(s);
  if (kind === "remote") s.state.url = "https://github.com/example/other.git\0";
  else write(s.root, kind === "file" ? "hello.txt" : kind === "tracking-ref" ? ".git/refs/remotes/origin/main" : kind === "head" ? ".git/refs/heads/main" : ".git/" + kind, "changed");
  await expect(f.apply()).rejects.toThrow();
  expect(f.journal.consumeCheckpointAction).not.toHaveBeenCalled(); expect(s.state.pushCount).toBe(0);
});
it("consumes once before push, uses host credentials and only fixed non-force push", async () => {
  const s = fixture(), f = action(s);
  expect(await f.apply()).toMatchObject({ workspace_id: s.workspace.id, commit: s.commit, parent: s.parent,
    remote: "origin", branch: "main", pushed: true, remote_tracking_verified: true, checkpoint_consumed: true });
  const calls = vi.mocked(spawnSync).mock.calls;
  const [, argv, options] = calls.find(([, args]) => (args as string[]).includes("push"))!;
  expect(argv).toContain("credential.useHttpPath=false"); expect(argv).not.toContain("credential.useHttpPath=true");
  expect((argv as string[]).slice(-3)).toEqual(["--", "origin", `${s.commit}:refs/heads/main`]);
  expect((options as any).shell).toBeUndefined();
  expect((options as any).env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_NO_LAZY_FETCH: "1" });
  for (const [, args] of calls) expect((args as string[]).slice((args as string[]).findIndex(a => a.startsWith("--work-tree=")) + 1, (args as string[]).findIndex(a => a.startsWith("--work-tree=")) + 2).some(a => ["add", "commit", "commit-tree", "update-ref", "fetch", "--force", "--force-with-lease", "--delete", "tag"].includes(a))).toBe(false);
});
it("failure burns checkpoint without reuse or automatic retry", async () => {
  const s = fixture(), f = action(s); s.state.failed = true;
  await expect(f.apply()).rejects.toThrow("GIT PUBLISH PUSH FAILED NEW APPROVAL REQUIRED");
  await expect(f.apply()).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
  expect(s.state.pushCount).toBe(1);
});
it("does not push when durable consumption fails or approval is expired", async () => {
  const s = fixture(), f = action(s);
  f.journal.consumeCheckpointAction.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
  await expect(f.apply()).rejects.toThrow("disk unavailable");
  expect(s.state.pushCount).toBe(0);
  fs.writeFileSync(f.file, JSON.stringify({ status: "expired" }));
  await expect(f.apply()).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
  expect(s.state.pushCount).toBe(0);
});
it("requires the exact recovery instruction and fingerprint", async () => {
  const s = fixture(), f = action(s);
  await expect(f.apply("d".repeat(64))).rejects.toThrow("GIT PUSH PLAN CHANGED");
  f.journal.approvedCheckpoint.mockImplementationOnce(() => { throw new TaskJournalError("TASK_REQUEST_MISMATCH", "Instruction mismatch"); });
  await expect(f.apply()).rejects.toMatchObject({ code: "TASK_REQUEST_MISMATCH" });
  expect(f.journal.consumeCheckpointAction).not.toHaveBeenCalled(); expect(s.state.pushCount).toBe(0);
});
it("requires tracking verification after push and burns failed verification", async () => {
  const s = fixture(), f = action(s); s.state.updateTracking = false;
  await expect(f.apply()).rejects.toThrow("TRACKING MISMATCH NEW APPROVAL REQUIRED");
  await expect(f.apply()).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" }); expect(s.state.pushCount).toBe(1);
});
it("revalidates after evidence inspection and again inside consumed action", async () => {
  const s = fixture(), f = action(s);
  f.inspect.mockImplementationOnce(async () => { write(s.root, "hello.txt", "race"); return f.evidence; });
  await expect(f.apply()).rejects.toThrow(); expect(s.state.pushCount).toBe(0);
});
it("revalidates inside action after burn", async () => {
  const s = fixture(), f = action(s);
  f.journal.consumeCheckpointAction.mockImplementationOnce(() => { fs.writeFileSync(f.file, JSON.stringify({ status: "consumed" })); write(s.root, "hello.txt", "race after burn"); });
  await expect(f.apply()).rejects.toThrow(); expect(s.state.pushCount).toBe(0);
});
it("MCP exposes recovery under reconciler gate with strict scopes and tunnel", async () => {
  const s = fixture(), f = action(s);
  const server = createMcpServer({ workspace: s.workspace as never, logger: nullLogger, getTaskReconciler: () => f.reconciler });
  const [a, b] = InMemoryTransport.createLinkedPair(); const send = a.send.bind(a); let authInfo: any;
  a.send = (message, options) => send(message, { ...options, authInfo });
  const client = new Client({ name: "push-hermetic", version: "1" }); await server.connect(b); await client.connect(a);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === "git_push_plan")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools.find(t => t.name === "git_push_checkpoint")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tools.find(t => t.name === "git_push_checkpoint")?.inputSchema.additionalProperties).toBe(false);
    const args = { ...s.fields, fingerprint: f.plan.fingerprint, task_id: "same", next_iteration: 2 };
    const call = async (name: string, arguments_: object) => JSON.parse(((await client.callTool({ name, arguments: arguments_ })).content as any)[0].text);
    expect((await call("git_push_checkpoint", args)).error).toBe("TRUSTED_TUNNEL_REQUIRED");
    authInfo = { token: "oauth", clientId: "reader", scopes: ["codex.execute", "git.read"] };
    expect((await call("git_push_checkpoint", args)).error).toBe("TRUSTED_TUNNEL_REQUIRED");
    authInfo = { token: "trusted-tunnel", clientId: "openai-secure-tunnel", scopes: ["git.read"] };
    expect((await call("git_push_checkpoint", args)).error).toBe("INSUFFICIENT_SCOPE");
    expect((await call("git_push_plan", s.fields)).fingerprint).toBe(f.plan.fingerprint);
    authInfo.scopes = ["codex.execute"];
    expect((await call("git_push_plan", s.fields)).error).toBe("INSUFFICIENT_SCOPE");
    fs.writeFileSync(f.file, JSON.stringify({ status: "expired" }));
    expect((await call("git_push_checkpoint", args)).error).toBe("CHECKPOINT_UNAVAILABLE");
  } finally { await client.close(); await server.close(); }
  const gated = createMcpServer({ workspace: s.workspace as never, logger: nullLogger });
  const [c, d] = InMemoryTransport.createLinkedPair(); const reader = new Client({ name: "gated", version: "1" });
  await gated.connect(d); await reader.connect(c);
  try { expect((await reader.listTools()).tools.some(t => t.name.startsWith("git_push_"))).toBe(false); }
  finally { await reader.close(); await gated.close(); }
});
it("shows distinct bounded one-time push-only approval text", () => {
  const s = fixture(), f = action(s);
  const prompt: any = { workspaceName: "fixture", workspaceRoot: s.root, taskId: "same", evidence: { digest: "e".repeat(64) },
    checkpoint: { instruction_excerpt: f.plan.instruction, next_iteration: 2, request_sha256: "b".repeat(64) } };
  const message = approvalMessage(prompt);
  for (const term of ["検証済みローカルcommit", "non-force HTTPS push", "stage・commit・reset・clean・shell", "60秒", "1回限り", "push前に消費", "新しい承認", "自動再試行はしません"]) expect(message).toContain(term);
  expect(message).not.toContain("100644でstage");
  prompt.checkpoint.instruction_excerpt += "x".repeat(2049);
  expect(() => approvalMessage(prompt)).toThrow("Invalid approval display data");
});
