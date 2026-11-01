import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceRegistration, type FolderOwner, type FolderDecision, type FolderApprovalPrompt, type WorkspaceRemovalPrompt } from "../src/workspace/registration.js";
import { WorkspaceProfiles } from "../src/workspace/profiles.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { vi.useRealTimers(); for (const f of cleanups.splice(0).reverse()) await f(); vi.restoreAllMocks(); });
function setup(decision: FolderDecision = "approved") {
  const previous = process.env.C2C_STATE_DIR, state = isolateStateDir(), root = makeTmpDir("registration");
  cleanups.push(() => { cleanup(root); cleanup(state); if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous; });
  write(root, "alpha/marker.txt", "original"); write(root, "beta/marker.txt", "new project");
  const workspace = new Workspace(path.join(root, "alpha"));
  const config = write(root, "profiles.json", JSON.stringify({ version: 1, defaultProfileId: "alpha", profiles: [
    { id: "alpha", path: workspace.root, codexNetworkHosts: ["example.com"] },
  ] }));
  fs.chmodSync(config, 0o600);
  const profiles = WorkspaceProfiles.load(workspace, config)!;
  const choose = vi.fn(async () => path.join(root, "beta"));
  const approve = vi.fn(async (_prompt: FolderApprovalPrompt | WorkspaceRemovalPrompt, _signal: AbortSignal): Promise<FolderDecision> => decision);
  const owner: FolderOwner = { supported: true, choose, approve };
  const registration = new WorkspaceRegistration(profiles, owner);
  cleanups.push(() => registration.close());
  return { root, config, workspace, profiles, choose, approve, owner, registration };
}
function setupRemoval(safety: "clear" | "blocking" | "unknown" = "clear", decision: FolderDecision = "approved") {
  const s = setup(decision);
  s.profiles.commitApprovedAddition(s.profiles.prepareAddition(path.join(s.root, "beta")));
  const registration = new WorkspaceRegistration(s.profiles, s.owner, () => safety);
  cleanups.push(() => registration.close());
  return { ...s, registration };
}
function view(service: WorkspaceRegistration, id: string): any { return service.status(id); }
async function settled(service: WorkspaceRegistration, id: string) {
  await expect.poll(() => view(service, id).state, { timeout: 2000 }).not.toMatch(/queued|selecting_folder|awaiting_owner/);
  return view(service, id);
}

it("bounds registration beyond the native selection and approval envelope", () => {
  const s = setup();
  const timer = vi.spyOn(globalThis, "setTimeout");
  s.registration.start();
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 5_590_000);
  s.registration.cancelPending();
});

it("adds only the owner-picked folder without restart or selection change, with no repeated write on status", async () => {
  const s = setup(); const initial = s.profiles.current();
  const started: any = s.registration.start();
  expect(started.state).toBe("queued"); expect(s.choose).not.toHaveBeenCalled();
  const end = await settled(s.registration, started.registration_id);
  expect(end.state).toBe("registered"); expect(end.selection_changed).toBe(false);
  expect(end.restart_required).toBe(false); expect(end.network_permissions_added).toBe(false);
  expect(s.profiles.current()).toBe(initial); expect(s.profiles.count).toBe(2);
  expect(s.profiles.get(end.profile.id).codexNetworkHosts).toEqual([]);
  expect(s.approve).toHaveBeenCalledTimes(1);
  expect(s.approve.mock.calls[0]?.[0]).toMatchObject({ workspaceRoot: path.join(s.root, "beta") });
  const stored = fs.readFileSync(s.config, "utf8");
  expect(WorkspaceProfiles.load(s.workspace, s.config)!.count).toBe(2);
  s.registration.status(started.registration_id);
  expect(fs.readFileSync(s.config, "utf8")).toBe(stored);
  expect(JSON.stringify(end)).not.toContain(s.root);
  const duplicate: any = s.registration.start();
  expect((await settled(s.registration, duplicate.registration_id)).state).toBe("already_registered");
  expect(s.approve).toHaveBeenCalledTimes(1); expect(fs.readFileSync(s.config, "utf8")).toBe(stored);
});

it.each(["denied", "timed_out", "unavailable"] as const)("does not grant access for owner result %s", async decision => {
  const s = setup(decision), before = fs.readFileSync(s.config, "utf8");
  const start: any = s.registration.start();
  expect((await settled(s.registration, start.registration_id)).state).toBe("denied");
  expect(s.profiles.count).toBe(1); expect(fs.readFileSync(s.config, "utf8")).toBe(before);
});

it("deduplicates pending requests and cancels a late approval after revocation", async () => {
  const s = setup(); let resolve!: (d: FolderDecision) => void;
  s.owner.approve = () => new Promise(r => { resolve = r; });
  const a: any = s.registration.start(); const b: any = s.registration.start();
  expect(a.registration_id).toBe(b.registration_id);
  await expect.poll(() => view(s.registration, a.registration_id).state).toBe("awaiting_owner");
  const before = fs.readFileSync(s.config, "utf8");
  s.registration.cancelPending(); resolve("approved");
  await new Promise(r => setTimeout(r, 10));
  expect(view(s.registration, a.registration_id).state).toBe("cancelled");
  expect(fs.readFileSync(s.config, "utf8")).toBe(before); expect(s.profiles.count).toBe(1);
});

it("rejects a configuration change while the owner is reviewing", async () => {
  const s = setup();
  s.owner.approve = async () => { fs.appendFileSync(s.config, "\n"); return "approved"; };
  const a: any = s.registration.start();
  expect((await settled(s.registration, a.registration_id)).state).toBe("blocked");
  expect(s.profiles.count).toBe(1);
});

it("does not reuse approval after a persistence failure", async () => {
  const s = setup();
  const commit = vi.spyOn(s.profiles, "commitApprovedAddition").mockImplementation(() => { throw new Error("disk failure"); });
  const a: any = s.registration.start();
  expect((await settled(s.registration, a.registration_id)).state).toBe("blocked");
  s.registration.status(a.registration_id); s.registration.status(a.registration_id);
  expect(commit).toHaveBeenCalledTimes(1); expect(s.approve).toHaveBeenCalledTimes(1);
});

it("does not fabricate a platform capability or accept an unknown request", () => {
  const s = setup(); const unavailable = new WorkspaceRegistration(s.profiles, { ...s.owner, supported: false });
  expect(() => unavailable.start()).toThrow(/not supported/);
  expect(() => s.registration.status("f".repeat(32))).toThrow(/never issued/);
  s.registration.close(); expect(() => s.registration.start()).toThrow(/closed/);
  expect(s.choose).not.toHaveBeenCalled();
});

it("unregisters only an approved non-selected project after a separate owner approval", async () => {
  const s = setupRemoval(); const before = fs.readFileSync(s.config, "utf8");
  const started: any = s.registration.unregisterStart(s.profiles.list().find(p => p.id !== "alpha")!.id);
  expect(started).toMatchObject({ operation: "unregister", state: "queued" });
  const done = await settled(s.registration, started.registration_id);
  expect(done).toMatchObject({ operation: "unregister", state: "unregistered", profile: { id: expect.any(String) } });
  expect(s.profiles.count).toBe(1); expect(fs.readFileSync(path.join(s.root, "beta", "marker.txt"), "utf8")).toBe("new project");
  expect(fs.readFileSync(s.config, "utf8")).not.toBe(before);
  expect(s.approve).toHaveBeenCalledWith(expect.not.objectContaining({ workspaceRoot: expect.anything() }), expect.any(AbortSignal));
  expect(JSON.stringify(done)).not.toContain(s.root);
});

it.each(["blocking", "unknown"] as const)("refuses unregistration when task state is %s", safety => {
  const s = setupRemoval(safety); const id = s.profiles.list().find(p => p.id !== "alpha")!.id, before = fs.readFileSync(s.config, "utf8");
  expect(() => s.registration.unregisterStart(id)).toThrow(safety === "blocking" ? /running or waiting/ : /cannot be safely verified/);
  expect(s.approve).not.toHaveBeenCalled(); expect(fs.readFileSync(s.config, "utf8")).toBe(before);
});

it("rechecks task safety and config after owner approval before removal", async () => {
  const s = setupRemoval(); const id = s.profiles.list().find(p => p.id !== "alpha")!.id;
  let safety: "clear" | "blocking" = "clear";
  const registration = new WorkspaceRegistration(s.profiles, { ...s.owner, approve: async () => { safety = "blocking"; return "approved"; } }, () => safety);
  cleanups.push(() => registration.close()); const started: any = registration.unregisterStart(id);
  expect((await settled(registration, started.registration_id)).state).toBe("blocked");
  expect(s.profiles.get(id)).toBeDefined();
});

it("deduplicates only the same pending unregistration and keeps owner approval bound to its profile", async () => {
  const s = setupRemoval();
  const [alpha, beta] = s.profiles.list();
  let resolve!: (decision: FolderDecision) => void;
  s.owner.approve = () => new Promise(r => { resolve = r; });
  const first: any = s.registration.unregisterStart(beta.id);
  const same: any = s.registration.unregisterStart(beta.id);
  expect(same.registration_id).toBe(first.registration_id);
  expect(() => s.registration.unregisterStart(alpha.id)).toThrow("Another workspace registration operation is awaiting its owner decision.");
  expect(() => s.registration.start()).toThrow("Another workspace registration operation is awaiting its owner decision.");
  await expect.poll(() => view(s.registration, first.registration_id).state).toBe("awaiting_owner");
  s.registration.cancelPending(); resolve("approved");
  await new Promise(r => setTimeout(r, 10));
  expect(view(s.registration, first.registration_id)).toMatchObject({ state: "cancelled", operation: "unregister" });
  expect(s.profiles.get(beta.id)).toBeDefined();
});

it("times out an unregistration without consuming approval or changing persistent profiles", async () => {
  vi.useFakeTimers();
  const s = setupRemoval(); const beta = s.profiles.list().find(p => p.id !== "alpha")!;
  const before = fs.readFileSync(s.config, "utf8");
  s.owner.approve = () => new Promise(() => {});
  const started: any = s.registration.unregisterStart(beta.id);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_590_000);
  expect(view(s.registration, started.registration_id)).toMatchObject({ state: "blocked", code: "WORKSPACE_UNREGISTRATION_TIMEOUT" });
  expect(fs.readFileSync(s.config, "utf8")).toBe(before); expect(s.profiles.get(beta.id)).toBeDefined();
});

it("evicts only terminal runtime history after 64 results without rewriting profiles", async () => {
  const s = setup();
  const ids: string[] = [];
  for (let i = 0; i < 64; i++) {
    const job: any = s.registration.start(); ids.push(job.registration_id);
    await settled(s.registration, job.registration_id);
  }
  const stored = fs.readFileSync(s.config, "utf8");
  const next: any = s.registration.start();
  await settled(s.registration, next.registration_id);
  expect(() => s.registration.status(ids[0]!)).toThrow("This registration result expired from bounded runtime history");
  expect(s.registration.status(ids[63]!)).toMatchObject({ registration_id: ids[63] });
  expect(fs.readFileSync(s.config, "utf8")).toBe(stored);
});

it("does not evict an active unregistration at the history bound", async () => {
  const s = setupRemoval(); const beta = s.profiles.list().find(p => p.id !== "alpha")!;
  for (let i = 0; i < 63; i++) await settled(s.registration, (s.registration.start() as any).registration_id);
  s.owner.approve = () => new Promise(() => {});
  const active: any = s.registration.unregisterStart(beta.id);
  await expect.poll(() => view(s.registration, active.registration_id).state).toBe("awaiting_owner");
  expect(() => s.registration.start()).toThrow("Another workspace registration operation is awaiting its owner decision.");
  expect(view(s.registration, active.registration_id)).toMatchObject({ state: "awaiting_owner", operation: "unregister" });
});
