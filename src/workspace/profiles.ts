import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { Workspace } from "./manager.js";
import { normalizeCodexNetworkHosts } from "../codex/network-policy.js";

const PROFILE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_PROFILES = 16;
const MAX_CONFIG_BYTES = 64 * 1024;

interface RawProfile {
  id?: unknown;
  path?: unknown;
  codexNetworkHosts?: unknown;
}

interface RawConfig {
  version?: unknown;
  defaultProfileId?: unknown;
  profiles?: unknown;
}

interface SelectionState {
  version: 1;
  profileId: string;
}

export interface WorkspaceProfileSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  selected: boolean;
}

export interface WorkspaceProfile {
  id: string;
  workspace: Workspace;
  codexNetworkHosts: readonly string[];
}

export class WorkspaceProfilesError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceProfilesError";
  }
}

function failure(message: string): never {
  throw new WorkspaceProfilesError("WORKSPACE_ADDITION_CONFLICT", message);
}

function noSymlinks(file: string): void {
  if (!path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) {
    failure("Use an absolute local path.");
  }
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) failure("Symlink path components are not allowed.");
  }
}

function privateFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES) {
    failure("Profiles storage must be a bounded, regular, single-linked file.");
  }
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()))) {
    throw new WorkspaceProfilesError("INSECURE_WORKSPACE_PROFILES_FILE", "Profiles storage must be same-owner and owner-only (0600).");
  }
}

function sameIdentity(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function readOwnerConfig(file: string): Buffer {
  noSymlinks(file);
  const before = fs.lstatSync(file);
  privateFile(before);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    privateFile(opened);
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    noSymlinks(file);
    const after = fs.lstatSync(file);
    privateFile(after);
    if (length > MAX_CONFIG_BYTES || !sameIdentity(before, opened) || !sameIdentity(opened, after) ||
        opened.size !== length || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      failure("Profiles config changed while reading; reload profiles and retry.");
    }
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

function contains(parent: string, child: string): boolean {
  const fold = (s: string) => process.platform === "darwin" || process.platform === "win32" ? s.toLowerCase() : s;
  const relative = path.relative(fold(parent), fold(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export interface WorkspaceAdditionCandidate {
  readonly profileId: string;
  readonly workspace: Workspace;
  readonly alreadyRegistered: boolean;
}

interface AdditionSnapshot {
  bytes: Buffer;
  root: string;
  identity: fs.Stats;
  state: string;
}

function validateProfileId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROFILE_ID.test(value)) {
    throw new WorkspaceProfilesError(
      "INVALID_WORKSPACE_PROFILE",
      `${label} must match ${PROFILE_ID.source}.`
    );
  }
  return value;
}

export class WorkspaceProfiles {
  private readonly additions = new WeakMap<WorkspaceAdditionCandidate, AdditionSnapshot>();
  private registrationUnavailable = false;
  private configBytes: Buffer;
  private readonly profiles = new Map<string, WorkspaceProfile>();
  private selectedProfileId: string;
  readonly defaultProfileId: string;
  readonly configFile: string;
  private readonly selectionFile: string;

  private constructor(
    anchorWorkspace: Workspace,
    configuredFile: string,
    bytes: Buffer
  ) {
    this.configBytes = bytes;
    const raw = JSON.parse(bytes.toString("utf8")) as RawConfig;
    if (raw.version !== 1 || !Array.isArray(raw.profiles)) {
      throw new WorkspaceProfilesError(
        "INVALID_WORKSPACE_PROFILES_FILE",
        "Workspace profiles config must use version 1 and a profiles array."
      );
    }
    if (raw.profiles.length < 1 || raw.profiles.length > MAX_PROFILES) {
      throw new WorkspaceProfilesError(
        "INVALID_WORKSPACE_PROFILES_FILE",
        `Workspace profiles config must contain 1-${MAX_PROFILES} profiles.`
      );
    }

    const defaultProfileId = validateProfileId(raw.defaultProfileId, "defaultProfileId");
    const workspaceIds = new Set<string>();

    for (const entry of raw.profiles as RawProfile[]) {
      if (!entry || typeof entry !== "object") {
        throw new WorkspaceProfilesError("INVALID_WORKSPACE_PROFILE", "Each workspace profile must be an object.");
      }
      const id = validateProfileId(entry.id, "profile id");
      if (this.profiles.has(id)) {
        throw new WorkspaceProfilesError("DUPLICATE_WORKSPACE_PROFILE", `Duplicate workspace profile id: ${id}`);
      }
      if (typeof entry.path !== "string" || !path.isAbsolute(entry.path) || /[\u0000-\u001f\u007f]/.test(entry.path)) {
        throw new WorkspaceProfilesError(
          "INVALID_WORKSPACE_PROFILE",
          `Workspace profile '${id}' must use an absolute local owner path.`
        );
      }
      const workspace = new Workspace(entry.path);
      if (workspaceIds.has(workspace.id)) {
        throw new WorkspaceProfilesError(
          "DUPLICATE_WORKSPACE_PROFILE",
          "Two workspace profile ids resolve to the same directory."
        );
      }
      let codexNetworkHosts: string[];
      try {
        codexNetworkHosts = normalizeCodexNetworkHosts(entry.codexNetworkHosts);
      } catch (error) {
        throw new WorkspaceProfilesError(
          "INVALID_WORKSPACE_PROFILE",
          `Workspace profile '${id}' has invalid codexNetworkHosts: ${(error as Error).message}`
        );
      }
      workspaceIds.add(workspace.id);
      this.profiles.set(id, { id, workspace, codexNetworkHosts });
    }

    const defaultWorkspace = this.profiles.get(defaultProfileId);
    if (!defaultWorkspace) {
      throw new WorkspaceProfilesError(
        "INVALID_WORKSPACE_PROFILES_FILE",
        "defaultProfileId does not name one of the configured profiles."
      );
    }
    if (defaultWorkspace.workspace.root !== anchorWorkspace.root) {
      throw new WorkspaceProfilesError(
        "WORKSPACE_PROFILE_ANCHOR_MISMATCH",
        "The default workspace profile must resolve to the bridge --workspace directory."
      );
    }

    this.defaultProfileId = defaultProfileId;
    this.configFile = fs.realpathSync.native(configuredFile);
    this.selectionFile = path.join(
      getStateDir(),
      "workspace-selection",
      `${anchorWorkspace.id}.json`
    );

    const saved = readJsonIfExists<SelectionState>(this.selectionFile, 4096);
    this.selectedProfileId =
      saved?.version === 1 &&
      typeof saved.profileId === "string" &&
      this.profiles.has(saved.profileId)
        ? saved.profileId
        : defaultProfileId;
  }

  static load(anchorWorkspace: Workspace, configuredFile?: string): WorkspaceProfiles | undefined {
    const requested = configuredFile?.trim();
    if (!requested) return undefined;
    const raw = readOwnerConfig(requested);
    return new WorkspaceProfiles(anchorWorkspace, requested, raw);
  }

  private checkConfig(): Buffer {
    if (this.registrationUnavailable) failure("Registration durability is unknown; reload profiles before registering again.");
    const bytes = readOwnerConfig(this.configFile);
    if (!bytes.equals(this.configBytes)) failure("Profiles config changed externally; reload profiles and request approval again.");
    return bytes;
  }

  private validateAddition(root: string): fs.Stats {
    noSymlinks(root);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || fs.realpathSync.native(root) !== root) failure("Select a canonical existing local directory.");
    const home = fs.realpathSync.native(os.homedir());
    if (root === path.parse(root).root || contains(root, home)) failure("Home and filesystem roots cannot be registered.");
    const sensitive = /^(?:\.ssh|\.aws|\.azure|\.config|\.codex|\.git|\.hg|\.svn|node_modules|\.gnupg|\.kube|\.docker|\.credentials|\.secrets|secrets|\.direnv|\.cloudflared|\.terraform|\.serverless)$/i;
    if (root.split(path.sep).some(part => sensitive.test(part))) failure("Sensitive directories cannot be registered.");
    const state = fs.realpathSync.native(getStateDir());
    if (contains(root, state) || contains(state, root) || contains(root, this.configFile)) failure("Workspace must be separate from state and profiles storage.");
    for (const profile of this.profiles.values()) {
      const existing = profile.workspace.root;
      if (existing !== root && (contains(existing, root) || contains(root, existing))) failure("Workspace overlaps an approved root.");
    }
    return stat;
  }

  prepareAddition(selectedPath: string): WorkspaceAdditionCandidate {
    const bytes = this.checkConfig();
    noSymlinks(selectedPath);
    const root = fs.realpathSync.native(selectedPath);
    const identity = this.validateAddition(root);
    const existing = [...this.profiles.values()].find(profile => profile.workspace.root === root);
    if (!existing && this.count >= MAX_PROFILES) failure("Workspace profile limit (16) reached.");
    const workspace = existing?.workspace ?? new Workspace(root);
    if (!sameIdentity(identity, this.validateAddition(root))) failure("Selected folder changed; select it again.");
    const stem = path.basename(root).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 37) || "workspace";
    const base = `${stem}-${workspace.id}`;
    let profileId = existing?.id ?? base;
    for (let n = 2; !existing && this.profiles.has(profileId); n++) profileId = `${base.slice(0, 60)}-${n}`;
    const candidate = Object.freeze({ profileId, workspace, alreadyRegistered: !!existing });
    this.additions.set(candidate, { bytes, root, identity, state: fs.realpathSync.native(getStateDir()) });
    return candidate;
  }

  /** Called only by the trusted native controller after owner approval. */
  commitApprovedAddition(candidate: WorkspaceAdditionCandidate): WorkspaceProfileSummary {
    const snapshot = this.additions.get(candidate);
    if (!snapshot) failure("Unknown or consumed addition candidate; select the folder and approve again.");
    this.additions.delete(candidate);
    const revalidate = () => {
      if (!this.checkConfig().equals(snapshot.bytes)) failure("Profiles changed; request approval again.");
      if (fs.realpathSync.native(getStateDir()) !== snapshot.state ||
          candidate.workspace.root !== snapshot.root ||
          !sameIdentity(snapshot.identity, this.validateAddition(snapshot.root))) failure("Selected folder or state changed; request approval again.");
    };
    revalidate();
    if (candidate.alreadyRegistered) return this.list().find(profile => profile.id === candidate.profileId)!;
    if (this.count >= MAX_PROFILES || this.profiles.has(candidate.profileId)) failure("Profile limit or ID conflict; request approval again.");
    const directory = path.dirname(this.configFile);
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || (typeof process.getuid === "function" && parent.uid !== process.getuid()) || (parent.mode & 0o022) !== 0) {
      failure("Profiles parent directory must be same-owner and not writable by others.");
    }
    const lock = `${this.configFile}.lock`;
    let lockFd: number;
    try {
      lockFd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    } catch {
      failure("Profiles registration is locked; retry after the other writer finishes. Existing locks are never removed automatically.");
    }
    let temp: string | undefined;
    let renamed = false;
    try {
      privateFile(fs.fstatSync(lockFd));
      revalidate();
      const raw = JSON.parse(snapshot.bytes.toString("utf8")) as RawConfig;
      const bytes = Buffer.from(JSON.stringify({ ...raw, profiles: [...raw.profiles as RawProfile[], {
        id: candidate.profileId, path: snapshot.root, codexNetworkHosts: [],
      }] }, null, 2) + "\n");
      if (bytes.length > MAX_CONFIG_BYTES) failure("Profiles config would exceed its size limit.");
      temp = `${this.configFile}.${randomBytes(12).toString("hex")}.tmp`;
      const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {
        privateFile(fs.fstatSync(fd));
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      revalidate();
      noSymlinks(directory);
      if (!sameIdentity(parent, fs.lstatSync(directory))) failure("Profiles parent changed; reload and retry.");
      fs.renameSync(temp, this.configFile);
      renamed = true;
      const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      if (!readOwnerConfig(this.configFile).equals(bytes)) failure("Persisted profiles changed; reload profiles.");
      this.configBytes = bytes;
      this.profiles.set(candidate.profileId, { id: candidate.profileId, workspace: candidate.workspace, codexNetworkHosts: [] });
      return this.list().find(profile => profile.id === candidate.profileId)!;
    } catch (error) {
      if (renamed) {
        this.registrationUnavailable = true;
        failure("Registration durability is unknown; reload profiles before registering again.");
      }
      throw error;
    } finally {
      if (temp && !renamed) { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
      try {
        noSymlinks(lock);
        if (sameIdentity(fs.fstatSync(lockFd), fs.lstatSync(lock))) fs.unlinkSync(lock);
      } finally { fs.closeSync(lockFd); }
    }
  }

  get selectedId(): string {
    return this.selectedProfileId;
  }

  get count(): number {
    return this.profiles.size;
  }

  current(): WorkspaceProfile {
    const profile = this.profiles.get(this.selectedProfileId);
    if (!profile) {
      throw new WorkspaceProfilesError("WORKSPACE_PROFILE_NOT_FOUND", "Selected workspace profile is unavailable.");
    }
    return profile;
  }

  get(id: string): WorkspaceProfile {
    if (!PROFILE_ID.test(id)) {
      throw new WorkspaceProfilesError("INVALID_WORKSPACE_PROFILE", "Invalid workspace profile id.");
    }
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new WorkspaceProfilesError(
        "WORKSPACE_PROFILE_NOT_FOUND",
        "Workspace profile is not owner-approved."
      );
    }
    return profile;
  }

  list(): WorkspaceProfileSummary[] {
    return [...this.profiles.values()].map((profile) => ({
      id: profile.id,
      workspaceId: profile.workspace.id,
      workspaceName: profile.workspace.name,
      selected: profile.id === this.selectedProfileId,
    }));
  }

  select(id: string): WorkspaceProfile {
    const profile = this.get(id);
    this.selectedProfileId = profile.id;
    writeSecureJson(this.selectionFile, {
      version: 1,
      profileId: profile.id,
    } satisfies SelectionState);
    return profile;
  }
}
