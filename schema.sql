-- auto-dm D1 스키마 (설계서 §2)
-- 적용: npm run db:local  /  npm run db:remote

-- 접점이 생긴 사람 (단일 계정이므로 대화 = 연락처 1:1)
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,            -- IGSID (인스타 스코프 유저 ID)
  username TEXT,
  first_seen_at TEXT NOT NULL,    -- ISO8601 UTC
  last_seen_at TEXT NOT NULL,
  last_inbound_at TEXT,           -- 24h 윈도우 계산 기준
  automation_paused INTEGER NOT NULL DEFAULT 0,  -- 1이면 이 사람에게 자동응답 중지
  notes TEXT
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag)
);

-- 주고받은 모든 메시지 (인박스의 원천)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,            -- 인바운드: Meta mid / 아웃바운드: 발송 후 응답 id
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  source TEXT NOT NULL CHECK (source IN ('user','auto','sequence','manual')),
  kind TEXT NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm','story_reply','comment','comment_reply')),
  text TEXT,
  automation_id INTEGER,          -- 자동 발송이면 규칙 참조
  payload_json TEXT,              -- 원본 이벤트/응답 보존
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at);

-- 자동화 규칙
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('comment_keyword','dm_keyword','story_reply')),
  enabled INTEGER NOT NULL DEFAULT 1,
  media_id TEXT,                  -- comment_keyword: 특정 게시물만. NULL = 모든 게시물
  keywords_json TEXT NOT NULL,    -- ["빛","e북"] / story_reply는 [] 허용 = 모든 답장
  match_mode TEXT NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('contains','exact')),
  public_reply_text TEXT,         -- comment_keyword 전용, NULL이면 공개답장 생략
  dm_text TEXT NOT NULL,
  once_per_user INTEGER NOT NULL DEFAULT 1,
  cooldown_hours INTEGER NOT NULL DEFAULT 0,  -- once_per_user=0일 때 재발동 최소 간격
  tag_to_apply TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 규칙별 발동 기록 (1인 1회·쿨다운 판정의 원천)
CREATE TABLE IF NOT EXISTS automation_hits (
  automation_id INTEGER NOT NULL REFERENCES automations(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  last_fired_at TEXT NOT NULL,
  fire_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (automation_id, contact_id)
);

-- 시퀀스 정의 (규칙에 부착되는 후속 단계 0~3개)
CREATE TABLE IF NOT EXISTS sequence_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id),
  delay_minutes INTEGER NOT NULL,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 시퀀스 예약 (Cron이 스캔하는 큐)
CREATE TABLE IF NOT EXISTS sequence_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES sequence_steps(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','expired','cancelled','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON sequence_jobs(status, due_at);

-- 웹훅 이벤트 원본 + 중복 제거 (동일 이벤트 재전송 방어)
CREATE TABLE IF NOT EXISTS events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE, -- comment_id / message mid / 이벤트 고유값
  type TEXT NOT NULL,              -- comment | message | story_reply | unknown
  payload_json TEXT NOT NULL,
  outcome TEXT,                    -- matched:<automation_id> | no_match | duplicate | error:<요약>
  created_at TEXT NOT NULL
);

-- 런타임 설정 (토큰 등 — Cron이 갱신하므로 시크릿이 아니라 DB에 둔다)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,            -- ig_access_token / ig_user_id / token_refreshed_at ...
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 대화 플로우: 첫 DM에 붙는 선택 버튼 (탭하면 맞는 응답 발송)
CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id),
  label TEXT NOT NULL,            -- 버튼에 보이는 글자 (<=20자 권장)
  response_text TEXT NOT NULL,    -- 이 버튼을 누르면 보낼 두 번째 메시지 (제품 링크 포함)
  sort INTEGER NOT NULL DEFAULT 0
);
