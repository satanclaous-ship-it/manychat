// 웹훅 파싱·라우팅 (설계서 §3.2-3, §3.3)
// 순수 함수 — 네트워크/DB 없이 페이로드만 정규화. 테스트 대상.

import type { NormalizedEvent } from "./types";

/**
 * Meta 웹훅 본문(entry[])을 정규화 이벤트 배열로 변환.
 * - changes[].field == "comments" → comment
 * - messaging[].message → dm (message.reply_to.story 있으면 story_reply)
 * - is_echo == true 는 kind:"dm", isEcho:true 로 표시 (호출부에서 트리거 제외, 기록만)
 */
export function parseWebhook(body: any): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    // 1) 댓글 변경 이벤트
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "comments") continue;
      const v = change.value ?? {};
      const commentId = String(v.id ?? "");
      if (!commentId) continue;
      out.push({
        kind: "comment",
        dedupeKey: `comment:${commentId}`,
        commentId,
        mediaId: String(v.media?.id ?? ""),
        fromId: String(v.from?.id ?? ""),
        fromUsername: v.from?.username ?? null,
        text: String(v.text ?? ""),
      });
    }

    // 2) 메시징 이벤트 (DM / 스토리 답장)
    for (const m of entry?.messaging ?? []) {
      const msg = m?.message;
      if (!msg) continue; // read/delivery 등은 무시
      const mid = String(msg.mid ?? "");
      const senderId = String(m.sender?.id ?? "");
      const text = String(msg.text ?? "");
      const story = msg.reply_to?.story;

      if (story) {
        out.push({
          kind: "story_reply",
          dedupeKey: `msg:${mid}`,
          senderId,
          text,
          storyId: story.id ? String(story.id) : null,
        });
      } else {
        out.push({
          kind: "dm",
          dedupeKey: `msg:${mid}`,
          senderId,
          text,
          isEcho: msg.is_echo === true,
          quickReplyPayload: msg.quick_reply?.payload ?? null,
        });
      }
    }
  }

  return out;
}
