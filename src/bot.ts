/**
 * Telegram bot — Telegraf command handlers and conversational flows.
 *
 * Commands mutate Postgres via db.ts; read paths use messages.ts for formatting.
 * In-memory `sessions` track multi-step flows (/add wizard, /done follow-up,
 * evening check-in) keyed by Telegram chat id.
 */
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Config } from "./config.js";
import {
  addProject,
  addDailyLog,
  getProject,
  getUserByTelegramChatId,
  linkTelegramByCode,
  unlinkTelegram,
  setNextAction,
  setStatus,
  stampProgress,
  type NewProject,
  type ProjectStatus,
  type ProjectType,
  type User,
  PROJECT_STATUSES,
} from "./db.js";
import { buildStallSection, formatDailyMessage, formatProjectList } from "./messages.js";

const SETTABLE_STATUSES: ProjectStatus[] = [...PROJECT_STATUSES];

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

interface CheckinSession {
  kind: "checkin";
}

type Session = AddDraft | DoneFollowUp | CheckinSession;

// ---------------------------------------------------------------------------
// Input parsers for the guided /add flow
// ---------------------------------------------------------------------------

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

export interface ConciergeBot {
  bot: Telegraf;
  sendDailyMessage: (user: User) => Promise<void>;
  sendCheckinMessage: (user: User) => Promise<void>;
}

export function createBot(config: Config): ConciergeBot {
  const bot = new Telegraf(config.telegramBotToken);
  const sessions = new Map<string, Session>();

  async function requireLinkedUser(
    ctx: { chat?: { id?: number }; reply: (s: string) => Promise<unknown> }
  ): Promise<User | null> {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return null;
    const user = await getUserByTelegramChatId(chatId);
    if (!user) {
      await ctx.reply(
        "Your Telegram isn't linked yet.\n\n" +
          "1. Sign up at the Concierge dashboard\n" +
          "2. Open Settings → generate a link code\n" +
          "3. Send /link YOUR_CODE here"
      );
      return null;
    }
    return user;
  }

  bot.start(async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    await ctx.reply(
      [
        "\u2693 Concierge is online.",
        "",
        "Commands:",
        "/today — today's focus",
        "/list — active projects + scores",
        "/add — add a project (guided)",
        "/next {id} {text} — set next action",
        "/done {id} — mark next action done",
        "/progress {id} [note] — log progress (resets the stall clock)",
        "/status {id} {status} — update status",
        "/unlink — disconnect this Telegram from your account",
      ].join("\n")
    );
  });

  bot.command("link", async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    const existing = await getUserByTelegramChatId(chatId);
    if (existing) {
      await ctx.reply(`Already linked to ${existing.email}. Use /unlink to disconnect first.`);
      return;
    }

    const code = stripCommand(ctx.message.text).trim().toUpperCase();
    if (!code) {
      await ctx.reply("Usage: /link CODE\n\nGet your code from the dashboard Settings tab.");
      return;
    }

    const user = await linkTelegramByCode(code, chatId);
    if (!user) {
      await ctx.reply("Invalid or expired link code. Generate a new one in the dashboard.");
      return;
    }

    await ctx.reply(`\u2705 Linked to ${user.email}. Try /today to see your focus.`);
  });

  bot.command("unlink", async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;
    const user = await getUserByTelegramChatId(chatId);
    if (!user) {
      await ctx.reply("This chat isn't linked to any account.");
      return;
    }
    await unlinkTelegram(user.id);
    sessions.delete(chatId);
    await ctx.reply("Telegram unlinked. Generate a new code in the dashboard to reconnect.");
  });

  bot.command("today", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    await ctx.reply(await formatDailyMessage(user.id, user.stall_days));
  });

  bot.command("list", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    await ctx.reply(await formatProjectList(user.id));
  });

  bot.command("next", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    if (id === null || remainder.trim() === "") {
      await ctx.reply("Usage: /next {id} {the next concrete step}");
      return;
    }
    if (!(await getProject(user.id, id))) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    await setNextAction(user.id, id, remainder.trim());
    await stampProgress(user.id, id);
    await ctx.reply(`\u2705 Next action for #${id} updated.`);
  });

  bot.command("status", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    const status = remainder.trim().toLowerCase() as ProjectStatus;
    if (id === null || !SETTABLE_STATUSES.includes(status)) {
      await ctx.reply(`Usage: /status {id} {${SETTABLE_STATUSES.join("|")}}`);
      return;
    }
    if (!(await getProject(user.id, id))) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    await setStatus(user.id, id, status);
    await ctx.reply(`\u2705 #${id} is now "${status}".`);
  });

  bot.command("done", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    const chatId = ctx.chat!.id.toString();
    const rest = stripCommand(ctx.message.text);
    const { id } = splitIdAndRest(rest);
    if (id === null) {
      await ctx.reply("Usage: /done {id}");
      return;
    }
    const project = await getProject(user.id, id);
    if (!project) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    await stampProgress(user.id, id);
    sessions.set(chatId, { kind: "done_next_action", projectId: id });
    await ctx.reply(
      [
        `\uD83C\uDF89 Nice — marked "${project.next_action ?? "(no action)"}" done for ${project.name}.`,
        "",
        "What's the new next action? Reply with the next step,",
        `or send /status ${id} shipped | paid | blocked if it's finished/stuck.`,
      ].join("\n")
    );
  });

  bot.command("progress", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    if (id === null) {
      await ctx.reply("Usage: /progress {id} [optional note]");
      return;
    }
    const project = await getProject(user.id, id);
    if (!project) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    await stampProgress(user.id, id);
    const note = remainder.trim();
    if (note) {
      await addDailyLog(user.id, `#${id} ${project.name}: ${note}`);
    }
    await ctx.reply(
      `\u2705 Logged progress on #${id} (${project.name}).${note ? " Note saved." : ""}`
    );
  });

  bot.command("skip", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    const chatId = ctx.chat!.id.toString();
    const session = sessions.get(chatId);
    if (session?.kind === "checkin") {
      sessions.delete(chatId);
      const stalls = await buildStallSection(user.id, user.stall_days);
      await ctx.reply(
        stalls
          ? `No check-in logged tonight.\n\n${stalls}`
          : "No check-in logged tonight. Nothing stalling — nice."
      );
    } else {
      await ctx.reply("Nothing to skip.");
    }
  });

  bot.command("add", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    const chatId = ctx.chat!.id.toString();
    sessions.set(chatId, { kind: "add", step: "name", data: {} });
    await ctx.reply("Adding a project. What's its name? (or /cancel)");
  });

  bot.command("cancel", async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;
    if (sessions.delete(chatId)) {
      await ctx.reply("Cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  // Free-text handler: only runs when a session is active (not for commands).
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    const user = await getUserByTelegramChatId(chatId);
    if (!user) return;

    const session = sessions.get(chatId);
    if (!session) return;

    if (session.kind === "add") {
      await handleAddStep(ctx, user.id, session, sessions, chatId, text);
      return;
    }

    if (session.kind === "done_next_action") {
      await setNextAction(user.id, session.projectId, text.trim());
      await stampProgress(user.id, session.projectId);
      sessions.delete(chatId);
      await ctx.reply(`\u2705 New next action set for #${session.projectId}.`);
      return;
    }

    if (session.kind === "checkin") {
      await addDailyLog(user.id, text.trim());
      sessions.delete(chatId);
      const stalls = await buildStallSection(user.id, user.stall_days);
      await ctx.reply(
        stalls
          ? `\u2705 Logged. Thanks.\n\n${stalls}`
          : "\u2705 Logged. Thanks. Nothing stalling right now — nice."
      );
    }
  });

  const sendDailyMessage = async (user: User): Promise<void> => {
    if (!user.telegram_chat_id) return;
    await bot.telegram.sendMessage(
      user.telegram_chat_id,
      await formatDailyMessage(user.id, user.stall_days)
    );
  };

  const sendCheckinMessage = async (user: User): Promise<void> => {
    if (!user.telegram_chat_id) return;
    const chatId = user.telegram_chat_id;
    if (!sessions.has(chatId)) {
      sessions.set(chatId, { kind: "checkin" });
    }
    await bot.telegram.sendMessage(
      chatId,
      "\uD83C\uDF19 What did you move forward today? Reply with what you got done, or /skip."
    );
  };

  return { bot, sendDailyMessage, sendCheckinMessage };
}

async function handleAddStep(
  ctx: { reply: (s: string) => Promise<unknown> },
  userId: number,
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
      const project = await addProject(userId, {
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

function stripCommand(text: string): string {
  return text.replace(/^\/\S+\s*/, "");
}

function splitIdAndRest(text: string): { id: number | null; remainder: string } {
  const trimmed = text.trim();
  const match = /^(\d+)\b\s*(.*)$/s.exec(trimmed);
  if (!match) return { id: null, remainder: trimmed };
  return { id: Number(match[1]), remainder: match[2] ?? "" };
}
