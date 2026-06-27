/**
 * Optional AI assistant — Anthropic chat with live database context.
 *
 * buildSystemPrompt() injects goals, projects, allocation, and stalls on every
 * turn. Tool calls (create_project, update_project, create_goal) write directly
 * to Postgres so the assistant can act, not just advise.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import {
  addGoal,
  addProject,
  getActiveProjects,
  getAllProjects,
  getGoals,
  getProject,
  getStalledProjects,
  getUserById,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  updateProject,
  type NewProject,
  type ProjectPatch,
  type ProjectStatus,
  type ProjectType,
} from "./db.js";
import { allocateDay, score, daysSince } from "./scoring.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatAction {
  type: "created_project" | "updated_project" | "created_goal";
  id: number;
  name?: string;
  title?: string;
}

export interface ChatResult {
  reply: string;
  actions: ChatAction[];
}

const MAX_HISTORY = 20;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_TOOL_ROUNDS = 6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_project",
    description:
      "Add a new project to the user's portfolio. Use when they want to track a new client gig, product, or income stream, or when they agree to a project you recommend. Always include a concrete next_action.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short project name" },
        type: {
          type: "string",
          enum: ["fast", "passive"],
          description: "fast = paid client/services work; passive = long-game products/ads",
        },
        client: { type: "string", description: "Client or customer name, if any" },
        revenue_potential: { type: "integer", description: "1-5, 5 = big money" },
        confidence: { type: "integer", description: "1-5, likelihood someone pays" },
        time_to_cash: {
          type: "integer",
          description: "1-5, 1 = paid within days, 5 = months/never",
        },
        effort_remaining: { type: "integer", description: "Estimated hours left, >= 0" },
        status: {
          type: "string",
          enum: ["idea", "active", "blocked", "shipped", "paid", "archived"],
        },
        next_action: { type: "string", description: "Single concrete next step" },
        deadline: { type: "string", description: "YYYY-MM-DD, optional" },
        notes: { type: "string" },
      },
      required: [
        "name",
        "type",
        "revenue_potential",
        "confidence",
        "time_to_cash",
        "effort_remaining",
        "next_action",
      ],
    },
  },
  {
    name: "update_project",
    description:
      "Update an existing project by id — sharpen next_action, change status, adjust scores, etc.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Project id, e.g. from the live context" },
        name: { type: "string" },
        type: { type: "string", enum: ["fast", "passive"] },
        client: { type: "string" },
        revenue_potential: { type: "integer" },
        confidence: { type: "integer" },
        time_to_cash: { type: "integer" },
        effort_remaining: { type: "integer" },
        status: {
          type: "string",
          enum: ["idea", "active", "blocked", "shipped", "paid", "archived"],
        },
        next_action: { type: "string" },
        deadline: { type: "string", description: "YYYY-MM-DD or empty to clear" },
        notes: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_goal",
    description: "Add a high-level goal that frames what the user's projects are working toward.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
      },
      required: ["title"],
    },
  },
];

export function isAiConfigured(config: Config): boolean {
  return config.anthropicApiKey.length > 0;
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
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

function validate1to5(v: unknown, field: string): { value: number } | { error: string } {
  const n = toInt(v);
  if (n === null || n < 1 || n > 5) return { error: `${field} must be an integer 1-5` };
  return { value: n };
}

function validateDeadline(v: unknown): { value: string | null } | { error: string } {
  const s = toNullableString(v);
  if (s === null) return { value: null };
  if (!DATE_RE.test(s)) return { error: "deadline must be YYYY-MM-DD or empty" };
  return { value: s };
}

function validateNewProjectInput(
  body: Record<string, unknown>
): { value: NewProject } | { error: string } {
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
  if (!PROJECT_STATUSES.includes(status)) {
    return { error: `status must be one of ${PROJECT_STATUSES.join(", ")}` };
  }

  const deadline = validateDeadline(body.deadline);
  if ("error" in deadline) return deadline;

  const next_action = toNullableString(body.next_action);
  if (!next_action) return { error: "next_action is required" };

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
      next_action,
      deadline: deadline.value,
      notes: toNullableString(body.notes),
    },
  };
}

function validateProjectPatchInput(
  body: Record<string, unknown>
): { value: ProjectPatch } | { error: string } {
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
    if (!PROJECT_STATUSES.includes(status)) {
      return { error: `status must be one of ${PROJECT_STATUSES.join(", ")}` };
    }
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

interface ToolRunResult {
  output: Record<string, unknown>;
  actions: ChatAction[];
}

async function runTool(
  userId: number,
  name: string,
  input: unknown
): Promise<ToolRunResult> {
  const body =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (name === "create_project") {
    const result = validateNewProjectInput(body);
    if ("error" in result) return { output: { ok: false, error: result.error }, actions: [] };
    const project = await addProject(userId, result.value);
    return {
      output: {
        ok: true,
        project: {
          id: project.id,
          name: project.name,
          type: project.type,
          status: project.status,
          next_action: project.next_action,
        },
      },
      actions: [{ type: "created_project", id: project.id, name: project.name }],
    };
  }

  if (name === "update_project") {
    const id = toInt(body.id);
    if (id === null) return { output: { ok: false, error: "id must be an integer" }, actions: [] };
    if (!(await getProject(userId, id))) {
      return { output: { ok: false, error: `no project #${id}` }, actions: [] };
    }

    const result = validateProjectPatchInput(body);
    if ("error" in result) return { output: { ok: false, error: result.error }, actions: [] };
    if (Object.keys(result.value).length === 0) {
      return { output: { ok: false, error: "no fields to update" }, actions: [] };
    }

    const updated = await updateProject(userId, id, result.value);
    if (!updated) return { output: { ok: false, error: `failed to update #${id}` }, actions: [] };
    return {
      output: {
        ok: true,
        project: {
          id: updated.id,
          name: updated.name,
          status: updated.status,
          next_action: updated.next_action,
        },
      },
      actions: [{ type: "updated_project", id: updated.id, name: updated.name }],
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

  return { output: { ok: false, error: `unknown tool: ${name}` }, actions: [] };
}

export async function buildSystemPrompt(userId: number): Promise<string> {
  const user = await getUserById(userId);
  const stallDays = user?.stall_days ?? 4;
  const goals = await getGoals(userId);
  const active = await getActiveProjects(userId);
  const all = await getAllProjects(userId);
  const allocation = allocateDay(active);
  const stalled = await getStalledProjects(userId, stallDays);

  const lines: string[] = [];

  lines.push(
    "You are the AI assistant for Concierge — a personal assistant and business analyst for a solo developer building a freelance/dev business on the side of a full-time job.",
    "",
    "How you think:",
    "- The user is time-poor: ~1 hour on weeknights, more on weekends. Keep suggestions realistic for that.",
    "- Two project tracks: 'fast' = client/services/paid software = income, ALWAYS the priority; 'passive' = ads/affiliate/own products = long game, only with leftover time.",
    "- Never dump the whole task list. Surface the ONE highest-leverage next move, then a little supporting context.",
    "- Priority score = (revenue_potential * confidence * (6 - time_to_cash)) / max(effort_remaining, 1). Higher = do sooner.",
    "- Be concrete and concise. No motivational fluff. Sharpen vague next actions into specific, shippable steps. Help rank, plan, and unblock.",
    "",
    "Tools — you can change the database:",
    "- create_project: add a new project when the user wants one tracked, or when they agree to a project you propose. Fill in sensible 1-5 scores; default status active. next_action is required.",
    "- update_project: change next_action, status, scores, etc. on an existing project by id.",
    "- create_goal: add a north-star goal when the user wants one or agrees to your suggestion.",
    "- When the user is vague, ask a quick clarifying question OR propose one concrete project and offer to add it.",
    "- When they say 'add it', 'create that', 'track this', or clearly accept a proposal, call the tool — don't just describe what you would add.",
    "- After creating/updating, confirm briefly what you saved (id + name + next action).",
    ""
  );

  lines.push("# Goals");
  if (goals.length === 0) {
    lines.push("(none set yet — encourage the user to define one)");
  } else {
    for (const g of goals) {
      lines.push(`- #${g.id} ${g.title}${g.detail ? ` — ${g.detail}` : ""}`);
    }
  }
  lines.push("");

  lines.push("# Active projects");
  if (active.length === 0) {
    lines.push("(no active projects)");
  } else {
    for (const p of active) {
      const bits = [
        `score ${round1(score(p))}`,
        `rev ${p.revenue_potential}/5`,
        `conf ${p.confidence}/5`,
        `time_to_cash ${p.time_to_cash}/5`,
        `~${p.effort_remaining}h left`,
      ];
      if (p.deadline) bits.push(`deadline ${p.deadline}`);
      if (p.last_progress_at) {
        const d = daysSince(p.last_progress_at);
        if (d !== null) bits.push(`${d}d since progress`);
      }
      lines.push(
        `- #${p.id} [${p.type}] ${p.name}${p.client ? ` (client: ${p.client})` : ""} — ${bits.join(", ")}`
      );
      lines.push(`    next: ${p.next_action ?? "(none set)"}`);
      if (p.notes) lines.push(`    notes: ${p.notes}`);
    }
  }
  lines.push("");

  const nonActive = all.filter((p) => p.status !== "active");
  if (nonActive.length > 0) {
    lines.push("# Other projects (not active)");
    for (const p of nonActive) {
      lines.push(`- #${p.id} [${p.type}] ${p.name} — status: ${p.status}`);
    }
    lines.push("");
  }

  lines.push("# Today's allocation (computed by the formula)");
  if (allocation.primary) {
    lines.push(
      `- PRIMARY (income): #${allocation.primary.project.id} ${allocation.primary.project.name} — ${allocation.primary.project.next_action ?? "(no next action)"}`
    );
  } else {
    lines.push("- PRIMARY: none — no active fast/income projects. Push the user to find/close a client.");
  }
  if (allocation.secondary) {
    lines.push(
      `- Secondary (passive, max 30 min): #${allocation.secondary.project.id} ${allocation.secondary.project.name}`
    );
  }
  if (allocation.deadlineWarnings.length > 0) {
    lines.push(
      `- Deadlines within 3 days: ${allocation.deadlineWarnings.map((p) => `${p.name} (${p.deadline})`).join("; ")}`
    );
  }
  if (stalled.length > 0) {
    lines.push(
      `- Stalling (no progress in ${stallDays}+ days): ${stalled.map((p) => p.name).join("; ")}`
    );
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

export async function chat(
  config: Config,
  userId: number,
  messages: ChatMessage[]
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

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    const response = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: TOOLS,
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
    reply: "I hit the tool-use limit for this turn. Check the Manage tab — your changes may have been saved.",
    actions,
  };
}
