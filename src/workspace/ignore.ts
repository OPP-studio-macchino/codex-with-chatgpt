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

export class IgnoreRules {
  private sensitive: Ignore;
  private noise: Ignore;
  private custom: Ignore;

  constructor(workspaceRoot: string) {
    this.sensitive = ignore({ ignorecase: true }).add(SENSITIVE_PATTERNS);
    this.noise = ignore({ ignorecase: true }).add(NOISE_PATTERNS);
    this.custom = ignore({ ignorecase: true });
    const c2cignore = path.join(workspaceRoot, ".c2cignore");
    if (fs.existsSync(c2cignore)) {
      try {
        const stat = fs.lstatSync(c2cignore);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
          throw new Error(".c2cignore must be a regular file no larger than 1 MiB");
        }
        this.custom.add(fs.readFileSync(c2cignore, "utf8"));
      } catch (error) {
        throw new Error(
          `Cannot enforce .c2cignore; refusing workspace access: ${(error as Error).message}`
        );
      }
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
