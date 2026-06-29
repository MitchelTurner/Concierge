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
  last_daily_nudge_date: string | null;
  last_checkin_nudge_date: string | null;
  created_at: string;
  updated_at: string;
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

/** A note captured after a phone call, optionally linked to an idea. */
export interface CallNote {
  id: number;
  user_id: number;
  project_id: number | null;
  contact_name: string | null;
  note: string;
  called_at: string;
  created_at: string;
}

export interface CallNoteWithProject extends CallNote {
  project_name: string | null;
}

export interface NewCallNote {
  contact_name?: string | null;
  note: string;
  project_id?: number | null;
  called_at?: string;
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
  /** Idea description — what you're exploring or building toward. */
  notes?: string | null;
  status?: ProjectStatus;
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
  last_daily_nudge_date DATE,
  last_checkin_nudge_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS call_notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  contact_name TEXT,
  note TEXT NOT NULL,
  called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_notes_user_id ON call_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_call_notes_project_id ON call_notes(project_id);
`;

function getPool(): pg.Pool {
  if (!pool) throw new Error("Database not initialized — call initDb() first.");
  return pool;
}

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
      "fast",
      null,
      3,
      3,
      3,
      8,
      p.status ?? "idea",
      null,
      null,
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

export async function setNextAction(
  userId: number,
  id: number,
  nextAction: string
): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET next_action = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3",
    [nextAction, userId, id]
  );
  return (result.rowCount ?? 0) > 0;
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

export async function clearNextAction(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET next_action = NULL, updated_at = NOW() WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
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
  await getPool().query("UPDATE projects SET updated_at = NOW() WHERE user_id = $1 AND id = $2", [
    userId,
    projectId,
  ]);
  return result.rows[0];
}

export async function updateProjectTask(
  userId: number,
  taskId: number,
  patch: { title?: string; done?: boolean }
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

// --- Call notes ---

export async function getCallNotes(userId: number, limit = 100): Promise<CallNoteWithProject[]> {
  const result = await getPool().query<CallNoteWithProject>(
    `SELECT cn.*, p.name AS project_name
     FROM call_notes cn
     LEFT JOIN projects p ON p.id = cn.project_id AND p.user_id = cn.user_id
     WHERE cn.user_id = $1
     ORDER BY cn.called_at DESC, cn.id DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

export async function getCallNote(userId: number, id: number): Promise<CallNote | undefined> {
  const result = await getPool().query<CallNote>(
    "SELECT * FROM call_notes WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return result.rows[0];
}

export async function addCallNote(userId: number, input: NewCallNote): Promise<CallNoteWithProject> {
  const calledAt = input.called_at ?? nowIso();
  const result = await getPool().query<CallNote>(
    `INSERT INTO call_notes (user_id, project_id, contact_name, note, called_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, input.project_id ?? null, input.contact_name?.trim() || null, input.note.trim(), calledAt]
  );
  const note = result.rows[0];
  if (input.project_id) {
    await stampProgress(userId, input.project_id);
  }
  let projectName: string | null = null;
  if (note.project_id) {
    const project = await getProject(userId, note.project_id);
    projectName = project?.name ?? null;
  }
  return { ...note, project_name: projectName };
}

export async function deleteCallNote(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM call_notes WHERE user_id = $1 AND id = $2",
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
