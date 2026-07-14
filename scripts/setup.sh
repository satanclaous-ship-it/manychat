#!/usr/bin/env bash
# auto-dm 원샷 셋업 — Cloudflare 배포 (docs/03-build-guide M0)
# 실행: bash scripts/setup.sh
# 브라우저 인증 1회 + 시크릿 입력만 하면 배포까지 끝난다.
set -e
cd "$(dirname "$0")/.."

echo "▶ 1/6 의존성 설치"
npm install

echo "▶ 2/6 Cloudflare 로그인 (브라우저 열림 — 최초 1회)"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

echo "▶ 3/6 D1 데이터베이스 생성 + wrangler.toml에 id 주입"
if grep -q "REPLACE_AFTER_D1_CREATE" wrangler.toml; then
  OUT=$(npx wrangler d1 create auto_dm_db 2>&1) || true
  echo "$OUT"
  DBID=$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -n "$DBID" ]; then
    sed -i.bak "s/REPLACE_AFTER_D1_CREATE/$DBID/" wrangler.toml && rm -f wrangler.toml.bak
    echo "  database_id = $DBID 주입 완료"
  else
    echo "  ⚠️ database_id 자동 추출 실패. 위 출력의 id를 wrangler.toml에 직접 넣어주세요."
  fi
else
  echo "  이미 설정됨 — 건너뜀"
fi

echo "▶ 4/6 스키마 적용 (원격 D1)"
npm run db:remote

echo "▶ 5/6 시크릿 4종 입력 (입력값은 화면에 안 보임)"
for s in APP_SECRET WEBHOOK_VERIFY_TOKEN DASHBOARD_PASSWORD SESSION_SIGNING_KEY; do
  echo "  - $s:"
  npx wrangler secret put "$s"
done

echo "▶ 6/6 배포"
npx wrangler deploy

echo ""
echo "✅ 배포 완료. 다음은 docs/03-build-guide 의 M1 (Meta 콘솔 손작업)."
echo "   웹훅 콜백 URL: 위 배포 출력의 https://<...>.workers.dev/webhook"
