import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  redactAndTruncate,
  redactSensitiveText,
  StreamingSecretRedactor,
} from "../src/security/redaction.js";
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

  it("keeps multiline private-key state across streamed lines", () => {
    const redactor = new StreamingSecretRedactor();
    const output = [
      "safe prefix -----BEGIN PRIVATE KEY-----",
      "cross-page-private-key-body",
      "-----END PRIVATE KEY----- safe suffix",
    ].map((line) => redactor.redactLine(line).text);
    expect(output.join("\n")).not.toContain("cross-page-private-key-body");
    expect(output[0]).toContain("safe prefix");
    expect(output[2]).toContain("safe suffix");
    expect(redactor.isInsideMultilineSecret()).toBe(false);
  });

  it("tracks a second block that begins after a complete same-line block", () => {
    const redactor = new StreamingSecretRedactor();
    const first = redactor.redactLine(
      "-----BEGIN PRIVATE KEY-----one-----END PRIVATE KEY----- -----BEGIN RSA PRIVATE KEY-----"
    );
    const body = redactor.redactLine("second-block-body");
    expect(first.text).not.toContain("one");
    expect(body.text).not.toContain("second-block-body");
    expect(redactor.isInsideMultilineSecret()).toBe(true);
    redactor.redactLine("-----END RSA PRIVATE KEY-----");
    expect(redactor.isInsideMultilineSecret()).toBe(false);
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

  it.each(['"', "'", "`"])(
    "redacts a long credential before truncating when the delimiter is %s",
    (delimiter) => {
      const secret = "S".repeat(620);
      const input = `const password = ${delimiter}${secret}${delimiter};\r\n`;
      const result = redactAndTruncate(input, 500);
      expect(result.text).not.toContain("S".repeat(32));
      expect(result.text).toContain("[REDACTED]");
      expect(result.redactionCount).toBe(1);
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(500);
    }
  );

  it.each([499, 500, 501])("adds an explicit marker across the %i-byte boundary", (size) => {
    const result = redactAndTruncate("a".repeat(size), 500);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(size > 500);
    expect(result.text.includes("[TRUNCATED]")).toBe(size > 500);
  });

  it("does not split a multi-byte character at the byte limit", () => {
    const result = redactAndTruncate("界".repeat(200), 500);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(500);
    expect(result.text).not.toContain("�");
    expect(result.text).toContain("[TRUNCATED]");
  });

  it("fails closed for an oversized logical unit", () => {
    const result = redactAndTruncate(`password = "${"X".repeat(5 * 1024 * 1024)}"`, 500);
    expect(result.text).toBe("[REDACTED OVERSIZED TEXT] [TRUNCATED]");
    expect(result.redactionCount).toBe(1);
  });
});
