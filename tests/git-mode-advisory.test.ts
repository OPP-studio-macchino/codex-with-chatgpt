import { expect, it } from "vitest";
import { classifyStatusPair, readStatusPair, type GitCommandResult } from "../src/workspace/git.js";
const result = (stdout: string, ok = true): GitCommandResult => ({ stdout, ok, stderr: "", code: ok ? 0 : 1 });
const mode = "1 .M N... 100644 100644 100755 abc abc file\0";
const content = "1 .M N... 100644 100644 100644 abc abc file\0";
const classify = (a: string, b: string) => classifyStatusPair(result(a), result(b), () => false);
it("uses the same snapshot runner for identical statuses except filemode", () => {
  const calls: string[][] = [];
  const pair = readStatusPair(args => { calls.push(args); return result(calls.length === 1 ? mode : ""); });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(["-c", "core.filemode=false", ...calls[0]!]);
  expect(classifyStatusPair(pair.raw, pair.content, () => false)).toEqual({ contentDirty: false, modeOnly: ["file"] });
});
it("retains content and content-plus-mode changes", () => {
  expect(classify(content, content)).toEqual({ contentDirty: true, modeOnly: [] });
  expect(classify(mode, content)).toEqual({ contentDirty: true, modeOnly: [] });
});
it("never classifies staged modes as mode-only", () => {
  const staged = "1 M. N... 100644 100755 100755 abc abc file\0";
  expect(classify(staged, staged)).toEqual({ contentDirty: true, modeOnly: [] });
  expect(classify(staged, "")).toEqual({ contentDirty: null, modeOnly: [] });
});
it("fails advisory closed for sensitive, failed, incomplete and excessive output", () => {
  const unknown = { contentDirty: null, modeOnly: [] };
  expect(classifyStatusPair(result(mode), result(""), () => true)).toEqual(unknown);
  expect(classifyStatusPair(result(mode), result("", false), () => false)).toEqual(unknown);
  expect(classify(mode.slice(0, -1), "")).toEqual(unknown);
  expect(classify(content, "")).toEqual(unknown);
  const many = Array.from({ length: 501 }, (_, i) => `? file${i}\0`).join("");
  expect(classify(many, many)).toEqual(unknown);
});
it("keeps untracked and conflicts dirty", () => {
  const conflict = "u UU N... 100644 100644 100644 100644 abc abc abc file\0";
  expect(classify(conflict, conflict)).toEqual({ contentDirty: true, modeOnly: [] });
  expect(classify("? new\0", "? new\0")).toEqual({ contentDirty: true, modeOnly: [] });
});
it("reports visible mode-only paths alongside hidden entries without claiming clean", () => {
  const hidden = "? private-hidden-file\0";
  const sensitive = (file: string) => file.startsWith("private-");
  const mixed = classifyStatusPair(result(mode + hidden), result(hidden), sensitive);
  expect(mixed).toEqual({ contentDirty: null, modeOnly: ["file"] });
  expect(JSON.stringify(mixed)).not.toContain("private-hidden-file");
  expect(classifyStatusPair(result(mode + hidden + "? visible\0"), result(hidden + "? visible\0"), sensitive))
    .toEqual({ contentDirty: true, modeOnly: ["file"] });
  const manyHidden = Array.from({ length: 500 }, (_, i) => `? private-${i}\0`).join("");
  expect(classifyStatusPair(result(mode + manyHidden), result(manyHidden), sensitive))
    .toEqual({ contentDirty: null, modeOnly: [] });
});
