import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import {
  addGoal,
  addProject,
  deleteGoal,
  deleteProject,
  getAllProjects,
  getGoal,
  getGoals,
  getProject,
  updateGoal,
  updateProject,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  type NewProject,
  type ProjectPatch,
  type ProjectStatus,
  type ProjectType,
} from "./db.js";
import { chat, isAiConfigured, type ChatMessage } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

/** Constant-time string comparison that doesn't leak length via early return. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still run a compare to keep timing roughly constant.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function validateDeadline(v: unknown): { value: string | null } | { error: string } {
  const s = toNullableString(v);
  if (s === null) return { value: null };
  if (!DATE_RE.test(s)) return { error: "deadline must be YYYY-MM-DD or empty" };
  return { value: s };
}

function validate1to5(v: unknown, field: string): { value: number } | { error: string } {
  const n = toInt(v);
  if (n === null || n < 1 || n > 5) return { error: `${field} must be an integer 1-5` };
  return { value: n };
}

/** Validate a full project payload for creation. */
function validateNewProject(body: Record<string, unknown>): { value: NewProject } | { error: string } {
  const name = toNullableString(body.name);
  if (!name) return { error: "name is required" };

  const type = String(body.type ?? "").trim() as ProjectType;
  if (!PROJECT_TYPES.includes(type)) return { error: "type must be 'fast' or 'passive'" };

  const rev = validate1to5(body.revenue_potential, "revenue_potential");
  if ("error" in rev) return rev;
  const conf = validate1to5(body.confidence, "confidence");
  if ("error" in conf) return conf;
  const ttc = validate1to5(body.time_to_cash, "time_to_cash");
  if ("error" in ttc) return ttc;

  const effort = toInt(body.effort_remaining);
  if (effort === null || effort < 0) return { error: "effort_remaining must be a whole number >= 0" };

  const status = String(body.status ?? "active").trim() as ProjectStatus;
  if (!PROJECT_STATUSES.includes(status)) return { error: `status must be one of ${PROJECT_STATUSES.join(", ")}` };

  const deadline = validateDeadline(body.deadline);
  if ("error" in deadline) return deadline;

  return {
    value: {
      name,
      type,
      client: toNullableString(body.client),
      revenue_potential: rev.value,
      confidence: conf.value,
      time_to_cash: ttc.value,
      effort_remaining: effort,
      status,
      next_action: toNullableString(body.next_action),
      deadline: deadline.value,
      notes: toNullableString(body.notes),
    },
  };
}

/** Validate a partial project payload for editing. */
function validateProjectPatch(body: Record<string, unknown>): { value: ProjectPatch } | { error: string } {
  const patch: ProjectPatch = {};

  if ("name" in body) {
    const name = toNullableString(body.name);
    if (!name) return { error: "name cannot be empty" };
    patch.name = name;
  }
  if ("type" in body) {
    const type = String(body.type ?? "").trim() as ProjectType;
    if (!PROJECT_TYPES.includes(type)) return { error: "type must be 'fast' or 'passive'" };
    patch.type = type;
  }
  if ("status" in body) {
    const status = String(body.status ?? "").trim() as ProjectStatus;
    if (!PROJECT_STATUSES.includes(status)) return { error: `status must be one of ${PROJECT_STATUSES.join(", ")}` };
    patch.status = status;
  }
  for (const field of ["revenue_potential", "confidence", "time_to_cash"] as const) {
    if (field in body) {
      const r = validate1to5(body[field], field);
      if ("error" in r) return r;
      patch[field] = r.value;
    }
  }
  if ("effort_remaining" in body) {
    const effort = toInt(body.effort_remaining);
    if (effort === null || effort < 0) return { error: "effort_remaining must be a whole number >= 0" };
    patch.effort_remaining = effort;
  }
  if ("deadline" in body) {
    const d = validateDeadline(body.deadline);
    if ("error" in d) return d;
    patch.deadline = d.value;
  }
  if ("client" in body) patch.client = toNullableString(body.client);
  if ("next_action" in body) patch.next_action = toNullableString(body.next_action);
  if ("notes" in body) patch.notes = toNullableString(body.notes);

  return { value: patch };
}

function parseId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? id : null;
}

/** Build the Express app. Caller is responsible for listen(). */
export function createServer(config: Config): express.Express {
  const app = express();
  app.use(express.json());

  // Public, unauthenticated: lets the frontend know whether a password has been
  // configured so it can show the login screen vs a "set a password" notice.
  app.get("/api/config", (_req, res) => {
    res.json({ configured: config.dashboardPassword.length > 0 });
  });

  // Auth gate for the API. The static shell is public (it holds no data).
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    // No password configured → the dashboard is locked entirely (an empty
    // password must never authenticate). Serve no data.
    if (!config.dashboardPassword) {
      res.status(503).json({
        error: "Dashboard not configured. Set DASHBOARD_PASSWORD to enable it.",
      });
      return;
    }
    const provided =
      (req.header("x-dashboard-password") ?? "").toString() ||
      (req.query.key ? String(req.query.key) : "");
    if (!provided || !safeEqual(provided, config.dashboardPassword)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };

  const api = express.Router();
  api.use(requireAuth);

  // Confirms the supplied password is valid (used by the login form).
  api.get("/session", (_req, res) => res.json({ ok: true }));

  // --- Projects ---
  api.get("/projects", (_req, res) => res.json(getAllProjects()));

  api.get("/projects/:id", (req, res) => {
    const id = parseId(req);
    const project = id !== null ? getProject(id) : undefined;
    if (!project) return res.status(404).json({ error: "Not found" });
    res.json(project);
  });

  api.post("/projects", (req, res) => {
    const result = validateNewProject(req.body ?? {});
    if ("error" in result) return res.status(400).json({ error: result.error });
    res.status(201).json(addProject(result.value));
  });

  api.patch("/projects/:id", (req, res) => {
    const id = parseId(req);
    if (id === null || !getProject(id)) return res.status(404).json({ error: "Not found" });
    const result = validateProjectPatch(req.body ?? {});
    if ("error" in result) return res.status(400).json({ error: result.error });
    res.json(updateProject(id, result.value));
  });

  api.delete("/projects/:id", (req, res) => {
    const id = parseId(req);
    if (id === null || !deleteProject(id)) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  // --- Goals ---
  api.get("/goals", (_req, res) => res.json(getGoals()));

  api.post("/goals", (req, res) => {
    const title = toNullableString((req.body ?? {}).title);
    if (!title) return res.status(400).json({ error: "title is required" });
    const detail = toNullableString((req.body ?? {}).detail);
    res.status(201).json(addGoal(title, detail));
  });

  api.patch("/goals/:id", (req, res) => {
    const id = parseId(req);
    if (id === null || !getGoal(id)) return res.status(404).json({ error: "Not found" });
    const body = req.body ?? {};
    const patch: { title?: string; detail?: string | null } = {};
    if ("title" in body) {
      const title = toNullableString(body.title);
      if (!title) return res.status(400).json({ error: "title cannot be empty" });
      patch.title = title;
    }
    if ("detail" in body) patch.detail = toNullableString(body.detail);
    res.json(updateGoal(id, patch));
  });

  api.delete("/goals/:id", (req, res) => {
    const id = parseId(req);
    if (id === null || !deleteGoal(id)) return res.status(404).json({ error: "Not found" });
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
      const reply = await chat(config, messages);
      res.json({ reply });
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
