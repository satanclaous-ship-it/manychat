# auto-dm — 인스타그램 댓글 자동 DM (매니챗 클론 v1)

게시물 댓글에 키워드가 달리면 자동으로 DM을 보낸다. DM 키워드 자동응답·스토리 답장 반응·시간차 후속발송(시퀀스)·인박스·연락처 태그까지. **Cloudflare Workers + D1, 월 고정비 0원.** 단일 계정 개인용.

> 기획·설계·빌드 가이드 전문: [`docs/`](./docs/) (01-plan / 02-design / 03-build-guide). 빌드는 03의 마일스톤 순서를 따른다.

## 현재 상태 — M0·M2·M3·M4·M5 코드 완성. 남은 건 계정 셋업(M1)뿐

| 마일스톤 | 상태 |
|---|---|
| M0 골격 + 웹훅 검증 | ✅ 구현·실측 |
| M2 댓글→자동 DM 코어 (매칭·중복제거·연락처·태그·액션체인) | ✅ 구현·실측 |
| M3 DM 키워드·스토리 답장 | ✅ 구현 |
| M4 대시보드 5화면 (자동화·인박스·연락처·로그 + 로그인) | ✅ 구현·실측 |
| M5 시퀀스 Cron + 24h 가드 + 토큰 갱신 | ✅ 구현·테스트 |
| **M1 Meta 콘솔 + Cloudflare 배포** | ⬜ **사용자만 가능** (계정·로그인 필요) |

검증: 유닛 29개 통과 + 타입체크 clean + `wrangler dev` 로컬 D1로 전 구간 실측 — 웹훅(GET 검증·서명 401·댓글 매칭→events_log·연락처·태그·중복제거·no_match) + 대시보드(로그인 가드·자동화 CRUD·인박스 윈도우 열림/닫힘·수동답장·정지·예약취소·연락처 태그필터·CSV·로그).

## 빠른 시작 — 원샷 스크립트 (M0 배포)

```bash
bash scripts/setup.sh
```
Cloudflare 로그인(브라우저 1회) → D1 생성·id 자동 주입 → 스키마 적용 → 시크릿 4종 입력 → 배포까지 한 번에. 끝나면 웹훅 콜백 URL이 출력된다 → 그대로 M1로.

수동으로 하려면:
```bash
npm install && npm test
npx wrangler d1 create auto_dm_db     # 출력된 database_id를 wrangler.toml에 붙여넣기
npm run db:remote                     # 스키마 적용
npx wrangler secret put APP_SECRET            # Meta 앱 시크릿 (설정>기본)
npx wrangler secret put WEBHOOK_VERIFY_TOKEN  # 임의 문자열
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put SESSION_SIGNING_KEY   # 임의 랜덤 문자열
npx wrangler deploy
```

## M1 이후 — 토큰 시드

Meta 재인가로 새 토큰 발급(`docs/03-build-guide` M1-A) 후:

```bash
npx wrangler d1 execute auto_dm_db --remote --command "
INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES
 ('api_version','v25.0', datetime('now')),
 ('ig_user_id','<내 IG 유저 ID>', datetime('now')),
 ('ig_access_token','<새 장기 토큰>', datetime('now'));"
```

웹훅 계정 구독 활성화(M1-B):
```bash
curl -s -X POST "https://graph.instagram.com/v25.0/<IG_USER_ID>/subscribed_apps?subscribed_fields=comments,messages&access_token=<TOKEN>"
```

## 로컬 개발

```bash
cp .dev.vars.example .dev.vars    # 시크릿 로컬값
npm run db:local                  # 로컬 D1 스키마
npx wrangler dev --local          # http://localhost:8787
```

## 구조 (docs/02-design §9)

```
src/
  index.ts       Hono 앱 + scheduled(Cron) 핸들러
  webhook.ts     웹훅 파싱·정규화 (순수)
  handler.ts     본처리 오케스트레이션 (중복제거→연락처→매칭→액션)
  triggers.ts    키워드 매칭 엔진 (순수)
  sequences.ts   시퀀스 Cron 처리 + 토큰 갱신
  meta.ts        Graph API 클라이언트 (§4)
  db.ts          D1 쿼리
  crypto.ts      서명 검증 + 세션 서명
  app/           대시보드 (M4)
schema.sql       D1 스키마 (§2)
test/            유닛 테스트 + 픽스처
```
