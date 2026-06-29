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
import type { Config } from "./config.js";
import {
  AuthError,
  login,
  logout,
  resolveUserFromToken,
  signup,
  toPublicUser,
} from "./auth.js";
import {
  addCallNote,
  addGoal,
  addProject,
  addProjectTask,
  deleteCallNote,
  deleteGoal,
  deleteProject,
  deleteProjectTask,
  generateLinkCode,
  getAllProjectsWithTasks,
  getCallNotes,
  getGoal,
  getGoals,
  getProject,
  getProjectTask,
  getProjectWithTasks,
  getUserById,
  setTelegramLinkCode,
  unlinkTelegram,
  updateGoal,
  updateProject,
  updateProjectTask,
  updateUserSettings,
  type NewCallNote,
  type NewProject,
  type ProjectPatch,
  type ProjectStatus,
} from "./db.js";
import { chat, isAiConfigured, suggestTasksForProject, type ChatMessage } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const UI_STATUSES: ProjectStatus[] = ["idea", "active", "blocked", "shipped", "archived"];

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

function validateNewProject(body: Record<string, unknown>): { value: NewProject } | { error: string } {
  const name = toNullableString(body.name);
  if (!name) return { error: "name is required" };

  const status = String(body.status ?? "idea").trim() as ProjectStatus;
  if (!UI_STATUSES.includes(status)) {
    return { error: `status must be one of ${UI_STATUSES.join(", ")}` };
  }

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
      notes: toNullableString(body.notes ?? body.description),
      status,
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

  return { value: patch };
}

function parseId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? id : null;
}

function bearerToken(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/** Build the Express app. Caller is responsible for listen(). */
export function createServer(config: Config): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // --- Public auth routes ---
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const body = req.body ?? {};
      const email = String(body.email ?? "").trim();
      const password = String(body.password ?? "");
      const name = toNullableString(body.name);
      const result = await signup(config, email, password, name);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof AuthError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const body = req.body ?? {};
      const email = String(body.email ?? "").trim();
      const password = String(body.password ?? "");
      const result = await login(email, password);
      res.json(result);
    } catch (err) {
      if (err instanceof AuthError) return res.status(401).json({ error: err.message });
      throw err;
    }
  });

  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await resolveUserFromToken(token);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.userId = user.id;
    next();
  };

  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    const token = bearerToken(req);
    if (token) await logout(token);
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
    const title = toNullableString((req.body ?? {}).title);
    if (!title) return res.status(400).json({ error: "title is required" });
    const task = await addProjectTask(req.userId!, id, title);
    res.status(201).json(task);
  });

  api.patch("/tasks/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await getProjectTask(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    const body = req.body ?? {};
    const patch: { title?: string; done?: boolean } = {};
    if ("title" in body) {
      const title = toNullableString(body.title);
      if (!title) return res.status(400).json({ error: "title cannot be empty" });
      patch.title = title;
    }
    if ("done" in body) patch.done = Boolean(body.done);
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

  // --- Call notes ---
  api.get("/call-notes", async (req, res) => {
    res.json(await getCallNotes(req.userId!));
  });

  api.post("/call-notes", async (req, res) => {
    const body = req.body ?? {};
    const note = toNullableString(body.note);
    if (!note) return res.status(400).json({ error: "note is required" });

    const projectIdRaw = body.project_id;
    let projectId: number | null = null;
    if (projectIdRaw !== null && projectIdRaw !== undefined && projectIdRaw !== "") {
      projectId = toInt(projectIdRaw);
      if (projectId === null) return res.status(400).json({ error: "project_id must be an integer" });
      if (!(await getProject(req.userId!, projectId))) {
        return res.status(404).json({ error: "project not found" });
      }
    }

    const calledAtRaw = toNullableString(body.called_at);
    let calledAt: string | undefined;
    if (calledAtRaw) {
      const parsed = new Date(calledAtRaw);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "called_at must be a valid date" });
      }
      calledAt = parsed.toISOString();
    }

    const input: NewCallNote = {
      note,
      contact_name: toNullableString(body.contact_name),
      project_id: projectId,
      called_at: calledAt,
    };
    res.status(201).json(await addCallNote(req.userId!, input));
  });

  api.delete("/call-notes/:id", async (req, res) => {
    const id = parseId(req);
    if (id === null || !(await deleteCallNote(req.userId!, id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  // --- AI chat agent ---
  api.get("/chat/status", (_req, res) => {
    res.json({ enabled: isAiConfigured(config), model: config.anthropicModel });
  });

  api.post("/chat", async (req, res) => {
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
      const result = await chat(config, req.userId!, messages);
      res.json({ reply: result.reply, actions: result.actions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ai] chat failed:", msg);
      res.status(502).json({ error: `AI request failed: ${msg}` });
    }
  });

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
