import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  WorkspaceProfiles,
  WorkspaceProfilesError,
} from "../src/workspace/profiles.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const item of cleanupPaths.splice(0)) cleanup(item);
});

function setupProfile(codexNetworkHosts: unknown): WorkspaceProfiles {
  isolateStateDir();
  const root = makeTmpDir("workspace-network-policy");
  cleanupPaths.push(root);
  makeGitRepo(root);
  const configDir = makeTmpDir("workspace-network-config");
  cleanupPaths.push(configDir);
  const file = path.join(configDir, "workspace-profiles.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    defaultProfileId: "alpha",
    profiles: [{
      id: "alpha",
      path: root,
      codexNetworkHosts,
    }],
  }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return WorkspaceProfiles.load(new Workspace(root), file)!;
}

describe("workspace-scoped Codex network policy", () => {
  it("loads a normalized allowlist without exposing it in profile summaries", () => {
    const profiles = setupProfile(["TTC.TAXI-INF.JP", "ttc.taxi-inf.jp"]);
    expect(profiles.current().codexNetworkHosts).toEqual(["ttc.taxi-inf.jp"]);
    expect(JSON.stringify(profiles.list())).not.toContain("taxi-inf");
  });

  it("fails closed on an invalid owner network target", () => {
    expect(() => setupProfile(["*.example.com"])).toThrowError(
      expect.objectContaining({
        code: "INVALID_WORKSPACE_PROFILE",
      }) as Partial<WorkspaceProfilesError>
    );
  });
});
