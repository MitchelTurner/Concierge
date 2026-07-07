/**
 * Web dashboard API — Express REST routes + static frontend.
 *
 * Public: signup, login, health check.
 * Protected (/api/*): projects, goals, settings, AI chat — all require
 * Authorization: Bearer <session token> from auth.ts.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRailway, type Config } from "./config.js";
import {
  AuthError,
  login,
  logout,
  resolveUserFromToken,
  signup,
  toPublicUser,
} from "./auth.js";
import {
  addGoal,
  addMeetingNote,
  addProject,
  addProjectTask,
  addProjectTasks,
  addContact,
  deleteContact,
  deleteGoal,
  deleteMeetingNote,
  deleteMemory,
  deleteProject,
  deleteProjectTask,
  generateLinkCode,
  getAllProjectsWithTasks,
  getDailyLog,
  getContacts,
  getGoal,
  getGoals,
  getMeetingNote,
  getMeetingNotes,
  getMemories,
  getOpenOutreach,
  getProject,
  getProjectTask,
  getProjectWithTasks,
  getUserById,
  setTelegramLinkCode,
  unlinkTelegram,
  updateContact,
  updateGoal,
  updateMeetingNote,
  updateProject,
  updateProjectTask,
  updateUserSettings,
  MEETING_NOTE_TYPES,
  PROJECT_TYPES,
  PROJECT_STATUSES,
  type MeetingNotePatch,
  type MeetingNoteType,
  type NewMeetingNote,
  type NewProject,
  type ProjectType,
  type ProjectPatch,
  type ProjectStatus,
} from "./db.js";
import {
  chat,
  isAiConfigured,
  liveMeetingAssist,
  suggestTasksForProject,
  suggestTasksFromMeetingNote,
  type ChatMessage,
} from "./ai.js";
import { isTranscriptionConfigured, transcribeAudio } from "./transcribe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UI_STATUSES: ProjectStatus[] = [...PROJECT_STATUSES];
const RATE_WINDOW_MS = 60_000;
const SESSION_COOKIE = "concierge_session";

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

function toNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function toProjectType(v: unknown): ProjectType | null {
  const value = String(v ?? "").trim() as ProjectType;
  return PROJECT_TYPES.includes(value) ? value : null;
}

function toScoreInt(field: string, v: unknown): { value: number } | { error: string } {
  const n = toInt(v);
  if (n === null || n < 1 || n > 5) {
    return { error: `${field} must be an integer from 1 to 5` };
  }
  return { value: n };
}

function toPositiveInt(field: string, v: unknown): { value: number } | { error: string } {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) {
    return { error: `${field} must be a number >= 1` };
  }
  return { value: Math.round(n) };
}

function toIsoDate(field: string, v: unknown): { value: string | null } | { error: string } {
  const value = toNullableString(v);
  if (!value) return { value: null };
  if (!ISO_DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    return { error: `${field} must be YYYY-MM-DD` };
  }
  return { value };
}

function parseCookie(req: Request, name: string): string | null {
  const header = req.header("cookie");
  if (!header) return null;
  const cookies = header.split(";");
  for (const cookie of cookies) {
    const [rawName, ...rest] = cookie.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

function setSessionCookie(res: Response, token: string): void {
  const secure = isRailway() || process.env.NODE_ENV === "production";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 30}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res: Response): void {
  const secure = isRailway() || process.env.NODE_ENV === "production";
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function rateLimit(max: number, windowMs: number, keyFn: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = keyFn(req);
    const current = rateBuckets.get(key);
    if (!current || current.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (current.count >= max) {
      res.status(429).json({ error: "Too many requests. Try again in a minute." });
      return;
    }
    current.count += 1;
    next();
  };
}

function validateNewProject(body: Record<string, unknown>): { value: NewProject } | { error: string } {
  const name = toNullableString(body.name);
  if (!name) return { error: "name is required" };

  const type = toProjectType(body.type ?? "fast");
  if (!type) return { error: `type must be one of ${PROJECT_TYPES.join(", ")}` };

  const status = String(body.status ?? "idea").trim() as ProjectStatus;
  if (!UI_STATUSES.includes(status)) {
    return { error: `status must be one of ${UI_STATUSES.join(", ")}` };
  }

  const revenue = toScoreInt("revenue_potential", body.revenue_potential ?? 3);
  if ("error" in revenue) return revenue;
  const confidence = toScoreInt("confidence", body.confidence ?? 3);
  if ("error" in confidence) return confidence;
  const timeToCash = toScoreInt("time_to_cash", body.time_to_cash ?? 3);
  if ("error" in timeToCash) return timeToCash;
  const effort = toPositiveInt("effort_remaining", body.effort_remaining ?? 8);
  if ("error" in effort) return effort;
  const deadline = toIsoDate("deadline", body.deadline);
  if ("error" in deadline) return deadline;

  const tasksRaw = body.tasks;
  const tasks: string[] = [];
  if (Array.isArray(tasksRaw)) {
    for (const t of tasksRaw) {
      const s = typeof t === "string" ? t.trim() : "";
      if (s) tasks.push(s);
    }
  }

  return {
    value: {
      name,
      type,
      client: toNullableString(body.client),
      revenue_potential: revenue.value,
      confidence: confidence.value,
      time_to_cash: timeToCash.value,
      effort_remaining: effort.value,
      notes: toNullableString(body.notes ?? body.description),
      status,
      next_action: toNullableString(body.next_action),
      deadline: deadline.value,
      tasks: tasks.length ? tasks : undefined,
    },
  };
}

function validateProjectPatch(body: Record<string, unknown>): { value: ProjectPatch } | { error: string } {
  const patch: ProjectPatch = {};

  if ("name" in body) {
    const name = toNullableString(body.name);
    if (!name) return { error: "name cannot be empty" };
    patch.name = name;
  }
  if ("type" in body) {
    const type = toProjectType(body.type);
    if (!type) return { error: `type must be one of ${PROJECT_TYPES.join(", ")}` };
    patch.type = type;
  }
  if ("client" in body) {
    patch.client = toNullableString(body.client);
  }
  if ("revenue_potential" in body) {
    const revenue = toScoreInt("revenue_potential", body.revenue_potential);
    if ("error" in revenue) return revenue;
    patch.revenue_potential = revenue.value;
  }
  if ("confidence" in body) {
    const confidence = toScoreInt("confidence", body.confidence);
    if ("error" in confidence) return confidence;
    patch.confidence = confidence.value;
  }
  if ("time_to_cash" in body) {
    const timeToCash = toScoreInt("time_to_cash", body.time_to_cash);
    if ("error" in timeToCash) return timeToCash;
    patch.time_to_cash = timeToCash.value;
  }
  if ("effort_remaining" in body) {
    const effort = toPositiveInt("effort_remaining", body.effort_remaining);
    if ("error" in effort) return effort;
    patch.effort_remaining = effort.value;
  }
  if ("notes" in body || "description" in body) {
    patch.notes = toNullableString(body.notes ?? body.description);
  }
  if ("status" in body) {
    const status = String(body.status ?? "").trim() as ProjectStatus;
    if (!UI_STATUSES.includes(status)) {
      return { error: `status must be one of ${UI_STATUSES.join(", ")}` };
    }
    patch.status = status;
  }
  if ("next_action" in body) {
    patch.next_action = toNullableString(body.next_action);
  }
  if ("deadline" in body) {
    const deadline = toIsoDate("deadline", body.deadline);
    if ("error" in deadline) return deadline;
    patch.deadline = deadline.value;
  }

  return { value: patch };
}

function validateNewMeetingNote(
  body: Record<string, unknown>
): { value: NewMeetingNote } | { error: string } {
  const title = toNullableString(body.title);
  const bodyText = body.body !== undefined ? String(body.body) : "";
  const type = String(body.type ?? "call").trim() as MeetingNoteType;
  if (!MEETING_NOTE_TYPES.includes(type)) {
    return { error: `type must be one of ${MEETING_NOTE_TYPES.join(", ")}` };
  }

  const projectIdRaw = body.project_id;
  let project_id: number | null = null;
  if (projectIdRaw !== undefined && projectIdRaw !== null && projectIdRaw !== "") {
    const n = toInt(projectIdRaw);
    if (n === null) return { error: "project_id must be an integer" };
    project_id = n;
  }

  const occurred_at = toNullableString(body.occurred_at);
  if (occurred_at && Number.isNaN(Date.parse(occurred_at))) {
    return { error: "occurred_at must be a valid ISO date" };
  }

  return {
    value: {
      title: title || (type === "call" ? "Phone call" : "Meeting"),
      body: bodyText,
      type,
      participants: toNullableString(body.participants),
      project_id,
      occurred_at: occurred_at ?? undefined,
    },
  };
}

function validateMeetingNotePatch(
  body: Record<string, unknown>
): { value: MeetingNotePatch } | { error: string } {
  const patch: MeetingNotePatch = {};

  if ("title" in body) {
    const title = toNullableString(body.title);
    if (!title) return { error: "title cannot be empty" };
    patch.title = title;
  }
  if ("body" in body) patch.body = String(body.body ?? "");
  if ("type" in body) {
    const type = String(body.type ?? "").trim() as MeetingNoteType;
    if (!MEETING_NOTE_TYPES.includes(type)) {
      return { error: `type must be one of ${MEETING_NOTE_TYPES.join(", ")}` };
    }
    patch.type = type;
  }
  if ("participants" in body) patch.participants = toNullableString(body.participants);
  if ("project_id" in body) {
    const raw = body.project_id;
    if (raw === null || raw === "") {
      patch.project_id = null;
    } else {
      const n = toInt(raw);
      if (n === null) return { error: "project_id must be an integer" };
      patch.project_id = n;
    }
  }
  if ("occurred_at" in body) {
    const occurred_at = toNullableString(body.occurred_at);
    if (!occurred_at || Number.isNaN(Date.parse(occurred_at))) {
      return { error: "occurred_at must be a valid ISO date" };
    }
    patch.occurred_at = occurred_at;
  }

  return { value: patch };
}

function parseId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? id : null;
}

function parsePositiveInt(v: unknown): number | null {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function bearerToken(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/** Build the Express app. Caller is responsible for listen(). */
export function createServer(config: Config): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // --- Public auth routes ---
  app.post("/api/auth/signup", rateLimit(10, RATE_WINDOW_MS, (req) => `signup:${req.ip}`), async (req, res) => {
    try {
      const body = req.body ?? {};
      const email = String(body.email ?? "").trim();
      const password = String(body.password ?? "");
      const name = toNullableString(body.name);
      const result = await signup(config, email, password, name);
      setSessionCookie(res, result.token);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof AuthError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.post("/api/auth/login", rateLimit(10, RATE_WINDOW_MS, (req) => `login:${req.ip}`), async (req, res) => {
    try {
      const body = req.body ?? {};
      const email = String(body.email ?? "").trim();
      const password = String(body.password ?? "");
      const result = await login(email, password);
      setSessionCookie(res, result.token);
      res.json(result);
    } catch (err) {
      if (err instanceof AuthError) return res.status(401).json({ error: err.message });
      throw err;
    }
  });

  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const bearer = bearerToken(req);
    const cookieToken = parseCookie(req, SESSION_COOKIE);
    const token = bearer ?? cookieToken;
    if (!token) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await resolveUserFromToken(token);
    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (bearer && !cookieToken) {
      setSessionCookie(res, bearer);
    }
    req.userId = user.id;
    next();
  };

  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    const token = bearerToken(req) ?? parseCookie(req, SESSION_COOKIE);
    if (token) await logout(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    const user = await getUserById(req.userId!);
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json(toPublicUser(user));
  });

  app.patch("/api/auth/me", requireAuth, async (req, res) => {
    const body = req.body ?? {};
    const patch: Parameters<typeof updateUserSettings>[1] = {};

    if ("name" in body) patch.name = toNullableString(body.name);
    if ("daily_time" in body) {
      const t = String(body.daily_time).trim();
      if (!TIME_RE.test(t)) return res.status(400).json({ error: "daily_time must be HH:MM" });
      patch.daily_time = t;
    }
    if ("checkin_time" in body) {
      const t = String(body.checkin_time).trim();
      if (!TIME_RE.test(t)) return res.status(400).json({ error: "checkin_time must be HH:MM" });
      patch.checkin_time = t;
    }
    if ("timezone" in body) {
      const tz = String(body.timezone).trim();
      if (!tz) return res.status(400).json({ error: "timezone is required" });
      patch.timezone = tz;
    }
    if ("stall_days" in body) {
      const n = toInt(body.stall_days);
      if (n === null || n < 1) return res.status(400).json({ error: "stall_days must be >= 1" });
      patch.stall_days = n;
    }
    if ("weekly_review_day" in body) {
      const n = toInt(body.weekly_review_day);
      if (n === null || n < 0 || n > 6) {
        return res.status(400).json({ error: "weekly_review_day must be 0 (Sunday) to 6 (Saturday)" });
      }
      patch.weekly_review_day = n;
    }
    if ("weekly_review_time" in body) {
      const t = String(body.weekly_review_time).trim();
      if (!TIME_RE.test(t)) return res.status(400).json({ error: "weekly_review_time must be HH:MM" });
      patch.weekly_review_time = t;
    }
    if ("calendar_ics_url" in body) {
      const url = toNullableString(body.calendar_ics_url);
      if (url !== null && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: "calendar_ics_url must be an http(s) URL or empty" });
      }
      patch.calendar_ics_url = url;
    }

    const updated = await updateUserSettings(req.userId!, patch);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(toPublicUser(updated));
  });

  app.post("/api/auth/telegram-link", requireAuth, async (req, res) => {
    const code = generateLinkCode();
    await setTelegramLinkCode(req.userId!, code);
    res.json({ code, instructions: `Send /link ${code} to your Telegram bot.` });
  });

  app.delete("/api/auth/telegram", requireAuth, async (req, res) => {
    await unlinkTelegram(req.userId!);
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(requireAuth);

  // --- Projects (ideas) ---
  api.get("/projects", async (req, res) => {
    res.json(await getAllProjectsWithTasks(req.userId!));
  });

  api.get("/projects/:id", async (req, res) => {
    const id = parseId(req);
    const project = id !== null ? await getProjectWithTasks(req.userId!, id) : undefined;
    if (!project) return res.status(404).json({ error: "Not found" });
    res.json(project);
  });

  api.post("/projects", async (req, res) => {
    const result = validateNewProject(req.body ?? {});
    if ("error" in result) return res.status(400).json({ error: result.error });
    const project = await addProject(req.userId!, result.value);
    const withTasks = await getProjectWithTasks(req.userId!, project.id);
    res.status(201).json(withTasks);
  });

  api.patch("/projects/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await getProject(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    const result = validateProjectPatch(req.body ?? {});
    if ("error" in result) return res.status(400).json({ error: result.error });
    await updateProject(req.userId!, id, result.value);
    res.json(await getProjectWithTasks(req.userId!, id));
  });

  api.delete("/projects/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await deleteProject(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  api.post("/projects/:id/tasks", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await getProject(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    const body = req.body ?? {};
    const titlesRaw = body.titles;
    if (Array.isArray(titlesRaw)) {
      const titles = titlesRaw
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean);
      if (titles.length === 0) return res.status(400).json({ error: "titles must be a non-empty array" });
      const added = await addProjectTasks(req.userId!, id, titles);
      return res.status(201).json({ tasks: added, project: await getProjectWithTasks(req.userId!, id) });
    }
    const title = toNullableString(body.title);
    if (!title) return res.status(400).json({ error: "title or titles is required" });
    const task = await addProjectTask(req.userId!, id, title);
    res.status(201).json(task);
  });

  api.patch("/tasks/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await getProjectTask(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    const body = req.body ?? {};
    const patch: { title?: string; done?: boolean; sort_order?: number } = {};
    if ("title" in body) {
      const title = toNullableString(body.title);
      if (!title) return res.status(400).json({ error: "title cannot be empty" });
      patch.title = title;
    }
    if ("done" in body) patch.done = Boolean(body.done);
    if ("sort_order" in body) {
      const order = Number(body.sort_order);
      if (!Number.isInteger(order) || order < 0) {
        return res.status(400).json({ error: "sort_order must be a non-negative integer" });
      }
      patch.sort_order = order;
    }
    res.json(await updateProjectTask(req.userId!, id, patch));
  });

  api.delete("/tasks/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await deleteProjectTask(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  api.post("/projects/:id/suggest-tasks", async (req, res) => {
    if (!isAiConfigured(config)) {
      return res.status(501).json({
        error: "AI not configured. Set ANTHROPIC_API_KEY to enable task suggestions.",
      });
    }
    const id = parseId(req);
    if (id === null || !(await getProject(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const suggestions = await suggestTasksForProject(config, req.userId!, id);
      const add = Boolean((req.body ?? {}).add);
      if (add) {
        const added = [];
        for (const title of suggestions) {
          added.push(await addProjectTask(req.userId!, id, title));
        }
        return res.json({ suggestions, added, project: await getProjectWithTasks(req.userId!, id) });
      }
      res.json({ suggestions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: msg });
    }
  });

  // --- Goals ---
  api.get("/goals", async (req, res) => {
    res.json(await getGoals(req.userId!));
  });

  api.post("/goals", async (req, res) => {
    const title = toNullableString((req.body ?? {}).title);
    if (!title) return res.status(400).json({ error: "title is required" });
    const detail = toNullableString((req.body ?? {}).detail);
    res.status(201).json(await addGoal(req.userId!, title, detail));
  });

  api.patch("/goals/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await getGoal(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    const body = req.body ?? {};
    const patch: { title?: string; detail?: string | null } = {};
    if ("title" in body) {
      const title = toNullableString(body.title);
      if (!title) return res.status(400).json({ error: "title cannot be empty" });
      patch.title = title;
    }
    if ("detail" in body) patch.detail = toNullableString(body.detail);
    res.json(await updateGoal(req.userId!, id, patch));
  });

  api.delete("/goals/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await deleteGoal(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  // --- Contacts ---

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  api.get("/contacts", async (req, res) => {
    res.json(await getContacts(req.userId!));
  });

  api.post("/contacts", async (req, res) => {
    const body = req.body ?? {};
    const name = toNullableString(body.name);
    const email = toNullableString(body.email);
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "a valid email is required" });
    }
    const projectId = body.project_id === null || body.project_id === undefined || body.project_id === ""
      ? null
      : toInt(body.project_id);
    if (projectId !== null && !(await getProject(req.userId!, projectId))) {
      return res.status(400).json({ error: `no project #${projectId}` });
    }
    res.status(201).json(
      await addContact(req.userId!, {
        name,
        email,
        project_id: projectId,
        role: toNullableString(body.role),
        notes: toNullableString(body.notes),
      })
    );
  });

  api.patch("/contacts/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null) return res.status(404).json({ error: "Not found" });
    const body = req.body ?? {};
    const patch: Parameters<typeof updateContact>[2] = {};

    if ("name" in body) {
      const name = toNullableString(body.name);
      if (!name) return res.status(400).json({ error: "name cannot be empty" });
      patch.name = name;
    }
    if ("email" in body) {
      const email = toNullableString(body.email);
      if (!email || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "a valid email is required" });
      }
      patch.email = email;
    }
    if ("project_id" in body) {
      const projectId = body.project_id === null || body.project_id === "" ? null : toInt(body.project_id);
      if (projectId !== null && !(await getProject(req.userId!, projectId))) {
        return res.status(400).json({ error: `no project #${projectId}` });
      }
      patch.project_id = projectId;
    }
    if ("role" in body) patch.role = toNullableString(body.role);
    if ("notes" in body) patch.notes = toNullableString(body.notes);

    const updated = await updateContact(req.userId!, id, patch);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  api.delete("/contacts/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await deleteContact(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  // --- Outreach (read-only here; drafting/sending happens in Telegram) ---

  api.get("/outreach", async (req, res) => {
    res.json(await getOpenOutreach(req.userId!));
  });

  // --- Assistant memory ---

  api.get("/memories", async (req, res) => {
    res.json(await getMemories(req.userId!));
  });

  api.delete("/memories/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await deleteMemory(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  // --- Meeting notes (calls & meetings) ---
  api.get("/meeting-notes", async (req, res) => {
    res.json(await getMeetingNotes(req.userId!));
  });

  api.post("/meeting-notes", async (req, res) => {
    const result = validateNewMeetingNote(req.body ?? {});
    if ("error" in result) return res.status(400).json({ error: result.error });

    if (result.value.project_id != null) {
      const project = await getProject(req.userId!, result.value.project_id);
      if (!project) return res.status(400).json({ error: "project not found" });
    }

    res.status(201).json(await addMeetingNote(req.userId!, result.value));
  });

  api.patch("/meeting-notes/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await getMeetingNote(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }

    const result = validateMeetingNotePatch(req.body ?? {});
    if ("error" in result) return res.status(400).json({ error: result.error });

    if (result.value.project_id != null) {
      const project = await getProject(req.userId!, result.value.project_id);
      if (!project) return res.status(400).json({ error: "project not found" });
    }

    res.json(await updateMeetingNote(req.userId!, id, result.value));
  });

  api.delete("/meeting-notes/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await deleteMeetingNote(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  api.post("/meeting-notes/:id/extract-tasks", async (req, res) => {
    if (!isAiConfigured(config)) {
      return res.status(501).json({
        error: "AI not configured. Set ANTHROPIC_API_KEY to enable task extraction.",
      });
    }
    const id = parseId(req);
    const note = id === null ? undefined : await getMeetingNote(req.userId!, id);
    if (!note) return res.status(404).json({ error: "Not found" });
    if (!note.body.trim()) return res.status(400).json({ error: "note has no body to extract from" });

    const projectId = note.project_id ?? parsePositiveInt((req.body ?? {}).project_id);
    if (projectId === null) {
      return res.status(400).json({ error: "link this note to an idea first, or pass project_id" });
    }
    if (!(await getProject(req.userId!, projectId))) {
      return res.status(400).json({ error: "project not found" });
    }

    try {
      const suggestions = await suggestTasksFromMeetingNote(config, req.userId!, note);
      const add = Boolean((req.body ?? {}).add);
      if (add) {
        const added = await addProjectTasks(req.userId!, projectId, suggestions);
        return res.json({
          suggestions,
          added,
          project: await getProjectWithTasks(req.userId!, projectId),
        });
      }
      res.json({ suggestions, project_id: projectId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: msg });
    }
  });

  // --- Live recording: transcription + real-time assist ---

  // Whether the record feature's two halves are available.
  api.get("/notes/record-status", (_req, res) => {
    res.json({
      transcription: isTranscriptionConfigured(config),
      assist: isAiConfigured(config),
    });
  });

  // Transcribe one audio segment. Body is the raw audio bytes (any codec the
  // browser's MediaRecorder produced); content-type carries the mime type.
  api.post(
    "/transcribe",
    express.raw({ type: () => true, limit: "25mb" }),
    async (req, res) => {
      if (!isTranscriptionConfigured(config)) {
        return res.status(501).json({
          error: "Transcription not configured. Set OPENAI_API_KEY to enable recording.",
        });
      }
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res.status(400).json({ error: "empty audio body" });
      }
      const mimeType = (req.header("content-type") || "audio/webm").split(";")[0].trim();
      const headerName = req.header("x-filename");
      const filename = headerName && /^[\w.\- ]{1,80}$/.test(headerName) ? headerName : "segment.webm";
      try {
        const arrayBuffer = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer;
        const text = await transcribeAudio(config, arrayBuffer, filename, mimeType);
        res.json({ text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: msg });
      }
    }
  );

  // Given the running transcript, return live notes + questions to ask next.
  api.post(
    "/meeting-notes/live-assist",
    rateLimit(40, RATE_WINDOW_MS, (req) => `live-assist:${req.userId ?? req.ip}`),
    async (req, res) => {
      if (!isAiConfigured(config)) {
        return res.status(501).json({
          error: "AI not configured. Set ANTHROPIC_API_KEY to enable live notes and questions.",
        });
      }
      const body = req.body ?? {};
      const transcript = typeof body.transcript === "string" ? body.transcript : "";
      if (!transcript.trim()) return res.json({ notes: [], questions: [] });

      let projectId: number | null = null;
      if (body.project_id !== undefined && body.project_id !== null && body.project_id !== "") {
        const n = toInt(body.project_id);
        if (n === null) return res.status(400).json({ error: "project_id must be an integer" });
        if (!(await getProject(req.userId!, n))) {
          return res.status(400).json({ error: "project not found" });
        }
        projectId = n;
      }

      try {
        const result = await liveMeetingAssist(config, req.userId!, transcript, projectId);
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: msg });
      }
    }
  );

  // --- Daily progress log ---
  api.get("/daily-log", async (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    res.json(await getDailyLog(req.userId!, limit));
  });

  // --- AI chat agent ---
  api.get("/chat/status", (_req, res) => {
    res.json({ enabled: isAiConfigured(config), model: config.anthropicModel });
  });

  api.post(
    "/chat",
    rateLimit(20, RATE_WINDOW_MS, (req) => `chat:${req.userId ?? req.ip}`),
    async (req, res) => {
    if (!isAiConfigured(config)) {
      return res.status(501).json({
        error: "AI agent not configured. Set ANTHROPIC_API_KEY to enable it.",
      });
    }
    const raw = (req.body ?? {}).messages;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ error: "messages must be a non-empty array" });
    }
    const messages: ChatMessage[] = [];
    for (const m of raw) {
      const role = (m && m.role) === "assistant" ? "assistant" : "user";
      const content = typeof (m && m.content) === "string" ? m.content.trim() : "";
      if (content) messages.push({ role, content });
    }
    if (messages.length === 0) {
      return res.status(400).json({ error: "no valid messages" });
    }
    try {
      const result = await chat(config, req.userId!, messages, {
        allowWrite: Boolean((req.body ?? {}).allow_write),
      });
      res.json({ reply: result.reply, actions: result.actions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ai] chat failed:", msg);
      res.status(502).json({ error: `AI request failed: ${msg}` });
    }
    }
  );

  app.use("/api", api);
  app.use(express.static(PUBLIC_DIR));

  return app;
}

/** Start the web dashboard listening on config.port. */
export function startServer(config: Config): void {
  const app = createServer(config);
  app.listen(config.port, () => {
    console.log(`[web] dashboard listening on port ${config.port}`);
  });
}
