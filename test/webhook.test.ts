import { describe, it, expect } from "vitest";
import { parseWebhook } from "../src/webhook";
import * as fx from "./fixtures";

describe("parseWebhook", () => {
  it("댓글 이벤트 정규화", () => {
    const [ev] = parseWebhook(fx.commentEvent);
    expect(ev.kind).toBe("comment");
    if (ev.kind !== "comment") throw new Error();
    expect(ev.commentId).toBe("COMMENT_1");
    expect(ev.mediaId).toBe("MEDIA_1");
    expect(ev.fromId).toBe("USER_A");
    expect(ev.fromUsername).toBe("user_a");
    expect(ev.dedupeKey).toBe("comment:COMMENT_1");
  });

  it("DM 이벤트 정규화 (echo 아님)", () => {
    const [ev] = parseWebhook(fx.dmEvent);
    expect(ev.kind).toBe("dm");
    if (ev.kind !== "dm") throw new Error();
    expect(ev.senderId).toBe("USER_C");
    expect(ev.isEcho).toBe(false);
    expect(ev.dedupeKey).toBe("msg:MID_1");
  });

  it("echo DM은 isEcho=true", () => {
    const [ev] = parseWebhook(fx.dmEcho);
    if (ev.kind !== "dm") throw new Error();
    expect(ev.isEcho).toBe(true);
  });

  it("스토리 답장은 story_reply로 분기", () => {
    const [ev] = parseWebhook(fx.storyReplyEvent);
    expect(ev.kind).toBe("story_reply");
    if (ev.kind !== "story_reply") throw new Error();
    expect(ev.storyId).toBe("STORY_1");
  });

  it("빈/이상 페이로드는 빈 배열", () => {
    expect(parseWebhook({})).toEqual([]);
    expect(parseWebhook({ entry: [] })).toEqual([]);
    expect(parseWebhook({ entry: [{ messaging: [{ sender: { id: "X" } }] }] })).toEqual([]); // message 없음
  });
});

describe("parseWebhook — 버튼(빠른답장) 탭", () => {
  it("quick_reply.payload 를 dm 이벤트에 담는다", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "USER_E" },
              message: { mid: "MID_QR", text: "마음이 피곤해요", quick_reply: { payload: "qr:7" } },
            },
          ],
        },
      ],
    };
    const [ev] = parseWebhook(body);
    if (ev.kind !== "dm") throw new Error();
    expect(ev.quickReplyPayload).toBe("qr:7");
    expect(ev.isEcho).toBe(false);
  });
  it("일반 DM은 quickReplyPayload가 null", () => {
    const [ev] = parseWebhook(fx.dmEvent);
    if (ev.kind !== "dm") throw new Error();
    expect(ev.quickReplyPayload).toBeNull();
  });
});
