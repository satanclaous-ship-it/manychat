// 공용 타입 (설계서 §2 데이터 모델 · §3 이벤트)

export interface Env {
  DB: D1Database;
  APP_SECRET: string;
  WEBHOOK_VERIFY_TOKEN: string;
  DASHBOARD_PASSWORD: string;
  SESSION_SIGNING_KEY: string;
}

export type AutomationType = "comment_keyword" | "dm_keyword" | "story_reply";
export type MatchMode = "contains" | "exact";

export interface Automation {
  id: number;
  name: string;
  type: AutomationType;
  enabled: number;
  media_id: string | null;
  keywords_json: string;
  match_mode: MatchMode;
  public_reply_text: string | null;
  dm_text: string;
  once_per_user: number;
  cooldown_hours: number;
  tag_to_apply: string | null;
}

// 웹훅에서 정규화한 인바운드 이벤트 (설계서 §3.3)
export type NormalizedEvent =
  | {
      kind: "comment";
      dedupeKey: string; // comment_id
      commentId: string;
      mediaId: string;
      fromId: string;
      fromUsername: string | null;
      text: string;
    }
  | {
      kind: "dm";
      dedupeKey: string; // message mid
      senderId: string;
      text: string;
      isEcho: boolean;
      quickReplyPayload: string | null; // 버튼 탭이면 "qr:<id>"
    }
  | {
      kind: "story_reply";
      dedupeKey: string;
      senderId: string;
      text: string;
      storyId: string | null;
    };
