import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * PairingCode: a short-lived, one-time, local verification credential shown
 * on the authorization page. This is NOT an OAuth Authorization Code.
 */
export interface PairingSession {
  id: string;
  codeHash: Buffer;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  wrongAttempts: number;
  used: boolean;
}

export interface PairingVerifyOk {
  ok: true;
  sessionId: string;
}

export interface PairingVerifyFail {
  ok: false;
  reason: "invalid" | "expired" | "too_many_attempts" | "rate_limited" | "no_active_session";
  attemptsLeft?: number;
}

export type PairingVerifyResult = PairingVerifyOk | PairingVerifyFail;

// No ambiguous characters (I, L, O, 0, 1).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(length = 8): string {
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      // rejection sampling for uniformity
      if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) {
        chars.push(ALPHABET[byte % ALPHABET.length]);
        if (chars.length === length) break;
      }
    }
  }
  return chars.join("");
}

function hashCode(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

export function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export interface PairingManagerOptions {
  ttlMs?: number;
  maxAttempts?: number;
  ipRateLimit?: number;
  ipRateWindowMs?: number;
  maxStateEntries?: number;
  maxGlobalWrongAttempts?: number;
}

export class PairingManager {
  private sessions = new Map<string, PairingSession>();
  private bindingAttempts = new Map<string, { attemptsLeft: number; expiresAt: number }>();
  private rateHits = new Map<string, { count: number; resetAt: number }>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly ipRateLimit: number;
  private readonly ipRateWindowMs: number;
  private readonly maxStateEntries: number;
  private readonly maxGlobalWrongAttempts: number;

  constructor(
    private readonly workspaceId: string,
    opts: PairingManagerOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.ipRateLimit = opts.ipRateLimit ?? 10;
    this.ipRateWindowMs = opts.ipRateWindowMs ?? 60_000;
    this.maxStateEntries = opts.maxStateEntries ?? 64;
    this.maxGlobalWrongAttempts = opts.maxGlobalWrongAttempts ?? 64;
  }

  /** Create a new pairing session. Invalidates previous sessions (one active at a time). */
  create(): { sessionId: string; code: string; expiresAt: number } {
    this.sessions.clear();
    this.bindingAttempts.clear();
    this.rateHits.clear();
    const raw = generateCode();
    const session: PairingSession = {
      id: randomBytes(16).toString("hex"),
      codeHash: hashCode(raw),
      workspaceId: this.workspaceId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      wrongAttempts: 0,
      used: false,
    };
    this.sessions.set(session.id, session);
    return { sessionId: session.id, code: formatPairingCode(raw), expiresAt: session.expiresAt };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.bindingAttempts) {
      if (entry.expiresAt <= now) this.bindingAttempts.delete(key);
    }
    for (const [key, entry] of this.rateHits) {
      if (entry.resetAt <= now) this.rateHits.delete(key);
    }
  }

  private checkRate(bindingId: string, ip: string | undefined): boolean {
    const now = Date.now();
    this.prune(now);
    const key = `${bindingId}\0${ip ?? "unknown"}`;
    const entry = this.rateHits.get(key);
    if (!entry || now > entry.resetAt) {
      if (!entry && this.rateHits.size >= this.maxStateEntries) return false;
      this.rateHits.set(key, { count: 1, resetAt: now + this.ipRateWindowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.ipRateLimit;
  }

  verify(codeInput: string, bindingId: string, ip?: string): PairingVerifyResult {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(bindingId)) {
      return { ok: false, reason: "no_active_session" };
    }
    const normalized = normalizePairingCode(codeInput);
    const inputHash = hashCode(normalized);
    const now = Date.now();
    this.prune(now);

    const active = [...this.sessions.values()].filter((s) => !s.used);
    if (active.length === 0) return { ok: false, reason: "no_active_session" };

    for (const session of active) {
      if (now > session.expiresAt) {
        this.sessions.delete(session.id);
        return { ok: false, reason: "expired" };
      }
      // A correct owner-held code must remain usable even after untrusted
      // requests exhaust wrong-attempt/rate state. It is still one-time.
      const match = timingSafeEqual(inputHash, session.codeHash);
      if (match) {
        session.used = true;
        this.sessions.delete(session.id);
        this.bindingAttempts.clear();
        this.rateHits.clear();
        return { ok: true, sessionId: session.id };
      }
      if (session.wrongAttempts >= this.maxGlobalWrongAttempts || !this.checkRate(bindingId, ip)) {
        return { ok: false, reason: "rate_limited" };
      }
      const attemptKey = `${session.id}:${bindingId}`;
      let attempts = this.bindingAttempts.get(attemptKey);
      if (!attempts) {
        if (this.bindingAttempts.size >= this.maxStateEntries) return { ok: false, reason: "rate_limited" };
        attempts = { attemptsLeft: this.maxAttempts, expiresAt: session.expiresAt };
      }
      if (attempts.attemptsLeft <= 0) {
        return { ok: false, reason: "too_many_attempts" };
      }
      session.wrongAttempts++;
      attempts.attemptsLeft--;
      this.bindingAttempts.set(attemptKey, attempts);
      if (attempts.attemptsLeft <= 0) {
        return { ok: false, reason: "too_many_attempts" };
      }
      return { ok: false, reason: "invalid", attemptsLeft: attempts.attemptsLeft };
    }
    return { ok: false, reason: "no_active_session" };
  }

  hasActiveSession(): boolean {
    const now = Date.now();
    this.prune(now);
    for (const [id, session] of this.sessions) {
      if (!session.used && now <= session.expiresAt) return true;
      if (session.used || now > session.expiresAt) this.sessions.delete(id);
    }
    return false;
  }

  activeSessionId(): string | null {
    const now = Date.now();
    this.prune(now);
    for (const [id, session] of this.sessions) {
      if (!session.used && now <= session.expiresAt) return session.id;
      if (session.used || now > session.expiresAt) this.sessions.delete(id);
    }
    return null;
  }

  invalidateAll(): void {
    this.sessions.clear();
    this.bindingAttempts.clear();
    this.rateHits.clear();
  }
}
