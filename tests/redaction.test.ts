import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "../src/security/redaction.js";
import { Logger, redact } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("outbound secret redaction", () => {
  it("redacts common credentials while preserving ordinary source text", () => {
    const secrets = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
      "AKIAABCDEFGHIJKLMNOP",
      "npm_abcdefghijklmnopqrstuvwxyz123456",
      "c2c_at_abcdefghijklmnopqrstuvwxyz1234567890",
      "c2c_tunnel_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
    ];
    const input = [
      "const answer = 42;",
      `api_key = "${secrets[0]}"`,
      `token=${secrets[1]}`,
      `AWS_ACCESS_KEY_ID=${secrets[2]}`,
      `NPM_TOKEN=${secrets[3]}`,
      `Authorization: Bearer ${secrets[4]}`,
      `tunnel_header = "${secrets[5]}"`,
      'AWS_SECRET_ACCESS_KEY="synthetic-secret-value"',
      "password = 'correct horse battery staple'",
    ].join("\n");

    const result = redactSensitiveText(input);
    expect(result.text).toContain("const answer = 42;");
    for (const secret of secrets) expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain("synthetic-secret-value");
    expect(result.text).toContain("[REDACTED]");
    expect(result.redactionCount).toBeGreaterThanOrEqual(5);
  });

  it("redacts private-key blocks and credentials embedded in URLs", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "abc123",
      "-----END PRIVATE KEY-----",
      "https://alice:supersecret@example.com/private",
    ].join("\n");
    const result = redactSensitiveText(input);
    expect(result.text).not.toContain("abc123");
    expect(result.text).not.toContain("supersecret");
    expect(result.text).toContain("[REDACTED PRIVATE KEY]");
  });

  it("is idempotent and the logger also hides pairing codes", () => {
    const once = redactSensitiveText('password = "[REDACTED]"').text;
    expect(redactSensitiveText(once).text).toBe(once);
    expect(redact("Pair with ABCD-EFGH")).toBe("Pair with [REDACTED]");
  });

  it("bounds individual log fields", () => {
    const dir = makeTmpDir("bounded-log");
    const file = path.join(dir, "bridge.log");
    new Logger({ file }).info("x".repeat(100_000), { detail: "y".repeat(100_000) });
    expect(fs.statSync(file).size).toBeLessThan(20_000);
    cleanup(dir);
  });
});
