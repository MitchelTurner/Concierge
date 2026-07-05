# Architecture

High-level map of how **Concierge** runs as a single Node process.

## Runtime overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        npm start / npm run dev                   │
│                         src/index.ts                             │
└────────────┬────────────────────────────────────────────────────┘
             │
    ┌────────┼────────┬──────────────┬─────────────────┐
    ▼        ▼        ▼              ▼                 ▼
 initDb   createBot  startUser    startServer    session cleanup
 (db.ts)  (bot.ts)  Scheduler    (server.ts)    (hourly, db.ts)
                    (scheduler.ts)
             │              │
             │              └── every minute: for each linked user,
             │                  compare local time → send daily / check-in /
             │                  weekly review; hourly → proactive
             │                  deadline & stall alerts
             │
             └── Telegraf long-polling + command handlers
```

All user data lives in **PostgreSQL**. Every query is scoped by `user_id` so accounts stay isolated.

## Core domain: dual-track prioritization

Business logic is centralized in `scoring.ts` and reused everywhere:

1. **Score** each active project: `(revenue × confidence × speed) / effort`
2. **Split** into `fast` (income) and `passive` (long-game) queues
3. **Allocate** one primary task from `fast`, optional secondary from `passive`
4. **Never** promote passive work to primary when no fast projects exist

`messages.ts` turns allocation into Telegram text. The bot, scheduler, dashboard AI, and `npm run daily` all call the same helpers — one source of truth.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `config.ts` | Load and validate environment variables at boot |
| `db.ts` | Schema (`CREATE TABLE IF NOT EXISTS`), connection pool, CRUD |
| `auth.ts` | Signup/login, bcrypt passwords, bearer session tokens |
| `scoring.ts` | `score()`, `allocateDay()`, `planTimebox()`, deadline/stall date math |
| `messages.ts` | `formatDailyMessage()`, `formatProjectList()`, time-box + weekly review text |
| `bot.ts` | Telegram commands, guided `/add` wizard, check-in sessions, voice notes, AI free-text chat |
| `scheduler.ts` | Minute cron → per-user timezone nudges + weekly review (deduped by date), hourly alerts |
| `alerts.ts` | Proactive deadline/stall pings, deduped via one-shot `app_meta` claims |
| `calendar.ts` | ICS feed fetch (cached) + parse → today's events for nudges and AI context |
| `transcribe.ts` | Optional OpenAI transcription for Telegram voice notes |
| `email.ts` | Optional SMTP sending for client outreach + fallback draft template |
| `inbox.ts` | Optional IMAP polling — matches client replies to sent outreach, notifies via Telegram |
| `server.ts` | REST API under `/api/*`, serves `public/index.html` |
| `ai.ts` | Anthropic chat with live DB context + tools, memory, check-in parsing, email drafting |
| `daily.ts` | One-shot CLI: send today's message to one user and exit |

## Data flow examples

### Morning nudge

1. `scheduler.ts` sees user's local time matches `daily_time`
2. Checks `last_daily_nudge_date` to avoid duplicate sends
3. Calls `sendDailyMessage` → `formatDailyMessage` → `allocateDay`
4. Telegraf sends the formatted string to `telegram_chat_id`
5. `markDailyNudgeSent` records today's date

### Dashboard edit

1. Browser calls `PATCH /api/projects/:id` with bearer token
2. `server.ts` validates body, `db.ts` updates row
3. Next `/today` or scheduled nudge reads fresh data — no cache layer

### AI assistant

1. `POST /api/chat` with conversation history
2. `buildSystemPrompt` injects goals, projects, allocation, stalls
3. Claude may call `create_project` / `update_project` / `create_goal` tools
4. Tool results are written to Postgres; reply includes what changed

## Auth model

- **Web:** email + password → bcrypt hash in `users.password_hash`
- **Sessions:** random 32-byte hex token in `sessions`, 30-day expiry
- **API:** `Authorization: Bearer <token>` on all `/api/*` routes except signup/login
- **Telegram:** one-time link code from dashboard → `/link CODE` binds `telegram_chat_id`

## Deployment notes

- **Railway:** long-running `npm start`, Postgres via `DATABASE_URL`, `PORT` for HTTP
- **Single bot instance:** only one process should long-poll a given `TELEGRAM_BOT_TOKEN` (409 Conflict otherwise)
- **No frontend build:** dashboard is static HTML/JS in `public/`

## Further reading

- [DATABASE.md](DATABASE.md) — schema details and storage rationale
- [README.md](../README.md) — setup, commands, API reference
