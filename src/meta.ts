// Meta Graph API 클라이언트 (설계서 §4)
// graph.instagram.com — Instagram API with Instagram Login.

export interface MetaConfig {
  apiVersion: string; // 예: "v25.0"
  igUserId: string;
  accessToken: string;
}

export interface MetaResult {
  ok: boolean;
  status: number;
  body: any;
  errorCode?: number;
}

async function post(url: string, payload: unknown): Promise<MetaResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    body,
    errorCode: body?.error?.code,
  };
}

function base(cfg: MetaConfig): string {
  return `https://graph.instagram.com/${cfg.apiVersion}`;
}

export interface QuickReplyButton {
  label: string;
  payload: string;
}

/** 인스타 quick_replies 형식으로 변환 (설계서 확장 — 대화 플로우). */
function buildMessage(text: string, buttons?: QuickReplyButton[]): Record<string, unknown> {
  const message: Record<string, unknown> = { text };
  if (buttons && buttons.length) {
    message.quick_replies = buttons.slice(0, 13).map((b) => ({
      content_type: "text",
      title: b.label.slice(0, 20),
      payload: b.payload,
    }));
  }
  return message;
}

/** 4.1 일반 DM 발송 (24h 윈도우 안). 버튼 옵션 시 quick_replies 부착. */
export function sendDirectMessage(
  cfg: MetaConfig,
  recipientIgsid: string,
  text: string,
  buttons?: QuickReplyButton[],
) {
  return post(`${base(cfg)}/${cfg.igUserId}/messages?access_token=${cfg.accessToken}`, {
    recipient: { id: recipientIgsid },
    message: buildMessage(text, buttons),
  });
}

/** 4.2 Private reply — 댓글에 대한 비공개 DM (댓글당 1회, 7일 이내). 버튼 부착 가능. */
export function sendPrivateReply(
  cfg: MetaConfig,
  commentId: string,
  text: string,
  buttons?: QuickReplyButton[],
) {
  return post(`${base(cfg)}/${cfg.igUserId}/messages?access_token=${cfg.accessToken}`, {
    recipient: { comment_id: commentId },
    message: buildMessage(text, buttons),
  });
}

/** 4.3 댓글 공개 답장. */
export function replyToComment(cfg: MetaConfig, commentId: string, text: string) {
  return post(`${base(cfg)}/${commentId}/replies?access_token=${cfg.accessToken}`, {
    message: text,
  });
}

/** 4.5 장기 토큰 갱신 (주 1회 Cron). */
export async function refreshToken(currentToken: string): Promise<MetaResult> {
  const url =
    `https://graph.instagram.com/refresh_access_token` +
    `?grant_type=ig_refresh_token&access_token=${currentToken}`;
  const res = await fetch(url);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, errorCode: body?.error?.code };
}

/** 텍스트 1,000바이트 초과 여부 (설계서 §4.1). */
export function exceedsByteLimit(text: string, limit = 1000): boolean {
  return new TextEncoder().encode(text).length > limit;
}
