// 웹훅 본처리 오케스트레이션 (설계서 §3.2 5~8, §5 액션 체인)
// index.ts에서 ctx.waitUntil()로 호출.

import type { Env, NormalizedEvent } from "./types";
import { parseWebhook } from "./webhook";
import { selectAutomation } from "./triggers";
import * as db from "./db";
import * as meta from "./meta";
import type { MetaConfig } from "./meta";

async function loadMetaConfig(env: Env): Promise<MetaConfig | null> {
  const [apiVersion, igUserId, accessToken] = await Promise.all([
    db.getSetting(env.DB, "api_version"),
    db.getSetting(env.DB, "ig_user_id"),
    db.getSetting(env.DB, "ig_access_token"),
  ]);
  if (!apiVersion || !igUserId || !accessToken) return null;
  return { apiVersion, igUserId, accessToken };
}

/** 웹훅 본문 전체 처리. 이벤트별로 순서대로 (설계서 §3.2). */
export async function processWebhook(env: Env, body: any): Promise<void> {
  const events = parseWebhook(body);
  if (events.length === 0) return;

  const cfg = await loadMetaConfig(env);
  const myId = cfg?.igUserId;

  for (const ev of events) {
    await handleEvent(env, cfg, myId, ev);
  }
}

async function handleEvent(
  env: Env,
  cfg: MetaConfig | null,
  myId: string | undefined,
  ev: NormalizedEvent,
): Promise<void> {
  // 4) 중복 제거
  const inserted = await db.tryInsertEvent(env.DB, ev.dedupeKey, ev.kind, JSON.stringify(ev));
  if (!inserted) return; // 중복

  const senderId = ev.kind === "comment" ? ev.fromId : ev.senderId;

  // 6) 자기 자신 필터 (내 댓글/내 echo)
  const isSelf = (ev.kind === "comment" && senderId === myId) || (ev.kind === "dm" && ev.isEcho);
  const inbound = !isSelf; // 인바운드만 24h 윈도우 갱신 (댓글도 기록상 접점이나 윈도우 미개방은 시퀀스 단계에서 판정)

  // 5) 연락처 upsert — DM/스토리답장 인바운드만 last_inbound_at 갱신
  const opensWindow = (ev.kind === "dm" && !ev.isEcho) || ev.kind === "story_reply";
  const username = ev.kind === "comment" ? ev.fromUsername : null;
  if (senderId) await db.upsertContact(env.DB, senderId, username, opensWindow);

  if (isSelf) {
    await db.setEventOutcome(env.DB, ev.dedupeKey, "self");
    if (senderId) {
      await db.logMessage(env.DB, {
        id: ev.dedupeKey,
        contactId: senderId,
        direction: "out",
        source: ev.kind === "dm" ? "manual" : "user",
        kind: ev.kind === "comment" ? "comment" : "dm",
        text: ev.text,
      });
    }
    return;
  }

  // 인바운드 메시지 기록
  if (senderId) {
    await db.logMessage(env.DB, {
      id: ev.dedupeKey,
      contactId: senderId,
      direction: "in",
      source: "user",
      kind: ev.kind === "comment" ? "comment" : ev.kind === "story_reply" ? "story_reply" : "dm",
      text: ev.text,
    });
  }

  // 7) 트리거 매칭
  const type = ev.kind === "comment" ? "comment_keyword" : ev.kind === "story_reply" ? "story_reply" : "dm_keyword";
  const automations = await db.listEnabledAutomations(env.DB, type);
  const rule = selectAutomation(ev, automations);
  if (!rule) {
    await db.setEventOutcome(env.DB, ev.dedupeKey, "no_match");
    return;
  }

  // 연락처 가드 + 중복 발동 가드
  if (await db.isContactPaused(env.DB, senderId)) {
    await db.setEventOutcome(env.DB, ev.dedupeKey, `paused:${rule.id}`);
    return;
  }
  if (!(await db.canFire(env.DB, rule, senderId))) {
    await db.setEventOutcome(env.DB, ev.dedupeKey, `guard:${rule.id}`);
    return;
  }

  if (!cfg) {
    await db.setEventOutcome(env.DB, ev.dedupeKey, "error:no_token");
    return;
  }

  // 액션 실행 (설계서 §5 순서: 공개답장 → private reply/DM → 태그 → hits → 시퀀스)
  await runActions(env, cfg, ev, rule, senderId);
}

async function runActions(
  env: Env,
  cfg: MetaConfig,
  ev: NormalizedEvent,
  rule: import("./types").Automation,
  senderId: string,
): Promise<void> {
  const errors: string[] = [];

  // 공개 답장 (comment 전용)
  if (ev.kind === "comment" && rule.public_reply_text) {
    const r = await meta.replyToComment(cfg, ev.commentId, rule.public_reply_text);
    if (!r.ok) errors.push(`public_reply:${r.errorCode ?? r.status}`);
  }

  // DM 발송: comment → private reply, 그 외 → 일반 DM
  let dmResult;
  if (ev.kind === "comment") {
    dmResult = await meta.sendPrivateReply(cfg, ev.commentId, rule.dm_text);
  } else {
    dmResult = await meta.sendDirectMessage(cfg, senderId, rule.dm_text);
  }
  if (dmResult.ok) {
    await db.logMessage(env.DB, {
      id: dmResult.body?.message_id ?? `out:${ev.dedupeKey}`,
      contactId: senderId,
      direction: "out",
      source: "auto",
      kind: ev.kind === "comment" ? "dm" : "dm",
      text: rule.dm_text,
      automationId: rule.id,
    });
  } else {
    errors.push(`dm:${dmResult.errorCode ?? dmResult.status}`);
  }

  // 태그
  if (rule.tag_to_apply) await db.applyTag(env.DB, senderId, rule.tag_to_apply);

  // hits 기록 + 시퀀스 예약 (DM 성공 시에만)
  if (dmResult.ok) {
    await db.recordHit(env.DB, rule.id, senderId);
    await db.scheduleSequence(env.DB, rule.id, senderId);
  }

  const outcome = errors.length ? `matched:${rule.id};err:${errors.join(",")}` : `matched:${rule.id}`;
  await db.setEventOutcome(env.DB, ev.dedupeKey, outcome);
}
