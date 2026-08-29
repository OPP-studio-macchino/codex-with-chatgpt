import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gitDiff, gitInfo, gitStatus } from "../src/workspace/git.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git } from "./helpers.js";

let repo: string;
let plain: string;

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

  it("handles non-repos gracefully", () => {
    const diff = gitDiff(plain, { mode: "unstaged" });
    expect(diff.isRepo).toBe(false);
  });
});
