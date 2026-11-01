import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import express from "express";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { ensureTrustedTunnelToken } from "../src/auth/trusted-tunnel.js";
import { Workspace } from "../src/workspace/manager.js";
import { TaskJournal } from "../src/execution/task-journal.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import { notificationId } from "../src/notifications/delivery-store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));

const dirs: string[] = [];
let bridge: Bridge | undefined;
afterEach(async () => {
  await bridge?.close(); bridge = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

it("recovers a non-selected approved profile without Codex, selection changes, approvals or old-history notices", async () => {
  // This source fixture exercises startup wiring without a socket or active bridge.
  vi.spyOn(express.application, "listen").mockImplementation(() => {
    const server = Object.assign(new EventEmitter(), { address: () => ({ port: 0 }), close: (done: () => void) => done() });
    queueMicrotask(() => server.emit("listening"));
    return server as any;
  });
  const state = isolateStateDir(); dirs.push(state); vi.stubEnv("C2C_STATE_DIR", state);
  const root = makeTmpDir("notice-profiles"); dirs.push(root);
  for (const name of ["alpha", "beta"]) fs.mkdirSync(path.join(root, name));
  const alpha = new Workspace(path.join(root, "alpha")), beta = new Workspace(path.join(root, "beta"));
  const config = path.join(root, "profiles.json");
  fs.writeFileSync(config, JSON.stringify({ version: 1, defaultProfileId: "alpha", profiles: [
    { id: "alpha", path: alpha.root }, { id: "beta", path: beta.root },
  ] }), { mode: 0o600 });
  const selection = path.join(state, "workspace-selection", alpha.id + ".json");
  fs.mkdirSync(path.dirname(selection), { mode: 0o700 });
  fs.writeFileSync(selection, JSON.stringify({ version: 1, profileId: "alpha" }), { mode: 0o600 });
  const selected = fs.readFileSync(selection, "utf8");
  const journal = new TaskJournal(beta.id);
  const run = { task_id: "non-selected", iteration: 1, run_id: "a".repeat(32), state: "running" as const, execution_mode: "read_only" as const };
  journal.begin(beta.id, run, "fixture"); journal.complete(beta.id, { ...run, state: "completed" }); journal.close();
  const main = path.join(state, "task-journal", beta.id + ".json"), before = fs.readFileSync(main, "utf8");
  const start = vi.spyOn(CodexAppServer.prototype, "startTurn");
  const reply = vi.spyOn(CodexAppServer.prototype, "reply");
  const approve = vi.fn(), inspect = vi.fn(), sound = vi.fn();
  const notify = vi.fn(async () => ({ outcome: "notice_acknowledged" as const }));
  const opts = { workspaceRoot: alpha.root, workspaceProfilesFile: config, port: 0, persistRuntime: false,
    codexExecution: true, codexBinary: "/usr/bin/true", trustedTunnelTokenFile: ensureTrustedTunnelToken(alpha.id).file,
    runNotifier: notify, completionNotifier: sound, reconciliationApprove: approve, reconciliationInspect: inspect };
  bridge = await startBridge(opts);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toMatchObject({ workspace_id: beta.id, notification_id: notificationId(beta.id, run.run_id, "terminal") });
  await bridge.close(); bridge = undefined;
  bridge = await startBridge(opts);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(sound).not.toHaveBeenCalled();
  expect(fs.readFileSync(selection, "utf8")).toBe(selected); expect(fs.readFileSync(main, "utf8")).toBe(before);
});
