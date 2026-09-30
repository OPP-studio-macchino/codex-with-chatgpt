import { expect, it, vi } from "vitest";
import { terminateNativeHelper } from "../src/workspace/native-helper-lifecycle.js";
const app = "/private/tmp/c2c-folder-owner-ABC123/C2C Project Access.app";
function fixture(values: number[]) {
  const run = vi.fn(async (_file: string, _args: string[]) => {
    if (!values.length) throw new Error("unexpected additional process invocation");
    return values.shift()!;
  });
  const wait = vi.fn(async (_ms: number) => undefined);
  return { run, wait };
}
it("checks absence twice without signalling another application", async () => {
  const f = fixture([1, 1]);
  expect(await terminateNativeHelper(app, f.run, f.wait)).toBe(true);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.run.mock.calls.every(([file]) => file === "/usr/bin/pgrep")).toBe(true);
  expect(f.run.mock.calls[0]![1]).toContain("-u");
  expect(f.run.mock.calls[0]![1].at(-1)).toMatch(/^\^.*C2C Project Access\\\.app.*\$$/);
});
it("uses TERM once and verifies actual absence", async () => {
  const f = fixture([0, 0, 1, 1]);
  expect(await terminateNativeHelper(app, f.run, f.wait)).toBe(true);
  expect(f.run).toHaveBeenCalledTimes(4);
  expect(f.run.mock.calls[1]).toEqual(["/usr/bin/pkill", expect.arrayContaining(["-TERM", "-u", "-f"])]);
});
it("has a fixed small call bound and fails when the helper remains", async () => {
  const f = fixture([0, 0, 0, 0, 0, 0, 0]);
  expect(await terminateNativeHelper(app, f.run, f.wait)).toBe(false);
  expect(f.run).toHaveBeenCalledTimes(7);
  const signals = f.run.mock.calls.filter(([file]) => file.endsWith("pkill")).map(([,args]) => args[0]);
  expect(signals).toEqual(["-TERM", "-KILL", "-KILL"]);
});
it("does not claim success when a late helper appears", async () => {
  const f = fixture([1, 0]);
  expect(await terminateNativeHelper(app, f.run, f.wait)).toBe(false);
});
it("does not interpret process inspection failure as absence", async () => {
  const f = fixture([-1]);
  expect(await terminateNativeHelper(app, f.run, f.wait)).toBe(false);
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("refuses broad or unrelated process targets before any process command", async () => {
  const f = fixture([]);
  for (const value of ["Finder", "/Applications/Finder.app", "/tmp/C2C Project Access.app", app+"\n"]) {
    expect(await terminateNativeHelper(value, f.run, f.wait)).toBe(false);
  }
  expect(f.run).not.toHaveBeenCalled();
});
