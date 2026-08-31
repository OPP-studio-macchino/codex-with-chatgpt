import ignore, { type Ignore } from "ignore";
import fs from "node:fs";
import path from "node:path";

/**
 * Files that must never be readable through MCP, regardless of user config.
 * Matched with gitignore semantics against workspace-relative paths.
 */
export const SENSITIVE_PATTERNS: string[] = [
  ".git",
  ".git/",
  ".hg",
  ".hg/",
  ".svn",
  ".svn/",
  ".c2cignore",
  ".c2c.json",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.der",
  "*.crt",
  "*.cer",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "id_dsa",
  "id_dsa.*",
  ".ssh/",
  ".direnv/",
  ".credentials/",
  ".secrets/",
  "secrets/",
  ".aws/",
  ".azure/",
  ".config/gcloud/",
  ".gnupg/",
  ".kube/config",
  ".docker/config.json",
  ".npmrc",
  ".pypirc",
  ".sentryclirc",
  ".yarnrc",
  ".yarnrc.yml",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".gitconfig",
  "*.keychain",
  "*.keychain-db",
  "*.kdbx",
  "*.ovpn",
  ".cloudflared/",
  "credentials.json",
  "credentials*.json",
  "service-account*.json",
  "secrets.json",
  "*secret*.yaml",
  "*secret*.yml",
  "*.tfstate",
  "*.tfstate.*",
  "terraform.tfvars",
  "*.auto.tfvars",
  "*.auto.tfvars.json",
  ".terraform/",
  ".serverless/",
  "*.mobileprovision",
  "*.provisionprofile",
  "*.har",
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.db3",
  "*.dump",
  "*.backup",
  "*.log",
  "playwright/.auth/",
  "storage-state*.json",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  "local.properties",
  "key.properties",
  "auth.json",
  ".htpasswd",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  "cookies.sqlite",
  "[Cc]ookies*",
  ".c2c-secrets*",
  "._*",
];

/** High-noise directories excluded from listing/search by default. */
export const NOISE_PATTERNS: string[] = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  "coverage/",
  ".cache/",
  ".turbo/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  "target/",
  ".gradle/",
  ".idea/",
  ".tooling/",
  ".pnpm-store/",
  ".DS_Store",
  "._*",
  "*.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

function readVerifiedIgnoreFile(workspaceRoot: string): string | null {
  const file = path.join(workspaceRoot, ".c2cignore");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > 1024 * 1024) {
      throw new Error(".c2cignore must be a regular file no larger than 1 MiB");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 1024 * 1024) throw new Error(".c2cignore grew beyond 1 MiB");
    const canonical = fs.realpathSync.native(file);
    const after = fs.statSync(file);
    if (
      canonical !== path.resolve(file) ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino
    ) {
      throw new Error(".c2cignore changed while being read");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close of a read-only descriptor
      }
    }
  }
}

export class IgnoreRules {
  private sensitive: Ignore;
  private noise: Ignore;
  private custom: Ignore;

  constructor(workspaceRoot: string) {
    this.sensitive = ignore({ ignorecase: true }).add(SENSITIVE_PATTERNS);
    this.noise = ignore({ ignorecase: true }).add(NOISE_PATTERNS);
    this.custom = ignore({ ignorecase: true });
    try {
      const content = readVerifiedIgnoreFile(workspaceRoot);
      if (content !== null) this.custom.add(content);
    } catch (error) {
      throw new Error(
        `Cannot enforce .c2cignore; refusing workspace access: ${(error as Error).message}`
      );
    }
  }

  /** True when the path must be denied with ACCESS_DENIED_SENSITIVE_FILE. */
  isSensitive(relPath: string): boolean {
    if (!relPath || relPath === ".") return false;
    return this.sensitive.ignores(relPath) || this.custom.ignores(relPath);
  }

  /** True when the path should be hidden from listing/search (not an error). */
  isNoise(relPath: string): boolean {
    if (!relPath || relPath === ".") return false;
    return this.noise.ignores(relPath);
  }

  isHidden(relPath: string): boolean {
    return this.isSensitive(relPath) || this.isNoise(relPath);
  }
}

/** Apply the non-configurable sensitive-path policy without reading a workspace. */
export function isBuiltinSensitivePath(relPath: string): boolean {
  if (!relPath || relPath === ".") return false;
  return ignore({ ignorecase: true }).add(SENSITIVE_PATTERNS).ignores(relPath);
}
