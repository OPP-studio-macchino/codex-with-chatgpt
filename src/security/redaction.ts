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
      /(["']?(?:AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|STRIPE_SECRET_KEY|DATABASE_URL)["']?\s*[:=]\s*["'])([^"'\r\n]{4,})(["'])/gi,
    replacement: "$1[REDACTED]$3",
  },
  {
    pattern:
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key|cookie)["']?\s*[:=]\s*["'])([^"'\r\n]{4,})(["'])/gi,
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
