import { config as loadDotenv } from "dotenv";

loadDotenv();

// ---------------------------------------------------------------------------
// Environment helpers — used by db.ts and signup defaults
// ---------------------------------------------------------------------------

/** True when running on Railway (or a Railway-compatible host). */
export function isRailway(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID
  );
}

/**
 * PostgreSQL connection string. Required — set `DATABASE_URL` to your Railway
 * Postgres (or local) instance.
 */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL. " +
        "Add a Postgres service and link DATABASE_URL (see README)."
    );
  }
  return url;
}

/**
 * Whether to insert demo projects/goals when a new user signs up.
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
  /** Anthropic API key for the AI chat agent. Empty = agent disabled. */
  anthropicApiKey: string;
  /** Anthropic model id for the chat agent. */
  anthropicModel: string;
  /** OpenAI API key for voice-note transcription. Empty = voice notes disabled. */
  openaiApiKey: string;
  /** OpenAI transcription model id. */
  openaiTranscribeModel: string;
  /** SMTP settings for sending client outreach emails. Empty host = sending disabled. */
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  /** From address for outgoing mail, e.g. "Alex <alex@example.com>". */
  smtpFrom: string;
  /** IMAP settings for detecting client replies. Empty host = reply detection disabled. */
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  /** HTTP port for the web dashboard (Railway sets PORT). */
  port: number;
  /** Default timezone for new accounts (users can override in settings). */
  defaultTz: string;
  /** Default daily nudge time for new accounts. */
  defaultDailyTime: string;
  /** Default evening check-in time for new accounts. */
  defaultCheckinTime: string;
  /** Default stall threshold for new accounts. */
  defaultStallDays: number;
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

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

function parseOptionalPort(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a valid port number (got "${raw}").`);
  }
  return n;
}

function parseTime(name: string, fallback: string): string {
  const value = (process.env[name] ?? fallback).trim();
  if (!TIME_RE.test(value)) {
    throw new Error(`${name} must be 24h "HH:MM" (got "${value}"), e.g. 07:30.`);
  }
  return value;
}

/**
 * Load and validate environment configuration. Throws with a clear message if
 * a required value is missing or malformed, so boot fails fast.
 */
export function loadConfig(): Config {
  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");

  const defaultDailyTime = parseTime("DAILY_TIME", "07:30");
  const defaultCheckinTime = parseTime("CHECKIN_TIME", "20:00");

  const stallDaysRaw = (process.env.STALL_DAYS ?? "4").trim();
  const defaultStallDays = Number(stallDaysRaw);
  if (!Number.isInteger(defaultStallDays) || defaultStallDays < 1) {
    throw new Error(
      `STALL_DAYS must be a positive whole number (got "${stallDaysRaw}"), e.g. 4.`
    );
  }

  const defaultTz = (process.env.TZ ?? "America/Chicago").trim();
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const anthropicModel = (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6").trim();
  const openaiApiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const openaiTranscribeModel = (process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1").trim();

  const smtpHost = (process.env.SMTP_HOST ?? "").trim();
  const smtpPort = parseOptionalPort("SMTP_PORT", 587);
  const smtpUser = (process.env.SMTP_USER ?? "").trim();
  const smtpPass = (process.env.SMTP_PASS ?? "").trim();
  const smtpFrom = (process.env.SMTP_FROM ?? smtpUser).trim();

  const imapHost = (process.env.IMAP_HOST ?? "").trim();
  const imapPort = parseOptionalPort("IMAP_PORT", 993);
  const imapUser = (process.env.IMAP_USER ?? smtpUser).trim();
  const imapPass = (process.env.IMAP_PASS ?? smtpPass).trim();

  const portRaw = (process.env.PORT ?? "3000").trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number (got "${portRaw}").`);
  }

  // Ensure DATABASE_URL is present at boot.
  getDatabaseUrl();

  return {
    telegramBotToken,
    anthropicApiKey,
    anthropicModel,
    openaiApiKey,
    openaiTranscribeModel,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFrom,
    imapHost,
    imapPort,
    imapUser,
    imapPass,
    port,
    defaultTz,
    defaultDailyTime,
    defaultCheckinTime,
    defaultStallDays,
  };
}

/** Parse "HH:MM" into a node-cron expression that fires every minute at that time. */
export function timeToMinuteCron(time: string): string {
  const match = TIME_RE.exec(time);
  if (!match) {
    throw new Error(`Invalid time: ${time}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return `${minute} ${hour} * * *`;
}
