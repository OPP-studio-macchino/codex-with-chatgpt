import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { redactAndTruncate } from "../security/redaction.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
  authorizedAt?: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const PROVISIONAL_CLIENT_TTL_MS = 5 * 60 * 1000;
const MAX_PROVISIONAL_CLIENTS = 8;
const MAX_REGISTERED_CLIENTS = 32;
const MAX_PERSISTED_TOKENS = 256;

export function isAllowedOAuthRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (
    uri !== uri.trim() ||
    uri.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(uri) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
  );
}

function sanitizeClientName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? redactAndTruncate(sanitized, 200).text : undefined;
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    const data = readJsonIfExists<PersistedAuthState>(this.file);
    if (!data) return;
    const now = Date.now();
    const persistedClients = Array.isArray(data.clients) ? data.clients : [];
    for (const client of persistedClients) {
      if (this.clients.size >= MAX_REGISTERED_CLIENTS) break;
      if (
        !client ||
        typeof client.clientId !== "string" ||
        !/^c2c_client_[A-Za-z0-9_-]{8,64}$/.test(client.clientId) ||
        !Array.isArray(client.redirectUris) ||
        client.redirectUris.length < 1 ||
        client.redirectUris.length > 10 ||
        new Set(client.redirectUris).size !== client.redirectUris.length ||
        !client.redirectUris.every((uri) => typeof uri === "string" && isAllowedOAuthRedirectUri(uri)) ||
        typeof client.createdAt !== "string" ||
        !Number.isFinite(Date.parse(client.createdAt)) ||
        (client.authorizedAt !== undefined &&
          (typeof client.authorizedAt !== "string" || !Number.isFinite(Date.parse(client.authorizedAt))))
      ) {
        continue;
      }
      // Registrations persisted by older versions were already usable and are
      // therefore treated as authorized during migration.
      this.clients.set(client.clientId, {
        ...client,
        clientName: sanitizeClientName(client.clientName),
        authorizedAt: client.authorizedAt ?? client.createdAt,
      });
    }
    const persistedTokens = Array.isArray(data.tokens) ? data.tokens : [];
    for (const token of persistedTokens) {
      if (this.tokens.size >= MAX_PERSISTED_TOKENS) break;
      if (
        token &&
        /^[a-f0-9]{64}$/.test(token.hash) &&
        (token.kind === "access" || token.kind === "refresh") &&
        typeof token.clientId === "string" &&
        token.workspaceId === this.workspaceId &&
        Array.isArray(token.scopes) &&
        token.scopes.every((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope)) &&
        Number.isFinite(token.issuedAt) &&
        Number.isFinite(token.expiresAt) &&
        !token.revoked &&
        token.expiresAt > now
      ) {
        this.tokens.set(token.hash, token);
      }
    }
  }

  private save(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()].filter((client) => Boolean(client.authorizedAt)),
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    if (
      !Array.isArray(input.redirectUris) ||
      input.redirectUris.length < 1 ||
      input.redirectUris.length > 10 ||
      new Set(input.redirectUris).size !== input.redirectUris.length ||
      !input.redirectUris.every((uri) => typeof uri === "string" && isAllowedOAuthRedirectUri(uri))
    ) {
      throw new Error("INVALID_REDIRECT_URIS");
    }
    const cutoff = Date.now() - PROVISIONAL_CLIENT_TTL_MS;
    for (const [clientId, client] of this.clients) {
      if (!client.authorizedAt && Date.parse(client.createdAt) < cutoff) this.clients.delete(clientId);
    }
    const provisional = [...this.clients.values()]
      .filter((client) => !client.authorizedAt)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const authorizedCount = this.clients.size - provisional.length;
    if (authorizedCount >= MAX_REGISTERED_CLIENTS) {
      throw new Error("CLIENT_REGISTRATION_LIMIT");
    }
    while (provisional.length >= MAX_PROVISIONAL_CLIENTS) {
      const oldest = provisional.shift();
      if (oldest) this.clients.delete(oldest.clientId);
    }
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: sanitizeClientName(input.clientName),
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  markClientAuthorized(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.authorizedAt = new Date().toISOString();
    this.save();
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const scopes = [...new Set(input.scopes)];
    if (scopes.some((scope) => !(SUPPORTED_SCOPES as readonly string[]).includes(scope))) {
      throw new Error("Unsupported OAuth scope.");
    }
    const now = Date.now();
    for (const [hash, token] of this.tokens) {
      if (token.revoked || token.expiresAt <= now) this.tokens.delete(hash);
    }
    const requiredSlots = scopes.includes("offline_access") ? 2 : 1;
    const oldestAccessTokens = [...this.tokens.values()]
      .filter((token) => token.kind === "access")
      .sort((a, b) => a.issuedAt - b.issuedAt);
    while (this.tokens.size + requiredSlots > MAX_PERSISTED_TOKENS && oldestAccessTokens.length > 0) {
      const oldest = oldestAccessTokens.shift();
      if (oldest) this.tokens.delete(oldest.hash);
    }
    if (this.tokens.size + requiredSlots > MAX_PERSISTED_TOKENS) {
      throw new Error("TOKEN_LIMIT_REACHED");
    }
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.clients.clear();
    this.tokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }

  static deleteStateFile(workspaceId: string): void {
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return ["workspace.read"];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  return asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
}

export function invalidScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return [];
  return requested
    .split(/[\s+]+/)
    .filter(Boolean)
    .filter((scope) => !(SUPPORTED_SCOPES as readonly string[]).includes(scope));
}
