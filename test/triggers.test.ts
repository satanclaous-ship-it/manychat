import { describe, it, expect } from "vitest";
import { matchesKeywords, normalizeText, selectAutomation } from "../src/triggers";
import type { Automation, NormalizedEvent } from "../src/types";
import * as fx from "./fixtures";
import { parseWebhook } from "../src/webhook";

function rule(p: Partial<Automation>): Automation {
  return {
    id: 1,
    name: "r",
    type: "comment_keyword",
    enabled: 1,
    media_id: null,
    keywords_json: '["빛"]',
    match_mode: "contains",
    public_reply_text: null,
    dm_text: "링크",
    once_per_user: 1,
    cooldown_hours: 0,
    tag_to_apply: null,
    ...p,
  };
}

describe("matchesKeywords", () => {
  it("contains 부분일치", () => {
    expect(matchesKeywords("빛 신청합니다", ["빛"], "contains", false)).toBe(true);
    expect(matchesKeywords("예쁘네요", ["빛"], "contains", false)).toBe(false);
  });
  it("exact 전체일치", () => {
    expect(matchesKeywords("빛", ["빛"], "exact", false)).toBe(true);
    expect(matchesKeywords("빛 신청", ["빛"], "exact", false)).toBe(false);
  });
  it("대소문자·공백 정규화", () => {
    expect(matchesKeywords("  E-Book  ", ["e-book"], "contains", false)).toBe(true);
    expect(normalizeText("  A   B ")).toBe("a b");
  });
  it("빈 배열: allowEmpty로 제어 (story_reply=모든 답장)", () => {
    expect(matchesKeywords("아무거나", [], "contains", true)).toBe(true);
    expect(matchesKeywords("아무거나", [], "contains", false)).toBe(false);
  });
});

describe("selectAutomation", () => {
  const [commentEv] = parseWebhook(fx.commentEvent) as NormalizedEvent[];
  const [noKwEv] = parseWebhook(fx.commentNoKeyword) as NormalizedEvent[];

  it("키워드 매칭 규칙 선택", () => {
    expect(selectAutomation(commentEv, [rule({})])?.id).toBe(1);
  });
  it("키워드 불일치 → null", () => {
    expect(selectAutomation(noKwEv, [rule({})])).toBeNull();
  });
  it("media_id 특정 규칙: 다른 게시물이면 제외", () => {
    expect(selectAutomation(commentEv, [rule({ media_id: "OTHER" })])).toBeNull();
    expect(selectAutomation(commentEv, [rule({ media_id: "MEDIA_1" })])?.id).toBe(1);
  });
  it("disabled 규칙 제외", () => {
    expect(selectAutomation(commentEv, [rule({ enabled: 0 })])).toBeNull();
  });
  it("타입 불일치 제외 (dm 규칙은 댓글에 안 걸림)", () => {
    expect(selectAutomation(commentEv, [rule({ type: "dm_keyword" })])).toBeNull();
  });
  it("복수 매칭 시 id 최소 하나만", () => {
    const picked = selectAutomation(commentEv, [rule({ id: 5 }), rule({ id: 2 }), rule({ id: 9 })]);
    expect(picked?.id).toBe(2);
  });
});
