// 시퀀스 엔진 — Cron 매 1분 (설계서 §6)

import type { Env } from "./types";
import * as db from "./db";
import * as meta from "./meta";
import type { MetaConfig } from "./meta";

interface JobRow {
  id: number;
  step_id: number;
  contact_id: string;
  text: string;
  attempt: number;
  last_inbound_at: string | null;
  automation_paused: number;
}

async function loadMetaConfig(env: Env): Promise<MetaConfig | null> {
  const [apiVersion, igUserId, accessToken] = await Promise.all([
    db.getSetting(env.DB, "api_version"),
    db.getSetting(env.DB, "ig_user_id"),
    db.getSetting(env.DB, "ig_access_token"),
  ]);
  if (!apiVersion || !igUserId || !accessToken) return null;
  return { apiVersion, igUserId, accessToken };
}

const WINDOW_MS = 24 * 3600_000;

/** 만료·정지·정상발송 판정 (설계서 §6-2). 순수 함수로 분리 — 테스트 대상. */
export function decideJob(
  now: number,
  lastInboundAt: string | null,
  paused: number,
): "cancelled" | "expired" | "send" {
  if (paused === 1) return "cancelled";
  if (!lastInboundAt) return "expired";
  if (now - new Date(lastInboundAt).getTime() >= WINDOW_MS) return "expired";
  return "send";
}

async function resolve(env: Env, jobId: number, status: string): Promise<void> {
  await env.DB.prepare("UPDATE sequence_jobs SET status = ?, resolved_at = ? WHERE id = ?")
    .bind(status, db.nowIso(), jobId)
    .run();
}

/** 매 분 실행: pending & due 잡 처리 (설계서 §6). */
export async function runSequenceTick(env: Env): Promise<void> {
  const now = Date.now();
  const due = await env.DB.prepare(
    "SELECT j.id, j.step_id, j.contact_id, j.attempt, s.text, " +
      "       c.last_inbound_at, c.automation_paused " +
      "FROM sequence_jobs j " +
      "JOIN sequence_steps s ON s.id = j.step_id " +
      "JOIN contacts c ON c.id = j.contact_id " +
      "WHERE j.status = 'pending' AND j.due_at <= ? " +
      "ORDER BY j.due_at LIMIT 50",
  )
    .bind(db.nowIso())
    .all<JobRow>();

  const jobs = due.results ?? [];
  if (jobs.length === 0) return;

  const cfg = await loadMetaConfig(env);

  for (const job of jobs) {
    const decision = decideJob(now, job.last_inbound_at, job.automation_paused);
    if (decision !== "send") {
      await resolve(env, job.id, decision);
      continue;
    }
    if (!cfg) {
      await resolve(env, job.id, "failed");
      continue;
    }
    const r = await meta.sendDirectMessage(cfg, job.contact_id, job.text);
    if (r.ok) {
      await db.logMessage(env.DB, {
        id: r.body?.message_id ?? `seq:${job.id}`,
        contactId: job.contact_id,
        direction: "out",
        source: "sequence",
        kind: "dm",
        text: job.text,
      });
      await resolve(env, job.id, "sent");
    } else if (r.status === 429 && job.attempt < 3) {
      // 요율 제한 — 다음 tick 재시도 (설계서 §4.6)
      await env.DB.prepare("UPDATE sequence_jobs SET attempt = attempt + 1 WHERE id = ?").bind(job.id).run();
    } else {
      await resolve(env, job.id, "failed");
    }
  }
}

/** 주 1회 토큰 갱신 (설계서 §4.5). 월요일 첫 실행에서 호출. */
export async function maybeRefreshToken(env: Env, now: Date): Promise<void> {
  if (now.getUTCDay() !== 1) return; // 월요일만
  const last = await db.getSetting(env.DB, "token_refreshed_at");
  if (last && now.getTime() - new Date(last).getTime() < 6 * 24 * 3600_000) return;
  const token = await db.getSetting(env.DB, "ig_access_token");
  if (!token) return;
  const r = await meta.refreshToken(token);
  if (r.ok && r.body?.access_token) {
    await db.setSetting(env.DB, "ig_access_token", r.body.access_token);
    await db.setSetting(env.DB, "token_refreshed_at", now.toISOString());
  }
}
