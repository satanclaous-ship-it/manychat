# auto-dm 오푸스 빌드 가이드 (문서 3/3)

> 이 문서는 실행 매뉴얼이다. `auto-dm` 레포에서 오푸스(Claude Code) 세션을 열고,
> 마일스톤 순서대로 킥오프 프롬프트를 붙여넣어 빌드한다.
> 판정 기준을 전부 통과하기 전에는 다음 마일스톤으로 넘어가지 않는다.

## 0. 사용법과 사전 준비물

### 빌드 방식
1. `satanclaous-ship-it/auto-dm` 레포를 연 오푸스 세션에서 시작 (레포에 이 문서 3종이 `docs/`로 들어 있다).
2. 마일스톤 하나 = 오푸스 세션 한 턴(또는 한 세션). 아래 킥오프 프롬프트를 그대로 붙여넣는다.
3. 각 마일스톤 끝의 **판정 기준 체크리스트**를 내(사용자)가 직접 확인한다 — 오푸스의 "됐습니다"가 아니라 실제 동작으로.
4. M1만 내 손이 필요하다 (Meta 콘솔 클릭). 나머지는 오푸스가 코드로 해결한다.

### 사전 준비물 (한 번만)
- [ ] Cloudflare 계정 (무료) + `npm i -g wrangler` + `wrangler login`
- [ ] 기존 Meta 개발자 앱 접근 (creator_os에서 쓰는 그 앱) — developers.facebook.com 로그인 확인
- [ ] **Meta 앱 시크릿(App Secret) 확보**: developers.facebook.com → 내 앱 → 설정 > 기본 → '앱 시크릿' 보기. M0에서 `APP_SECRET` wrangler secret으로 넣는다 (웹훅 서명 검증 키)
- [ ] 인스타그램 프로페셔널 계정 (이미 충족)
- [ ] Node.js 20+ 로컬 또는 오푸스 세션 환경
- [x] **레포 = `satanclaous-ship-it/manychat`** (이미 생성됨, 코드·문서 포함). 앱/워커 이름은 `auto-dm`, GitHub 레포명만 `manychat`이다.

---

## M0 — 프로젝트 골격 + 배포 파이프라인

> ✅ **코드 구현·검증 완료** (레포에 있음). 남은 건 `bash scripts/setup.sh`로 Cloudflare에 배포하는 것뿐 — 이건 당신 계정 로그인이 필요하다.

**목표**: 빈 Worker가 배포되고, 웹훅 검증(GET)에 응답한다.

**오푸스 킥오프 프롬프트**:
```
auto-dm 레포의 docs/ 설계서(02-design)를 읽고 M0을 구현해줘.
1) Hono + TypeScript Workers 프로젝트 골격 (설계서 §9 레포 구조 그대로)
2) schema.sql (설계서 §2 전체) + wrangler.toml: D1 바인딩(auto_dm_db), cron "* * * * *"
3) GET /webhook: hub.verify_token 검증 응답 (설계서 §3.1)
4) POST /webhook: 서명 검증(§3.2-1)까지만 — 통과 시 원문을 events_log에 저장하고 200
5) /app/*는 "under construction" 200
6) wrangler secret 4종(APP_SECRET, WEBHOOK_VERIFY_TOKEN, DASHBOARD_PASSWORD,
   SESSION_SIGNING_KEY) 사용 코드 + README에 세팅 명령 기록
테스트: 서명 검증 유닛 테스트 (올바른/틀린 HMAC 픽스처).
완료 후: wrangler d1 create·migrations 적용·deploy 명령을 README에 정리하고 배포까지.
```

**판정 기준**:
- [ ] `https://<worker>.workers.dev/webhook?hub.mode=subscribe&hub.verify_token=<토큰>&hub.challenge=123` → 응답 `123`
- [ ] 틀린 verify_token → 403
- [ ] 서명 없는 POST /webhook → 401
- [ ] `wrangler d1 execute auto_dm_db --command "SELECT name FROM sqlite_master"` 에 §2 테이블 전부

---

## M1 — Meta 콘솔 손작업 (권한·웹훅·토큰) ★내 손 필요

**목표**: 실제 인스타 이벤트가 Worker에 도착하고, 메시징 권한이 있는 새 토큰이 D1에 들어간다.

### 1-A. 권한 추가 & 새 토큰 발급
> 기존 60일 토큰에 스코프를 "추가"할 수는 없다 (refresh는 기간 연장만) — **재인가로 새 토큰을 발급**받아야 한다 (설계서 §10-10).

1. developers.facebook.com → 내 앱 → **Instagram > API setup with Instagram login**
2. 권한(스코프)에 다음을 활성화한 뒤, 토큰 생성(재인가) 진행:
   `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`
   (creator_os가 쓰는 기존 insights 토큰은 그대로 두고, auto-dm용 별도 토큰으로 관리)
3. 단기 토큰이 나오면 장기 토큰(60일)으로 교환 — 아래 curl 실행 (`APP_SECRET`·단기토큰 채워서):
   ```bash
   curl -s -G "https://graph.instagram.com/access_token" \
     -d "grant_type=ig_exchange_token" \
     -d "client_secret=<APP_SECRET>" \
     -d "access_token=<단기_토큰>"
   ```
   응답의 `access_token`이 60일 장기 토큰이다. (Instagram > API setup 화면이 이미 장기 토큰을 주면 이 단계 생략.)
4. 설정 3종을 D1에 시드 (README의 시드 스크립트 사용):
   `ig_access_token`(새 토큰), `ig_user_id`(내 IG 계정 ID — creator_os config에 이미 있음), `api_version`(현재 `v25.0`)
   `wrangler d1 execute auto_dm_db --command "INSERT OR REPLACE INTO settings ..."`

### 1-B. 웹훅 등록
1. 앱 대시보드 → Instagram → **Webhooks 설정**: Callback URL = `https://<worker>.workers.dev/webhook`, Verify token = M0에서 만든 값 → "확인 및 저장" (이때 M0의 GET 검증이 통과되어야 함)
2. 구독 필드에서 `comments`, `messages` 활성화
3. 계정 단위 구독 활성화: `POST /{ig_user_id}/subscribed_apps?subscribed_fields=comments,messages` (README의 curl 한 줄)

### 1-C. 앱 모드 확인
- 앱은 **개발 모드 유지** (라이브 전환·심사 불필요 — 단일 계정 전용 전제).
- ⚠️ **실측 관문**: 개발 모드에서 타인 댓글/DM 이벤트가 실제로 들어오는지가 이 프로젝트의 유일한 외부 불확실성이다. 아래 판정 기준 3~4번이 그 실측이다. 안 들어오면 → 런북 §R-5 (심사 경로) 참고.

**판정 기준**:
- [ ] 웹훅 등록 시 "확인 및 저장" 성공 (GET 검증 통과)
- [ ] 내 계정으로 내 게시물에 댓글 → 1분 내 events_log에 comment 이벤트 행 생김
- [ ] **타인 계정(가족/친구 폰)으로 댓글** → events_log에 이벤트 도착 ★핵심 실측
- [ ] 타인 계정으로 내 계정에 DM → events_log에 message 이벤트 도착
- [ ] `curl`로 4.1 DM 발송 테스트 → 그 타인 계정에 DM 수신 (24h 윈도우 내이므로 가능)

---

## M2 — 댓글 → 자동 DM 코어 ★첫 실전 가동

**목표**: e북 배포 자동화가 실제로 돈다. 대시보드는 아직 없어도 된다 — 규칙은 SQL 시드로.

**오푸스 킥오프 프롬프트**:
```
M2를 구현해줘. 설계서 §3(웹훅 흐름 전체), §4.1~4.3, §5(트리거 엔진).
1) POST /webhook 본처리: 파싱→중복제거→연락처 upsert→자기자신 필터→매칭→액션
2) comment_keyword 타입 전체 액션 체인: 공개답장(설정 시)→private reply→태그→hits→시퀀스 잡 생성(발송은 M5)
3) meta.ts API 클라이언트 + §4.6 에러 처리
4) 시드 스크립트: 기획서 UC1의 e북 자동화 규칙 1건 (키워드/DM 본문은 플레이스홀더,
   DM 본문 첫 줄에 자동발송 고지 문구 포함 — 기획서 §5.4)
테스트: 웹훅 픽스처(댓글 매칭/불일치/중복/자기댓글/재댓글) 5종 유닛 테스트.
```

**판정 기준**:
- [ ] 타인 계정으로 키워드 댓글 → **60초 내** 그 계정에 e북 링크 DM 도착 (기획서 성공기준 1)
- [ ] 같은 계정으로 재댓글 → DM 재발송 안 됨 (events_log outcome으로 확인)
- [ ] 키워드 없는 댓글 → no_match 기록, 발송 없음
- [ ] contacts에 그 사람 + `ebook-3light` 태그 생성
- [ ] (설정 시) 댓글에 공개 답장 달림

**M2 통과 = 가동 선언.** 이 시점부터 실제 게시물에 걸어도 된다. 이후 마일스톤은 돌아가는 시스템 위의 증축.

---

## M3 — DM 키워드 자동응답 + 스토리 답장

**오푸스 킥오프 프롬프트**:
```
M3: dm_keyword / story_reply 타입 구현. 설계서 §3.3, §5.
- message 이벤트에서 is_echo 필터, reply_to.story로 스토리 답장 분기
- 인바운드마다 last_inbound_at 갱신 (24h 윈도우 원천)
- dm_keyword는 once_per_user=0 + cooldown_hours 기본 24 시나리오 테스트 포함
시드: 기획서 UC2·UC3 규칙 각 1건. 픽스처 테스트: echo 무시/스토리 분기/쿨다운.
```

**판정 기준**:
- [ ] 타인 계정 "e북" DM → 자동 응답 수신
- [ ] 내가 인스타 앱에서 직접 보낸 DM(echo) → 트리거 안 됨, messages에 out으로 기록
- [ ] 스토리 답장 → 감사 메시지 자동 응답
- [ ] 같은 사람 24시간 내 재키워드 → 쿨다운으로 미발동

---

## M4 — 대시보드 (자동화·인박스·연락처·로그)

**오푸스 킥오프 프롬프트**:
```
M4: 대시보드 전체. 설계서 §7 화면 5개 + §8 인증.
- 로그인(비번→서명 쿠키 30일), 이후 모든 /app/* 가드
- 자동화 CRUD 폼 (게시물 드롭다운은 media API 최근 25개), on/off 토글
- 인박스: 목록/상세/수동 답장(윈도우 밖 비활성+사유)/자동화 일시정지/예약 취소
- 연락처: 태그 필터 + CSV 내보내기
- 로그: 최근 100건 + 에러 필터
모바일 우선 단일 컬럼. 프레임워크 없는 서버 렌더 HTML.
```

**판정 기준**:
- [ ] 폰 브라우저에서 로그인 → 4개 탭 전부 동작
- [ ] 코드 수정 없이 새 자동화 생성 → 실제 발동 확인 (기획서 성공기준 2)
- [ ] 인박스 수동 답장 → 상대 계정에 실제 DM 도착
- [ ] 24h 윈도우 지난 대화는 답장 입력 비활성 + 사유 문구
- [ ] CSV 다운로드에 태그 필터 반영

---

## M5 — 시퀀스·후속 발송

**오푸스 킥오프 프롬프트**:
```
M5: 시퀀스 엔진. 설계서 §6 그대로 (Cron 매 1분, 24h 가드, 배치 50, 재시도 §4.6).
- 자동화 폼에 시퀀스 단계 0~3개 편집 UI 추가
- 주 1회 토큰 갱신(§4.5)도 이 cron 핸들러에
테스트: 가드 3종(paused/expired/정상발송) + 재시도 유닛 테스트.
```

**판정 기준**:
- [ ] **dm_keyword 규칙**(인바운드 DM이 24h 윈도우를 엶)에 "10분 뒤" 단계 추가 → 트리거 후 10분(±1분)에 후속 DM 도착 (기획서 성공기준 3). ※ comment_keyword 규칙의 후속은 상대가 답장하기 전엔 `expired`가 정상 — 기획 UC1 6단계 주석 참고
- [ ] 인박스 예약 취소 → 발송 안 됨 (cancelled)
- [ ] due 시점에 24h 윈도우 밖이면 expired 기록, 발송 없음
- [ ] settings.token_refreshed_at이 월요일 갱신됨 (다음 주 확인)

---

## R. 운영 런북

| # | 상황 | 대응 |
|---|---|---|
| R-1 | DM이 안 나간다 | ① `/app/logs` 에러 필터 → ② `error:token`이면 R-2 → ③ no_match면 키워드·게시물 ID 확인 → ④ 이벤트 자체가 없으면 R-3 |
| R-2 | 토큰 만료/무효 (190) | M1-A 절차로 재발급 → 시드 스크립트로 D1 교체. 원인이 비번 변경/보안 이벤트인지 확인 |
| R-3 | 웹훅이 안 들어온다 | 앱 대시보드 웹훅 테스트 버튼 → 도착하면 구독 필드 확인, 안 오면 콜백 URL·Worker 배포 상태 확인 |
| R-4 | 무료 한도 점검 (월 1회) | Cloudflare 대시보드: Workers 요청 수·D1 사용량. 예상 규모(일 수백 이벤트)면 한도 1% 미만 |
| R-5 | 개발 모드에서 타인 이벤트가 안 들어오는 경우 | 설계 전제가 깨진 것. Meta 앱 심사(Advanced Access) 경로로 전환 — 스코프별 심사 신청 + 스크린캐스트 제출. 이 경우에도 코드는 그대로, 앱 설정만 바뀐다 |
| R-6 | D1 백업 (월 1회) | `wrangler d1 export auto_dm_db --output backup-YYYYMM.sql` → auto-dm 레포 외부 보관 |
| R-7 | 토큰 유출 의심 | Meta 콘솔에서 해당 토큰 무효화 → R-2 재발급. DASHBOARD_PASSWORD도 교체 |

## 부록 — 마일스톤 진행 기록표 (빌드하며 채우기)

| 마일스톤 | 완료일 | 실측 메모 |
|---|---|---|
| M0 | 2026-07-14 | 코드 완성. 배포(setup.sh)는 사용자 |
| M1 | | ⬜ 당신 몫 — 개발 모드 타인 이벤트: 수신 □ / 미수신 □ |
| M2 | 2026-07-14 | 코드 완성·로컬 실측. 첫 실전 가동일(M1 후): |
| M3 | 2026-07-14 | 코드 완성 |
| M4 | 2026-07-14 | 코드 완성·로컬 실측 (5화면) |
| M5 | 2026-07-14 | 코드 완성·24h 가드 테스트 |
