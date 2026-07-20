# STATUS — auto-dm (매니챗 클론) 진행 상태

> 2026-07-20 세션 아카이빙 시점. 다음에 이 레포를 열면 **여기부터 읽으면 됨.**
> 코드는 전부 완성·검증됨. 막힌 곳은 **Meta 앱 심사(공개 접근)** 하나뿐.

## 한 줄 요약
게시물 댓글→자동 DM(+대화 플로우 버튼·시퀀스·인박스·대시보드)까지 **코드 완성, 실배포 완료, 인스타 연결됨.** 단, Meta 앱이 **개발(Development) 모드**라 지금은 **앱에 등록된 계정(테스터)만** 자동 DM이 작동. **일반 팔로워까지 되게 하려면 Meta 앱 심사(Advanced Access)** 통과가 필요 — 이게 유일한 잔여 관문.

## 지금 살아있는 것 (실제 상태)
- **배포**: `https://auto-dm.satanclaous.workers.dev` (Cloudflare Workers + D1, 월 0원)
- **대시보드**: `/app/login` (비번 = 배포 때 정한 DASHBOARD_PASSWORD). 자동화·인박스·연락처·로그·설정 5화면 동작.
- **Meta 연결**: 웹훅 등록됨, 계정 구독 = `comments,messages` (둘 다). 앱 = Content Insights-IG.
- **D1에 시드됨**: `ig_access_token`, `ig_user_id`=17841405934581390, `api_version`=v25.0, 테스트 자동화 1건(키워드 "테스트").
- **검증**: 유닛 31 통과 + 타입체크 clean + 로컬 wrangler dev 전 구간 실측(웹훅·트리거·플로우·대시보드).

## 막힌 지점 (핵심)
개발 모드에서 인스타는 **앱에 역할 있는 계정의 상호작용만** 웹훅으로 보냄. 그래서 일반 계정 댓글은 웹훅이 안 옴(실측 확인). 두 가지 길:
- **테스트용(지금 당장)**: 2번째 인스타 계정을 **Instagram Tester**로 등록 → 그 계정으로는 오늘도 작동. (App roles → Roles → Instagram testers → 초대 → 그 계정 instagram.com Settings→Apps and websites→Tester invites에서 수락)
- **공개 런칭**: **Meta 앱 심사**로 `instagram_business_manage_messages`·`_manage_comments` Advanced Access 획득 (비즈니스 인증 + 스크린캐스트 + 며칠~2주 대기). 오직 계정주만 제출 가능.

## 미결정 (다음 세션에서 이어갈 갈림길)
사용자가 아직 안 고른 3안:
1. **하이브리드(추천)** — 매니챗으로 e북(7/29) 먼저 런칭 + 자체앱 심사 병행. 승인되면 갈아타고 매니챗 해지.
2. **자체앱 심사 직행** — 매니챗 안 씀. 심사 서류(신청 문구·정당화·스크린캐스트 시나리오)는 이 레포 세션이 작성 예정.
3. **매니챗 사용** — 자체앱 보류(코드는 이 레포에 보존, 언제든 재개).

## 재개 방법 (경로별)
- **테스터로 지금 테스트**: 위 "테스트용" 절차 → `npx wrangler tail auto-dm` 켜고 테스터 계정으로 "테스트" 댓글 → POST 뜨고 DM 도착 확인.
- **심사 서류 작성**: 다음 세션에 "auto-dm 앱 심사 서류 써줘" → 권한별 사용사례·스크린캐스트 대본·개인정보처리방침 초안 생성.
- **코드 수정 후 재배포**: 다운로드 폴더의 레포에서 `npx wrangler deploy` (database_id는 wrangler.toml에 이미 박힘). 스키마 변경 시 `npm run db:remote`(idempotent).
- **토큰 만료 시**: Meta에서 새 토큰 발급 → 대시보드 "설정"에 붙여넣기(재배포 후) 또는 `wrangler d1 execute`로 settings의 ig_access_token 교체.

## ⚠️ 보안 할 일
- 이번 세션 채팅에 **IG 액세스 토큰을 평문으로 붙였음.** 여유될 때 Meta에서 **토큰 재발급(Generate token)** 해서 교체 권장. (교체는 대시보드 설정 화면 또는 d1 execute 한 줄.)
- 토큰·앱시크릿은 레포에 없음(D1/Wrangler secret에만). 커밋 금지 유지.

## 문서
- 기획·설계·빌드가이드: `docs/01-plan.md` `docs/02-design.md` `docs/03-build-guide.md` (허브 `outputs/2026-07-14-auto-dm-*` 와 동일 원본).
- 빌드가이드 M1(Meta 콘솔)·런북(R-1~R-7)에 문제해결 정리됨. 특히 **R-5 = 이번에 막힌 개발모드/심사 이슈.**
