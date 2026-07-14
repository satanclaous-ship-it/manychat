// 트리거 매칭 엔진 (설계서 §5)
// 매칭 판정은 순수 함수로 분리 — 테스트 대상. 액션 실행(runActions)은 db/meta 주입.

import type { Automation, AutomationType, NormalizedEvent } from "./types";

/** 텍스트 정규화: 소문자 + 공백 정리 (설계서 §5-3). */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 키워드 매칭 (설계서 §5-3). story_reply + 빈 배열 = 모든 답장 매칭. */
export function matchesKeywords(
  text: string,
  keywords: string[],
  mode: "contains" | "exact",
  allowEmpty: boolean,
): boolean {
  if (keywords.length === 0) return allowEmpty;
  const t = normalizeText(text);
  return keywords.some((kw) => {
    const k = normalizeText(kw);
    if (!k) return false;
    return mode === "exact" ? t === k : t.includes(k);
  });
}

function eventType(ev: NormalizedEvent): AutomationType {
  return ev.kind === "comment"
    ? "comment_keyword"
    : ev.kind === "story_reply"
      ? "story_reply"
      : "dm_keyword";
}

/**
 * 이벤트에 대해 발동할 규칙 하나를 고른다 (설계서 §5).
 * - type 일치 + enabled
 * - comment: media_id NULL(전체) 또는 이벤트 media_id 일치
 * - 키워드 매칭 (story_reply는 빈 배열 허용)
 * - 복수 매칭 시 id 최소 하나만 (예측 가능성)
 * 연락처 가드(automation_paused)·중복 가드(hits)는 DB가 필요하므로 호출부에서 별도 적용.
 */
export function selectAutomation(
  ev: NormalizedEvent,
  automations: Automation[],
): Automation | null {
  const type = eventType(ev);
  const text = ev.kind === "comment" ? ev.text : ev.text;
  const candidates = automations
    .filter((a) => a.enabled === 1 && a.type === type)
    .filter((a) => {
      if (ev.kind === "comment") {
        return a.media_id == null || a.media_id === ev.mediaId;
      }
      return true;
    })
    .filter((a) => {
      let kws: string[] = [];
      try {
        kws = JSON.parse(a.keywords_json);
      } catch {
        kws = [];
      }
      return matchesKeywords(text, kws, a.match_mode, ev.kind === "story_reply");
    })
    .sort((a, b) => a.id - b.id);

  return candidates[0] ?? null;
}
