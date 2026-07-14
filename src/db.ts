// D1 쿼리 모음 (설계서 §2 스키마)

import type { Automation } from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, value, nowIso())
    .run();
}

/** dedupe_key 선점. 이미 있으면 false (중복) — 설계서 §3.2-4. */
export async function tryInsertEvent(
  db: D1Database,
  dedupeKey: string,
  type: string,
  payloadJson: string,
): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO events_log (dedupe_key, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(dedupeKey, type, payloadJson, nowIso())
      .run();
    return true;
  } catch {
    return false; // UNIQUE 충돌 = 중복
  }
}

export async function setEventOutcome(db: D1Database, dedupeKey: string, outcome: string): Promise<void> {
  await db.prepare("UPDATE events_log SET outcome = ? WHERE dedupe_key = ?").bind(outcome, dedupeKey).run();
}

export async function upsertContact(
  db: D1Database,
  id: string,
  username: string | null,
  inbound: boolean,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO contacts (id, username, first_seen_at, last_seen_at, last_inbound_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "  username = COALESCE(excluded.username, contacts.username), " +
        "  last_seen_at = excluded.last_seen_at, " +
        "  last_inbound_at = CASE WHEN ? THEN excluded.last_seen_at ELSE contacts.last_inbound_at END",
    )
    .bind(id, username, now, now, inbound ? now : null, inbound ? 1 : 0)
    .run();
}

export async function isContactPaused(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT automation_paused FROM contacts WHERE id = ?")
    .bind(id)
    .first<{ automation_paused: number }>();
  return (row?.automation_paused ?? 0) === 1;
}

export async function listEnabledAutomations(db: D1Database, type: string): Promise<Automation[]> {
  const res = await db
    .prepare("SELECT * FROM automations WHERE enabled = 1 AND type = ?")
    .bind(type)
    .all<Automation>();
  return res.results ?? [];
}

/** 발동 가드: once_per_user / cooldown_hours (설계서 §5-5). true면 발동 가능. */
export async function canFire(db: D1Database, automation: Automation, contactId: string): Promise<boolean> {
  const hit = await db
    .prepare("SELECT last_fired_at FROM automation_hits WHERE automation_id = ? AND contact_id = ?")
    .bind(automation.id, contactId)
    .first<{ last_fired_at: string }>();
  if (!hit) return true;
  if (automation.once_per_user === 1) return false;
  if (automation.cooldown_hours <= 0) return true;
  const last = new Date(hit.last_fired_at).getTime();
  return Date.now() - last >= automation.cooldown_hours * 3600_000;
}

export async function recordHit(db: D1Database, automationId: number, contactId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO automation_hits (automation_id, contact_id, last_fired_at, fire_count) VALUES (?, ?, ?, 1) " +
        "ON CONFLICT(automation_id, contact_id) DO UPDATE SET " +
        "  last_fired_at = excluded.last_fired_at, fire_count = automation_hits.fire_count + 1",
    )
    .bind(automationId, contactId, nowIso())
    .run();
}

export async function applyTag(db: D1Database, contactId: string, tag: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag, created_at) VALUES (?, ?, ?)")
    .bind(contactId, tag, nowIso())
    .run();
}

export async function logMessage(
  db: D1Database,
  m: {
    id: string;
    contactId: string;
    direction: "in" | "out";
    source: "user" | "auto" | "sequence" | "manual";
    kind: "dm" | "story_reply" | "comment" | "comment_reply";
    text: string | null;
    automationId?: number | null;
    payloadJson?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO messages (id, contact_id, direction, source, kind, text, automation_id, payload_json, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      m.id,
      m.contactId,
      m.direction,
      m.source,
      m.kind,
      m.text,
      m.automationId ?? null,
      m.payloadJson ?? null,
      nowIso(),
    )
    .run();
}

/** 시퀀스 잡 예약 (설계서 §6). 규칙에 붙은 단계들을 due_at 계산해 큐잉. */
export async function scheduleSequence(db: D1Database, automationId: number, contactId: string): Promise<void> {
  const steps = await db
    .prepare("SELECT id, delay_minutes FROM sequence_steps WHERE automation_id = ? ORDER BY sort")
    .bind(automationId)
    .all<{ id: number; delay_minutes: number }>();
  const now = Date.now();
  for (const step of steps.results ?? []) {
    const dueAt = new Date(now + step.delay_minutes * 60_000).toISOString();
    await db
      .prepare("INSERT INTO sequence_jobs (step_id, contact_id, due_at, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(step.id, contactId, dueAt, nowIso())
      .run();
  }
}
