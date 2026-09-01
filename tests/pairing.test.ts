import { describe, it, expect, vi, afterEach } from "vitest";
import { PairingManager, formatPairingCode, normalizePairingCode } from "../src/pairing/manager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PairingManager", () => {
  it("generates codes in XXXX-XXXX format without ambiguous characters", () => {
    const manager = new PairingManager("ws1");
    for (let i = 0; i < 20; i++) {
      const { code } = manager.create();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(code).not.toMatch(/[ILO01]/);
    }
  });

  it("accepts the correct code exactly once", () => {
    const manager = new PairingManager("ws1");
    const { code } = manager.create();
    const first = manager.verify(code, "request-1");
    expect(first.ok).toBe(true);
    const second = manager.verify(code, "request-1");
    expect(second.ok).toBe(false);
  });

  it("is forgiving about dashes and case", () => {
    const manager = new PairingManager("ws1");
    const { code } = manager.create();
    const sloppy = code.replace("-", " ").toLowerCase();
    expect(manager.verify(sloppy, "request-1").ok).toBe(true);
  });

  it("rejects wrong codes and limits attempts", () => {
    const manager = new PairingManager("ws1", { maxAttempts: 3 });
    manager.create();
    expect(manager.verify("AAAA-AAAA", "request-1")).toMatchObject({ ok: false, reason: "invalid", attemptsLeft: 2 });
    expect(manager.verify("BBBB-BBBB", "request-1")).toMatchObject({ ok: false, reason: "invalid", attemptsLeft: 1 });
    expect(manager.verify("CCCC-CCCC", "request-1")).toMatchObject({ ok: false, reason: "too_many_attempts" });
    expect(manager.verify("DDDD-DDDD", "request-1")).toMatchObject({ ok: false, reason: "too_many_attempts" });
  });

  it("expires codes after the TTL", () => {
    vi.useFakeTimers();
    const manager = new PairingManager("ws1", { ttlMs: 2 * 60_000 });
    const { code } = manager.create();
    vi.advanceTimersByTime(2 * 60_000 + 1000);
    expect(manager.verify(code, "request-1")).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rate limits per IP", () => {
    const manager = new PairingManager("ws1", { ipRateLimit: 3, maxAttempts: 100 });
    manager.create();
    manager.verify("AAAA-AAAA", "request-1", "1.2.3.4");
    manager.verify("AAAA-AAAA", "request-1", "1.2.3.4");
    manager.verify("AAAA-AAAA", "request-1", "1.2.3.4");
    expect(manager.verify("AAAA-AAAA", "request-1", "1.2.3.4")).toMatchObject({ ok: false, reason: "rate_limited" });
    // other IPs unaffected
    expect(manager.verify("AAAA-AAAA", "request-1", "5.6.7.8").reason).not.toBe("rate_limited");
  });

  it("invalidates previous sessions when creating a new one", () => {
    const manager = new PairingManager("ws1");
    const first = manager.create();
    manager.create();
    expect(manager.verify(first.code, "request-1").ok).toBe(false);
  });

  it("does not let one pending request spend another request's attempt budget", () => {
    const manager = new PairingManager("ws1", { maxAttempts: 3, ipRateLimit: 100 });
    const owner = manager.create();
    manager.verify("AAAA-AAAA", "attacker-request", "proxy");
    manager.verify("BBBB-BBBB", "attacker-request", "proxy");
    expect(manager.verify("CCCC-CCCC", "attacker-request", "proxy")).toMatchObject({
      ok: false,
      reason: "too_many_attempts",
    });
    expect(manager.verify(owner.code, "owner-request", "proxy")).toMatchObject({ ok: true });
  });

  it("hard-bounds unique attacker state while reserving a correct owner code", () => {
    const manager = new PairingManager("ws1", {
      maxAttempts: 100,
      ipRateLimit: 100,
      maxStateEntries: 64,
      maxGlobalWrongAttempts: 64,
    });
    const owner = manager.create();
    for (let index = 0; index < 20_000; index++) {
      manager.verify("1111-1111", `binding-${index}`, `ip-${index}`);
    }
    const state = manager as unknown as {
      bindingAttempts: Map<string, unknown>;
      rateHits: Map<string, unknown>;
    };
    expect(state.bindingAttempts.size).toBeLessThanOrEqual(64);
    expect(state.rateHits.size).toBeLessThanOrEqual(64);
    expect(manager.verify(owner.code, "owner-request", "proxy")).toMatchObject({ ok: true });
  });

  it("normalizes input", () => {
    expect(normalizePairingCode(" ab2-cd3 e ")).toBe("AB2CD3E");
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});
