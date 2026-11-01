import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalEvidence, OWNER_COMMANDS, readOwnerTestEvidence } from "../src/execution/owner-test-evidence.js";
import { createMcpServer } from "../src/mcp/server.js";
import { nullLogger } from "../src/logger/index.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const id = "a".repeat(24), root = "/workspace", file = `/state/owner-test-evidence/${id}.json`;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
  vi.stubEnv("C2C_STATE_DIR", "/state");
  const entries = new Map<string, { data: Buffer; mode: number; dir: boolean; link: boolean; nlink: number; ino: number }>();
  const put = (p: string, data = "", dir = false, mode = dir ? 0o700 : 0o600) => entries.set(p, { data: Buffer.from(data), dir, mode, link: false, nlink: 1, ino: entries.size + 1 });
  put("/", "", true, 0o755); put("/state", "", true); put("/state/owner-test-evidence", "", true); put(root, "", true);
  const manifest: Record<string, string> = {};
  for (const name of ["src", "tests", "scripts", "skill"]) {
    put(`${root}/${name}`, "", true); put(`${root}/${name}/example`, "source"); manifest[`${name}/example`] = hash("source");
  }
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts"]) {
    put(`${root}/${name}`, "source"); manifest[name] = hash("source");
  }
  const result = { status: "passed", source_after: "matched", commands: OWNER_COMMANDS.map((command, i) => ({ command, exit_code: 0, complete: true,
    counts: i === 1 ? { passed: 12, failed: 0, skipped: 0, total: 12 } : null,
    test_files: i === 1 ? { passed: 1, failed: 0, skipped: 0, total: 1 } : null })) };
  const receipt: any = { schema_version: 1, source: "fixed-owner-runner", workspace_id: id, workspace_root: root,
    recorded_at: new Date().toISOString(), runner_manifest_sha256: "b".repeat(64), raw_result_sha256: "c".repeat(64),
    manifest, manifest_sha256: hash(canonicalEvidence(manifest)), result, result_sha256: hash(canonicalEvidence(result)) };
  const save = () => put(file, JSON.stringify(receipt)); save();
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const stat = (p: string) => {
    const e = entries.get(p); if (!e) throw missing();
    return { size: e.data.length, dev: 1, ino: e.ino, mode: e.mode, uid: process.getuid?.(), nlink: e.nlink, mtimeMs: 1, ctimeMs: 1,
      isFile: () => !e.dir && !e.link, isDirectory: () => e.dir, isSymbolicLink: () => e.link } as fs.Stats;
  };
  const descriptors = new Map<number, { p: string; offset: number }>(); let next = 1;
  vi.spyOn(fs.realpathSync, "native").mockImplementation(p => { if (!entries.has(String(p))) throw missing(); return String(p); });
  vi.spyOn(fs, "lstatSync").mockImplementation(p => stat(String(p)) as any);
  vi.spyOn(fs, "existsSync").mockImplementation(p => entries.has(String(p)));
  vi.spyOn(fs, "readdirSync").mockImplementation(p => [...entries.keys()].filter(n => n.startsWith(String(p) + "/") && !n.slice(String(p).length + 1).includes("/")).map(n => n.slice(String(p).length + 1)) as any);
  vi.spyOn(fs, "openSync").mockImplementation(p => { stat(String(p)); descriptors.set(next, { p: String(p), offset: 0 }); return next++; });
  vi.spyOn(fs, "fstatSync").mockImplementation(fd => stat(descriptors.get(fd)!.p) as any);
  vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    const d = descriptors.get(fd)!, data = entries.get(d.p)!.data, start = position ?? d.offset;
    const n = Math.min(length, data.length - start); data.copy(buffer, offset, start, start + n); d.offset = start + n; return n;
  }) as any);
  vi.spyOn(fs, "closeSync").mockImplementation(fd => { descriptors.delete(fd); });
  return { entries, put, receipt, save };
}

it("reads genuine bound evidence without writing or attributing it to a task", () => {
  fixture(); const write = vi.spyOn(fs, "writeFileSync");
  expect(readOwnerTestEvidence(id, root)).toMatchObject({ available: true, status: "passed", current_match: true, stale: false, applies_to_latest_task: false });
  expect(write).not.toHaveBeenCalled();
});

it("roundtrips a real Python-derived receipt through the TypeScript reader", () => {
  // Derive before the virtual filesystem is installed; Python never writes state.
  const code = "import runpy,json; m=runpy.run_path('tests/test_owner_test_evidence.py'); t=m['ReceiptTests'](); d=t.fixture(); print(json.dumps(t.derive(d)))";
  const output = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8", timeout: 10000 });
  expect(output.status, output.stderr).toBe(0);
  const derived = JSON.parse(output.stdout);
  const f = fixture();
  // Use the actual Python payload unchanged. Its one-file source manifest is
  // intentionally historical relative to the virtual current source tree.
  f.put(file, JSON.stringify(derived));
  expect(readOwnerTestEvidence(id, root)).toMatchObject({ available: true, status: "passed", stale: true,
    commands: [{}, { counts: { total: 12 }, test_files: { total: 1 } }, {}, {}] });
});

it("refuses an old claimed PASS lacking explicit file counts", () => {
  const f = fixture(); delete f.receipt.result.commands[1].test_files;
  f.receipt.result_sha256 = hash(canonicalEvidence(f.receipt.result)); f.save();
  expect(readOwnerTestEvidence(id, root)).toMatchObject({ available: false, reason: "OWNER_EVIDENCE_RESULT_INVALID" });
});

it.each(["absent", "malformed", "wrong-workspace", "wrong-root", "symlink", "hardlink", "permissions", "ancestor", "future", "hash", "forged-pass", "workspace-copy"])("refuses %s receipt", mode => {
  const f = fixture();
  if (mode === "absent") f.entries.delete(file);
  if (mode === "malformed") f.put(file, "{}");
  if (mode === "wrong-workspace") { f.receipt.workspace_id = "d".repeat(24); f.save(); }
  if (mode === "wrong-root") { f.receipt.workspace_root = "/elsewhere"; f.save(); }
  if (mode === "symlink") f.entries.get(file)!.link = true;
  if (mode === "hardlink") f.entries.get(file)!.nlink = 2;
  if (mode === "permissions") f.entries.get(file)!.mode = 0o644;
  if (mode === "ancestor") f.entries.get("/state")!.mode = 0o777;
  if (mode === "future") { f.receipt.recorded_at = new Date(Date.now() + 3600000).toISOString(); f.save(); }
  if (mode === "hash") { f.receipt.result_sha256 = "0".repeat(64); f.save(); }
  if (mode === "forged-pass") { f.receipt.result.commands = []; f.receipt.result_sha256 = hash(canonicalEvidence(f.receipt.result)); f.save(); }
  if (mode === "workspace-copy") { vi.stubEnv("C2C_STATE_DIR", "/workspace/.local/state"); }
  expect(readOwnerTestEvidence(id, root).available).toBe(false);
});

it.each(["changed", "added", "unreadable"])("marks historical success stale when source is %s", mode => {
  const f = fixture();
  if (mode === "changed") f.put(root + "/src/example", "changed");
  if (mode === "added") f.put(root + "/src/new", "new");
  if (mode === "unreadable") f.entries.get(root + "/src/example")!.link = true;
  expect(readOwnerTestEvidence(id, root)).toMatchObject({ available: true, status: "passed", current_match: false, stale: true });
});

it.each(["failed", "partial"])("retains a %s fixed run without manufacturing missing counts", status => {
  const f = fixture();
  f.receipt.result.status = status;
  f.receipt.result.commands = f.receipt.result.commands.slice(0, 1);
  f.receipt.result.commands[0].exit_code = status === "failed" ? 1 : null;
  f.receipt.result.commands[0].complete = false;
  f.receipt.result_sha256 = hash(canonicalEvidence(f.receipt.result)); f.save();
  expect(readOwnerTestEvidence(id, root)).toMatchObject({ available: true, status, commands: [{ counts: null }] });
});

it("test_status preserves a newer unrelated task with no tests alongside trusted owner evidence", async () => {
  const f = fixture();
  f.put("/state/executions", "", true);
  f.put(`/state/executions/${id}.jsonl`, JSON.stringify({ taskId: "newer-unrelated", iteration: 1, tests: null, changedFiles: null, exitStatus: "ok", timestamp: new Date().toISOString() }) + "\n");
  const write = vi.spyOn(fs, "writeFileSync");
  const server = createMcpServer({ workspace: { id, root } as any, logger: nullLogger });
  const client = new Client({ name: "owner-receipt-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const response: any = await client.callTool({ name: "test_status", arguments: {} });
    expect(JSON.parse(response.content[0].text)).toMatchObject({ available: false, taskId: "newer-unrelated", tests: null,
      owner_validation: { available: true, status: "passed", current_match: true, applies_to_latest_task: false } });
    expect(write).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});
