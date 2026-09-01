/**
 * Last-line-of-defense redaction for text that may leave the local machine.
 *
 * Path policy is the primary boundary. This scanner covers credentials that
 * were accidentally committed or embedded in an otherwise-readable file. It
 * intentionally avoids generic entropy guessing because that would corrupt
 * ordinary source code while still failing to prove that arbitrary PII is
 * absent.
 */

export interface RedactionResult {
  text: string;
  redactionCount: number;
}

export interface RedactedTruncatedResult extends RedactionResult {
  truncated: boolean;
}

type Rule = {
  pattern: RegExp;
  replacement: string;
};

const RULES: Rule[] = [
  {
    pattern:
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  {
    pattern: /\bc2c_(?:at|rt|ac|admin|tunnel)_[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED C2C CREDENTIAL]",
  },
  {
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g,
    replacement: "[REDACTED PROVIDER KEY]",
  },
  {
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED API KEY]",
  },
  {
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g,
    replacement: "[REDACTED SOURCE CONTROL TOKEN]",
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED CHAT TOKEN]",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED CLOUD ACCESS KEY]",
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replacement: "[REDACTED API KEY]",
  },
  {
    pattern: /\b(?:npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{20,})\b/g,
    replacement: "[REDACTED PROVIDER KEY]",
  },
  {
    pattern: /(\b(?:authorization|proxy-authorization)\s*:\s*Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    replacement: "$1[REDACTED]$2",
  },
  {
    pattern:
      /(["'`]?(?:AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|STRIPE_SECRET_KEY|DATABASE_URL)["'`]?\s*[:=]\s*["'`])([^"'`\r\n]{4,})(["'`])/gi,
    replacement: "$1[REDACTED]$3",
  },
  {
    pattern:
      /(["'`]?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key|cookie)["'`]?\s*[:=]\s*["'`])([^"'`\r\n]{4,})(["'`])/gi,
    replacement: "$1[REDACTED]$3",
  },
  {
    pattern:
      /^(\s*(?:AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|STRIPE_SECRET_KEY|DATABASE_URL)\s*=\s*)([^\r\n#]{4,})/gim,
    replacement: "$1[REDACTED]",
  },
  {
    pattern:
      /^(\s*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|COOKIE)\s*=\s*)([^\r\n#]{4,})/gim,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /^(\s*(?:Cookie|Set-Cookie)\s*:\s*).+$/gim,
    replacement: "$1[REDACTED]",
  },
];

const MAX_REDACTION_INPUT_BYTES = 4 * 1024 * 1024;
const TRUNCATION_MARKER = " [TRUNCATED]";
const PRIVATE_KEY_BEGIN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----/;

function utf8Prefix(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(input, "utf8");
  if (bytes.length <= maxBytes) return input;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function redactSensitiveText(input: string): RedactionResult {
  let text = input;
  let redactionCount = 0;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      if (match.includes("[REDACTED")) return match;
      redactionCount++;
      return match.replace(rule.pattern, rule.replacement);
    });
  }
  return { text, redactionCount };
}

/**
 * Stateful line redaction for descriptor-streamed files. It prevents a
 * multi-line private-key block from becoming visible when pagination or search
 * splits BEGIN/body/END across separate output units.
 */
export class StreamingSecretRedactor {
  private privateKeyLabel: string | null = null;

  redactLine(input: string): RedactionResult {
    if (this.privateKeyLabel) {
      const endMarker = `-----END ${this.privateKeyLabel}-----`;
      const end = input.indexOf(endMarker);
      if (end < 0) {
        return { text: "[REDACTED PRIVATE KEY CONTENT]", redactionCount: 1 };
      }
      this.privateKeyLabel = null;
      const suffix = input.slice(end + endMarker.length);
      const remainder = suffix ? this.redactLine(suffix) : { text: "", redactionCount: 0 };
      return {
        text: `[REDACTED PRIVATE KEY]${remainder.text}`,
        redactionCount: 1 + remainder.redactionCount,
      };
    }

    const begin = PRIVATE_KEY_BEGIN.exec(input);
    if (!begin || begin.index === undefined) return redactSensitiveText(input);
    const endMarker = `-----END ${begin[1]}-----`;
    const end = input.indexOf(endMarker, begin.index + begin[0].length);
    const prefix = redactSensitiveText(input.slice(0, begin.index));
    if (end >= 0) {
      const suffix = input.slice(end + endMarker.length);
      const remainder = suffix ? this.redactLine(suffix) : { text: "", redactionCount: 0 };
      return {
        text: `${prefix.text}[REDACTED PRIVATE KEY]${remainder.text}`,
        redactionCount: prefix.redactionCount + 1 + remainder.redactionCount,
      };
    }

    this.privateKeyLabel = begin[1];
    return {
      text: `${prefix.text}[REDACTED PRIVATE KEY]`,
      redactionCount: prefix.redactionCount + 1,
    };
  }

  isInsideMultilineSecret(): boolean {
    return this.privateKeyLabel !== null;
  }
}

/**
 * Redact a complete bounded logical unit before truncating it. This preserves
 * closing delimiters needed by credential rules and never splits UTF-8 output.
 * Oversized raw input fails closed instead of exposing a prefix that could end
 * inside a credential value.
 */
export function redactAndTruncate(
  input: string,
  maxBytes: number,
  opts: { trimEnd?: boolean } = {}
): RedactedTruncatedResult {
  const limit = Math.max(Buffer.byteLength(TRUNCATION_MARKER, "utf8"), Math.floor(maxBytes));
  const logicalUnit = opts.trimEnd === false ? input : input.trimEnd();
  if (Buffer.byteLength(logicalUnit, "utf8") > MAX_REDACTION_INPUT_BYTES) {
    return {
      text: `[REDACTED OVERSIZED TEXT]${TRUNCATION_MARKER}`,
      redactionCount: 1,
      truncated: true,
    };
  }
  const redacted = redactSensitiveText(logicalUnit);
  if (Buffer.byteLength(redacted.text, "utf8") <= limit) {
    return { ...redacted, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  return {
    text: `${utf8Prefix(redacted.text, limit - markerBytes)}${TRUNCATION_MARKER}`,
    redactionCount: redacted.redactionCount,
    truncated: true,
  };
}
