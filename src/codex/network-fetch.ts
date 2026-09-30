import { createHash } from "node:crypto";
import { normalizeCodexNetworkHost, normalizeCodexNetworkHosts } from "./network-policy.js";

const MAX_NETWORK_IMAGE_BYTES = 4 * 1024 * 1024;
const NETWORK_FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface NetworkImageResult {
  mimeType: string;
  data: Buffer;
  bytes: number;
  sha256: string;
  sourceUrl: string;
}

function validateUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  if (
    typeof rawUrl !== "string" ||
    rawUrl !== rawUrl.trim() ||
    rawUrl.length < 1 ||
    rawUrl.length > 2048
  ) {
    throw new Error("Network image URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Network image URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("Only credential-free HTTPS image URLs on the default port are allowed.");
  }
  const host = normalizeCodexNetworkHost(url.hostname);
  const allowlist = new Set(normalizeCodexNetworkHosts(allowedHosts));
  if (!allowlist.has(host)) {
    throw new Error("Network image host is not owner-approved.");
  }
  return url;
}

export async function fetchAllowedNetworkImage(
  rawUrl: string,
  allowedHosts: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<NetworkImageResult> {
  const url = validateUrl(rawUrl, allowedHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      headers: {
        Accept: "image/jpeg,image/png,image/webp",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error("Network image request did not return HTTP 200.");
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new Error("Network response is not an allowed image type.");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_NETWORK_IMAGE_BYTES) {
      throw new Error("Network image exceeds the byte limit.");
    }
    if (!response.body) throw new Error("Network image response has no body.");

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > MAX_NETWORK_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Network image exceeds the byte limit.");
      }
      chunks.push(value);
    }
    if (total < 1) throw new Error("Network image response is empty.");
    const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    return {
      mimeType: contentType,
      data,
      bytes: total,
      sha256: createHash("sha256").update(data).digest("hex"),
      sourceUrl: url.toString(),
    };
  } finally {
    clearTimeout(timer);
  }
}
