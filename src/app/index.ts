// 대시보드 마운트 (설계서 §7) — M4에서 화면 5개 구현.
// M0~M2 단계: 로그인 가드 + placeholder. 세션 인증은 crypto.ts 재사용.

import type { Hono } from "hono";
import type { Env } from "../types";
import { signSession, verifySession } from "../crypto";

const SESSION_COOKIE = "adm_session";

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function mountApp(app: Hono<{ Bindings: Env }>): void {
  app.get("/app/login", (c) =>
    c.html(
      `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">` +
        `<form method=post style="max-width:320px;margin:15vh auto;font-family:system-ui;display:flex;gap:8px;flex-direction:column">` +
        `<h3>auto-dm</h3><input type=password name=password placeholder="비밀번호" autofocus>` +
        `<button>로그인</button></form>`,
    ),
  );

  app.post("/app/login", async (c) => {
    const form = await c.req.parseBody();
    if (form.password !== c.env.DASHBOARD_PASSWORD) {
      await new Promise((r) => setTimeout(r, 1000)); // 무차별 대입 완화
      return c.text("unauthorized", 401);
    }
    const cookie = await signSession(c.env.SESSION_SIGNING_KEY, "ok");
    c.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`,
    );
    return c.redirect("/app");
  });

  // 가드 + placeholder (M4에서 화면 구현)
  app.get("/app/*", async (c) => {
    const cookie = parseCookie(c.req.header("cookie") ?? null, SESSION_COOKIE);
    if (!(await verifySession(c.env.SESSION_SIGNING_KEY, cookie))) {
      return c.redirect("/app/login");
    }
    return c.html(`<!doctype html><p style="font-family:system-ui;margin:2rem">대시보드 — M4에서 구현 예정.</p>`);
  });

  app.get("/app", (c) => c.redirect("/app/inbox"));
}
