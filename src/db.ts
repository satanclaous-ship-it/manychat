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

// ─────────────────────────────────────────────────────────────
// 대시보드 쿼리 (설계서 §7)
// ─────────────────────────────────────────────────────────────

export interface AutomationRow extends Automation {
  hit_count: number;
  step_count: number;
  btn_count: number;
}

export async function listAutomations(db: D1Database): Promise<AutomationRow[]> {
  const res = await db
    .prepare(
      "SELECT a.*, " +
        " (SELECT COUNT(*) FROM automation_hits h WHERE h.automation_id = a.id) AS hit_count, " +
        " (SELECT COUNT(*) FROM sequence_steps s WHERE s.automation_id = a.id) AS step_count, " +
        " (SELECT COUNT(*) FROM quick_replies q WHERE q.automation_id = a.id) AS btn_count " +
        "FROM automations a ORDER BY a.id",
    )
    .all<AutomationRow>();
  return res.results ?? [];
}

export async function getAutomation(db: D1Database, id: number): Promise<Automation | null> {
  return await db.prepare("SELECT * FROM automations WHERE id = ?").bind(id).first<Automation>();
}

export interface NewAutomation {
  name: string;
  type: string;
  media_id: string | null;
  keywords_json: string;
  match_mode: string;
  public_reply_text: string | null;
  dm_text: string;
  once_per_user: number;
  cooldown_hours: number;
  tag_to_apply: string | null;
}

export async function createAutomation(
  db: D1Database,
  a: NewAutomation,
  steps: { delay_minutes: number; text: string }[],
): Promise<number> {
  const now = nowIso();
  const res = await db
    .prepare(
      "INSERT INTO automations (name,type,enabled,media_id,keywords_json,match_mode,public_reply_text,dm_text,once_per_user,cooldown_hours,tag_to_apply,created_at,updated_at) " +
        "VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      a.name,
      a.type,
      a.media_id,
      a.keywords_json,
      a.match_mode,
      a.public_reply_text,
      a.dm_text,
      a.once_per_user,
      a.cooldown_hours,
      a.tag_to_apply,
      now,
      now,
    )
    .run();
  const id = res.meta.last_row_id as number;
  let sort = 0;
  for (const s of steps) {
    await db
      .prepare("INSERT INTO sequence_steps (automation_id,delay_minutes,text,sort) VALUES (?,?,?,?)")
      .bind(id, s.delay_minutes, s.text, sort++)
      .run();
  }
  return id;
}

export async function toggleAutomation(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE automations SET enabled = 1 - enabled, updated_at = ? WHERE id = ?")
    .bind(nowIso(), id)
    .run();
}

export async function deleteAutomation(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM sequence_steps WHERE automation_id = ?").bind(id).run();
  await db.prepare("DELETE FROM automation_hits WHERE automation_id = ?").bind(id).run();
  await db.prepare("DELETE FROM quick_replies WHERE automation_id = ?").bind(id).run();
  await db.prepare("DELETE FROM automations WHERE id = ?").bind(id).run();
}

export interface ConversationRow {
  id: string;
  username: string | null;
  last_inbound_at: string | null;
  automation_paused: number;
  last_text: string | null;
  last_at: string | null;
  last_dir: string | null;
}

export async function listConversations(db: D1Database, limit = 50): Promise<ConversationRow[]> {
  const res = await db
    .prepare(
      "SELECT c.id, c.username, c.last_inbound_at, c.automation_paused, " +
        " m.text AS last_text, m.created_at AS last_at, m.direction AS last_dir " +
        "FROM contacts c " +
        "LEFT JOIN messages m ON m.id = ( " +
        "  SELECT id FROM messages m2 WHERE m2.contact_id = c.id ORDER BY m2.created_at DESC LIMIT 1) " +
        "ORDER BY COALESCE(m.created_at, c.last_seen_at) DESC LIMIT ?",
    )
    .bind(limit)
    .all<ConversationRow>();
  return res.results ?? [];
}

export interface MessageRow {
  id: string;
  direction: string;
  source: string;
  kind: string;
  text: string | null;
  created_at: string;
}

export async function getConversation(
  db: D1Database,
  contactId: string,
): Promise<{ contact: ConversationRow | null; messages: MessageRow[]; pendingJobs: number }> {
  const contact = await db
    .prepare("SELECT id, username, last_inbound_at, automation_paused, NULL last_text, NULL last_at, NULL last_dir FROM contacts WHERE id = ?")
    .bind(contactId)
    .first<ConversationRow>();
  const msgs = await db
    .prepare("SELECT id,direction,source,kind,text,created_at FROM messages WHERE contact_id = ? ORDER BY created_at")
    .bind(contactId)
    .all<MessageRow>();
  const jobs = await db
    .prepare("SELECT COUNT(*) c FROM sequence_jobs WHERE contact_id = ? AND status = 'pending'")
    .bind(contactId)
    .first<{ c: number }>();
  return { contact, messages: msgs.results ?? [], pendingJobs: jobs?.c ?? 0 };
}

export async function setPaused(db: D1Database, contactId: string, paused: boolean): Promise<void> {
  await db.prepare("UPDATE contacts SET automation_paused = ? WHERE id = ?").bind(paused ? 1 : 0, contactId).run();
}

export async function cancelPendingJobs(db: D1Database, contactId: string): Promise<void> {
  await db
    .prepare("UPDATE sequence_jobs SET status = 'cancelled', resolved_at = ? WHERE contact_id = ? AND status = 'pending'")
    .bind(nowIso(), contactId)
    .run();
}

/** 24h 윈도우 안이면 true (수동 답장 허용 판정 — 설계서 §7 인박스). */
export function withinWindow(lastInboundAt: string | null): boolean {
  if (!lastInboundAt) return false;
  return Date.now() - new Date(lastInboundAt).getTime() < 24 * 3600_000;
}

export interface ContactListRow {
  id: string;
  username: string | null;
  tags: string | null;
  last_seen_at: string;
}

export async function listContacts(db: D1Database, tag: string | null): Promise<ContactListRow[]> {
  const q =
    "SELECT c.id, c.username, c.last_seen_at, " +
    " (SELECT GROUP_CONCAT(t.tag, ',') FROM contact_tags t WHERE t.contact_id = c.id) AS tags " +
    "FROM contacts c " +
    (tag ? "WHERE EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = c.id AND t.tag = ?) " : "") +
    "ORDER BY c.last_seen_at DESC LIMIT 500";
  const stmt = tag ? db.prepare(q).bind(tag) : db.prepare(q);
  const res = await stmt.all<ContactListRow>();
  return res.results ?? [];
}

export async function listAllTags(db: D1Database): Promise<string[]> {
  const res = await db.prepare("SELECT DISTINCT tag FROM contact_tags ORDER BY tag").all<{ tag: string }>();
  return (res.results ?? []).map((r) => r.tag);
}

export interface EventRow {
  type: string;
  outcome: string | null;
  created_at: string;
}

export async function listEvents(db: D1Database, errorsOnly: boolean): Promise<EventRow[]> {
  const q =
    "SELECT type, outcome, created_at FROM events_log " +
    (errorsOnly ? "WHERE outcome LIKE 'error:%' OR outcome LIKE '%err:%' " : "") +
    "ORDER BY id DESC LIMIT 100";
  const res = await db.prepare(q).all<EventRow>();
  return res.results ?? [];
}

// ─────────────────────────────────────────────────────────────
// 대화 플로우: 빠른 답장 버튼 (quick_replies)
// ─────────────────────────────────────────────────────────────

export interface QuickReply {
  id: number;
  automation_id: number;
  label: string;
  response_text: string;
  sort: number;
}

export async function getQuickReplies(db: D1Database, automationId: number): Promise<QuickReply[]> {
  const res = await db
    .prepare("SELECT * FROM quick_replies WHERE automation_id = ? ORDER BY sort")
    .bind(automationId)
    .all<QuickReply>();
  return res.results ?? [];
}

export async function getQuickReplyById(db: D1Database, id: number): Promise<QuickReply | null> {
  return await db.prepare("SELECT * FROM quick_replies WHERE id = ?").bind(id).first<QuickReply>();
}

export async function addQuickReplies(
  db: D1Database,
  automationId: number,
  buttons: { label: string; response_text: string }[],
): Promise<void> {
  let sort = 0;
  for (const b of buttons) {
    await db
      .prepare("INSERT INTO quick_replies (automation_id,label,response_text,sort) VALUES (?,?,?,?)")
      .bind(automationId, b.label, b.response_text, sort++)
      .run();
  }
}

export async function deleteQuickReplies(db: D1Database, automationId: number): Promise<void> {
  await db.prepare("DELETE FROM quick_replies WHERE automation_id = ?").bind(automationId).run();
}
