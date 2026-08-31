import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gitDiff, gitInfo, gitStatus } from "../src/workspace/git.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git } from "./helpers.js";

let repo: string;
let plain: string;

const UNSAFE_GIT_CONFIGURATION =
  "UNSAFE_GIT_CONFIGURATION: Git inspection is disabled for this repository.";

function commandQuote(value: string): string {
  const portable = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  return JSON.stringify(portable);
}

function markerHelper(root: string, name = "git-helper"): { command: string; marker: string } {
  const marker = path.join(root, `${name}-executed`);
  const helper = write(
    root,
    `${name}.cjs`,
    'require("node:fs").writeFileSync(process.argv[2], "executed\\n");\nprocess.exit(1);\n'
  );
  const command = [process.execPath, helper, marker].map(commandQuote).join(" ");
  return { command, marker };
}

beforeAll(() => {
  repo = makeTmpDir("git-repo");
  makeGitRepo(repo);
  plain = makeTmpDir("not-a-repo");
  // The test-tmp dir lives inside this project's own git repo; stop git from
  // walking up so `plain` is genuinely outside any repository.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
});

afterAll(() => {
  delete process.env.GIT_CEILING_DIRECTORIES;
  cleanup(repo);
  cleanup(plain);
});

describe("gitInfo", () => {
  it("reports branch, commit and dirty state", () => {
    const clean = gitInfo(repo);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBe("main");
    expect(clean.commit).toMatch(/^[a-f0-9]{7,}$/);
    expect(clean.dirty).toBe(false);

    write(repo, "hello.txt", "changed\n");
    expect(gitInfo(repo).dirty).toBe(true);
    git(repo, "checkout", "--", "hello.txt");
  });

  it("handles non-repos gracefully", () => {
    expect(gitInfo(plain).isRepo).toBe(false);
  });

  it("rejects a .git symlink that points outside the workspace", () => {
    const victim = makeTmpDir("git-symlink-victim");
    const exposed = makeTmpDir("git-symlink-exposed");
    makeGitRepo(victim);
    write(victim, "outside-secret.txt", "must-not-leak\n");
    git(victim, "add", "outside-secret.txt");
    git(victim, "commit", "-m", "private victim content");
    fs.symlinkSync(path.join(victim, ".git"), path.join(exposed, ".git"), "dir");

    expect(gitInfo(exposed).isRepo).toBe(false);
    expect(gitDiff(exposed, { mode: "head" }).diff).not.toContain("must-not-leak");
    cleanup(exposed);
    cleanup(victim);
  });

  it("rejects an arbitrary .git control file pointing at another checkout", () => {
    const victim = makeTmpDir("git-file-victim");
    const exposed = makeTmpDir("git-file-exposed");
    makeGitRepo(victim);
    write(victim, "outside-secret.txt", "must-not-leak\n");
    git(victim, "add", "outside-secret.txt");
    git(victim, "commit", "-m", "private victim content");
    write(exposed, ".git", `gitdir: ${path.join(victim, ".git")}\n`);

    expect(gitInfo(exposed).isRepo).toBe(false);
    expect(gitDiff(exposed, { mode: "head" }).diff).not.toContain("must-not-leak");
    cleanup(exposed);
    cleanup(victim);
  });

  it("supports a validated git worktree control file", () => {
    const source = makeTmpDir("git-worktree-source");
    const container = makeTmpDir("git-worktree-container");
    const linked = path.join(container, "linked");
    makeGitRepo(source);
    git(source, "worktree", "add", "-b", "c2c-linked-test", linked);

    expect(gitInfo(linked).isRepo).toBe(true);
    expect(gitInfo(linked).branch).toBe("c2c-linked-test");
    cleanup(container);
    cleanup(source);
  });

  it("rejects repositories with an alternate object store", () => {
    const isolated = makeTmpDir("git-alternates");
    const alternate = makeTmpDir("git-alternates-store");
    makeGitRepo(isolated);
    fs.mkdirSync(path.join(isolated, ".git", "objects", "info"), { recursive: true });
    write(isolated, ".git/objects/info/alternates", alternate + "\n");

    expect(gitInfo(isolated).isRepo).toBe(false);
    cleanup(isolated);
    cleanup(alternate);
  });
});

describe("gitStatus", () => {
  it("categorizes staged, unstaged and untracked files", () => {
    write(repo, "hello.txt", "modified content\n");
    write(repo, "staged.txt", "new staged file\n");
    write(repo, "untracked.txt", "new file\n");
    git(repo, "add", "staged.txt");

    const status = gitStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.unstaged.map((entry) => entry.path)).toContain("hello.txt");
    expect(status.staged.map((entry) => entry.path)).toContain("staged.txt");
    expect(status.untracked).toContain("untracked.txt");

    git(repo, "reset", "staged.txt");
    git(repo, "checkout", "--", "hello.txt");
  });

  it("does not disclose sensitive untracked paths", () => {
    write(repo, ".env.production", "SECRET=do-not-list\n");
    write(repo, ".npmrc", "//registry.npmjs.org/:_authToken=do-not-list\n");
    const status = gitStatus(repo);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(".env.production");
    expect(serialized).not.toContain(".npmrc");
    expect(status.redactedPathCount).toBeGreaterThanOrEqual(2);
    fs.rmSync(path.join(repo, ".env.production"), { force: true });
    fs.rmSync(path.join(repo, ".npmrc"), { force: true });
  });

  it("bounds large status responses", () => {
    for (let index = 0; index < 510; index++) {
      write(repo, `bulk-${String(index).padStart(3, "0")}.txt`, "x\n");
    }
    const status = gitStatus(repo);
    const returned =
      status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length;
    expect(returned).toBe(500);
    expect(status.truncated).toBe(true);
    for (let index = 0; index < 510; index++) {
      fs.rmSync(path.join(repo, `bulk-${String(index).padStart(3, "0")}.txt`), { force: true });
    }
  });
});

describe("gitDiff pagination", () => {
  it("returns the full diff when small", () => {
    write(repo, "hello.txt", "a different greeting\n");
    const diff = gitDiff(repo, { mode: "unstaged" });
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("a different greeting");
    expect(diff.hasMore).toBe(false);
    expect(diff.nextOffset).toBeNull();
    git(repo, "checkout", "--", "hello.txt");
  });

  it("paginates on byte offsets and never splits lines", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}-${"x".repeat(40)}`).join("\n");
    write(repo, "hello.txt", lines);
    const first = gitDiff(repo, { mode: "unstaged", maxBytes: 8192 });
    expect(first.hasMore).toBe(true);
    expect(first.diff.endsWith("\n")).toBe(true);
    expect(first.nextOffset).toBe(first.returnedBytes);

    const second = gitDiff(repo, { mode: "unstaged", offset: first.nextOffset!, maxBytes: 8192 });
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);

    // walk to the end
    let offset = 0;
    let assembled = "";
    for (let hop = 0; hop < 1000; hop++) {
      const page = gitDiff(repo, { mode: "unstaged", offset, maxBytes: 65536 });
      assembled += page.diff;
      if (!page.hasMore) break;
      offset = page.nextOffset!;
    }
    expect(assembled.length).toBe(first.totalBytes);
    git(repo, "checkout", "--", "hello.txt");
  });

  it("excludes sensitive files from full-repo diffs", () => {
    write(repo, ".env", "SECRET=1\n");
    git(repo, "add", "-f", ".env");
    write(repo, ".env", "SECRET=leaked-value\n");
    const diff = gitDiff(repo, { mode: "unstaged" });
    expect(diff.diff).not.toContain("leaked-value");
    git(repo, "rm", "-f", "--cached", ".env");
  });

  it("excludes sensitive files from directory-scoped diffs", () => {
    write(repo, "private/.env", "SECRET=1\n");
    git(repo, "add", "-f", "private/.env");
    const diff = gitDiff(repo, { mode: "staged" }, "private");
    expect(diff.diff).not.toContain("SECRET=1");
    git(repo, "rm", "-f", "--cached", "private/.env");
  });

  it("honors .c2cignore for tracked diffs", () => {
    const isolated = makeTmpDir("git-custom-ignore");
    makeGitRepo(isolated);
    write(isolated, ".c2cignore", "private-notes/\n");
    write(isolated, "private-notes/plan.txt", "initial\n");
    git(isolated, "add", "-f", "private-notes/plan.txt");
    git(isolated, "commit", "-m", "add private fixture");
    write(isolated, "private-notes/plan.txt", "must-not-leave\n");
    const diff = gitDiff(isolated, { mode: "unstaged" });
    expect(diff.diff).not.toContain("must-not-leave");
    expect(diff.redactedPathCount).toBe(1);
    cleanup(isolated);
  });

  it("redacts credentials accidentally committed in an allowed source file", () => {
    const token = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    write(repo, "hello.txt", `export const api_key = "${token}";\n`);
    const diff = gitDiff(repo, { mode: "unstaged" });
    expect(diff.diff).not.toContain(token);
    expect(diff.diff).toContain("[REDACTED");
    expect(diff.redactionCount).toBeGreaterThan(0);
    git(repo, "checkout", "--", "hello.txt");
  });

  it.skipIf(process.platform === "win32")("does not execute repository-configured diff drivers", () => {
    const isolated = makeTmpDir("git-driver");
    makeGitRepo(isolated);
    write(isolated, "driver.sh", "#!/bin/sh\n: > driver-executed\nexit 0\n");
    fs.chmodSync(path.join(isolated, "driver.sh"), 0o700);
    write(isolated, ".gitattributes", "evil.txt diff=evil\n");
    write(isolated, "evil.txt", "initial\n");
    git(isolated, "add", ".gitattributes", "evil.txt");
    git(isolated, "commit", "-m", "add diff fixture");
    git(isolated, "config", "diff.evil.command", "./driver.sh");
    write(isolated, "evil.txt", "changed safely\n");

    const diff = gitDiff(isolated, { mode: "unstaged" });
    expect(diff.diff).toContain("changed safely");
    expect(fs.existsSync(path.join(isolated, "driver-executed"))).toBe(false);
    cleanup(isolated);
  });

  it(
    "fails closed before repository clean/process/smudge filters can execute",
    () => {
      for (const driver of ["clean", "process", "smudge"] as const) {
        const isolated = makeTmpDir(`git-${driver}-filter`);
        makeGitRepo(isolated);
        write(isolated, ".gitattributes", "hello.txt filter=hostile\n");
        git(isolated, "add", ".gitattributes");
        git(isolated, "commit", "-m", "add filter attributes");
        const { command, marker } = markerHelper(isolated, `${driver}-helper`);
        git(isolated, "config", `filter.hostile.${driver}`, command);
        if (driver === "process") git(isolated, "config", "filter.hostile.required", "true");
        write(isolated, "hello.txt", `changed for ${driver}\n`);

        expect(gitStatus(isolated).isRepo).toBe(false);
        expect(() => gitDiff(isolated, { mode: "unstaged" })).toThrow(UNSAFE_GIT_CONFIGURATION);
        expect(fs.existsSync(marker)).toBe(false);
        cleanup(isolated);
      }
    }
  );

  it(
    "rejects included filter configuration without following the include",
    () => {
      const isolated = makeTmpDir("git-included-filter");
      makeGitRepo(isolated);
      write(isolated, ".gitattributes", "hello.txt filter=hostile\n");
      git(isolated, "add", ".gitattributes");
      git(isolated, "commit", "-m", "add filter attributes");
      const { command, marker } = markerHelper(isolated, "included-helper");
      const included = write(
        isolated,
        ".git/hostile-include",
        `[filter "hostile"]\n\tclean = ${command}\n`
      );
      git(isolated, "config", "include.path", included);
      write(isolated, "hello.txt", "changed with included filter\n");

      expect(() => gitDiff(isolated, { mode: "unstaged" })).toThrow(UNSAFE_GIT_CONFIGURATION);
      expect(fs.existsSync(marker)).toBe(false);
      cleanup(isolated);
    }
  );

  it(
    "rejects filters selected through .git/info/attributes",
    () => {
      const isolated = makeTmpDir("git-info-attributes-filter");
      makeGitRepo(isolated);
      const { command, marker } = markerHelper(isolated, "info-attributes-helper");
      write(isolated, ".git/info/attributes", "hello.txt filter=hostile\n");
      git(isolated, "config", "filter.hostile.clean", command);
      write(isolated, "hello.txt", "changed with info attributes\n");

      expect(() => gitDiff(isolated, { mode: "unstaged" })).toThrow(UNSAFE_GIT_CONFIGURATION);
      expect(fs.existsSync(marker)).toBe(false);
      cleanup(isolated);
    }
  );

  it(
    "rejects filters configured in linked-worktree configuration",
    () => {
      const source = makeTmpDir("git-filter-worktree-source");
      const container = makeTmpDir("git-filter-worktree-container");
      const linked = path.join(container, "linked");
      makeGitRepo(source);
      write(source, ".gitattributes", "hello.txt filter=hostile\n");
      git(source, "add", ".gitattributes");
      git(source, "commit", "-m", "add filter attributes");
      git(source, "config", "extensions.worktreeConfig", "true");
      git(source, "worktree", "add", "-b", "c2c-filter-test", linked);
      const { command, marker } = markerHelper(linked, "worktree-helper");
      git(linked, "config", "--worktree", "filter.hostile.clean", command);
      write(linked, "hello.txt", "changed in linked worktree\n");

      expect(() => gitDiff(linked, { mode: "unstaged" })).toThrow(UNSAFE_GIT_CONFIGURATION);
      expect(fs.existsSync(marker)).toBe(false);
      cleanup(container);
      cleanup(source);
    }
  );

  it(
    "rejects a promisor repository before a missing object can start a transport",
    () => {
      const isolated = makeTmpDir("git-promisor");
      makeGitRepo(isolated);
      const blob = git(isolated, "rev-parse", "HEAD:hello.txt").trim();
      const object = path.join(isolated, ".git", "objects", blob.slice(0, 2), blob.slice(2));
      fs.renameSync(object, path.join(isolated, "missing-blob-backup"));
      const { command, marker } = markerHelper(isolated, "transport-helper");
      git(isolated, "config", "remote.origin.url", `ext::${command}`);
      git(isolated, "config", "remote.origin.promisor", "true");
      git(isolated, "config", "remote.origin.partialCloneFilter", "blob:none");
      git(isolated, "config", "extensions.partialClone", "origin");
      git(isolated, "config", "protocol.ext.allow", "always");
      write(isolated, "hello.txt", "changed with missing base blob\n");

      expect(() => gitDiff(isolated, { mode: "unstaged" })).toThrow(UNSAFE_GIT_CONFIGURATION);
      expect(fs.existsSync(marker)).toBe(false);
      cleanup(isolated);
    }
  );

  it(
    "rejects credential and SSH helpers without exposing their configured values",
    () => {
      for (const key of ["credential.helper", "core.askPass", "core.sshCommand"] as const) {
        const isolated = makeTmpDir(`git-${key.replaceAll(".", "-")}`);
        makeGitRepo(isolated);
        const { command, marker } = markerHelper(isolated, "network-helper");
        git(isolated, "config", key, command);
        write(isolated, "hello.txt", `changed with ${key}\n`);

        expect(() => gitDiff(isolated, { mode: "unstaged" })).toThrow(
          UNSAFE_GIT_CONFIGURATION
        );
        expect(fs.existsSync(marker)).toBe(false);
        cleanup(isolated);
      }
    }
  );

  it("handles non-repos gracefully", () => {
    const diff = gitDiff(plain, { mode: "unstaged" });
    expect(diff.isRepo).toBe(false);
  });
});
