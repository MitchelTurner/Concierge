import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** True when running on Railway (or a Railway-compatible host). */
export function isRailway(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID
  );
}

/**
 * Absolute path to the SQLite database file.
 *
 * Resolution order:
 * 1. `DATABASE_PATH` env var when set (relative paths on Railway resolve under `/data`)
 * 2. `/data/operator.db` on Railway (expects a persistent volume at `/data`)
 * 3. `<project>/data/operator.db` for local development
 *
 * On hosts with an ephemeral filesystem, set `DATABASE_PATH` to a path on a
 * mounted persistent volume so goals, projects, and logs survive restarts.
 */
function resolveDbPath(): string {
  const explicit = process.env.DATABASE_PATH?.trim();
  if (explicit) {
    if (path.isAbsolute(explicit)) return path.resolve(explicit);
    // Relative paths on Railway almost always mean a misconfigured deploy
    // (ephemeral app dir). Force them onto the volume mount.
    if (isRailway()) return path.resolve("/data", explicit);
    return path.resolve(explicit);
  }

  if (isRailway()) return path.resolve("/data/operator.db");

  return path.resolve(__dirname, "..", "data", "operator.db");
}

export const DB_PATH = resolveDbPath();

/** True when running on Railway without an explicit DATABASE_PATH override. */
export const DB_USES_RAILWAY_DEFAULT =
  !process.env.DATABASE_PATH?.trim() && isRailway();

/**
 * Whether to insert the built-in demo projects/goals on a fresh database.
 * Default: on locally only. On Railway/production, never — unless explicitly enabled.
 */
export function shouldSeedDemoData(): boolean {
  const flag = process.env.SEED_DEMO_DATA?.trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return !isRailway();
}

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  /** Daily nudge time in 24h "HH:MM" form. */
  dailyTime: string;
  /** Evening check-in time in 24h "HH:MM" form. */
  checkinTime: string;
  /** An active project with no progress in this many days is "stalling". */
  stallDays: number;
  /** IANA timezone string used for cron correctness. */
  tz: string;
  /** Anthropic API key for the AI chat agent. Empty = agent disabled. */
  anthropicApiKey: string;
  /** Anthropic model id for the chat agent. */
  anthropicModel: string;
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

  const checkinTime = (process.env.CHECKIN_TIME ?? "20:00").trim();
  if (!DAILY_TIME_RE.test(checkinTime)) {
    throw new Error(
      `CHECKIN_TIME must be 24h "HH:MM" (got "${checkinTime}"), e.g. 20:00.`
    );
  }

  const stallDaysRaw = (process.env.STALL_DAYS ?? "4").trim();
  const stallDays = Number(stallDaysRaw);
  if (!Number.isInteger(stallDays) || stallDays < 1) {
    throw new Error(
      `STALL_DAYS must be a positive whole number (got "${stallDaysRaw}"), e.g. 4.`
    );
  }

  const tz = (process.env.TZ ?? "America/Chicago").trim();
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const anthropicModel = (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6").trim();

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
    checkinTime,
    stallDays,
    tz,
    anthropicApiKey,
    anthropicModel,
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
