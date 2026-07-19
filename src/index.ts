// auto-dm 엔트리 — Hono 앱 + Cron 핸들러 (설계서 §1)

import { Hono } from "hono";
import type { Env } from "./types";
import { verifyWebhookSignature } from "./crypto";
import { processWebhook } from "./handler";
import { runSequenceTick, maybeRefreshToken } from "./sequences";
import { getSetting } from "./db";
import { mountApp } from "./app";

const app = new Hono<{ Bindings: Env }>();

// 웹훅 등록 검증 (설계서 §3.1)
app.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === c.env.WEBHOOK_VERIFY_TOKEN) {
    return c.text(challenge ?? "");
  }
  return c.text("forbidden", 403);
});

// 웹훅 수신 (설계서 §3.2)
app.post("/webhook", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-hub-signature-256") ?? null;
  // 앱 시크릿: 대시보드 설정(D1)에서 먼저, 없으면 Wrangler 시크릿(env) 폴백
  const appSecret = (await getSetting(c.env.DB, "app_secret")) || c.env.APP_SECRET;
  const valid = await verifyWebhookSignature(appSecret, sig, raw);
  if (!valid) return c.text("unauthorized", 401);

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.text("bad request", 400);
  }

  // 즉시 200, 본처리는 백그라운드 (설계서 §3.2-2)
  c.executionCtx.waitUntil(processWebhook(c.env, body));
  return c.text("EVENT_RECEIVED", 200);
});

// 대시보드 (설계서 §7)
mountApp(app);

export default {
  fetch: app.fetch,
  // Cron: 시퀀스 발송 + 토큰 갱신 (설계서 §6)
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await runSequenceTick(env);
        await maybeRefreshToken(env, new Date());
      })(),
    );
  },
};
