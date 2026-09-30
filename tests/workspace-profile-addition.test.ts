import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceProfiles } from "../src/workspace/profiles.js";

let base: string;
let file: string;
let root: string;
let target: string;
let previous: string | undefined;
const mkdir = (p: string) => { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return p; };
function config(extra: Array<Record<string, unknown>> = []) {
  const raw = { version: 1, defaultProfileId: "alpha", custom: { keep: true }, profiles: [
    { id: "alpha", path: root, codexNetworkHosts: ["EXAMPLE.COM"], custom: 42 }, ...extra,
  ] };
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  return raw;
}
const load = () => WorkspaceProfiles.load(new Workspace(root), file)!;
beforeEach(() => {
  previous = process.env.C2C_STATE_DIR;
  // Canonical OS temp storage, independent of the checkout filesystem (including exFAT).
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "profile-add-")));
  process.env.C2C_STATE_DIR = mkdir(path.join(base, "state"));
  root = mkdir(path.join(base, "repos", "alpha"));
  target = mkdir(path.join(base, "repos", "new project"));
  file = path.join(mkdir(path.join(base, "storage")), "profiles.json");
  config();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous;
  fs.rmSync(base, { recursive: true, force: true });
});

it("adds immediately and after reload, preserving raw fields, identities, selection and hosts", () => {
  const beta = mkdir(path.join(base, "repos", "beta"));
  const raw = config([{ id: "beta", path: beta, codexNetworkHosts: ["beta.example"] }]);
  const p = load(); p.select("beta");
  const alpha = p.get("alpha"); const selected = p.current();
  const selection = fs.readFileSync(path.join(process.env.C2C_STATE_DIR!, "workspace-selection", `${alpha.workspace.id}.json`));
  const token = p.prepareAddition(target);
  expect(Object.isFrozen(token)).toBe(true);
  const summary = p.commitApprovedAddition(token);
  expect(summary.selected).toBe(false);
  expect(p.get(summary.id).workspace).toBe(token.workspace);
  expect(p.get(summary.id).codexNetworkHosts).toEqual([]);
  expect(p.get("alpha")).toBe(alpha); expect(p.current()).toBe(selected);
  expect(p.defaultProfileId).toBe("alpha"); expect(p.selectedId).toBe("beta");
  expect(alpha.codexNetworkHosts).toEqual(["example.com"]);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(persisted.profiles.slice(0, 2)).toEqual(raw.profiles);
  expect(persisted.custom).toEqual(raw.custom);
  expect(fs.readFileSync(path.join(process.env.C2C_STATE_DIR!, "workspace-selection", `${alpha.workspace.id}.json`))).toEqual(selection);
  expect(load().get(summary.id).workspace.root).toBe(target);
  expect(fs.readdirSync(target)).toEqual([]);
});
it("duplicates do not write or require a writable config directory", () => {
  const p = load(); const bytes = fs.readFileSync(file); const stat = fs.statSync(file);
  const token = p.prepareAddition(root);
  expect(token.alreadyRegistered).toBe(true); expect(token.workspace).toBe(p.current().workspace);
  const write = vi.spyOn(fs, "writeFileSync");
  p.commitApprovedAddition(token);
  expect(write).not.toHaveBeenCalled(); expect(fs.readFileSync(file)).toEqual(bytes);
  expect(fs.statSync(file).ino).toBe(stat.ino);
});
it("rejects overlap in either direction", () => {
  const p = load();
  expect(() => p.prepareAddition(mkdir(path.join(root, "child")))).toThrow(/overlaps/);
  expect(() => p.prepareAddition(path.dirname(root))).toThrow(/overlaps/);
});
it("rejects invalid, sensitive, state and config-containing targets and symlink components", () => {
  const p = load();
  for (const name of [".ssh", ".aws", ".config", ".codex", ".git", "node_modules", ".gnupg"]) {
    expect(() => p.prepareAddition(mkdir(path.join(base, name, "child")))).toThrow(/Sensitive/);
  }
  for (const dir of [base, path.dirname(file), process.env.C2C_STATE_DIR!, mkdir(path.join(process.env.C2C_STATE_DIR!, "child"))]) {
    expect(() => p.prepareAddition(dir)).toThrow();
  }
  for (const bad of ["relative", file, path.join(base, "missing"), "\0"]) expect(() => p.prepareAddition(bad)).toThrow();
  const home = mkdir(path.join(base, "fake-home")); vi.spyOn(os, "homedir").mockReturnValue(home);
  expect(() => p.prepareAddition(home)).toThrow(/Home/);
  expect(() => p.prepareAddition(path.parse(base).root)).toThrow();
  fs.symlinkSync(path.dirname(target), path.join(base, "link"));
  expect(() => p.prepareAddition(path.join(base, "link", path.basename(target)))).toThrow(/Symlink/);
});
it("rejects folder replacement and consumes the candidate", () => {
  const p = load(); const token = p.prepareAddition(target);
  fs.renameSync(target, `${target}-old`); mkdir(target);
  expect(() => p.commitApprovedAddition(token)).toThrow(/changed/);
  expect(() => p.commitApprovedAddition(token)).toThrow(/consumed/); expect(p.count).toBe(1);
});
it("rejects config edits both before preparation and after approval preparation", () => {
  const p = load(); const token = p.prepareAddition(target);
  fs.appendFileSync(file, " ");
  expect(() => p.commitApprovedAddition(token)).toThrow(/reload/);
  expect(() => p.prepareAddition(target)).toThrow(/reload/);
  expect(p.count).toBe(1);
});
it("rejects forged, foreign and reused candidates", () => {
  const p = load(); const token = p.prepareAddition(target);
  expect(() => p.commitApprovedAddition({ ...token })).toThrow(/Unknown/);
  expect(() => load().commitApprovedAddition(token)).toThrow(/Unknown/);
  p.commitApprovedAddition(token);
  expect(() => p.commitApprovedAddition(token)).toThrow(/consumed/);
});
it("failed persistence leaves memory and config unchanged", () => {
  const p = load(); const token = p.prepareAddition(target); const bytes = fs.readFileSync(file);
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("write failed"); });
  expect(() => p.commitApprovedAddition(token)).toThrow(/write failed/);
  expect(p.count).toBe(1); expect(fs.readFileSync(file)).toEqual(bytes);
  expect(fs.readdirSync(path.dirname(file))).toEqual(["profiles.json"]);
});
it("unknown durability disables further registration without adding to memory", () => {
  const p = load(); const token = p.prepareAddition(target); const sync = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error("sync failed");
    sync(fd);
  });
  expect(() => p.commitApprovedAddition(token)).toThrow(/durability/);
  expect(p.count).toBe(1); expect(() => p.prepareAddition(target)).toThrow(/durability/);
});
it("rejects config symlinks, parent symlinks, hard links and permissive modes", () => {
  const p = load(); const token = p.prepareAddition(target);
  fs.chmodSync(file, 0o644);
  expect(() => p.commitApprovedAddition(token)).toThrow(/owner-only/); expect(() => load()).toThrow();
  fs.chmodSync(file, 0o600);
  fs.linkSync(file, `${file}.hard`); expect(() => load()).toThrow(/single-linked/); fs.unlinkSync(`${file}.hard`);
  fs.renameSync(file, `${file}.real`); fs.symlinkSync(`${file}.real`, file); expect(() => load()).toThrow(/Symlink/);
  fs.unlinkSync(file); fs.renameSync(`${file}.real`, file);
  const alias = path.join(base, "alias"); fs.symlinkSync(path.dirname(file), alias);
  expect(() => WorkspaceProfiles.load(new Workspace(root), path.join(alias, path.basename(file)))).toThrow(/Symlink/);
});
it("enforces the limit and resolves deterministic ID collisions without overwriting", () => {
  let p = load(); const id = p.prepareAddition(target).profileId;
  config([{ id, path: mkdir(path.join(base, "other")) }]); p = load();
  const token = p.prepareAddition(target); expect(token.profileId).not.toBe(id); expect(token.profileId.length).toBeLessThanOrEqual(64);
  p.commitApprovedAddition(token); expect(p.get(id).workspace.root).toBe(path.join(base, "other"));
  config(Array.from({ length: 15 }, (_, i) => ({ id: `p${i}`, path: mkdir(path.join(base, `repo${i}`)) })));
  p = load(); expect(() => p.prepareAddition(target)).toThrow(/limit/);
  expect(p.prepareAddition(root).alreadyRegistered).toBe(true);
});
it("refuses existing locks, including symlinks, without deleting them", () => {
  const p = load(); const bytes = fs.readFileSync(file);
  fs.writeFileSync(`${file}.lock`, "held", { mode: 0o600 });
  expect(() => p.commitApprovedAddition(p.prepareAddition(target))).toThrow(/locked/);
  expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe("held");
  fs.unlinkSync(`${file}.lock`); fs.symlinkSync(file, `${file}.lock`);
  expect(() => p.commitApprovedAddition(p.prepareAddition(target))).toThrow(/locked/);
  expect(fs.lstatSync(`${file}.lock`).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(file)).toEqual(bytes); expect(p.count).toBe(1);
});
