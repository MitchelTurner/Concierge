import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the SQLite database file.
 *
 * Defaults to `<project>/data/operator.db`. On hosts with an ephemeral
 * filesystem (e.g. Railway), set `DATABASE_PATH` to a path on a mounted
 * persistent volume, e.g. `/data/operator.db`, so the DB survives redeploys.
 */
export const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.resolve(__dirname, "..", "data", "operator.db");

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  /** Daily nudge time in 24h "HH:MM" form. */
  dailyTime: string;
  /** IANA timezone string used for cron correctness. */
  tz: string;
  /** Phase 2 only — may be empty in Phase 1. */
  anthropicApiKey: string;
  /** HTTP port for the web dashboard (Railway sets PORT). */
  port: number;
  /**
   * Password gating the web dashboard. When empty, the web server is NOT
   * started — so the dashboard is never exposed unauthenticated.
   */
  dashboardPassword: string;
}

const DAILY_TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill it in (see README).`
    );
  }
  return value.trim();
}

/**
 * Load and validate environment configuration. Throws with a clear message if
 * a required value is missing or malformed, so boot fails fast.
 */
export function loadConfig(): Config {
  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramChatId = requireEnv("TELEGRAM_CHAT_ID");

  if (!/^-?\d+$/.test(telegramChatId)) {
    throw new Error(
      `TELEGRAM_CHAT_ID must be a numeric chat id (got "${telegramChatId}"). See README for how to find it.`
    );
  }

  const dailyTime = (process.env.DAILY_TIME ?? "07:30").trim();
  if (!DAILY_TIME_RE.test(dailyTime)) {
    throw new Error(
      `DAILY_TIME must be 24h "HH:MM" (got "${dailyTime}"), e.g. 07:30.`
    );
  }

  const tz = (process.env.TZ ?? "America/Chicago").trim();
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();

  const portRaw = (process.env.PORT ?? "3000").trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number (got "${portRaw}").`);
  }

  const dashboardPassword = (process.env.DASHBOARD_PASSWORD ?? "").trim();

  return {
    telegramBotToken,
    telegramChatId,
    dailyTime,
    tz,
    anthropicApiKey,
    port,
    dashboardPassword,
  };
}

/** Parse "HH:MM" into a node-cron expression that fires daily at that time. */
export function dailyTimeToCron(dailyTime: string): string {
  const match = DAILY_TIME_RE.exec(dailyTime);
  if (!match) {
    throw new Error(`Invalid DAILY_TIME: ${dailyTime}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return `${minute} ${hour} * * *`;
}
