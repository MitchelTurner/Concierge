/**
 * PostgreSQL data layer.
 *
 * Owns the connection pool, schema bootstrap (`CREATE TABLE IF NOT EXISTS`),
 * and all typed CRUD for users, sessions, projects, goals, and daily_log.
 *
 * Every query is scoped by `user_id` so multiple accounts share one database
 * safely. Demo projects are seeded only for new signups when SEED_DEMO_DATA
 * allows it (local by default, off on Railway).
 */
import pg from "pg";
import crypto from "node:crypto";
import { getDatabaseUrl, shouldSeedDemoData } from "./config.js";

export type ProjectType = "fast" | "passive";
export type ProjectStatus =
  | "idea"
  | "active"
  | "blocked"
  | "shipped"
  | "paid"
  | "archived";

export const PROJECT_TYPES: ProjectType[] = ["fast", "passive"];
export const PROJECT_STATUSES: ProjectStatus[] = [
  "idea",
  "active",
  "blocked",
  "shipped",
  "paid",
  "archived",
];

export interface User {
  id: number;
  email: string;
  password_hash?: string;
  name: string | null;
  telegram_chat_id: string | null;
  daily_time: string;
  checkin_time: string;
  timezone: string;
  stall_days: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekly_review_day: number;
  weekly_review_time: string;
  /** Optional read-only ICS feed for calendar awareness. */
  calendar_ics_url: string | null;
  last_daily_nudge_date: string | null;
  last_checkin_nudge_date: string | null;
  last_weekly_review_date: string | null;
  created_at: string;
  updated_at: string;
}

/** A durable fact or preference the assistant saved about the user. */
export interface UserMemory {
  id: number;
  user_id: number;
  content: string;
  created_at: string;
  updated_at: string;
}

/** A client contact, optionally linked to a project. */
export interface Contact {
  id: number;
  user_id: number;
  project_id: number | null;
  name: string;
  email: string;
  role: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewContact {
  name: string;
  email: string;
  project_id?: number | null;
  role?: string | null;
  notes?: string | null;
}

export interface ContactPatch {
  name?: string;
  email?: string;
  project_id?: number | null;
  role?: string | null;
  notes?: string | null;
}

export type OutreachStatus = "draft" | "sent" | "replied" | "cancelled";

/** A chase-up email to a client about something blocking the pipeline. */
export interface Outreach {
  id: number;
  user_id: number;
  project_id: number;
  contact_id: number;
  /** What the user is waiting on, e.g. "photos of the finished kitchen". */
  waiting_on: string;
  subject: string;
  body: string;
  status: OutreachStatus;
  smtp_message_id: string | null;
  sent_at: string | null;
  replied_at: string | null;
  reply_snippet: string | null;
  created_at: string;
  updated_at: string;
}

/** Outreach joined with its contact and project name (for matching and display). */
export interface OutreachWithContext extends Outreach {
  contact_name: string;
  contact_email: string;
  project_name: string;
}

export interface Project {
  id: number;
  user_id: number;
  name: string;
  type: ProjectType;
  client: string | null;
  revenue_potential: number;
  confidence: number;
  time_to_cash: number;
  effort_remaining: number;
  status: ProjectStatus;
  next_action: string | null;
  deadline: string | null;
  notes: string | null;
  last_progress_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A concrete task attached to an idea (project). */
export interface ProjectTask {
  id: number;
  user_id: number;
  project_id: number;
  title: string;
  done: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithTasks extends Project {
  tasks: ProjectTask[];
}

export interface DailyLogEntry {
  id: number;
  user_id: number;
  date: string;
  note: string;
  created_at: string;
}

export interface Goal {
  id: number;
  user_id: number;
  title: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export type MeetingNoteType = "call" | "meeting";

export const MEETING_NOTE_TYPES: MeetingNoteType[] = ["call", "meeting"];

/** Notes captured during phone calls or meetings. */
export interface MeetingNote {
  id: number;
  user_id: number;
  project_id: number | null;
  title: string;
  body: string;
  type: MeetingNoteType;
  participants: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

export interface NewMeetingNote {
  title: string;
  body: string;
  type?: MeetingNoteType;
  participants?: string | null;
  project_id?: number | null;
  occurred_at?: string;
}

export interface MeetingNotePatch {
  title?: string;
  body?: string;
  type?: MeetingNoteType;
  participants?: string | null;
  project_id?: number | null;
  occurred_at?: string;
}

export const PROJECT_EDITABLE_COLUMNS = [
  "name",
  "type",
  "client",
  "revenue_potential",
  "confidence",
  "time_to_cash",
  "effort_remaining",
  "status",
  "next_action",
  "deadline",
  "notes",
] as const;

export type ProjectEditableColumn = (typeof PROJECT_EDITABLE_COLUMNS)[number];
export type ProjectPatch = Partial<Pick<Project, ProjectEditableColumn>>;

export interface NewProject {
  name: string;
  type?: ProjectType;
  client?: string | null;
  revenue_potential?: number;
  confidence?: number;
  time_to_cash?: number;
  effort_remaining?: number;
  /** Idea description — what you're exploring or building toward. */
  notes?: string | null;
  status?: ProjectStatus;
  next_action?: string | null;
  deadline?: string | null;
  /** Optional initial tasks to seed with the idea. */
  tasks?: string[];
}

export interface NewUser {
  email: string;
  password_hash: string;
  name?: string | null;
  daily_time: string;
  checkin_time: string;
  timezone: string;
  stall_days: number;
}

export interface UserSettingsPatch {
  name?: string | null;
  daily_time?: string;
  checkin_time?: string;
  timezone?: string;
  stall_days?: number;
  weekly_review_day?: number;
  weekly_review_time?: string;
  calendar_ics_url?: string | null;
}

let pool: pg.Pool | null = null;

// ---------------------------------------------------------------------------
// Schema — applied once at boot via initDb()
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function todayIso(): string {
  return nowIso().slice(0, 10);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  telegram_chat_id TEXT UNIQUE,
  telegram_link_code TEXT,
  daily_time TEXT NOT NULL DEFAULT '07:30',
  checkin_time TEXT NOT NULL DEFAULT '20:00',
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  stall_days INTEGER NOT NULL DEFAULT 4,
  weekly_review_day INTEGER NOT NULL DEFAULT 0,
  weekly_review_time TEXT NOT NULL DEFAULT '17:00',
  last_daily_nudge_date DATE,
  last_checkin_nudge_date DATE,
  last_weekly_review_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Columns added after launch (no-ops on fresh installs).
ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_review_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_review_time TEXT NOT NULL DEFAULT '17:00';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_weekly_review_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_ics_url TEXT;

CREATE TABLE IF NOT EXISTS user_memory (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_memory_user_id ON user_memory(user_id);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_project_id ON contacts(project_id);

CREATE TABLE IF NOT EXISTS outreach (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  waiting_on TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','replied','cancelled')),
  smtp_message_id TEXT,
  sent_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  reply_snippet TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_user_id ON outreach(user_id);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('fast', 'passive')),
  client TEXT,
  revenue_potential INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  time_to_cash INTEGER NOT NULL,
  effort_remaining INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idea'
    CHECK (status IN ('idea','active','blocked','shipped','paid','archived')),
  next_action TEXT,
  deadline DATE,
  notes TEXT,
  last_progress_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_log_user_id ON daily_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS project_tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_user_id ON project_tasks(user_id);

CREATE TABLE IF NOT EXISTS meeting_notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'call'
    CHECK (type IN ('call', 'meeting')),
  participants TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_user_id ON meeting_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_notes_occurred_at ON meeting_notes(occurred_at DESC);
`;

function getPool(): pg.Pool {
  if (!pool) throw new Error("Database not initialized — call initDb() first.");
  return pool;
}

// Return DATE columns as "YYYY-MM-DD" strings instead of JS Date objects so
// date math (daysUntil, nudge dedupe comparisons) works on the documented type.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export async function initDb(): Promise<void> {
  if (pool) return;

  pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 10,
  });

  await pool.query(SCHEMA);
  await pool.query(
    "UPDATE projects SET last_progress_at = created_at WHERE last_progress_at IS NULL"
  );

  const counts = await pool.query<{ projectCount: string; goalCount: string; userCount: string }>(
    `SELECT
      (SELECT COUNT(*)::text FROM projects) AS "projectCount",
      (SELECT COUNT(*)::text FROM goals) AS "goalCount",
      (SELECT COUNT(*)::text FROM users) AS "userCount"`
  );
  const row = counts.rows[0];
  console.log(
    `[db] postgres ready — ${row.userCount} user(s), ${row.projectCount} project(s), ${row.goalCount} goal(s)`
  );
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// --- Users ---

export async function createUser(user: NewUser): Promise<User> {
  const result = await getPool().query<User>(
    `INSERT INTO users
      (email, password_hash, name, daily_time, checkin_time, timezone, stall_days, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     RETURNING *`,
    [
      user.email.toLowerCase(),
      user.password_hash,
      user.name ?? null,
      user.daily_time,
      user.checkin_time,
      user.timezone,
      user.stall_days,
    ]
  );
  const created = result.rows[0];

  if (shouldSeedDemoData()) {
    await seedUserDemoData(created.id);
    console.log(`[db] inserted demo data for new user #${created.id}`);
  }

  return created;
}

export async function getUserById(id: number): Promise<User | undefined> {
  const result = await getPool().query<User>("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const result = await getPool().query<User>("SELECT * FROM users WHERE email = $1", [
    email.toLowerCase(),
  ]);
  return result.rows[0];
}

export async function getUserByTelegramChatId(chatId: string): Promise<User | undefined> {
  const result = await getPool().query<User>(
    "SELECT * FROM users WHERE telegram_chat_id = $1",
    [chatId]
  );
  return result.rows[0];
}

export async function getUsersWithTelegram(): Promise<User[]> {
  const result = await getPool().query<User>(
    "SELECT * FROM users WHERE telegram_chat_id IS NOT NULL ORDER BY id"
  );
  return result.rows;
}

export async function updateUserSettings(
  userId: number,
  patch: UserSettingsPatch
): Promise<User | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(patch.name);
  }
  if (patch.daily_time !== undefined) {
    sets.push(`daily_time = $${i++}`);
    params.push(patch.daily_time);
  }
  if (patch.checkin_time !== undefined) {
    sets.push(`checkin_time = $${i++}`);
    params.push(patch.checkin_time);
  }
  if (patch.timezone !== undefined) {
    sets.push(`timezone = $${i++}`);
    params.push(patch.timezone);
  }
  if (patch.stall_days !== undefined) {
    sets.push(`stall_days = $${i++}`);
    params.push(patch.stall_days);
  }
  if (patch.weekly_review_day !== undefined) {
    sets.push(`weekly_review_day = $${i++}`);
    params.push(patch.weekly_review_day);
  }
  if (patch.weekly_review_time !== undefined) {
    sets.push(`weekly_review_time = $${i++}`);
    params.push(patch.weekly_review_time);
  }
  if (patch.calendar_ics_url !== undefined) {
    sets.push(`calendar_ics_url = $${i++}`);
    params.push(patch.calendar_ics_url);
  }

  if (sets.length === 0) return getUserById(userId);

  sets.push(`updated_at = NOW()`);
  params.push(userId);

  const result = await getPool().query<User>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function setTelegramLinkCode(userId: number, code: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET telegram_link_code = $1, updated_at = NOW() WHERE id = $2",
    [code, userId]
  );
}

export async function linkTelegramByCode(
  code: string,
  chatId: string
): Promise<User | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const taken = await client.query<{ id: number }>(
      "SELECT id FROM users WHERE telegram_chat_id = $1",
      [chatId]
    );
    if (taken.rows[0]) {
      await client.query("ROLLBACK");
      return undefined;
    }

    const result = await client.query<User>(
      `UPDATE users
       SET telegram_chat_id = $1, telegram_link_code = NULL, updated_at = NOW()
       WHERE telegram_link_code = $2
       RETURNING *`,
      [chatId, code]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function unlinkTelegram(userId: number): Promise<void> {
  await getPool().query(
    "UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL, updated_at = NOW() WHERE id = $1",
    [userId]
  );
}

export async function markDailyNudgeSent(userId: number, date: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET last_daily_nudge_date = $1, updated_at = NOW() WHERE id = $2",
    [date, userId]
  );
}

export async function markCheckinNudgeSent(userId: number, date: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET last_checkin_nudge_date = $1, updated_at = NOW() WHERE id = $2",
    [date, userId]
  );
}

export async function markWeeklyReviewSent(userId: number, date: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET last_weekly_review_date = $1, updated_at = NOW() WHERE id = $2",
    [date, userId]
  );
}

export type NudgeKind = "daily" | "checkin" | "weekly";

function nudgeClaimKey(kind: NudgeKind, userId: number, date: string): string {
  return `nudge:${kind}:${userId}:${date}`;
}

export async function claimUserNudge(
  userId: number,
  kind: NudgeKind,
  date: string
): Promise<boolean> {
  const result = await getPool().query<{ key: string }>(
    `INSERT INTO app_meta (key, value)
     VALUES ($1, 'sending')
     ON CONFLICT DO NOTHING
     RETURNING key`,
    [nudgeClaimKey(kind, userId, date)]
  );
  return result.rows.length > 0;
}

export async function completeUserNudge(
  userId: number,
  kind: NudgeKind,
  date: string
): Promise<void> {
  if (kind === "daily") {
    await markDailyNudgeSent(userId, date);
  } else if (kind === "checkin") {
    await markCheckinNudgeSent(userId, date);
  } else {
    await markWeeklyReviewSent(userId, date);
  }

  await getPool().query("UPDATE app_meta SET value = 'sent' WHERE key = $1", [
    nudgeClaimKey(kind, userId, date),
  ]);
}

export async function releaseUserNudgeClaim(
  userId: number,
  kind: NudgeKind,
  date: string
): Promise<void> {
  await getPool().query("DELETE FROM app_meta WHERE key = $1", [nudgeClaimKey(kind, userId, date)]);
}

// --- One-shot claims for proactive alerts ---

/** Claim an arbitrary app_meta key exactly once. Returns false if already claimed. */
export async function claimOnce(key: string): Promise<boolean> {
  const result = await getPool().query<{ key: string }>(
    `INSERT INTO app_meta (key, value)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING key`,
    [key, nowIso()]
  );
  return result.rows.length > 0;
}

export async function releaseClaim(key: string): Promise<void> {
  await getPool().query("DELETE FROM app_meta WHERE key = $1", [key]);
}

export async function getAppMeta(key: string): Promise<string | undefined> {
  const result = await getPool().query<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value;
}

export async function setAppMeta(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO app_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// --- Sessions ---

export async function createSession(userId: number, token: string, expiresAt: Date): Promise<void> {
  await getPool().query(
    "INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)",
    [userId, token, expiresAt.toISOString()]
  );
}

export async function getUserIdBySessionToken(token: string): Promise<number | undefined> {
  const result = await getPool().query<{ user_id: number }>(
    `SELECT user_id FROM sessions
     WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return result.rows[0]?.user_id;
}

export async function deleteSession(token: string): Promise<void> {
  await getPool().query("DELETE FROM sessions WHERE token = $1", [token]);
}

export async function deleteExpiredSessions(): Promise<void> {
  await getPool().query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

export function generateLinkCode(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// --- Projects ---

export async function getActiveProjects(userId: number): Promise<Project[]> {
  const result = await getPool().query<Project>(
    "SELECT * FROM projects WHERE user_id = $1 AND status = 'active' ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function getAllProjects(userId: number): Promise<Project[]> {
  const result = await getPool().query<Project>(
    "SELECT * FROM projects WHERE user_id = $1 ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function getProject(userId: number, id: number): Promise<Project | undefined> {
  const result = await getPool().query<Project>(
    "SELECT * FROM projects WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return result.rows[0];
}

export async function addProject(userId: number, p: NewProject): Promise<Project> {
  const ts = nowIso();
  const result = await getPool().query<Project>(
    `INSERT INTO projects
      (user_id, name, type, client, revenue_potential, confidence, time_to_cash,
       effort_remaining, status, next_action, deadline, notes,
       last_progress_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      userId,
      p.name,
      p.type ?? "fast",
      p.client ?? null,
      p.revenue_potential ?? 3,
      p.confidence ?? 3,
      p.time_to_cash ?? 3,
      p.effort_remaining ?? 8,
      p.status ?? "idea",
      p.next_action ?? null,
      p.deadline ?? null,
      p.notes ?? null,
      ts,
      ts,
      ts,
    ]
  );
  const project = result.rows[0];
  if (p.tasks?.length) {
    for (let i = 0; i < p.tasks.length; i++) {
      const title = p.tasks[i]?.trim();
      if (title) await addProjectTask(userId, project.id, title, i);
    }
  }
  return project;
}

export async function setStatus(
  userId: number,
  id: number,
  status: ProjectStatus
): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET status = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3",
    [status, userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function stampProgress(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET last_progress_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function addDailyLog(userId: number, note: string): Promise<DailyLogEntry> {
  const date = todayIso();
  const result = await getPool().query<DailyLogEntry>(
    "INSERT INTO daily_log (user_id, date, note) VALUES ($1, $2, $3) RETURNING *",
    [userId, date, note]
  );
  return result.rows[0];
}

export async function getDailyLog(userId: number, limit = 50): Promise<DailyLogEntry[]> {
  const result = await getPool().query<DailyLogEntry>(
    `SELECT * FROM daily_log
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

export async function getDailyLogSince(
  userId: number,
  sinceIso: string
): Promise<DailyLogEntry[]> {
  const result = await getPool().query<DailyLogEntry>(
    `SELECT * FROM daily_log
     WHERE user_id = $1 AND created_at >= $2
     ORDER BY created_at ASC`,
    [userId, sinceIso]
  );
  return result.rows;
}

export interface CompletedTaskRow extends ProjectTask {
  project_name: string;
}

/** Tasks marked done since a timestamp, with their project name for reporting. */
export async function getTasksCompletedSince(
  userId: number,
  sinceIso: string
): Promise<CompletedTaskRow[]> {
  const result = await getPool().query<CompletedTaskRow>(
    `SELECT t.*, p.name AS project_name
     FROM project_tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.user_id = $1 AND t.done = true AND t.updated_at >= $2
     ORDER BY t.updated_at ASC`,
    [userId, sinceIso]
  );
  return result.rows;
}

export async function getStalledProjects(userId: number, stallDays: number): Promise<Project[]> {
  const cutoff = new Date(Date.now() - stallDays * 86_400_000).toISOString();
  const active = await getActiveProjects(userId);
  return active
    .filter((p) => {
      if (!p.last_progress_at) return true;
      const t = new Date(p.last_progress_at).getTime();
      return Number.isNaN(t) || t < new Date(cutoff).getTime();
    })
    .sort((a, b) => {
      const ta = a.last_progress_at ? new Date(a.last_progress_at).getTime() : -Infinity;
      const tb = b.last_progress_at ? new Date(b.last_progress_at).getTime() : -Infinity;
      return ta - tb;
    });
}

export async function updateProject(
  userId: number,
  id: number,
  patch: ProjectPatch
): Promise<Project | undefined> {
  const keys = (Object.keys(patch) as ProjectEditableColumn[]).filter((k) =>
    PROJECT_EDITABLE_COLUMNS.includes(k)
  );
  if (keys.length === 0) return getProject(userId, id);

  const sets = keys.map((k, idx) => `${k} = $${idx + 1}`);
  const params: unknown[] = keys.map((k) => patch[k] ?? null);
  params.push(userId, id);

  const result = await getPool().query<Project>(
    `UPDATE projects SET ${sets.join(", ")}, updated_at = NOW()
     WHERE user_id = $${keys.length + 1} AND id = $${keys.length + 2}
     RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function deleteProject(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM projects WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Project tasks ---

export async function getTasksForProject(
  userId: number,
  projectId: number
): Promise<ProjectTask[]> {
  const result = await getPool().query<ProjectTask>(
    `SELECT * FROM project_tasks
     WHERE user_id = $1 AND project_id = $2
     ORDER BY done ASC, sort_order ASC, id ASC`,
    [userId, projectId]
  );
  return result.rows;
}

export async function getTasksForProjects(
  userId: number,
  projectIds: number[]
): Promise<ProjectTask[]> {
  if (projectIds.length === 0) return [];
  const result = await getPool().query<ProjectTask>(
    `SELECT * FROM project_tasks
     WHERE user_id = $1 AND project_id = ANY($2::int[])
     ORDER BY project_id, done ASC, sort_order ASC, id ASC`,
    [userId, projectIds]
  );
  return result.rows;
}

export async function attachTasksToProjects(
  projects: Project[],
  tasks: ProjectTask[]
): Promise<ProjectWithTasks[]> {
  const byProject = new Map<number, ProjectTask[]>();
  for (const t of tasks) {
    const list = byProject.get(t.project_id) ?? [];
    list.push(t);
    byProject.set(t.project_id, list);
  }
  return projects.map((p) => ({ ...p, tasks: byProject.get(p.id) ?? [] }));
}

export async function getAllProjectsWithTasks(userId: number): Promise<ProjectWithTasks[]> {
  const projects = await getAllProjects(userId);
  const tasks = await getTasksForProjects(
    userId,
    projects.map((p) => p.id)
  );
  return attachTasksToProjects(projects, tasks);
}

export async function getProjectWithTasks(
  userId: number,
  id: number
): Promise<ProjectWithTasks | undefined> {
  const project = await getProject(userId, id);
  if (!project) return undefined;
  const tasks = await getTasksForProject(userId, id);
  return { ...project, tasks };
}

export async function addProjectTask(
  userId: number,
  projectId: number,
  title: string,
  sortOrder?: number
): Promise<ProjectTask> {
  let order = sortOrder;
  if (order === undefined) {
    const count = await getPool().query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM project_tasks WHERE user_id = $1 AND project_id = $2",
      [userId, projectId]
    );
    order = Number(count.rows[0]?.n ?? 0);
  }

  const result = await getPool().query<ProjectTask>(
    `INSERT INTO project_tasks (user_id, project_id, title, sort_order)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, projectId, title.trim(), order]
  );
  await stampProgress(userId, projectId);
  return result.rows[0];
}

export async function addProjectTasks(
  userId: number,
  projectId: number,
  titles: string[]
): Promise<ProjectTask[]> {
  const added: ProjectTask[] = [];
  for (const title of titles) {
    const trimmed = title.trim();
    if (trimmed) added.push(await addProjectTask(userId, projectId, trimmed));
  }
  return added;
}

export async function updateProjectTask(
  userId: number,
  taskId: number,
  patch: { title?: string; done?: boolean; sort_order?: number }
): Promise<ProjectTask | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.title !== undefined) {
    sets.push(`title = $${i++}`);
    params.push(patch.title.trim());
  }
  if (patch.done !== undefined) {
    sets.push(`done = $${i++}`);
    params.push(patch.done);
  }
  if (patch.sort_order !== undefined) {
    sets.push(`sort_order = $${i++}`);
    params.push(patch.sort_order);
  }
  if (sets.length === 0) {
    const result = await getPool().query<ProjectTask>(
      "SELECT * FROM project_tasks WHERE user_id = $1 AND id = $2",
      [userId, taskId]
    );
    return result.rows[0];
  }

  sets.push("updated_at = NOW()");
  params.push(userId, taskId);

  const result = await getPool().query<ProjectTask>(
    `UPDATE project_tasks SET ${sets.join(", ")}
     WHERE user_id = $${i} AND id = $${i + 1}
     RETURNING *`,
    params
  );
  const task = result.rows[0];
  if (task && patch.done === true) {
    await stampProgress(userId, task.project_id);
  }
  return task;
}

export async function deleteProjectTask(userId: number, taskId: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM project_tasks WHERE user_id = $1 AND id = $2",
    [userId, taskId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getProjectTask(
  userId: number,
  taskId: number
): Promise<ProjectTask | undefined> {
  const result = await getPool().query<ProjectTask>(
    "SELECT * FROM project_tasks WHERE user_id = $1 AND id = $2",
    [userId, taskId]
  );
  return result.rows[0];
}

// --- Goals ---

export async function getGoals(userId: number): Promise<Goal[]> {
  const result = await getPool().query<Goal>(
    "SELECT * FROM goals WHERE user_id = $1 ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function getGoal(userId: number, id: number): Promise<Goal | undefined> {
  const result = await getPool().query<Goal>(
    "SELECT * FROM goals WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return result.rows[0];
}

export async function addGoal(
  userId: number,
  title: string,
  detail: string | null = null
): Promise<Goal> {
  const result = await getPool().query<Goal>(
    "INSERT INTO goals (user_id, title, detail) VALUES ($1, $2, $3) RETURNING *",
    [userId, title, detail]
  );
  return result.rows[0];
}

export async function updateGoal(
  userId: number,
  id: number,
  patch: { title?: string; detail?: string | null }
): Promise<Goal | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.title !== undefined) {
    sets.push(`title = $${i++}`);
    params.push(patch.title);
  }
  if (patch.detail !== undefined) {
    sets.push(`detail = $${i++}`);
    params.push(patch.detail);
  }
  if (sets.length === 0) return getGoal(userId, id);

  sets.push("updated_at = NOW()");
  params.push(userId, id);

  const result = await getPool().query<Goal>(
    `UPDATE goals SET ${sets.join(", ")} WHERE user_id = $${i} AND id = $${i + 1} RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function deleteGoal(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM goals WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Assistant memory ---

export async function getMemories(userId: number): Promise<UserMemory[]> {
  const result = await getPool().query<UserMemory>(
    "SELECT * FROM user_memory WHERE user_id = $1 ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function addMemory(userId: number, content: string): Promise<UserMemory> {
  const result = await getPool().query<UserMemory>(
    "INSERT INTO user_memory (user_id, content) VALUES ($1, $2) RETURNING *",
    [userId, content.trim()]
  );
  return result.rows[0];
}

export async function deleteMemory(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM user_memory WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Contacts ---

export async function getContacts(userId: number): Promise<Contact[]> {
  const result = await getPool().query<Contact>(
    "SELECT * FROM contacts WHERE user_id = $1 ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function getContact(userId: number, id: number): Promise<Contact | undefined> {
  const result = await getPool().query<Contact>(
    "SELECT * FROM contacts WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return result.rows[0];
}

/** Contact linked to a project (first match), used as the default outreach recipient. */
export async function getContactForProject(
  userId: number,
  projectId: number
): Promise<Contact | undefined> {
  const result = await getPool().query<Contact>(
    "SELECT * FROM contacts WHERE user_id = $1 AND project_id = $2 ORDER BY id LIMIT 1",
    [userId, projectId]
  );
  return result.rows[0];
}

export async function addContact(userId: number, c: NewContact): Promise<Contact> {
  const result = await getPool().query<Contact>(
    `INSERT INTO contacts (user_id, project_id, name, email, role, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      userId,
      c.project_id ?? null,
      c.name.trim(),
      c.email.trim().toLowerCase(),
      c.role?.trim() || null,
      c.notes?.trim() || null,
    ]
  );
  return result.rows[0];
}

export async function updateContact(
  userId: number,
  id: number,
  patch: ContactPatch
): Promise<Contact | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(patch.name.trim());
  }
  if (patch.email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(patch.email.trim().toLowerCase());
  }
  if (patch.project_id !== undefined) {
    sets.push(`project_id = $${i++}`);
    params.push(patch.project_id);
  }
  if (patch.role !== undefined) {
    sets.push(`role = $${i++}`);
    params.push(patch.role);
  }
  if (patch.notes !== undefined) {
    sets.push(`notes = $${i++}`);
    params.push(patch.notes);
  }
  if (sets.length === 0) return getContact(userId, id);

  sets.push("updated_at = NOW()");
  params.push(userId, id);

  const result = await getPool().query<Contact>(
    `UPDATE contacts SET ${sets.join(", ")} WHERE user_id = $${i} AND id = $${i + 1} RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function deleteContact(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM contacts WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Outreach (client chase-up emails) ---

const OUTREACH_CONTEXT_SELECT = `
  SELECT o.*, c.name AS contact_name, c.email AS contact_email, p.name AS project_name
  FROM outreach o
  JOIN contacts c ON c.id = o.contact_id
  JOIN projects p ON p.id = o.project_id`;

export async function addOutreach(
  userId: number,
  draft: {
    project_id: number;
    contact_id: number;
    waiting_on: string;
    subject: string;
    body: string;
  }
): Promise<Outreach> {
  const result = await getPool().query<Outreach>(
    `INSERT INTO outreach (user_id, project_id, contact_id, waiting_on, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, draft.project_id, draft.contact_id, draft.waiting_on, draft.subject, draft.body]
  );
  return result.rows[0];
}

export async function getOutreach(
  userId: number,
  id: number
): Promise<OutreachWithContext | undefined> {
  const result = await getPool().query<OutreachWithContext>(
    `${OUTREACH_CONTEXT_SELECT} WHERE o.user_id = $1 AND o.id = $2`,
    [userId, id]
  );
  return result.rows[0];
}

/** A user's drafts and sent-but-unanswered outreach, newest first. */
export async function getOpenOutreach(userId: number): Promise<OutreachWithContext[]> {
  const result = await getPool().query<OutreachWithContext>(
    `${OUTREACH_CONTEXT_SELECT}
     WHERE o.user_id = $1 AND o.status IN ('draft', 'sent')
     ORDER BY o.id DESC`,
    [userId]
  );
  return result.rows;
}

/** All sent outreach across users — the inbox watcher matches replies against these. */
export async function getAllSentOutreach(): Promise<OutreachWithContext[]> {
  const result = await getPool().query<OutreachWithContext>(
    `${OUTREACH_CONTEXT_SELECT} WHERE o.status = 'sent' ORDER BY o.sent_at DESC`
  );
  return result.rows;
}

export async function updateOutreach(
  userId: number,
  id: number,
  patch: {
    subject?: string;
    body?: string;
    status?: OutreachStatus;
    smtp_message_id?: string | null;
    sent_at?: string | null;
    replied_at?: string | null;
    reply_snippet?: string | null;
  }
): Promise<Outreach | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  for (const key of [
    "subject",
    "body",
    "status",
    "smtp_message_id",
    "sent_at",
    "replied_at",
    "reply_snippet",
  ] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      params.push(patch[key]);
    }
  }
  if (sets.length === 0) {
    const result = await getPool().query<Outreach>(
      "SELECT * FROM outreach WHERE user_id = $1 AND id = $2",
      [userId, id]
    );
    return result.rows[0];
  }

  sets.push("updated_at = NOW()");
  params.push(userId, id);

  const result = await getPool().query<Outreach>(
    `UPDATE outreach SET ${sets.join(", ")} WHERE user_id = $${i} AND id = $${i + 1} RETURNING *`,
    params
  );
  return result.rows[0];
}

// --- Meeting notes ---

export async function getMeetingNotes(userId: number): Promise<MeetingNote[]> {
  const result = await getPool().query<MeetingNote>(
    `SELECT * FROM meeting_notes
     WHERE user_id = $1
     ORDER BY occurred_at DESC, id DESC`,
    [userId]
  );
  return result.rows;
}

export async function getMeetingNote(
  userId: number,
  id: number
): Promise<MeetingNote | undefined> {
  const result = await getPool().query<MeetingNote>(
    "SELECT * FROM meeting_notes WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return result.rows[0];
}

export async function addMeetingNote(
  userId: number,
  note: NewMeetingNote
): Promise<MeetingNote> {
  const ts = nowIso();
  const result = await getPool().query<MeetingNote>(
    `INSERT INTO meeting_notes
      (user_id, project_id, title, body, type, participants, occurred_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      userId,
      note.project_id ?? null,
      note.title,
      note.body,
      note.type ?? "call",
      note.participants ?? null,
      note.occurred_at ?? ts,
      ts,
      ts,
    ]
  );
  return result.rows[0];
}

export async function updateMeetingNote(
  userId: number,
  id: number,
  patch: MeetingNotePatch
): Promise<MeetingNote | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.title !== undefined) {
    sets.push(`title = $${i++}`);
    params.push(patch.title);
  }
  if (patch.body !== undefined) {
    sets.push(`body = $${i++}`);
    params.push(patch.body);
  }
  if (patch.type !== undefined) {
    sets.push(`type = $${i++}`);
    params.push(patch.type);
  }
  if (patch.participants !== undefined) {
    sets.push(`participants = $${i++}`);
    params.push(patch.participants);
  }
  if (patch.project_id !== undefined) {
    sets.push(`project_id = $${i++}`);
    params.push(patch.project_id);
  }
  if (patch.occurred_at !== undefined) {
    sets.push(`occurred_at = $${i++}`);
    params.push(patch.occurred_at);
  }

  if (sets.length === 0) return getMeetingNote(userId, id);

  sets.push("updated_at = NOW()");
  params.push(userId, id);

  const result = await getPool().query<MeetingNote>(
    `UPDATE meeting_notes SET ${sets.join(", ")}
     WHERE user_id = $${i} AND id = $${i + 1}
     RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function deleteMeetingNote(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM meeting_notes WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Demo seed for new users ---

async function seedUserDemoData(userId: number): Promise<void> {
  const ts = nowIso();
  const seeds: { idea: NewProject; tasks: string[] }[] = [
    {
      idea: {
        name: "Local business website service",
        notes: "Build simple sites for restaurants and shops in my area. Start with one pilot client.",
        status: "active",
      },
      tasks: [
        "List 10 businesses nearby with bad websites",
        "Draft a one-page service offer",
        "Reach out to 3 owners this week",
      ],
    },
    {
      idea: {
        name: "Dev tools newsletter",
        notes: "Weekly roundup of useful libraries and patterns for working developers.",
        status: "idea",
      },
      tasks: ["Pick a name and domain", "Outline the first 3 issues", "Set up a simple landing page"],
    },
    {
      idea: {
        name: "Automation scripts marketplace",
        notes: "Sell small Python/Node scripts that solve repetitive business tasks.",
        status: "idea",
      },
      tasks: ["Research what people already pay for on Gumroad", "List 5 script ideas I could ship fast"],
    },
  ];

  for (const { idea, tasks } of seeds) {
    const project = await addProject(userId, { ...idea, tasks });
    await getPool().query(
      "UPDATE projects SET last_progress_at = $1, updated_at = $1 WHERE id = $2",
      [ts, project.id]
    );
  }

  await getPool().query(
    "INSERT INTO goals (user_id, title, detail) VALUES ($1, $2, $3)",
    [
      userId,
      "Ship one paid thing this quarter",
      "Turn rough ideas into concrete tasks and finish something people will pay for.",
    ]
  );
}
