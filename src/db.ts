import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, DB_USES_RAILWAY_DEFAULT, isRailway, shouldSeedDemoData } from "./config.js";

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

export interface Project {
  id: number;
  name: string;
  type: ProjectType;
  client: string | null;
  revenue_potential: number; // 1-5
  confidence: number; // 1-5
  time_to_cash: number; // 1-5 (1 = paid within days)
  effort_remaining: number; // estimated hours left
  status: ProjectStatus;
  next_action: string | null;
  deadline: string | null; // ISO date
  notes: string | null;
  last_progress_at: string | null; // ISO datetime of most recent progress
  created_at: string; // ISO datetime
  updated_at: string; // ISO datetime
}

/** A row in the daily_log table (evening check-ins + /progress notes). */
export interface DailyLogEntry {
  id: number;
  date: string; // ISO date (YYYY-MM-DD)
  note: string;
  created_at: string; // ISO datetime
}

/** A high-level goal that frames why the projects matter. */
export interface Goal {
  id: number;
  title: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

/** Project columns that may be edited from the dashboard. */
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

/** Fields a caller may provide when inserting a new project. */
export interface NewProject {
  name: string;
  type: ProjectType;
  client?: string | null;
  revenue_potential: number;
  confidence: number;
  time_to_cash: number;
  effort_remaining: number;
  status?: ProjectStatus;
  next_action?: string | null;
  deadline?: string | null;
  notes?: string | null;
}

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  deadline TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const DAILY_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const GOALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const INITIAL_SEED_KEY = "initial_seed_done";

function nowIso(): string {
  return new Date().toISOString();
}

/** ISO date (YYYY-MM-DD) `days` from today, useful for seed deadlines. */
function isoDateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Open (and lazily create) the database, ensure schema exists, and seed demo
 * rows exactly once on a brand-new database. Safe to call multiple times.
 */
export function initDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const dbExisted = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  db.exec(DAILY_LOG_SCHEMA);
  db.exec(GOALS_SCHEMA);
  db.exec(META_SCHEMA);
  migrate(db);

  seedOnFirstRun(db);

  const { projectCount, goalCount } = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM projects) AS projectCount,
        (SELECT COUNT(*) FROM goals) AS goalCount`
    )
    .get() as { projectCount: number; goalCount: number };

  console.log(`[db] using ${DB_PATH}${dbExisted ? "" : " (new file)"}`);
  console.log(`[db] loaded ${projectCount} project(s), ${goalCount} goal(s)`);

  if (isRailway()) {
    const onVolume = path.dirname(DB_PATH).startsWith("/data");
    if (!onVolume) {
      console.error(
        `[db] DATABASE_PATH="${DB_PATH}" is not on /data — on Railway your database ` +
          `must live on a persistent volume (e.g. /data/operator.db) or data is ` +
          `wiped on every deploy.`
      );
    } else if (!dbExisted) {
      console.error(
        "[db] New database file on Railway. If this happens after every deploy, " +
          "attach a persistent volume mounted at /data and set DATABASE_PATH=/data/operator.db."
      );
    }
  }

  if (DB_USES_RAILWAY_DEFAULT) {
    console.log(
      "[db] Railway detected — database defaults to /data/operator.db. " +
        "Attach a persistent volume mounted at /data or set DATABASE_PATH."
    );
  }

  // Ensure every project has a progress timestamp:
  // rows (migration) and freshly seeded rows to their created_at. Non-
  // destructive — only touches rows that are still NULL.
  db.exec(
    "UPDATE projects SET last_progress_at = created_at WHERE last_progress_at IS NULL"
  );

  return db;
}

/** True if `table` already has a column named `column`. */
function hasColumn(
  database: Database.Database,
  table: string,
  column: string
): boolean {
  const cols = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * Non-destructive schema migrations. Adds columns guarded by an existing-column
 * check so re-running never errors and existing data is never dropped.
 */
function migrate(database: Database.Database): void {
  if (!hasColumn(database, "projects", "last_progress_at")) {
    database.exec("ALTER TABLE projects ADD COLUMN last_progress_at TEXT");
  }
}

function getDb(): Database.Database {
  if (!db) return initDb();
  return db;
}

function hasMeta(database: Database.Database, key: string): boolean {
  const row = database
    .prepare("SELECT 1 FROM app_meta WHERE key = ?")
    .get(key);
  return row !== undefined;
}

function setMeta(database: Database.Database, key: string, value: string): void {
  database
    .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
    .run(key, value);
}

/**
 * Insert demo rows exactly once on a brand-new database. Never re-runs when
 * tables are later emptied — deleting all goals must not resurrect the seed.
 */
function seedOnFirstRun(database: Database.Database): void {
  if (hasMeta(database, INITIAL_SEED_KEY)) return;

  const { projectCount, goalCount } = database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM projects) AS projectCount,
        (SELECT COUNT(*) FROM goals) AS goalCount`
    )
    .get() as { projectCount: number; goalCount: number };

  // Fresh install only — never re-seed because a table was later emptied.
  if (projectCount === 0 && goalCount === 0 && shouldSeedDemoData()) {
    seedProjects(database);
    seedGoals(database);
    console.log("[db] inserted demo projects/goals (local onboarding)");
  } else if (projectCount === 0 && goalCount === 0 && isRailway()) {
    console.log(
      "[db] empty database — demo seed skipped on Railway. " +
        "Set SEED_DEMO_DATA=true only if you want sample rows."
    );
  }

  // Mark seeded for existing databases too so upgrades don't insert demo rows.
  setMeta(database, INITIAL_SEED_KEY, nowIso());
}

function seedProjects(database: Database.Database): void {
  const seeds: NewProject[] = [
    {
      name: "Joe's Pizza website",
      type: "fast",
      client: "Joe's Pizza",
      revenue_potential: 3,
      confidence: 5,
      time_to_cash: 1,
      effort_remaining: 6,
      status: "active",
      next_action: "Send the final invoice and deploy the menu page",
      deadline: isoDateInDays(2),
      notes: "Almost done — just the menu page and payment link left.",
    },
    {
      name: "Dental clinic booking tool",
      type: "fast",
      client: "BrightSmile Dental",
      revenue_potential: 5,
      confidence: 3,
      time_to_cash: 3,
      effort_remaining: 20,
      status: "active",
      next_action: "Scope the booking flow and send a fixed-price quote",
      deadline: null,
      notes: "Bigger contract, still needs a signed quote.",
    },
    {
      name: "Niche affiliate blog",
      type: "passive",
      client: null,
      revenue_potential: 4,
      confidence: 2,
      time_to_cash: 5,
      effort_remaining: 40,
      status: "active",
      next_action: "Write one 1500-word review post targeting a buyer keyword",
      deadline: null,
      notes: "Compounds slowly. Only touch with leftover time.",
    },
    {
      name: "VS Code productivity extension",
      type: "passive",
      client: null,
      revenue_potential: 3,
      confidence: 2,
      time_to_cash: 4,
      effort_remaining: 25,
      status: "active",
      next_action: "Ship a v0.1 with the single most-requested feature",
      deadline: null,
      notes: "Own product. Long game.",
    },
  ];

  const insert = database.prepare(
    `INSERT INTO projects
      (name, type, client, revenue_potential, confidence, time_to_cash,
       effort_remaining, status, next_action, deadline, notes, created_at, updated_at)
     VALUES
      (@name, @type, @client, @revenue_potential, @confidence, @time_to_cash,
       @effort_remaining, @status, @next_action, @deadline, @notes, @created_at, @updated_at)`
  );

  const ts = nowIso();
  const insertMany = database.transaction((rows: NewProject[]) => {
    for (const row of rows) {
      insert.run({
        name: row.name,
        type: row.type,
        client: row.client ?? null,
        revenue_potential: row.revenue_potential,
        confidence: row.confidence,
        time_to_cash: row.time_to_cash,
        effort_remaining: row.effort_remaining,
        status: row.status ?? "idea",
        next_action: row.next_action ?? null,
        deadline: row.deadline ?? null,
        notes: row.notes ?? null,
        created_at: ts,
        updated_at: ts,
      });
    }
  });

  insertMany(seeds);
}

function seedGoals(database: Database.Database): void {
  const ts = nowIso();
  database
    .prepare(
      "INSERT INTO goals (title, detail, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .run(
      "Go full-time as a dev as fast as possible",
      "Combine fast client income with passive products. Prioritize cash now; let passive compound.",
      ts,
      ts
    );
}

export function getActiveProjects(): Project[] {
  return getDb()
    .prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY id")
    .all() as Project[];
}

export function getAllProjects(): Project[] {
  return getDb()
    .prepare("SELECT * FROM projects ORDER BY id")
    .all() as Project[];
}

export function getProject(id: number): Project | undefined {
  return getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as Project | undefined;
}

export function addProject(p: NewProject): Project {
  const ts = nowIso();
  const result = getDb()
    .prepare(
      `INSERT INTO projects
        (name, type, client, revenue_potential, confidence, time_to_cash,
         effort_remaining, status, next_action, deadline, notes,
         last_progress_at, created_at, updated_at)
       VALUES
        (@name, @type, @client, @revenue_potential, @confidence, @time_to_cash,
         @effort_remaining, @status, @next_action, @deadline, @notes,
         @last_progress_at, @created_at, @updated_at)`
    )
    .run({
      name: p.name,
      type: p.type,
      client: p.client ?? null,
      revenue_potential: p.revenue_potential,
      confidence: p.confidence,
      time_to_cash: p.time_to_cash,
      effort_remaining: p.effort_remaining,
      status: p.status ?? "active",
      next_action: p.next_action ?? null,
      deadline: p.deadline ?? null,
      notes: p.notes ?? null,
      last_progress_at: ts,
      created_at: ts,
      updated_at: ts,
    });
  return getProject(Number(result.lastInsertRowid))!;
}

export function setNextAction(id: number, nextAction: string): boolean {
  const result = getDb()
    .prepare(
      "UPDATE projects SET next_action = ?, updated_at = ? WHERE id = ?"
    )
    .run(nextAction, nowIso(), id);
  return result.changes > 0;
}

export function setStatus(id: number, status: ProjectStatus): boolean {
  const result = getDb()
    .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, nowIso(), id);
  return result.changes > 0;
}

/** Stamp a project as having made progress right now (resets its stall clock). */
export function stampProgress(id: number): boolean {
  const ts = nowIso();
  const result = getDb()
    .prepare(
      "UPDATE projects SET last_progress_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(ts, ts, id);
  return result.changes > 0;
}

/** Append a free-text entry to the daily log (check-ins, /progress notes). */
export function addDailyLog(note: string): DailyLogEntry {
  const ts = nowIso();
  const result = getDb()
    .prepare(
      "INSERT INTO daily_log (date, note, created_at) VALUES (?, ?, ?)"
    )
    .run(ts.slice(0, 10), note, ts);
  return getDb()
    .prepare("SELECT * FROM daily_log WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as DailyLogEntry;
}

/**
 * Active projects that are stalling: no progress ever, or last progress older
 * than `stallDays` days. Sorted most-stalled first (never-progressed first).
 */
export function getStalledProjects(stallDays: number): Project[] {
  const cutoff = Date.now() - stallDays * 86_400_000;
  return getActiveProjects()
    .filter((p) => {
      if (!p.last_progress_at) return true;
      const t = new Date(p.last_progress_at).getTime();
      return Number.isNaN(t) || t < cutoff;
    })
    .sort((a, b) => {
      const ta = a.last_progress_at
        ? new Date(a.last_progress_at).getTime()
        : -Infinity;
      const tb = b.last_progress_at
        ? new Date(b.last_progress_at).getTime()
        : -Infinity;
      return ta - tb;
    });
}

/** Clear the current next_action (e.g. when it has been completed). */
export function clearNextAction(id: number): boolean {
  const result = getDb()
    .prepare("UPDATE projects SET next_action = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), id);
  return result.changes > 0;
}

/**
 * Apply a partial update to a project. Only whitelisted columns are written.
 * Returns the updated project, or undefined if the id doesn't exist.
 */
export function updateProject(id: number, patch: ProjectPatch): Project | undefined {
  const keys = (Object.keys(patch) as ProjectEditableColumn[]).filter((k) =>
    PROJECT_EDITABLE_COLUMNS.includes(k)
  );
  if (keys.length === 0) return getProject(id);

  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  const params: Record<string, unknown> = { id, updated_at: nowIso() };
  for (const k of keys) {
    params[k] = patch[k] ?? null;
  }

  const result = getDb()
    .prepare(
      `UPDATE projects SET ${setClause}, updated_at = @updated_at WHERE id = @id`
    )
    .run(params);
  return result.changes > 0 ? getProject(id) : undefined;
}

export function deleteProject(id: number): boolean {
  const result = getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getGoals(): Goal[] {
  return getDb()
    .prepare("SELECT * FROM goals ORDER BY id")
    .all() as Goal[];
}

export function getGoal(id: number): Goal | undefined {
  return getDb()
    .prepare("SELECT * FROM goals WHERE id = ?")
    .get(id) as Goal | undefined;
}

export function addGoal(title: string, detail: string | null = null): Goal {
  const ts = nowIso();
  const result = getDb()
    .prepare(
      "INSERT INTO goals (title, detail, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .run(title, detail, ts, ts);
  return getGoal(Number(result.lastInsertRowid))!;
}

export function updateGoal(
  id: number,
  patch: { title?: string; detail?: string | null }
): Goal | undefined {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: nowIso() };
  if (patch.title !== undefined) {
    sets.push("title = @title");
    params.title = patch.title;
  }
  if (patch.detail !== undefined) {
    sets.push("detail = @detail");
    params.detail = patch.detail ?? null;
  }
  if (sets.length === 0) return getGoal(id);

  const result = getDb()
    .prepare(
      `UPDATE goals SET ${sets.join(", ")}, updated_at = @updated_at WHERE id = @id`
    )
    .run(params);
  return result.changes > 0 ? getGoal(id) : undefined;
}

export function deleteGoal(id: number): boolean {
  const result = getDb().prepare("DELETE FROM goals WHERE id = ?").run(id);
  return result.changes > 0;
}

/** For tests/scripts: close the underlying handle and flush WAL to disk. */
export function closeDb(): void {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort flush before exit.
    }
    db.close();
    db = null;
  }
}
