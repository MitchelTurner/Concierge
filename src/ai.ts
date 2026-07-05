/**
 * Optional AI assistant — suggests and manages ideas and their tasks.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import {
  addContact,
  addDailyLog,
  addGoal,
  addMemory,
  addOutreach,
  addProject,
  addProjectTask,
  deleteMemory,
  getAllProjectsWithTasks,
  getContact,
  getContactForProject,
  getContacts,
  getGoals,
  getMeetingNotes,
  getMemories,
  getProjectTask,
  getProjectWithTasks,
  getStalledProjects,
  getUserById,
  PROJECT_TYPES,
  stampProgress,
  updateProject,
  updateProjectTask,
  type MeetingNote,
  type NewProject,
  type ProjectPatch,
  type ProjectType,
  type ProjectStatus,
} from "./db.js";
import { formatEventLines, getTodaysEvents } from "./calendar.js";
import { allocateDay, scoreProject } from "./scoring.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatAction {
  type:
    | "created_project"
    | "updated_project"
    | "created_goal"
    | "added_tasks"
    | "completed_task"
    | "logged_progress"
    | "saved_memory"
    | "forgot_memory"
    | "added_contact"
    | "drafted_email";
  id: number;
  name?: string;
  title?: string;
  taskCount?: number;
}

export interface ChatResult {
  reply: string;
  actions: ChatAction[];
}

const MAX_HISTORY = 20;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_TOOL_ROUNDS = 6;
const UI_STATUSES: ProjectStatus[] = ["idea", "active", "blocked", "shipped", "archived"];

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_idea",
    description:
      "Add a new project the user wants to pursue. Include type, next action, and 2-5 concrete starter tasks when possible.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short idea title" },
        description: { type: "string", description: "What the idea is about and why it matters" },
        type: { type: "string", enum: ["fast", "passive"] },
        status: { type: "string", enum: ["idea", "active", "blocked", "shipped", "archived"] },
        revenue_potential: { type: "integer", description: "1-5 revenue upside" },
        confidence: { type: "integer", description: "1-5 confidence someone pays" },
        time_to_cash: { type: "integer", description: "1-5 where 1 means money soon" },
        effort_remaining: { type: "integer", description: "Estimated hours remaining" },
        next_action: { type: "string", description: "Single concrete next step" },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Concrete tasks that move this idea forward",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_idea",
    description: "Update an existing idea's title, description, or status.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        description: { type: "string" },
        type: { type: "string", enum: ["fast", "passive"] },
        status: { type: "string", enum: ["idea", "active", "blocked", "shipped", "archived"] },
        revenue_potential: { type: "integer" },
        confidence: { type: "integer" },
        time_to_cash: { type: "integer" },
        effort_remaining: { type: "integer" },
        next_action: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_tasks",
    description:
      "Add one or more tasks to an existing idea. Use when suggesting next steps or when the user agrees to your task list.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Idea id" },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Task titles — specific and actionable",
        },
      },
      required: ["project_id", "tasks"],
    },
  },
  {
    name: "create_goal",
    description: "Add a high-level goal that frames what the user's ideas are working toward.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description:
      "Mark a task done when the user says they finished it. Use the task id shown in the ideas list.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "Id of the task to mark done" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "log_progress",
    description:
      "Record that the user made progress on an idea today (resets its stall timer) and optionally save a short progress note.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Idea id" },
        note: { type: "string", description: "Short progress note in the user's words" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "save_memory",
    description:
      "Remember a durable fact, preference, or constraint about the user (e.g. working hours, a client quirk, a standing rule). Keep it to one short sentence. Do not save transient status.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "One short sentence to remember" },
      },
      required: ["content"],
    },
  },
  {
    name: "forget_memory",
    description: "Delete a saved memory by its id (shown in the memory list) when it is wrong or outdated.",
    input_schema: {
      type: "object",
      properties: {
        memory_id: { type: "integer" },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "add_contact",
    description:
      "Save a client contact (name + email), optionally linked to a project so chase-up emails know who to write to.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        project_id: { type: "integer", description: "Project this contact belongs to" },
        role: { type: "string", description: "e.g. 'owner, Joe's Pizza'" },
      },
      required: ["name", "email"],
    },
  },
  {
    name: "draft_client_email",
    description:
      "Draft a chase-up email to a client when something is blocking the pipeline (e.g. waiting on photos, content, or approval). Write the subject and body yourself — short, friendly, and specific about what is needed. The user reviews and sends it from Telegram.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "integer" },
        contact_id: {
          type: "integer",
          description: "Contact to write to; omit to use the project's linked contact",
        },
        waiting_on: { type: "string", description: "What the user is waiting on, in a few words" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text email body, ready to send" },
      },
      required: ["project_id", "waiting_on", "subject", "body"],
    },
  },
];

export function isAiConfigured(config: Config): boolean {
  return config.anthropicApiKey.length > 0;
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

function parseTasks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
}

function toProjectType(v: unknown): ProjectType | null {
  const value = String(v ?? "").trim() as ProjectType;
  return PROJECT_TYPES.includes(value) ? value : null;
}

function toScoreInt(v: unknown): number | null {
  const n = toInt(v);
  return n !== null && n >= 1 && n <= 5 ? n : null;
}

function toEffort(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.round(n);
}

function validateNewIdea(body: Record<string, unknown>): { value: NewProject } | { error: string } {
  const name = toNullableString(body.name);
  if (!name) return { error: "name is required" };
  const type = toProjectType(body.type ?? "fast");
  if (!type) return { error: `type must be one of ${PROJECT_TYPES.join(", ")}` };
  const status = String(body.status ?? "idea").trim() as ProjectStatus;
  if (!UI_STATUSES.includes(status)) {
    return { error: `status must be one of ${UI_STATUSES.join(", ")}` };
  }
  const tasks = parseTasks(body.tasks);
  const revenue = toScoreInt(body.revenue_potential ?? 3);
  const confidence = toScoreInt(body.confidence ?? 3);
  const timeToCash = toScoreInt(body.time_to_cash ?? 3);
  const effort = toEffort(body.effort_remaining ?? 8);
  if (revenue === null || confidence === null || timeToCash === null || effort === null) {
    return {
      error:
        "revenue_potential, confidence, and time_to_cash must be 1-5, and effort_remaining must be >= 1",
    };
  }
  return {
    value: {
      name,
      type,
      revenue_potential: revenue,
      confidence,
      time_to_cash: timeToCash,
      effort_remaining: effort,
      notes: toNullableString(body.description ?? body.notes),
      status,
      next_action: toNullableString(body.next_action),
      tasks: tasks.length ? tasks : undefined,
    },
  };
}

function validateIdeaPatch(body: Record<string, unknown>): { value: ProjectPatch } | { error: string } {
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
  if ("description" in body || "notes" in body) {
    patch.notes = toNullableString(body.description ?? body.notes);
  }
  if ("status" in body) {
    const status = String(body.status ?? "").trim() as ProjectStatus;
    if (!UI_STATUSES.includes(status)) {
      return { error: `status must be one of ${UI_STATUSES.join(", ")}` };
    }
    patch.status = status;
  }
  if ("revenue_potential" in body) {
    const revenue = toScoreInt(body.revenue_potential);
    if (revenue === null) return { error: "revenue_potential must be 1-5" };
    patch.revenue_potential = revenue;
  }
  if ("confidence" in body) {
    const confidence = toScoreInt(body.confidence);
    if (confidence === null) return { error: "confidence must be 1-5" };
    patch.confidence = confidence;
  }
  if ("time_to_cash" in body) {
    const timeToCash = toScoreInt(body.time_to_cash);
    if (timeToCash === null) return { error: "time_to_cash must be 1-5" };
    patch.time_to_cash = timeToCash;
  }
  if ("effort_remaining" in body) {
    const effort = toEffort(body.effort_remaining);
    if (effort === null) return { error: "effort_remaining must be >= 1" };
    patch.effort_remaining = effort;
  }
  if ("next_action" in body) {
    patch.next_action = toNullableString(body.next_action);
  }
  return { value: patch };
}

interface ToolRunResult {
  output: Record<string, unknown>;
  actions: ChatAction[];
}

async function runTool(userId: number, name: string, input: unknown): Promise<ToolRunResult> {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (name === "create_idea" || name === "create_project") {
    const result = validateNewIdea(body);
    if ("error" in result) return { output: { ok: false, error: result.error }, actions: [] };
    const project = await addProject(userId, result.value);
    return {
      output: {
        ok: true,
        idea: { id: project.id, name: project.name, status: project.status },
        tasks_added: result.value.tasks?.length ?? 0,
      },
      actions: [
        {
          type: "created_project",
          id: project.id,
          name: project.name,
          taskCount: result.value.tasks?.length ?? 0,
        },
      ],
    };
  }

  if (name === "update_idea" || name === "update_project") {
    const id = toInt(body.id);
    if (id === null) return { output: { ok: false, error: "id must be an integer" }, actions: [] };
    const result = validateIdeaPatch(body);
    if ("error" in result) return { output: { ok: false, error: result.error }, actions: [] };
    if (Object.keys(result.value).length === 0) {
      return { output: { ok: false, error: "no fields to update" }, actions: [] };
    }
    const updated = await updateProject(userId, id, result.value);
    if (!updated) return { output: { ok: false, error: `no idea #${id}` }, actions: [] };
    return {
      output: { ok: true, idea: { id: updated.id, name: updated.name, status: updated.status } },
      actions: [{ type: "updated_project", id: updated.id, name: updated.name }],
    };
  }

  if (name === "add_tasks") {
    const projectId = toInt(body.project_id ?? body.id);
    if (projectId === null) {
      return { output: { ok: false, error: "project_id must be an integer" }, actions: [] };
    }
    const idea = await getProjectWithTasks(userId, projectId);
    if (!idea) return { output: { ok: false, error: `no idea #${projectId}` }, actions: [] };
    const tasks = parseTasks(body.tasks);
    if (!tasks.length) return { output: { ok: false, error: "tasks array is required" }, actions: [] };
    const added = [];
    for (const title of tasks) {
      added.push(await addProjectTask(userId, projectId, title));
    }
    return {
      output: { ok: true, added: added.map((t) => ({ id: t.id, title: t.title })) },
      actions: [{ type: "added_tasks", id: projectId, name: idea.name, taskCount: added.length }],
    };
  }

  if (name === "create_goal") {
    const title = toNullableString(body.title);
    if (!title) return { output: { ok: false, error: "title is required" }, actions: [] };
    const goal = await addGoal(userId, title, toNullableString(body.detail));
    return {
      output: { ok: true, goal: { id: goal.id, title: goal.title } },
      actions: [{ type: "created_goal", id: goal.id, title: goal.title }],
    };
  }

  if (name === "complete_task") {
    const taskId = toInt(body.task_id ?? body.id);
    if (taskId === null) {
      return { output: { ok: false, error: "task_id must be an integer" }, actions: [] };
    }
    const existing = await getProjectTask(userId, taskId);
    if (!existing) return { output: { ok: false, error: `no task #${taskId}` }, actions: [] };
    if (existing.done) {
      return { output: { ok: true, note: "task was already done" }, actions: [] };
    }
    const task = await updateProjectTask(userId, taskId, { done: true });
    return {
      output: { ok: true, task: { id: taskId, title: task?.title ?? existing.title } },
      actions: [{ type: "completed_task", id: taskId, title: task?.title ?? existing.title }],
    };
  }

  if (name === "log_progress") {
    const projectId = toInt(body.project_id ?? body.id);
    if (projectId === null) {
      return { output: { ok: false, error: "project_id must be an integer" }, actions: [] };
    }
    const idea = await getProjectWithTasks(userId, projectId);
    if (!idea) return { output: { ok: false, error: `no idea #${projectId}` }, actions: [] };
    await stampProgress(userId, projectId);
    const note = toNullableString(body.note);
    if (note) await addDailyLog(userId, `#${projectId} ${idea.name}: ${note}`);
    return {
      output: { ok: true, idea: { id: projectId, name: idea.name }, note_saved: Boolean(note) },
      actions: [{ type: "logged_progress", id: projectId, name: idea.name }],
    };
  }

  if (name === "save_memory") {
    const content = toNullableString(body.content);
    if (!content) return { output: { ok: false, error: "content is required" }, actions: [] };
    const memory = await addMemory(userId, content);
    return {
      output: { ok: true, memory: { id: memory.id, content: memory.content } },
      actions: [{ type: "saved_memory", id: memory.id, title: memory.content }],
    };
  }

  if (name === "forget_memory") {
    const memoryId = toInt(body.memory_id ?? body.id);
    if (memoryId === null) {
      return { output: { ok: false, error: "memory_id must be an integer" }, actions: [] };
    }
    const deleted = await deleteMemory(userId, memoryId);
    if (!deleted) return { output: { ok: false, error: `no memory #${memoryId}` }, actions: [] };
    return {
      output: { ok: true, deleted: memoryId },
      actions: [{ type: "forgot_memory", id: memoryId }],
    };
  }

  if (name === "add_contact") {
    const contactName = toNullableString(body.name);
    const email = toNullableString(body.email);
    if (!contactName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { output: { ok: false, error: "name and a valid email are required" }, actions: [] };
    }
    const projectId = toInt(body.project_id);
    if (projectId !== null && !(await getProjectWithTasks(userId, projectId))) {
      return { output: { ok: false, error: `no idea #${projectId}` }, actions: [] };
    }
    const contact = await addContact(userId, {
      name: contactName,
      email,
      project_id: projectId,
      role: toNullableString(body.role),
    });
    return {
      output: { ok: true, contact: { id: contact.id, name: contact.name, email: contact.email } },
      actions: [{ type: "added_contact", id: contact.id, name: contact.name }],
    };
  }

  if (name === "draft_client_email") {
    const projectId = toInt(body.project_id);
    const waitingOn = toNullableString(body.waiting_on);
    const subject = toNullableString(body.subject);
    const emailBody = toNullableString(body.body);
    if (projectId === null || !waitingOn || !subject || !emailBody) {
      return {
        output: { ok: false, error: "project_id, waiting_on, subject, and body are required" },
        actions: [],
      };
    }
    const project = await getProjectWithTasks(userId, projectId);
    if (!project) return { output: { ok: false, error: `no idea #${projectId}` }, actions: [] };

    const contactId = toInt(body.contact_id);
    const contact =
      contactId !== null
        ? await getContact(userId, contactId)
        : await getContactForProject(userId, projectId);
    if (!contact) {
      return {
        output: {
          ok: false,
          error: `no contact linked to idea #${projectId} — ask the user for a name and email, then use add_contact first`,
        },
        actions: [],
      };
    }

    const outreach = await addOutreach(userId, {
      project_id: projectId,
      contact_id: contact.id,
      waiting_on: waitingOn,
      subject,
      body: emailBody,
    });
    return {
      output: {
        ok: true,
        outreach: { id: outreach.id, to: contact.email, subject },
        note: "Draft saved. The user will get a review message with send/edit buttons in Telegram.",
      },
      actions: [{ type: "drafted_email", id: outreach.id, name: contact.name }],
    };
  }

  return { output: { ok: false, error: `unknown tool: ${name}` }, actions: [] };
}

export async function buildSystemPrompt(userId: number): Promise<string> {
  const user = await getUserById(userId);
  const stallDays = user?.stall_days ?? 4;
  const goals = await getGoals(userId);
  const ideas = await getAllProjectsWithTasks(userId);
  const allocation = allocateDay(ideas);
  const stalled = await getStalledProjects(userId, stallDays);

  const lines: string[] = [];

  lines.push(
    "You are the AI assistant for Concierge — a business analyst that helps the user choose the right project and sharpen their task list.",
    "",
    "How you work:",
    "- The user tracks **projects** with a type (`fast` or `passive`) and a checklist of concrete tasks.",
    "- The first open task on each project drives the daily focus nudge.",
    "- Fast projects are income work and always take priority over passive projects.",
    "- Your main job: sharpen tasks, improve prioritization, and suggest concrete small tasks when useful.",
    "- When a project is thin, ask one clarifying question OR propose 3-5 starter tasks and offer to add them.",
    "- Prefer adding tasks via tools when the user agrees ('yes', 'add those', 'sounds good').",
    "- Be concise. No motivational fluff. Tasks should be doable in an evening or weekend session.",
    "",
    "Tools:",
    "- create_idea: new idea + optional description + starter tasks",
    "- update_idea: change title, description, or status",
    "- add_tasks: append tasks to an existing idea by project_id",
    "- create_goal: add a north-star goal",
    "- complete_task: mark a task done by its task id when the user says they finished it",
    "- log_progress: stamp progress on an idea (and optionally save a note) when the user reports working on it",
    "- save_memory: remember a durable preference/fact the user shares (working hours, client quirks, standing rules)",
    "- forget_memory: remove a saved memory that is wrong or outdated",
    "- add_contact: save a client contact (name + email), optionally linked to a project",
    "- draft_client_email: when the user is blocked waiting on a client (photos, content, approval, payment), write a short friendly chase-up email; the user reviews and sends it from Telegram",
    ""
  );

  const memories = await getMemories(userId);
  lines.push("# Memory (durable facts and preferences about the user)");
  if (memories.length === 0) {
    lines.push("(nothing saved yet — use save_memory when the user shares something worth keeping)");
  } else {
    for (const m of memories.slice(0, 30)) {
      lines.push(`- [memory ${m.id}] ${m.content}`);
    }
  }
  lines.push("");

  lines.push("# Goals");
  if (goals.length === 0) {
    lines.push("(none — help the user define one if useful)");
  } else {
    for (const g of goals) {
      lines.push(`- #${g.id} ${g.title}${g.detail ? ` — ${g.detail}` : ""}`);
    }
  }
  lines.push("");

  lines.push("# Ideas and tasks");
  if (ideas.length === 0) {
    lines.push("(none yet — encourage capturing a rough idea and breaking it into tasks)");
  } else {
    for (const idea of ideas) {
      const open = idea.tasks.filter((t) => !t.done);
      const done = idea.tasks.filter((t) => t.done);
      lines.push(`- #${idea.id} [${idea.type}/${idea.status}] ${idea.name} — score ${scoreProject(idea).toFixed(1)}`);
      if (idea.notes) lines.push(`    description: ${idea.notes}`);
      if (open.length) {
        lines.push(`    focus task: ${open[0]!.title}`);
        lines.push(`    open tasks: ${open.map((t) => `[task ${t.id}] "${t.title}"`).join("; ")}`);
      } else if (idea.next_action) {
        lines.push(`    fallback action (no open tasks): ${idea.next_action}`);
      } else {
        lines.push("    open tasks: (none — suggest some!)");
      }
      if (done.length) lines.push(`    done: ${done.length} task(s)`);
    }
  }
  lines.push("");

  lines.push("# Suggested focus today");
  if (allocation.primary) {
    const { project, action, score } = allocation.primary;
    lines.push(`- Primary fast project: #${project.id} ${project.name} → ${action ?? "(add a task)"} [score ${score.toFixed(1)}]`);
  } else {
    lines.push("- No fast project is ready — help the user define or activate one.");
  }
  if (allocation.secondary) {
    lines.push(
      `- Spare time passive: #${allocation.secondary.project.id} ${allocation.secondary.project.name} → ${allocation.secondary.action ?? "(add a task)"}`
    );
  }
  if (allocation.deadlineWarnings.length > 0) {
    lines.push(
      `- Deadlines soon: ${allocation.deadlineWarnings.map((p) => `${p.name} (${p.deadline})`).join("; ")}`
    );
  }
  if (stalled.length > 0) {
    lines.push(`- Stalling (${stallDays}+ days): ${stalled.map((p) => p.name).join("; ")}`);
  }

  const contacts = await getContacts(userId);
  lines.push("");
  lines.push("# Client contacts");
  if (contacts.length === 0) {
    lines.push("(none — save one with add_contact when the user mentions a client's name and email)");
  } else {
    for (const c of contacts) {
      const project = c.project_id ? ` [idea #${c.project_id}]` : "";
      const role = c.role ? ` — ${c.role}` : "";
      lines.push(`- [contact ${c.id}] ${c.name} <${c.email}>${role}${project}`);
    }
  }

  if (user?.calendar_ics_url) {
    lines.push("");
    lines.push("# Today's calendar");
    try {
      const events = await getTodaysEvents(user.calendar_ics_url, user.timezone);
      if (events.length === 0) {
        lines.push("(no events today)");
      } else {
        lines.push(...formatEventLines(events, user.timezone));
      }
    } catch {
      lines.push("(calendar feed unavailable right now)");
    }
  }

  const notes = await getMeetingNotes(userId);
  const recentNotes = notes.slice(0, 8);
  lines.push("");
  lines.push("# Recent call/meeting notes");
  if (recentNotes.length === 0) {
    lines.push("(none)");
  } else {
    for (const n of recentNotes) {
      const linked = n.project_id ? ` [idea #${n.project_id}]` : "";
      const preview = n.body.length > 200 ? `${n.body.slice(0, 200)}…` : n.body;
      lines.push(`- #${n.id} ${n.title || n.type}${linked}: ${preview}`);
    }
  }

  return lines.join("\n");
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function parseSuggestionLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((line) => line.length > 3 && line.length < 200);
}

/** One-shot AI call to suggest tasks for a single idea. */
export async function suggestTasksForProject(
  config: Config,
  userId: number,
  projectId: number
): Promise<string[]> {
  if (!isAiConfigured(config)) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }

  const idea = await getProjectWithTasks(userId, projectId);
  if (!idea) throw new Error("Idea not found");

  const open = idea.tasks.filter((t) => !t.done).map((t) => t.title);
  const done = idea.tasks.filter((t) => t.done).map((t) => t.title);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system:
      "You suggest concrete, actionable tasks for ideas. Return ONLY a plain list — one task per line, no numbering, no intro. Each task should be doable in under 2 hours. Do not repeat existing tasks.",
    messages: [
      {
        role: "user",
        content: [
          `Idea: ${idea.name}`,
          idea.notes ? `Description: ${idea.notes}` : "",
          open.length ? `Existing open tasks: ${open.join("; ")}` : "No open tasks yet.",
          done.length ? `Already done: ${done.join("; ")}` : "",
          "",
          "Suggest 4-6 new tasks to move this idea forward.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const text = extractText(response.content);
  const lines = parseSuggestionLines(text);
  return lines.slice(0, 8);
}

/** Extract follow-up tasks from a call or meeting note. */
export async function suggestTasksFromMeetingNote(
  config: Config,
  userId: number,
  note: MeetingNote
): Promise<string[]> {
  if (!isAiConfigured(config)) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }

  let ideaContext = "";
  if (note.project_id) {
    const idea = await getProjectWithTasks(userId, note.project_id);
    if (idea) {
      const open = idea.tasks.filter((t) => !t.done).map((t) => t.title);
      ideaContext = [
        `Linked idea: ${idea.name}`,
        idea.notes ? `Description: ${idea.notes}` : "",
        open.length ? `Existing open tasks: ${open.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system:
      "You extract concrete follow-up tasks from call and meeting notes. Return ONLY a plain list — one task per line, no numbering, no intro. Each task should be doable in under 2 hours. Do not repeat existing tasks.",
    messages: [
      {
        role: "user",
        content: [
          note.title ? `Title: ${note.title}` : "",
          note.participants ? `With: ${note.participants}` : "",
          ideaContext,
          "",
          "Notes:",
          note.body,
          "",
          "Extract 3-6 follow-up tasks from these notes.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const text = extractText(response.content);
  const lines = parseSuggestionLines(text);
  return lines.slice(0, 8);
}

/**
 * One-shot chase-up email generation for /draft. Uses project context and
 * saved memories so tone and details fit the user.
 */
export async function draftOutreachEmail(
  config: Config,
  userId: number,
  projectId: number,
  contactName: string,
  waitingOn: string
): Promise<{ subject: string; body: string }> {
  if (!isAiConfigured(config)) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }

  const user = await getUserById(userId);
  const project = await getProjectWithTasks(userId, projectId);
  if (!project) throw new Error(`no project #${projectId}`);
  const memories = await getMemories(userId);

  const draftTool: Anthropic.Tool = {
    name: "email_draft",
    description: "The chase-up email to send.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body, ready to send" },
      },
      required: ["subject", "body"],
    },
  };

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system: [
      "You write short, friendly, professional chase-up emails to a freelancer's client when something is blocking progress.",
      "Be specific about what is needed and why it unblocks the work. No guilt-tripping, no fluff, 4-8 sentences max.",
      `Sign off as ${user?.name?.trim() || "the sender"}.`,
    ].join("\n"),
    tools: [draftTool],
    tool_choice: { type: "tool", name: "email_draft" },
    messages: [
      {
        role: "user",
        content: [
          `Project: ${project.name}`,
          project.notes ? `About: ${project.notes}` : "",
          `Client contact: ${contactName}`,
          `Waiting on: ${waitingOn}`,
          memories.length
            ? `Things to keep in mind about the sender: ${memories
                .slice(0, 10)
                .map((m) => m.content)
                .join("; ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  const input =
    toolUse?.input && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};
  const subject = toNullableString(input.subject);
  const body = toNullableString(input.body);
  if (!subject || !body) throw new Error("AI draft returned no subject/body");
  return { subject, body };
}

/** One-shot revision of an outreach draft from free-text instructions. */
export async function reviseOutreachEmail(
  config: Config,
  current: { subject: string; body: string },
  instructions: string
): Promise<{ subject: string; body: string }> {
  if (!isAiConfigured(config)) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }

  const reviseTool: Anthropic.Tool = {
    name: "email_draft",
    description: "The revised email.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body, ready to send" },
      },
      required: ["subject", "body"],
    },
  };

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system:
      "You revise a chase-up email according to the user's instructions. Keep it short, friendly, and professional. If the user's message reads like a complete replacement email, use their text nearly verbatim (fixing only obvious typos).",
    tools: [reviseTool],
    tool_choice: { type: "tool", name: "email_draft" },
    messages: [
      {
        role: "user",
        content: [
          `Current subject: ${current.subject}`,
          "Current body:",
          current.body,
          "",
          "Revision instructions:",
          instructions,
        ].join("\n"),
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  const input =
    toolUse?.input && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};
  const subject = toNullableString(input.subject) ?? current.subject;
  const body = toNullableString(input.body) ?? current.body;
  return { subject, body };
}

/**
 * One-shot assessment of a client reply: does it provide (or promise) what the
 * user was waiting on? Returns a single short line for the notification.
 */
export async function assessReply(
  config: Config,
  waitingOn: string,
  replyText: string
): Promise<string> {
  if (!isAiConfigured(config)) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 128,
    system:
      "You read a client's email reply and judge whether it delivers or promises what the user was waiting on. Answer in ONE short line, e.g. \"Looks like they attached the photos.\" or \"They haven't sent it yet — they're asking a question.\" No preamble.",
    messages: [
      {
        role: "user",
        content: `Waiting on: ${waitingOn}\n\nClient reply:\n${replyText.slice(0, 2000)}`,
      },
    ],
  });
  return extractText(response.content);
}

export interface CheckinOutcome {
  completedTasks: { id: number; title: string; project: string }[];
  progressedProjects: { id: number; name: string }[];
}

const CHECKIN_TOOL: Anthropic.Tool = {
  name: "record_checkin",
  description: "Record which tasks the user finished and which projects they progressed today.",
  input_schema: {
    type: "object",
    properties: {
      completed_task_ids: {
        type: "array",
        items: { type: "integer" },
        description: "Task ids the user clearly finished today",
      },
      progressed_project_ids: {
        type: "array",
        items: { type: "integer" },
        description: "Project ids the user worked on today without finishing a listed task",
      },
    },
    required: ["completed_task_ids", "progressed_project_ids"],
  },
};

function parseIdArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * Parse a free-text evening check-in and apply what it implies: mark tasks the
 * user finished as done and stamp progress on projects they worked on.
 * The raw check-in text is logged by the caller regardless.
 */
export async function processCheckin(
  config: Config,
  userId: number,
  text: string
): Promise<CheckinOutcome> {
  if (!isAiConfigured(config)) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }

  const ideas = await getAllProjectsWithTasks(userId);
  const relevant = ideas.filter((p) => p.status === "active" || p.status === "idea");
  const contextLines: string[] = [];
  for (const idea of relevant) {
    const open = idea.tasks.filter((t) => !t.done);
    contextLines.push(`- project ${idea.id}: ${idea.name}`);
    for (const t of open) {
      contextLines.push(`    task ${t.id}: ${t.title}`);
    }
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 512,
    system: [
      "You parse a user's evening check-in against their project list and record the outcome via the record_checkin tool.",
      "Be conservative: only include a task id when the check-in clearly says that task was finished.",
      "Include a project id in progressed_project_ids when the user worked on it but no listed task was clearly finished.",
      "If nothing matches, call the tool with two empty arrays.",
    ].join("\n"),
    tools: [CHECKIN_TOOL],
    tool_choice: { type: "tool", name: "record_checkin" },
    messages: [
      {
        role: "user",
        content: [
          "Projects and open tasks:",
          contextLines.length ? contextLines.join("\n") : "(none)",
          "",
          "Tonight's check-in:",
          text,
        ].join("\n"),
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  const input =
    toolUse?.input && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};

  const outcome: CheckinOutcome = { completedTasks: [], progressedProjects: [] };
  const projectById = new Map(relevant.map((p) => [p.id, p]));
  const taskIndex = new Map(
    relevant.flatMap((p) => p.tasks.filter((t) => !t.done).map((t) => [t.id, { task: t, project: p }] as const))
  );

  for (const taskId of parseIdArray(input.completed_task_ids)) {
    const entry = taskIndex.get(taskId);
    if (!entry) continue;
    await updateProjectTask(userId, taskId, { done: true });
    outcome.completedTasks.push({
      id: taskId,
      title: entry.task.title,
      project: entry.project.name,
    });
  }

  const alreadyStamped = new Set(outcome.completedTasks.map((t) => taskIndex.get(t.id)!.project.id));
  for (const projectId of parseIdArray(input.progressed_project_ids)) {
    const project = projectById.get(projectId);
    if (!project || alreadyStamped.has(projectId)) continue;
    await stampProgress(userId, projectId);
    outcome.progressedProjects.push({ id: projectId, name: project.name });
  }

  return outcome;
}

export async function chat(
  config: Config,
  userId: number,
  messages: ChatMessage[],
  options: { allowWrite: boolean }
): Promise<ChatResult> {
  if (!isAiConfigured(config)) {
    throw new Error("AI agent is not configured (set ANTHROPIC_API_KEY).");
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const trimmed = messages.slice(-MAX_HISTORY);
  const apiMessages: Anthropic.MessageParam[] = trimmed.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const actions: ChatAction[] = [];
  let rounds = 0;
  const system = await buildSystemPrompt(userId);
  const systemWithMode = `${system}\n\n# Mutation mode\n${
    options.allowWrite
      ? "The user explicitly allowed writes for this request. Use tools only when the latest user message clearly asks to create or update data."
      : "Read-only mode. Do not use tools or imply that you changed saved data in this reply."
  }`;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    const response = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemWithMode,
      tools: options.allowWrite ? TOOLS : undefined,
      messages: apiMessages,
    });

    if (response.stop_reason === "tool_use") {
      apiMessages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const { output, actions: newActions } = await runTool(userId, block.name, block.input);
        actions.push(...newActions);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(output),
        });
      }

      if (toolResults.length === 0) {
        return { reply: extractText(response.content) || "(tool call failed)", actions };
      }

      apiMessages.push({ role: "user", content: toolResults });
      continue;
    }

    const reply = extractText(response.content) || "(the assistant returned no text)";
    return { reply, actions };
  }

  return {
    reply: "I hit the tool-use limit for this turn. Check your workspace — changes may have been saved.",
    actions,
  };
}
