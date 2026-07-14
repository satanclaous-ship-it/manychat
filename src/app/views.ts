// 대시보드 HTML 헬퍼 (설계서 §7) — 모바일 우선, 프레임워크 없음.

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;line-height:1.5;
  background:Canvas;color:CanvasText}
header{position:sticky;top:0;background:Canvas;border-bottom:1px solid #8883;padding:.6rem 1rem;
  display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
header b{font-size:1rem}
nav{display:flex;gap:.25rem;flex-wrap:wrap}
nav a{padding:.35rem .7rem;border-radius:999px;text-decoration:none;color:inherit;font-size:.9rem}
nav a.on{background:#3b82f6;color:#fff}
main{max-width:680px;margin:0 auto;padding:1rem}
.card{border:1px solid #8883;border-radius:12px;padding:.85rem 1rem;margin:.6rem 0}
.row{display:flex;justify-content:space-between;gap:.75rem;align-items:center}
.muted{color:#8889;font-size:.82rem}
.badge{font-size:.72rem;padding:.1rem .5rem;border-radius:999px;background:#8882}
.on-b{background:#16a34a33;color:#16a34a}
.off-b{background:#8882;color:#8889}
.err{background:#dc262633;color:#dc2626}
a.btn,button{font:inherit;padding:.5rem .9rem;border-radius:8px;border:1px solid #8884;
  background:#8881;color:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:#3b82f6;color:#fff;border-color:#3b82f6}
button.danger{background:#dc262622;color:#dc2626;border-color:#dc262655}
input,textarea,select{font:inherit;width:100%;padding:.5rem;border:1px solid #8885;border-radius:8px;
  background:Canvas;color:CanvasText;margin-top:.2rem}
label{display:block;margin:.6rem 0 0;font-size:.9rem;font-weight:600}
form.inline{display:inline}
textarea{min-height:4rem}
.bubble{max-width:80%;padding:.5rem .75rem;border-radius:12px;margin:.35rem 0;white-space:pre-wrap;word-break:break-word}
.in{background:#8882;margin-right:auto}
.out{background:#3b82f6;color:#fff;margin-left:auto}
.tl{display:flex;flex-direction:column}
table{width:100%;border-collapse:collapse;font-size:.85rem}
td,th{text-align:left;padding:.4rem .3rem;border-bottom:1px solid #8882;vertical-align:top}
.kl{font-variant-numeric:tabular-nums}
`;

const TABS = [
  ["automations", "자동화"],
  ["inbox", "인박스"],
  ["contacts", "연락처"],
  ["logs", "로그"],
];

export function page(active: string, title: string, inner: string): string {
  const nav = TABS.map(
    ([k, label]) => `<a href="/app/${k}" class="${active === k ? "on" : ""}">${label}</a>`,
  ).join("");
  return (
    `<!doctype html><html lang=ko><head><meta charset=utf-8>` +
    `<meta name=viewport content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)} · auto-dm</title><style>${STYLE}</style></head><body>` +
    `<header><b>auto-dm</b><nav>${nav}</nav></header><main>${inner}</main></body></html>`
  );
}

/** UTC ISO → Asia/Kuala_Lumpur 표시 (설계서 §2). */
export function fmt(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Kuala_Lumpur",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
