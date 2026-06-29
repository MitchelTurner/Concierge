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
  addCallNote,
  addProject,
  addProjectTask,
  addDailyLog,
  getProjectWithTasks,
  getUserByTelegramChatId,
  linkTelegramByCode,
  unlinkTelegram,
  setStatus,
  stampProgress,
  updateProjectTask,
  type NewProject,
  type ProjectStatus,
  type User,
  PROJECT_STATUSES,
} from "./db.js";
import { buildStallSection, formatDailyMessage, formatProjectList } from "./messages.js";

const SETTABLE_STATUSES: ProjectStatus[] = [...PROJECT_STATUSES];

interface AddDraft {
  kind: "add";
  step: "name" | "description" | "task";
  data: Partial<NewProject> & { task?: string };
}

interface DoneFollowUp {
  kind: "done_next_task";
  projectId: number;
}

interface CheckinSession {
  kind: "checkin";
}

type Session = AddDraft | DoneFollowUp | CheckinSession;

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
        "/list — your ideas + open tasks",
        "/add — capture a new idea (guided)",
        "/next {id} {task} — add a task to an idea",
        "/done {id} — complete the next open task",
        "/progress {id} [note] — log progress on an idea",
        "/call {id} {contact} — {note} — log a phone call (id optional)",
        "/status {id} {status} — update idea status",
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
      await ctx.reply("Usage: /next {id} {task to add}");
      return;
    }
    const idea = await getProjectWithTasks(user.id, id);
    if (!idea) {
      await ctx.reply(`No idea with id ${id}.`);
      return;
    }
    await addProjectTask(user.id, id, remainder.trim());
    await stampProgress(user.id, id);
    await ctx.reply(`\u2705 Task added to #${id} "${idea.name}".`);
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
    if (!(await getProjectWithTasks(user.id, id))) {
      await ctx.reply(`No idea with id ${id}.`);
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
    const idea = await getProjectWithTasks(user.id, id);
    if (!idea) {
      await ctx.reply(`No idea with id ${id}.`);
      return;
    }
    const nextTask = idea.tasks.find((t) => !t.done);
    if (nextTask) {
      await updateProjectTask(user.id, nextTask.id, { done: true });
      await ctx.reply(`\uD83C\uDF89 Done: "${nextTask.title}" on ${idea.name}.`);
    } else {
      await stampProgress(user.id, id);
      await ctx.reply(`\u2705 Logged progress on ${idea.name} (no open tasks).`);
    }
    sessions.set(chatId, { kind: "done_next_task", projectId: id });
    await ctx.reply("What's the next task for this idea? Reply with text, or /cancel.");
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
    const idea = await getProjectWithTasks(user.id, id);
    if (!idea) {
      await ctx.reply(`No idea with id ${id}.`);
      return;
    }
    await stampProgress(user.id, id);
    const note = remainder.trim();
    if (note) {
      await addDailyLog(user.id, `#${id} ${idea.name}: ${note}`);
    }
    await ctx.reply(
      `\u2705 Logged progress on #${id} (${idea.name}).${note ? " Note saved." : ""}`
    );
  });

  bot.command("call", async (ctx) => {
    const user = await requireLinkedUser(ctx);
    if (!user) return;
    const rest = stripCommand(ctx.message.text).trim();
    if (!rest) {
      await ctx.reply(
        "Usage:\n/call {contact} — {note}\n/call {id} {contact} — {note}\n\nExample: /call 2 Jane Doe — interested, follow up Friday"
      );
      return;
    }

    let projectId: number | null = null;
    let remainder = rest;

    const idMatch = /^(\d+)\s+(.+)$/.exec(rest);
    if (idMatch) {
      projectId = Number(idMatch[1]);
      remainder = idMatch[2].trim();
      const idea = await getProjectWithTasks(user.id, projectId);
      if (!idea) {
        await ctx.reply(`No idea with id ${projectId}.`);
        return;
      }
    }

    const dashIdx = remainder.indexOf(" — ");
    let contactName: string | null = null;
    let note = remainder;
    if (dashIdx >= 0) {
      contactName = remainder.slice(0, dashIdx).trim() || null;
      note = remainder.slice(dashIdx + 3).trim();
    }

    if (!note) {
      await ctx.reply("Include a note after — . Example: /call Jane Doe — left voicemail, try again tomorrow");
      return;
    }

    await addCallNote(user.id, {
      project_id: projectId,
      contact_name: contactName,
      note,
    });

    const linked = projectId ? ` (linked to #${projectId})` : "";
    const who = contactName ? ` with ${contactName}` : "";
    await ctx.reply(`\u2705 Call note saved${who}${linked}.`);
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
    await ctx.reply("New idea — what's it called? (or /cancel)");
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

    if (session.kind === "done_next_task") {
      await addProjectTask(user.id, session.projectId, text.trim());
      await stampProgress(user.id, session.projectId);
      sessions.delete(chatId);
      await ctx.reply(`\u2705 New task added for idea #${session.projectId}.`);
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
      session.step = "description";
      await ctx.reply("Describe the idea in a sentence or two. (or /skip)");
      return;

    case "description":
      if (value.toLowerCase() !== "/skip") {
        d.notes = value;
      }
      session.step = "task";
      await ctx.reply("Add a first task? Reply with one concrete step, or /skip to finish.");
      return;

    case "task": {
      const tasks: string[] = [];
      if (value.toLowerCase() !== "/skip") {
        tasks.push(value);
      }
      const project = await addProject(userId, {
        name: d.name!,
        notes: d.notes ?? null,
        status: "idea",
        tasks: tasks.length ? tasks : undefined,
      });
      sessions.delete(chatId);
      await ctx.reply(
        `\u2705 Idea #${project.id} "${project.name}" saved${tasks.length ? " with 1 task" : ""}.`
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
