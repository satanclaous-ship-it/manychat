import { describe, it, expect } from "vitest";
import { decideJob } from "../src/sequences";

describe("decideJob — 24h 윈도우 가드 (설계서 §6-2)", () => {
  const now = new Date("2026-07-14T12:00:00Z").getTime();

  it("정지된 연락처 → cancelled", () => {
    expect(decideJob(now, "2026-07-14T11:00:00Z", 1)).toBe("cancelled");
  });
  it("인바운드 기록 없음 → expired (댓글만 단 사람)", () => {
    expect(decideJob(now, null, 0)).toBe("expired");
  });
  it("24h 지남 → expired", () => {
    expect(decideJob(now, "2026-07-13T11:59:00Z", 0)).toBe("expired");
  });
  it("24h 이내 → send", () => {
    expect(decideJob(now, "2026-07-14T01:00:00Z", 0)).toBe("send");
  });
  it("경계: 정확히 24h → expired", () => {
    expect(decideJob(now, "2026-07-13T12:00:00Z", 0)).toBe("expired");
  });
});
