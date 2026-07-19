// 대시보드 (설계서 §7) — 화면 5개: 로그인·자동화·인박스·연락처·로그.
// 서버 렌더 HTML, 모바일 우선. 세션 쿠키 가드.

import type { Hono } from "hono";
import type { Env, Automation } from "../types";
import { signSession, verifySession } from "../crypto";
import * as db from "../db";
import * as meta from "../meta";
import { page, esc, fmt } from "./views";

const SESSION_COOKIE = "adm_session";

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const TYPE_LABEL: Record<string, string> = {
  comment_keyword: "댓글 키워드",
  dm_keyword: "DM 키워드",
  story_reply: "스토리 답장",
};

async function metaConfig(env: Env): Promise<meta.MetaConfig | null> {
  const [apiVersion, igUserId, accessToken] = await Promise.all([
    db.getSetting(env.DB, "api_version"),
    db.getSetting(env.DB, "ig_user_id"),
    db.getSetting(env.DB, "ig_access_token"),
  ]);
  if (!apiVersion || !igUserId || !accessToken) return null;
  return { apiVersion, igUserId, accessToken };
}

export function mountApp(app: Hono<{ Bindings: Env }>): void {
  // ── 로그인 ──
  app.get("/app/login", (c) =>
    c.html(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
        `<form method=post style="max-width:320px;margin:15vh auto;font-family:system-ui;display:flex;gap:8px;flex-direction:column;padding:1rem">` +
        `<h3>auto-dm</h3><input type=password name=password placeholder="비밀번호" autofocus>` +
        `<button style="padding:.5rem;font:inherit">로그인</button></form>`,
    ),
  );

  app.post("/app/login", async (c) => {
    const form = await c.req.parseBody();
    if (form.password !== c.env.DASHBOARD_PASSWORD) {
      await new Promise((r) => setTimeout(r, 1000));
      return c.text("unauthorized", 401);
    }
    const cookie = await signSession(c.env.SESSION_SIGNING_KEY, "ok");
    c.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`,
    );
    return c.redirect("/app/automations");
  });

  // ── 가드 (login 제외 전 경로) ──
  app.use("/app", guard);
  app.use("/app/*", guard);
  async function guard(c: any, next: any) {
    if (c.req.path === "/app/login") return next();
    const cookie = parseCookie(c.req.header("cookie") ?? null, SESSION_COOKIE);
    if (!(await verifySession(c.env.SESSION_SIGNING_KEY, cookie))) return c.redirect("/app/login");
    return next();
  }

  app.get("/app", (c) => c.redirect("/app/automations"));

  // ── 화면 2: 자동화 ──
  app.get("/app/automations", async (c) => {
    const rows = await db.listAutomations(c.env.DB);
    const list =
      rows.length === 0
        ? `<p class=muted>아직 자동화가 없어요. 아래에서 첫 규칙을 만들어보세요.</p>`
        : rows
            .map(
              (a) => `<div class=card><div class=row>
        <div><b>${esc(a.name)}</b> <span class="badge ${a.enabled ? "on-b" : "off-b"}">${a.enabled ? "ON" : "OFF"}</span></div>
        <div class=muted>${TYPE_LABEL[a.type] ?? a.type}</div></div>
        <div class=muted>키워드 ${esc(a.keywords_json)} · 발동 ${a.hit_count}회${a.step_count ? ` · 후속 ${a.step_count}단계` : ""}</div>
        <div class=row style="margin-top:.5rem">
          <form class=inline method=post action="/app/automations/${a.id}/toggle"><button>${a.enabled ? "끄기" : "켜기"}</button></form>
          <form class=inline method=post action="/app/automations/${a.id}/delete" onsubmit="return confirm('삭제할까요?')"><button class=danger>삭제</button></form>
        </div></div>`,
            )
            .join("");
    return c.html(page("automations", "자동화", list + `<p style="margin-top:1rem"><a class=btn href="/app/automations/new">+ 새 자동화</a></p>`));
  });

  app.get("/app/automations/new", async (c) => {
    // 게시물 드롭다운 (media API 최근 25개) — 토큰 없거나 실패 시 텍스트 입력으로 폴백
    let mediaField = `<input name=media_id placeholder="게시물 ID (비우면 모든 게시물)">`;
    const cfg = await metaConfig(c.env);
    if (cfg) {
      try {
        const res = await fetch(
          `https://graph.instagram.com/${cfg.apiVersion}/${cfg.igUserId}/media?fields=id,caption&limit=25&access_token=${cfg.accessToken}`,
        );
        const j: any = await res.json();
        if (Array.isArray(j?.data) && j.data.length) {
          const opts = j.data
            .map((m: any) => `<option value="${esc(m.id)}">${esc((m.caption ?? m.id).slice(0, 40))}</option>`)
            .join("");
          mediaField = `<select name=media_id><option value="">모든 게시물</option>${opts}</select>`;
        }
      } catch {
        /* 폴백 유지 */
      }
    }
    const stepFields = [1, 2, 3]
      .map(
        (n) => `<div class=card><div class=muted>후속 ${n} (선택)</div>
      <label>지연(분)<input type=number name=step${n}_delay min=1 placeholder="예: 10"></label>
      <label>본문<textarea name=step${n}_text placeholder="비우면 사용 안 함"></textarea></label></div>`,
      )
      .join("");
    return c.html(
      page(
        "automations",
        "새 자동화",
        `<form method=post action="/app/automations">
      <label>이름<input name=name required placeholder="예: e북 배포"></label>
      <label>유형<select name=type>
        <option value=comment_keyword>댓글 키워드 → 자동 DM</option>
        <option value=dm_keyword>DM 키워드 자동응답</option>
        <option value=story_reply>스토리 답장 반응</option></select></label>
      <label>게시물 (댓글 유형만)${mediaField}</label>
      <label>키워드 (쉼표 구분 · 스토리 답장은 비우면 모든 답장)<input name=keywords placeholder="빛, e북"></label>
      <label>매칭<select name=match_mode><option value=contains>포함</option><option value=exact>정확히 일치</option></select></label>
      <label>공개 답장 (댓글에 달 댓글 · 선택)<input name=public_reply_text placeholder="DM 보냈어요 🌊"></label>
      <label>DM 본문<textarea name=dm_text required placeholder="(자동 발송) e북 링크: ..."></textarea></label>
      <label>부착 태그 (선택)<input name=tag_to_apply placeholder="ebook-3light"></label>
      <label><input type=checkbox name=once value=1 checked style="width:auto"> 1인 1회만 발동</label>
      <label>쿨다운(시간) — 1인1회 끌 때 재발동 간격<input type=number name=cooldown_hours min=0 value=0></label>
      <h4>후속 발송 (시퀀스 · 24h 윈도우 안에서만)</h4>${stepFields}
      <p style="margin-top:1rem"><button class=primary>만들기</button> <a class=btn href="/app/automations">취소</a></p>
    </form>`,
      ),
    );
  });

  app.post("/app/automations", async (c) => {
    const f = await c.req.parseBody();
    const keywords = String(f.keywords ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const steps: { delay_minutes: number; text: string }[] = [];
    for (const n of [1, 2, 3]) {
      const delay = parseInt(String(f[`step${n}_delay`] ?? ""), 10);
      const text = String(f[`step${n}_text`] ?? "").trim();
      if (delay > 0 && text) steps.push({ delay_minutes: delay, text });
    }
    await db.createAutomation(
      c.env.DB,
      {
        name: String(f.name ?? "무제").trim(),
        type: String(f.type ?? "comment_keyword"),
        media_id: String(f.media_id ?? "").trim() || null,
        keywords_json: JSON.stringify(keywords),
        match_mode: f.match_mode === "exact" ? "exact" : "contains",
        public_reply_text: String(f.public_reply_text ?? "").trim() || null,
        dm_text: String(f.dm_text ?? "").trim(),
        once_per_user: f.once ? 1 : 0,
        cooldown_hours: parseInt(String(f.cooldown_hours ?? "0"), 10) || 0,
        tag_to_apply: String(f.tag_to_apply ?? "").trim() || null,
      },
      steps,
    );
    return c.redirect("/app/automations");
  });

  app.post("/app/automations/:id/toggle", async (c) => {
    await db.toggleAutomation(c.env.DB, parseInt(c.req.param("id"), 10));
    return c.redirect("/app/automations");
  });
  app.post("/app/automations/:id/delete", async (c) => {
    await db.deleteAutomation(c.env.DB, parseInt(c.req.param("id"), 10));
    return c.redirect("/app/automations");
  });

  // ── 화면 3: 인박스 ──
  app.get("/app/inbox", async (c) => {
    const rows = await db.listConversations(c.env.DB);
    const list =
      rows.length === 0
        ? `<p class=muted>아직 대화가 없어요.</p>`
        : rows
            .map(
              (r) => `<a class=card style="display:block;text-decoration:none;color:inherit" href="/app/inbox/${encodeURIComponent(r.id)}">
        <div class=row><b>${esc(r.username ?? r.id)}</b>
          <span class=muted>${fmt(r.last_at)}</span></div>
        <div class=muted>${r.last_dir === "out" ? "→ " : ""}${esc((r.last_text ?? "").slice(0, 48))}</div>
        ${r.automation_paused ? `<span class="badge off-b">자동화 정지</span>` : ""}</a>`,
            )
            .join("");
    return c.html(page("inbox", "인박스", list));
  });

  app.get("/app/inbox/:id", async (c) => {
    const id = c.req.param("id");
    const { contact, messages, pendingJobs } = await db.getConversation(c.env.DB, id);
    if (!contact) return c.html(page("inbox", "인박스", `<p class=muted>없는 대화예요.</p>`));
    const open = db.withinWindow(contact.last_inbound_at);
    const timeline = messages
      .map(
        (m) => `<div class="bubble ${m.direction === "in" ? "in" : "out"}">${esc(m.text ?? "")}
      <div class=muted style="font-size:.7rem">${m.source} · ${fmt(m.created_at)}</div></div>`,
      )
      .join("");
    const replyBox = open
      ? `<form method=post action="/app/inbox/${encodeURIComponent(id)}/reply">
         <textarea name=text required placeholder="답장…"></textarea>
         <button class=primary style="margin-top:.4rem">보내기</button></form>`
      : `<p class=muted>24시간 메시징 윈도우 밖이라 수동 답장을 보낼 수 없어요. (상대가 다시 메시지를 보내면 열려요)</p>`;
    return c.html(
      page(
        "inbox",
        contact.username ?? id,
        `<div class=row><h3 style="margin:.2rem 0">${esc(contact.username ?? id)}</h3>
       <span class="badge ${open ? "on-b" : "off-b"}">${open ? "윈도우 열림" : "윈도우 닫힘"}</span></div>
     <div class="tl">${timeline || '<p class=muted>메시지 없음</p>'}</div>
     <div class=card>${replyBox}</div>
     <div class=row>
       <form class=inline method=post action="/app/inbox/${encodeURIComponent(id)}/pause"><button>${contact.automation_paused ? "자동화 재개" : "자동화 정지"}</button></form>
       ${pendingJobs ? `<form class=inline method=post action="/app/inbox/${encodeURIComponent(id)}/cancel-jobs"><button class=danger>예약 ${pendingJobs}건 취소</button></form>` : `<span class=muted>예약된 후속 없음</span>`}
     </div>`,
      ),
    );
  });

  app.post("/app/inbox/:id/reply", async (c) => {
    const id = c.req.param("id");
    const f = await c.req.parseBody();
    const text = String(f.text ?? "").trim();
    const { contact } = await db.getConversation(c.env.DB, id);
    if (contact && db.withinWindow(contact.last_inbound_at) && text) {
      const cfg = await metaConfig(c.env);
      if (cfg) {
        const r = await meta.sendDirectMessage(cfg, id, text);
        if (r.ok) {
          await db.logMessage(c.env.DB, {
            id: r.body?.message_id ?? `manual:${Date.now()}`,
            contactId: id,
            direction: "out",
            source: "manual",
            kind: "dm",
            text,
          });
        }
      }
    }
    return c.redirect(`/app/inbox/${encodeURIComponent(id)}`);
  });

  app.post("/app/inbox/:id/pause", async (c) => {
    const id = c.req.param("id");
    const { contact } = await db.getConversation(c.env.DB, id);
    await db.setPaused(c.env.DB, id, !(contact?.automation_paused === 1));
    return c.redirect(`/app/inbox/${encodeURIComponent(id)}`);
  });

  app.post("/app/inbox/:id/cancel-jobs", async (c) => {
    const id = c.req.param("id");
    await db.cancelPendingJobs(c.env.DB, id);
    return c.redirect(`/app/inbox/${encodeURIComponent(id)}`);
  });

  // ── 화면 4: 연락처 ──
  app.get("/app/contacts", async (c) => {
    const tag = c.req.query("tag") || null;
    const [rows, tags] = await Promise.all([db.listContacts(c.env.DB, tag), db.listAllTags(c.env.DB)]);
    const filter =
      `<div class=muted style="margin-bottom:.5rem">태그: ` +
      `<a href="/app/contacts">전체</a> ` +
      tags.map((t) => `<a href="/app/contacts?tag=${encodeURIComponent(t)}"${t === tag ? ' style="font-weight:700"' : ""}>${esc(t)}</a>`).join(" · ") +
      `</div>`;
    const table =
      rows.length === 0
        ? `<p class=muted>연락처가 없어요.</p>`
        : `<table><tr><th>사용자</th><th>태그</th><th>최근</th></tr>` +
          rows
            .map(
              (r) => `<tr><td><a href="/app/inbox/${encodeURIComponent(r.id)}">${esc(r.username ?? r.id)}</a></td>
        <td>${esc(r.tags ?? "")}</td><td class=kl>${fmt(r.last_seen_at)}</td></tr>`,
            )
            .join("") +
          `</table>`;
    const csv = `<p style="margin-top:1rem"><a class=btn href="/app/contacts.csv${tag ? `?tag=${encodeURIComponent(tag)}` : ""}">CSV 내보내기</a></p>`;
    return c.html(page("contacts", "연락처", filter + table + csv));
  });

  app.get("/app/contacts.csv", async (c) => {
    const tag = c.req.query("tag") || null;
    const rows = await db.listContacts(c.env.DB, tag);
    const csv =
      "id,username,tags,last_seen_at\n" +
      rows
        .map((r) => [r.id, r.username ?? "", (r.tags ?? "").replace(/,/g, "|"), r.last_seen_at].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
        .join("\n");
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="contacts${tag ? "-" + tag : ""}.csv"`);
    return c.body(csv);
  });

  // ── 화면 5: 로그 ──
  app.get("/app/logs", async (c) => {
    const errorsOnly = c.req.query("errors") === "1";
    const rows = await db.listEvents(c.env.DB, errorsOnly);
    const toggle = errorsOnly
      ? `<a class=btn href="/app/logs">전체 보기</a>`
      : `<a class=btn href="/app/logs?errors=1">에러만</a>`;
    const table =
      rows.length === 0
        ? `<p class=muted>로그가 없어요.</p>`
        : `<table><tr><th>시각</th><th>유형</th><th>결과</th></tr>` +
          rows
            .map((r) => {
              const isErr = (r.outcome ?? "").includes("err");
              return `<tr><td class=kl>${fmt(r.created_at)}</td><td>${esc(r.type)}</td>
        <td>${isErr ? `<span class="badge err">${esc(r.outcome)}</span>` : esc(r.outcome ?? "")}</td></tr>`;
            })
            .join("") +
          `</table>`;
    return c.html(page("logs", "로그", `<p>${toggle}</p>` + table));
  });

  // ── 화면 6: 설정 (인스타 연결 — M1 토큰을 브라우저에서 입력) ──
  app.get("/app/settings", async (c) => {
    const [token, userId, apiVersion, appSecret] = await Promise.all([
      db.getSetting(c.env.DB, "ig_access_token"),
      db.getSetting(c.env.DB, "ig_user_id"),
      db.getSetting(c.env.DB, "api_version"),
      db.getSetting(c.env.DB, "app_secret"),
    ]);

    // 연결 테스트: 토큰 있으면 /me 호출해서 즉시 확인
    let status = `<div class=card><b>연결 상태</b><div class=muted>아직 토큰이 없어요. 아래에 붙여넣고 저장하세요.</div></div>`;
    if (token && userId && apiVersion) {
      try {
        const res = await fetch(
          `https://graph.instagram.com/${apiVersion}/me?fields=user_id,username&access_token=${token}`,
        );
        const j: any = await res.json();
        if (res.ok && (j.username || j.user_id)) {
          status = `<div class=card><b>✅ 연결됨</b><div class=muted>@${esc(j.username ?? j.user_id)} · API ${esc(apiVersion)}</div></div>`;
        } else {
          status = `<div class=card><b>⚠️ 토큰 문제</b><div class="badge err">${esc(j?.error?.message ?? "확인 실패")}</div><div class=muted>토큰이 만료됐거나 권한이 부족할 수 있어요. 새 토큰으로 다시 저장하세요.</div></div>`;
        }
      } catch {
        status = `<div class=card><b>⚠️ 확인 중 오류</b><div class=muted>잠시 후 새로고침 해보세요.</div></div>`;
      }
    }

    const setBadge = (v: string | null) => (v ? `<span class="badge on-b">저장됨</span>` : `<span class="badge off-b">비어있음</span>`);

    return c.html(
      page(
        "settings",
        "설정",
        status +
          `<form method=post action="/app/settings">
        <label>인스타그램 액세스 토큰 ${setBadge(token)}
          <textarea name=ig_access_token placeholder="${token ? "(그대로 두면 유지, 바꾸려면 새 토큰 붙여넣기)" : "Meta에서 받은 긴 토큰 붙여넣기"}"></textarea></label>
        <label>인스타그램 유저 ID ${setBadge(userId)}
          <input name=ig_user_id value="${esc(userId ?? "")}" placeholder="숫자 ID"></label>
        <label>API 버전<input name=api_version value="${esc(apiVersion ?? "v25.0")}"></label>
        <label>앱 시크릿 (App Secret) ${setBadge(appSecret)}
          <input name=app_secret type=password placeholder="${appSecret ? "(그대로 두면 유지)" : "Meta 앱 설정>기본의 앱 시크릿"}"></label>
        <p class=muted>토큰·유저ID·앱시크릿은 여기(대시보드)에서만 관리돼요. 빈 칸은 기존 값을 유지합니다.</p>
        <p><button class=primary>저장</button></p>
      </form>
      <div class=card><div class=muted>연결 후 할 일: ① Meta 앱에서 웹훅 콜백 URL 등록 → ② 자동화 탭에서 규칙 만들기 → ③ 게시물에 키워드 댓글로 테스트.
      웹훅 콜백 URL은 <code>${new URL(c.req.url).origin}/webhook</code></div></div>`,
      ),
    );
  });

  app.post("/app/settings", async (c) => {
    const f = await c.req.parseBody();
    const token = String(f.ig_access_token ?? "").trim();
    const userId = String(f.ig_user_id ?? "").trim();
    const apiVersion = String(f.api_version ?? "").trim() || "v25.0";
    const appSecret = String(f.app_secret ?? "").trim();
    if (token) await db.setSetting(c.env.DB, "ig_access_token", token);
    if (userId) await db.setSetting(c.env.DB, "ig_user_id", userId);
    await db.setSetting(c.env.DB, "api_version", apiVersion);
    if (appSecret) await db.setSetting(c.env.DB, "app_secret", appSecret);
    return c.redirect("/app/settings");
  });
}
