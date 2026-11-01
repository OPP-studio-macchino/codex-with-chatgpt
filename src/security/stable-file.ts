import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const privateMode = (s: fs.Stats): boolean => process.platform === "win32" || ((s.mode & 0o077) === 0 &&
  (typeof process.getuid !== "function" || s.uid === process.getuid()));

export function checkPrivateParents(file: string): void {
  for (let p = path.dirname(file);; p = path.dirname(p)) {
    try {
      const s = fs.lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink() || (p === path.dirname(file) && !privateMode(s))) throw new Error("UNSAFE_PRIVATE_PATH");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (path.dirname(p) === p) break;
  }
}

export function readPrivateFile(file: string, maxBytes: number): string | null {
  checkPrivateParents(file);
  try {
    const { data, stat } = readStableFile(path.resolve(file), maxBytes);
    if (!privateMode(stat)) throw new Error("UNSAFE_PRIVATE_MODE");
    return data.toString("utf8");
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

export function syncPrivateDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } catch (e) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
  } finally { fs.closeSync(fd); }
}

export function writePrivateFile(file: string, text: string, maxBytes: number): void {
  if (Buffer.byteLength(text) > maxBytes) throw new Error("PRIVATE_FILE_CAPACITY");
  checkPrivateParents(file);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); checkPrivateParents(file);
  const temp = `${file}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(temp, 0o600); fs.renameSync(temp, file); syncPrivateDirectory(dir);
    syncPrivateDirectory(path.dirname(dir));
  } finally { try { fs.unlinkSync(temp); } catch { /* Already renamed. */ } }
}

export const sameFile = (a: fs.Stats, b: fs.Stats): boolean => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink && a.uid === b.uid;

/** Bounded descriptor read; reject aliases and replacement during the read. */
export function readStableFile(file: string, maxBytes: number): { data: Buffer; stat: fs.Stats } {
  if (!path.isAbsolute(file) || fs.realpathSync.native(file) !== file) throw new Error("UNSAFE_FILE");
  const parents = new Map<string, fs.Stats>();
  for (let dir = path.dirname(file);; dir = path.dirname(dir)) {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("UNSAFE_FILE");
    parents.set(dir, s);
    if (path.dirname(dir) === dir) break;
  }
  const before = fs.lstatSync(file);
  // macOS ships /usr/bin/git as a root-owned, hardlinked developer-tool shim.
  // Only these fixed OS executables may have links; source/state never may.
  const systemExecutable = (file === "/usr/bin/git" || file === "/usr/bin/env") && before.uid === 0 && (before.mode & 0o022) === 0;
  if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1 && !systemExecutable) || before.size > maxBytes) throw new Error("UNSAFE_FILE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!sameFile(before, opened)) throw new Error("FILE_CHANGED");
    const data = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < data.length) {
      const n = fs.readSync(fd, data, length, data.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length !== opened.size || !sameFile(opened, fs.fstatSync(fd)) || !sameFile(opened, fs.lstatSync(file))) throw new Error("FILE_CHANGED");
    for (const [dir, s] of parents) {
      const now = fs.lstatSync(dir);
      if (now.isSymbolicLink() || now.dev !== s.dev || now.ino !== s.ino || now.mode !== s.mode || now.uid !== s.uid) throw new Error("FILE_CHANGED");
    }
    return { data: data.subarray(0, length), stat: opened };
  } finally { fs.closeSync(fd); }
}
