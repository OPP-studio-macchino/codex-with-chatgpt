import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeChatGptSessionUrl,
  readSavedSession,
  sessionFile,
} from "../src/config/session.js";
import { isolateStateDir } from "./helpers.js";

describe("ChatGPT session URL validation", () => {
  it("accepts and canonicalizes ChatGPT conversation URLs", () => {
    expect(normalizeChatGptSessionUrl("https://chatgpt.com/c/abc_DEF-123/")).toBe(
      "https://chatgpt.com/c/abc_DEF-123"
    );
    expect(normalizeChatGptSessionUrl("https://chatgpt.com/g/my-gpt/c/conversation_1")).toBe(
      "https://chatgpt.com/g/my-gpt/c/conversation_1"
    );
  });

  it("rejects lookalike hosts, credentials, and non-conversation pages", () => {
    for (const candidate of [
      "https://chatgpt.com.evil.example/c/abc",
      "https://user:pass@chatgpt.com/c/abc",
      "http://chatgpt.com/c/abc",
      "https://chatgpt.com/share/abc",
      "https://example.com/c/abc",
      "https://chatgpt.com/c/abc?model=x",
      "https://chatgpt.com/c/abc#bottom",
    ]) {
      expect(() => normalizeChatGptSessionUrl(candidate)).toThrow(/ChatGPT conversation URL/);
    }
  });

  it("validates and redacts session metadata loaded from disk", () => {
    isolateStateDir();
    const file = sessionFile("0123456789abcdef01234567");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        url: "https://chatgpt.com/c/abc_DEF-123",
        title: "Review\u202e\napi_key = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890'",
        taskId: "c2c_1234",
        iteration: 2,
        lastState: "EXECUTED",
        savedAt: new Date().toISOString(),
      })
    );
    const saved = readSavedSession(file);
    expect(saved?.title).not.toContain("sk-proj-");
    expect(saved?.title).not.toContain("\u202e");
    expect(saved?.taskId).toBe("c2c_1234");
  });

  it("rejects an unsafe session URL loaded from disk", () => {
    isolateStateDir();
    const file = sessionFile("0123456789abcdef01234567");
    fs.writeFileSync(
      file,
      JSON.stringify({
        url: "https://chatgpt.com.evil.example/c/abc",
        savedAt: new Date().toISOString(),
      })
    );
    expect(readSavedSession(file)).toBeNull();
  });
});
