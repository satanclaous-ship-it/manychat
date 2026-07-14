# auto-dm 시스템 설계서 (문서 2/3)

> 전제 문서: `2026-07-14-auto-dm-01-plan.md` (기획서 — 범위·유스케이스·정책 제약)
> 독자: 오푸스 빌드 세션. 이 설계서의 결정은 빌드 중 임의 변경하지 않는다 — 바꿀 이유가 생기면 문서를 먼저 고친다.

## 1. 아키텍처와 기술 스택

```
[Meta / Instagram]
   │ ① 웹훅 POST (댓글·DM·스토리 답장)          ② Graph API 호출 (DM 발송·댓글 답장)
   ▼                                             ▲
[Cloudflare Worker — 단일 앱]────────────────────┘
   ├─ /webhook        웹훅 수신 (GET 검증, POST 이벤트)
   ├─ /app/*          대시보드 (비번 로그인, 폰 브라우저)
   ├─ Cron (매 1분)   시퀀스 잡 발송 + 토큰 주간 갱신
   └─ [D1 (SQLite)]   연락처·메시지·자동화 규칙·시퀀스 잡·이벤트 로그·설정
```

| 선택 | 무엇 | 이유 |
|---|---|---|
| 런타임 | **Cloudflare Workers** (무료 플랜) | 상시 대기 웹훅 수신 + 월 0원. 요청 10만/일 무료 — 개인 계정 트래픽의 수백 배 여유. 호출당 CPU 10ms 한도 → 웹훅 처리는 I/O 대기 위주라 무관 |
| 프레임워크 | **Hono** (TypeScript) | Workers 표준 라우터. 가볍고 오푸스가 잘 아는 스택 |
| DB | **D1** (무료 한도) | SQLite 문법, Worker 바인딩 한 줄. 연락처 수천 명 규모에 충분 |
| 예약 실행 | **Cron Triggers** (무료) | 매 1분 시퀀스 잡 스캔. 큐 서비스 불필요 |
| 대시보드 | **서버 렌더 HTML + 최소 JS** | SPA 프레임워크 없이 폼과 목록. 폰에서 빠르고 빌드 단순 |
| 배포 | **wrangler CLI** | `wrangler deploy` 한 방. GitHub Actions 연동은 선택 |

하지 않는 것: Queues(유료)·Durable Objects·KV — D1 + Cron으로 전부 충족되므로 도입하지 않는다.

## 2. 데이터 모델 (D1 스키마)

```sql
-- 접점이 생긴 사람 (단일 계정이므로 대화 = 연락처 1:1)
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,            -- IGSID (인스타 스코프 유저 ID)
  username TEXT,
  first_seen_at TEXT NOT NULL,    -- ISO8601 UTC
  last_seen_at TEXT NOT NULL,
  last_inbound_at TEXT,           -- 24h 윈도우 계산 기준
  automation_paused INTEGER NOT NULL DEFAULT 0,  -- 1이면 이 사람에게 자동응답 중지
  notes TEXT
);

CREATE TABLE contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag)
);

-- 주고받은 모든 메시지 (인박스의 원천)
CREATE TABLE messages (
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
CREATE INDEX idx_messages_contact ON messages(contact_id, created_at);

-- 자동화 규칙
CREATE TABLE automations (
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
CREATE TABLE automation_hits (
  automation_id INTEGER NOT NULL REFERENCES automations(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  last_fired_at TEXT NOT NULL,
  fire_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (automation_id, contact_id)
);

-- 시퀀스 정의 (규칙에 부착되는 후속 단계 0~3개)
CREATE TABLE sequence_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id),
  delay_minutes INTEGER NOT NULL,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 시퀀스 예약 (Cron이 스캔하는 큐)
CREATE TABLE sequence_jobs (
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
CREATE INDEX idx_jobs_due ON sequence_jobs(status, due_at);

-- 웹훅 이벤트 원본 + 중복 제거 (동일 이벤트 재전송 방어)
CREATE TABLE events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE, -- comment_id / message mid / 이벤트 고유값
  type TEXT NOT NULL,              -- comment | message | story_reply | unknown
  payload_json TEXT NOT NULL,
  outcome TEXT,                    -- matched:<automation_id> | no_match | duplicate | error:<요약>
  created_at TEXT NOT NULL
);

-- 런타임 설정 (토큰 등 — Cron이 갱신하므로 시크릿이 아니라 DB에 둔다)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,            -- ig_access_token / ig_user_id / token_refreshed_at ...
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

시각은 전부 UTC ISO8601로 저장, 대시보드 표시만 Asia/Kuala_Lumpur.

## 3. 웹훅 수신 흐름

### 3.1 엔드포인트 검증 (GET /webhook)
- Meta가 구독 등록 시 `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` 호출.
- `hub.verify_token`이 시크릿 `WEBHOOK_VERIFY_TOKEN`과 일치하면 `hub.challenge`를 그대로 응답.

### 3.2 이벤트 수신 (POST /webhook)
처리 순서 — **항상 이 순서**:
1. **서명 검증**: `X-Hub-Signature-256` 헤더 = `sha256=` + HMAC-SHA256(본문 원문, `APP_SECRET`). 불일치 → 401, 본문 폐기. **주의**: JSON 파싱 전의 raw body로 계산해야 하고(Meta는 특수문자를 escaped unicode 상태로 서명), 비교는 timing-safe로.
2. **즉시 200 응답 예약**: 본 처리 로직은 `ctx.waitUntil()`로 넘기고 200을 먼저 반환한다 (Meta는 응답 지연 시 재전송·구독 저하).
3. **파싱·라우팅**: `entry[]` → 각 이벤트를 아래 타입으로 분류.
   - `changes[].field == "comments"` → 댓글 이벤트
   - `messaging[]`에 `message` 존재 → DM (단, `message.is_echo == true`는 내가 보낸 것 → 기록만, 트리거 금지)
   - DM 중 스토리 답장 표식(`message.reply_to.story`)이 있으면 → 스토리 답장 이벤트
4. **중복 제거**: dedupe_key(댓글 id / 메시지 mid)를 `events_log`에 INSERT. UNIQUE 충돌 → `duplicate` 기록 후 종료.
5. **연락처 upsert**: 보낸 사람 IGSID·username을 contacts에 반영. 인바운드 DM·스토리 답장이면 `last_inbound_at` 갱신 (24h 윈도우의 기준).
6. **자기 자신 필터**: `from.id == 내 ig_user_id`인 댓글(내가 단 답글 포함)은 트리거 금지, 기록만.
7. **트리거 매칭 → 액션 실행** (§5).
8. **결과 기록**: events_log.outcome + messages 테이블에 발송 내역.

### 3.3 이벤트별 필드 추출
| 이벤트 | 트리거 대상 규칙 | 핵심 필드 |
|---|---|---|
| 댓글 | `comment_keyword` | comment_id, media_id, from.{id,username}, text |
| DM | `dm_keyword` | sender.id, message.mid, message.text |
| 스토리 답장 | `story_reply` | sender.id, message.mid, message.text, reply_to.story.id |

## 4. Meta API 호출 명세

> 이 절의 엔드포인트·페이로드는 2026-07 기준 공식 문서로 검증됨 (§10 부록에 항목별 출처·확신도). 현재 최신 버전 **v25.0** (2026-02 출시) — 버전은 `settings.api_version`에 두고 코드에 하드코딩하지 않는다.

베이스: `https://graph.instagram.com/{api_version}` (Instagram API with Instagram Login — 기존 creator_os와 동일 계열).
인증: 모든 호출에 `access_token` (D1 settings에서 로드).

### 4.1 DM 발송 (일반 — 24h 윈도우 안)
```
POST /{ig_user_id}/messages
{ "recipient": { "id": "<IGSID>" },
  "message":   { "text": "<본문>" } }
```
- 텍스트는 UTF-8 **1,000바이트 이하** — 대시보드 폼에서 바이트 기준 검증.

### 4.2 Private reply (댓글에 대한 비공개 DM)
```
POST /{ig_user_id}/messages
{ "recipient": { "comment_id": "<댓글 ID>" },
  "message":   { "text": "<본문>" } }
```
- 댓글 1건당 1회 한정, 일반 게시물 댓글은 생성 후 7일 이내.
- 이 호출은 24h 윈도우 밖에서도 허용되는 유일한 아웃바운드 진입점.

### 4.3 댓글 공개 답장
```
POST /{comment_id}/replies
{ "message": "<답장 텍스트>" }
```

### 4.4 웹훅 구독 (M1 손작업 + 1회 API 호출)
```
POST /{ig_user_id}/subscribed_apps?subscribed_fields=comments,messages
```
+ Meta 앱 대시보드에서 콜백 URL·verify token 등록 (빌드 가이드 M1에 클릭 단위 수록).

### 4.5 토큰 갱신 (주 1회 Cron)
```
GET https://graph.instagram.com/refresh_access_token
  ?grant_type=ig_refresh_token&access_token=<현재 토큰>
```
- 응답 토큰을 `settings.ig_access_token`에 저장. 실패 시 events_log에 error 기록 (대시보드 로그 화면에서 확인).
- **스코프 주의**: 기존 토큰에는 messages 권한이 없다. M1에서 `instagram_business_manage_messages`(+ `instagram_business_manage_comments`)를 포함해 **재인증으로 새 토큰 발급**이 선행된다.

### 4.6 에러 처리 공통 규칙
| 상황 | 처리 |
|---|---|
| 429 (요율 제한) | 시퀀스 잡이면 status 유지 + attempt+1, 다음 Cron에서 재시도 (최대 3회 → failed). 실시간 트리거면 1회 즉시 재시도 후 로그 |
| 190 계열 (토큰 만료·무효) | 발송 중단, events_log에 `error:token` — 런북 항목 |
| private reply 윈도우 초과/중복 | 재시도 없이 로그만 (정책상 불가) |
| 5xx | 1회 재시도 후 로그 |

## 5. 트리거 엔진

매칭 판정 — 이벤트 1건에 대해:
1. `enabled=1`이고 type이 일치하는 규칙을 전부 조회.
2. `comment_keyword`: media_id가 NULL(전체) 또는 이벤트 media_id와 일치.
3. 키워드 매칭: 텍스트를 소문자·공백 정리 후 — `contains`: 키워드 중 하나라도 포함 / `exact`: 전체 일치. `story_reply` + 빈 키워드 배열 = 모든 답장 매칭.
4. **연락처 가드**: `automation_paused=1`이면 발동 금지.
5. **중복 발동 가드**: `once_per_user=1` → automation_hits에 기록 있으면 종료. `once_per_user=0` → `last_fired_at + cooldown_hours > now`면 종료.
6. 복수 규칙이 동시에 매칭되면 **id가 가장 작은 것 하나만** 발동 (예측 가능성 우선).

액션 실행 순서 (comment_keyword 기준): 공개 답장(설정 시) → private reply DM → 태그 부착 → automation_hits 기록 → 시퀀스 잡 생성. 각 단계 실패는 다음 단계를 막지 않되 로그에 남긴다 (부분 성공 허용 — 공개 답장이 실패해도 DM은 나간다).

## 6. 시퀀스 엔진 (Cron 매 1분)

```
매 분:
1. sequence_jobs에서 status='pending' AND due_at <= now 를 오래된 순 50건 조회
2. 각 잡:
   a. 연락처 automation_paused=1 → cancelled
   b. last_inbound_at 없음 또는 +24h < now → expired  (24h 윈도우 가드)
   c. 발송 (4.1) → sent / 실패 → 4.6 규칙
3. 주 1회 (월요일 첫 실행): 토큰 갱신 (4.5)
```

- 윈도우 갱신: 상대가 새 인바운드를 보내면 `last_inbound_at`이 갱신되므로, 예약분은 자동으로 되살아난다 — 별도 로직 불필요 (판정을 발송 시점에 하기 때문).
- 인박스에서 대화별 "예약 취소" = 해당 contact의 pending 잡 → cancelled.

## 7. 대시보드 화면 정의 (5)

공통: 서버 렌더 HTML, 모바일 우선(단일 컬럼), 상단 탭 네비게이션 [자동화 | 인박스 | 연락처 | 로그].

| # | 화면 | 경로 | 내용 |
|---|---|---|---|
| 1 | 로그인 | `/app/login` | 비밀번호 1개 입력 → 서명된 세션 쿠키(30일). 실패 시 1초 지연(무차별 대입 완화) |
| 2 | 자동화 | `/app/automations` | 목록(이름·타입·상태·발동 수) + on/off 토글. "새 자동화" 폼: 타입 선택 → 타입별 필드(게시물 선택은 최근 게시물 25개 드롭다운 — media API로 로드), 키워드(쉼표 구분), 공개답장·DM 본문, 시퀀스 단계 0~3개(지연 분·본문), 태그 |
| 3 | 인박스 | `/app/inbox` | 대화 목록(최근순, 마지막 메시지 미리보기, 자동화 발동 뱃지) → 대화 상세: 타임라인(in/out·source 구분), 수동 답장 입력(24h 윈도우 밖이면 비활성+사유), 자동화 일시정지 토글, 예약 취소 버튼 |
| 4 | 연락처 | `/app/contacts` | 목록(유저네임·태그·최근 접점), 태그 필터, CSV 내보내기 버튼(`/app/contacts.csv?tag=`) |
| 5 | 로그 | `/app/logs` | events_log 최근 100건 (타입·outcome·시각). 에러만 필터 토글 — 장애 시 첫 확인 화면 |

## 8. 보안·시크릿 관리

| 항목 | 보관 위치 | 비고 |
|---|---|---|
| `APP_SECRET` (Meta 앱 시크릿 — 서명 검증) | Wrangler secret | 코드·레포에 절대 안 넣음 |
| `WEBHOOK_VERIFY_TOKEN` (임의 문자열) | Wrangler secret | M1에서 생성 |
| `DASHBOARD_PASSWORD` + `SESSION_SIGNING_KEY` | Wrangler secret | 쿠키는 HMAC 서명 값만 |
| IG 액세스 토큰 | **D1 settings** | Cron이 자동 갱신해야 하므로 시크릿 대신 DB. 단일 사용자·비공개 DB라 수용. 유출 시 Meta 콘솔에서 무효화 → 재발급 (런북) |
| ig_user_id, api_version | D1 settings | 배포 후 시드 스크립트로 입력 |

- 대시보드 전 경로는 세션 쿠키 필수 (`/webhook`, `/app/login`만 예외).
- 웹훅은 서명 검증 실패 시 본문을 로그에도 남기지 않는다.
- D1 백업: 주 1회 Cron에서 연락처·태그를 events_log와 함께 덤프할 필요는 없음 — wrangler `d1 export`를 런북의 월 1회 항목으로.

## 9. 레포 구조 (auto-dm)

```
auto-dm/
├── CLAUDE.md            # 허브 공통 블록 + 이 프로젝트 규칙 (허브에서 복사·수정)
├── docs/                # 이 문서 3종 사본 (원본은 허브 outputs/)
├── src/
│   ├── index.ts         # Hono 앱 + cron 핸들러 export
│   ├── webhook.ts       # §3 수신·검증·라우팅
│   ├── triggers.ts      # §5 매칭·액션
│   ├── sequences.ts     # §6 Cron 처리
│   ├── meta.ts          # §4 API 클라이언트 (fetch 래퍼)
│   ├── db.ts            # D1 쿼리 모음
│   └── app/             # §7 대시보드 (라우트별 파일 + html 헬퍼)
├── schema.sql           # §2 전체
├── wrangler.toml        # D1 바인딩, cron "* * * * *", secrets 선언
└── test/                # 웹훅 페이로드 픽스처 기반 단위 테스트
```

## 10. 부록 — 기술 사실 검증 (2026-07, 항목별 출처)

빌드 중 이 표와 코드가 어긋나면 **문서가 아니라 최신 공식 문서를 따르고, 이 표를 갱신**한다.

| # | 사실 | 확신도 | 출처 |
|---|---|---|---|
| 1 | Instagram Login 방식에서 Send API 지원. `POST graph.instagram.com/v25.0/{IG_ID}/messages`, 스코프 `instagram_business_manage_messages`, 텍스트 1,000바이트 이하. 최신 버전 v25.0 (2026-02) | 확실 | [Messaging API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/) · [v25 발표](https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25/) |
| 2 | Private reply: recipient에 `comment_id`. 피드/릴스 댓글은 생성 후 7일 이내, **댓글 1건당 1회**. 24h 윈도우와 별개 진입로 | 확실 (배포 전 curl 1회 실측 권장) | [Private Replies](https://developers.facebook.com/docs/instagram-platform/private-replies/) |
| 3 | 공개 답장: `POST /{comment_id}/replies` `{"message":"..."}`. 스코프 `instagram_business_manage_comments` | 확실 (스코프명만 거의 확실) | [IG Comment /replies](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies/) |
| 4 | 웹훅 = 앱 대시보드 등록 + `POST /{IG_ID}/subscribed_apps?subscribed_fields=comments,messages`. 스토리 답장은 `messages` 웹훅에 reply_to.story로 도착 | 확실 (전체 필드 목록은 대시보드에서 확정) | [Webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks) · [예시 페이로드](https://developers.facebook.com/docs/instagram-platform/webhooks/examples/) |
| 5 | Advanced Access(앱 심사+비즈니스 인증)는 **앱 역할 없는 타인이 앱을 사용할 때만** 필요 — 본인 계정 전용은 심사 불필요 | 요건 자체는 확실. "타인이 보내온 댓글/DM 이벤트도 심사 전 수신·응답 가능"은 실사용 보고 일치이나 공식 문구 미확보 → **M1 실측 관문** | [Access Levels](https://developers.facebook.com/docs/instagram-platform/overview/) |
| 6 | 24h 윈도우: 마지막 인바운드 메시지 기준. 스토리 답장은 윈도우를 열고, 댓글은 안 연다. HUMAN_AGENT 태그(7일)는 심사 필수 + 자동화 금지 → 미사용 | 확실 | [Messaging Window](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/) |
| 7 | 요율: 텍스트 100 calls/sec/계정, 미디어 10/sec. 일반 엔드포인트 4800×노출수/24h — 개인 규모 무관 | 확실 | [Rate Limits](https://developers.facebook.com/docs/instagram-platform/overview/) |
| 8 | 서명: `X-Hub-Signature-256` = HMAC-SHA256(raw body, app secret). escaped unicode 상태로 서명됨 | 확실 | [Webhooks for Instagram](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-instagram/) |
| 9 | Cloudflare 무료: Workers 10만 req/일·CPU 10ms, Cron 무료(최소 1분), D1 5GB·읽기 500만/일·쓰기 10만/일, 정적 자산 서빙 무료·무제한 | 확실 | [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| 10 | 기존 60일 토큰에 스코프 추가 불가 — `refresh_access_token`은 기간 연장만. 새 스코프는 **재인가 → 단기 토큰 → 장기 토큰 교환** | 확실 | [Business Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login) · [refresh_access_token](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/) |
