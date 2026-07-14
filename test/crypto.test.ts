import { describe, it, expect } from "vitest";
import { verifyWebhookSignature, signSession, verifySession } from "../src/crypto";

const enc = new TextEncoder();
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifyWebhookSignature", () => {
  const secret = "app_secret_123";
  const body = '{"object":"instagram","entry":[{"id":"1"}]}';

  it("올바른 서명 통과", async () => {
    const sig = "sha256=" + (await hmacHex(secret, body));
    expect(await verifyWebhookSignature(secret, sig, body)).toBe(true);
  });

  it("틀린 서명 거부", async () => {
    const sig = "sha256=" + (await hmacHex("wrong_secret", body));
    expect(await verifyWebhookSignature(secret, sig, body)).toBe(false);
  });

  it("본문 변조 거부", async () => {
    const sig = "sha256=" + (await hmacHex(secret, body));
    expect(await verifyWebhookSignature(secret, sig, body + " ")).toBe(false);
  });

  it("헤더 없음/형식오류 거부", async () => {
    expect(await verifyWebhookSignature(secret, null, body)).toBe(false);
    expect(await verifyWebhookSignature(secret, "md5=abc", body)).toBe(false);
  });
});

describe("세션 서명", () => {
  const key = "session_key";
  it("서명→검증 왕복", async () => {
    const cookie = await signSession(key, "ok");
    expect(await verifySession(key, cookie)).toBe(true);
  });
  it("변조/다른키 거부", async () => {
    const cookie = await signSession(key, "ok");
    expect(await verifySession("other_key", cookie)).toBe(false);
    expect(await verifySession(key, "ok.deadbeef")).toBe(false);
    expect(await verifySession(key, null)).toBe(false);
  });
});
