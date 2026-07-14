// 웹훅 서명 검증 + 세션 쿠키 서명 (설계서 §3.2-1, §8)
// Web Crypto만 사용 — Workers/Node 22 공통.

const enc = new TextEncoder();

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 길이 무관 타이밍-세이프 비교
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Meta 웹훅 서명 검증.
 * header = "sha256=<hex>", rawBody = 파싱 전 원문 (설계서 §3.2-1).
 */
export async function verifyWebhookSignature(
  appSecret: string,
  header: string | null,
  rawBody: string,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqual(header.slice("sha256=".length), expected);
}

/** 세션 쿠키 값 = "<payload>.<sig>" 서명 (설계서 §8). */
export async function signSession(key: string, payload: string): Promise<string> {
  const sig = await hmacSha256Hex(key, payload);
  return `${payload}.${sig}`;
}

export async function verifySession(key: string, cookie: string | null): Promise<boolean> {
  if (!cookie) return false;
  const idx = cookie.lastIndexOf(".");
  if (idx < 0) return false;
  const payload = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  const expected = await hmacSha256Hex(key, payload);
  return timingSafeEqual(sig, expected);
}
