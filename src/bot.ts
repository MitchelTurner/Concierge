import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Config } from "./config.js";
import {
  addProject,
  getProject,
  setNextAction,
  setStatus,
  type NewProject,
  type ProjectStatus,
  type ProjectType,
  PROJECT_STATUSES,
} from "./db.js";
import { formatDailyMessage, formatProjectList } from "./messages.js";

/** Statuses the user may set via /done or /status. */
const SETTABLE_STATUSES: ProjectStatus[] = [
  ...PROJECT_STATUSES,
];

// --- Conversation state (in-memory, single authorized user) ---------------

interface AddDraft {
  kind: "add";
  step:
    | "name"
    | "type"
    | "revenue"
    | "confidence"
    | "time_to_cash"
    | "effort"
    | "next_action";
  data: Partial<NewProject>;
}

interface DoneFollowUp {
  kind: "done_next_action";
  projectId: number;
}

type Session = AddDraft | DoneFollowUp;

function parse1to5(text: string): number | null {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

function parseHours(text: string): number | null {
  const n = Number(text.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export interface OperatorBot {
  bot: Telegraf;
  /** Send today's allocation to the authorized chat. */
  sendDailyMessage: () => Promise<void>;
}

export function createBot(config: Config): OperatorBot {
  const bot = new Telegraf(config.telegramBotToken);
  const authorizedChatId = config.telegramChatId;

  // Per-user conversation state. Only one authorized user, but keyed by id.
  const sessions = new Map<string, Session>();

  // Gatekeeper: only the configured chat id may interact at all.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== authorizedChatId) {
      return; // silently ignore everyone else
    }
    return next();
  });

  bot.start((ctx) =>
    ctx.reply(
      [
        "\uD83D\uDC4B Operator is online.",
        "",
        "Commands:",
        "/today — today's focus",
        "/list — active projects + scores",
        "/add — add a project (guided)",
        "/next {id} {text} — set next action",
        "/done {id} — mark next action done",
        "/status {id} {status} — update status",
      ].join("\n")
    )
  );

  bot.command("today", async (ctx) => {
    await ctx.reply(formatDailyMessage());
  });

  bot.command("list", async (ctx) => {
    await ctx.reply(formatProjectList());
  });

  // /next {id} {text}
  bot.command("next", async (ctx) => {
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    if (id === null || remainder.trim() === "") {
      await ctx.reply("Usage: /next {id} {the next concrete step}");
      return;
    }
    if (!getProject(id)) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    setNextAction(id, remainder.trim());
    await ctx.reply(`\u2705 Next action for #${id} updated.`);
  });

  // /status {id} {status}
  bot.command("status", async (ctx) => {
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    const status = remainder.trim().toLowerCase() as ProjectStatus;
    if (id === null || !SETTABLE_STATUSES.includes(status)) {
      await ctx.reply(
        `Usage: /status {id} {${SETTABLE_STATUSES.join("|")}}`
      );
      return;
    }
    if (!getProject(id)) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    setStatus(id, status);
    await ctx.reply(`\u2705 #${id} is now "${status}".`);
  });

  // /done {id} — mark current next action complete, prompt for the new one.
  bot.command("done", async (ctx) => {
    const rest = stripCommand(ctx.message.text);
    const { id } = splitIdAndRest(rest);
    if (id === null) {
      await ctx.reply("Usage: /done {id}");
      return;
    }
    const project = getProject(id);
    if (!project) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    sessions.set(authorizedChatId, { kind: "done_next_action", projectId: id });
    await ctx.reply(
      [
        `\uD83C\uDF89 Nice — marked "${project.next_action ?? "(no action)"}" done for ${project.name}.`,
        "",
        "What's the new next action? Reply with the next step,",
        `or send /status ${id} shipped | paid | blocked if it's finished/stuck.`,
      ].join("\n")
    );
  });

  // /add — guided, one question at a time.
  bot.command("add", async (ctx) => {
    sessions.set(authorizedChatId, {
      kind: "add",
      step: "name",
      data: {},
    });
    await ctx.reply("Adding a project. What's its name? (or /cancel)");
  });

  bot.command("cancel", async (ctx) => {
    if (sessions.delete(authorizedChatId)) {
      await ctx.reply("Cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  // Free-text handler drives /add and the /done follow-up.
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // commands handled above

    const session = sessions.get(authorizedChatId);
    if (!session) return; // nothing in progress; ignore stray text

    if (session.kind === "done_next_action") {
      setNextAction(session.projectId, text.trim());
      sessions.delete(authorizedChatId);
      await ctx.reply(`\u2705 New next action set for #${session.projectId}.`);
      return;
    }

    await handleAddStep(ctx, session, sessions, authorizedChatId, text);
  });

  const sendDailyMessage = async (): Promise<void> => {
    await bot.telegram.sendMessage(authorizedChatId, formatDailyMessage());
  };

  return { bot, sendDailyMessage };
}

async function handleAddStep(
  ctx: { reply: (s: string) => Promise<unknown> },
  session: AddDraft,
  sessions: Map<string, Session>,
  chatId: string,
  text: string
): Promise<void> {
  const value = text.trim();
  const d = session.data;

  switch (session.step) {
    case "name":
      d.name = value;
      session.step = "type";
      await ctx.reply("Type? Reply 'fast' (client/income) or 'passive'.");
      return;

    case "type": {
      const t = value.toLowerCase();
      if (t !== "fast" && t !== "passive") {
        await ctx.reply("Please reply exactly 'fast' or 'passive'.");
        return;
      }
      d.type = t as ProjectType;
      session.step = "revenue";
      await ctx.reply("Revenue potential? 1-5 (5 = big money).");
      return;
    }

    case "revenue": {
      const n = parse1to5(value);
      if (n === null) {
        await ctx.reply("Please reply with a number 1-5.");
        return;
      }
      d.revenue_potential = n;
      session.step = "confidence";
      await ctx.reply("Confidence someone actually pays? 1-5.");
      return;
    }

    case "confidence": {
      const n = parse1to5(value);
      if (n === null) {
        await ctx.reply("Please reply with a number 1-5.");
        return;
      }
      d.confidence = n;
      session.step = "time_to_cash";
      await ctx.reply("Time to cash? 1-5 (1 = paid within days, 5 = months/never).");
      return;
    }

    case "time_to_cash": {
      const n = parse1to5(value);
      if (n === null) {
        await ctx.reply("Please reply with a number 1-5.");
        return;
      }
      d.time_to_cash = n;
      session.step = "effort";
      await ctx.reply("Effort remaining in hours? (whole number)");
      return;
    }

    case "effort": {
      const n = parseHours(value);
      if (n === null) {
        await ctx.reply("Please reply with a number of hours (e.g. 8).");
        return;
      }
      d.effort_remaining = n;
      session.step = "next_action";
      await ctx.reply("What's the single concrete next action?");
      return;
    }

    case "next_action": {
      d.next_action = value;
      const project = addProject({
        name: d.name!,
        type: d.type!,
        revenue_potential: d.revenue_potential!,
        confidence: d.confidence!,
        time_to_cash: d.time_to_cash!,
        effort_remaining: d.effort_remaining!,
        next_action: d.next_action,
        status: "active",
      });
      sessions.delete(chatId);
      await ctx.reply(
        `\u2705 Added #${project.id} "${project.name}" (${project.type}, active).`
      );
      return;
    }
  }
}

/** Remove the leading "/command" (and optional @botname) token. */
function stripCommand(text: string): string {
  return text.replace(/^\/\S+\s*/, "");
}

/** Split "{id} rest of text" into a numeric id and the remainder. */
function splitIdAndRest(text: string): { id: number | null; remainder: string } {
  const trimmed = text.trim();
  const match = /^(\d+)\b\s*(.*)$/s.exec(trimmed);
  if (!match) return { id: null, remainder: trimmed };
  return { id: Number(match[1]), remainder: match[2] ?? "" };
}
