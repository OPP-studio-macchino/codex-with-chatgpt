import { describe, expect, it } from "vitest";
import { fetchAllowedNetworkImage } from "../src/codex/network-fetch.js";

function jpegResponse(body = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(body.byteLength),
    },
  });
}

describe("bounded owner-approved network image fetch", () => {
  it("fetches one exact-host HTTPS image in memory without redirects", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jpegResponse();
    }) as typeof fetch;

    const result = await fetchAllowedNetworkImage(
      "https://ttc.taxi-inf.jp/Real109.jpg?20260929170000",
      ["ttc.taxi-inf.jp"],
      fakeFetch
    );

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes).toBe(4);
    expect(result.data.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
    });
  });

  it.each([
    "http://ttc.taxi-inf.jp/Real109.jpg",
    "https://evil.example/Real109.jpg",
    "https://user:pass@ttc.taxi-inf.jp/Real109.jpg",
    "https://ttc.taxi-inf.jp:444/Real109.jpg",
    "https://ttc.taxi-inf.jp/Real109.jpg#fragment",
  ])("rejects out-of-policy URL before network access: %s", async (url) => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return jpegResponse();
    }) as typeof fetch;

    await expect(fetchAllowedNetworkImage(url, ["ttc.taxi-inf.jp"], fakeFetch)).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("rejects redirects and non-image responses", async () => {
    const redirectFetch = (async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/image.jpg" },
    })) as typeof fetch;
    await expect(
      fetchAllowedNetworkImage("https://ttc.taxi-inf.jp/Real109.jpg", ["ttc.taxi-inf.jp"], redirectFetch)
    ).rejects.toThrow(/HTTP 200/);

    const textFetch = (async () => new Response("nope", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
    await expect(
      fetchAllowedNetworkImage("https://ttc.taxi-inf.jp/Real109.jpg", ["ttc.taxi-inf.jp"], textFetch)
    ).rejects.toThrow(/image type/);
  });

  it("enforces the four-megabyte streaming cap even without content-length", async () => {
    const tooLarge = new Uint8Array(4 * 1024 * 1024 + 1);
    const fakeFetch = (async () => new Response(tooLarge, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })) as typeof fetch;

    await expect(
      fetchAllowedNetworkImage("https://ttc.taxi-inf.jp/Real109.jpg", ["ttc.taxi-inf.jp"], fakeFetch)
    ).rejects.toThrow(/byte limit/);
  });
});
