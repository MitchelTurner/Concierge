# Concierge

[![Node 20](https://img.shields.io/badge/node-20.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/TheMitchyBoy/Concierge/actions/workflows/ci.yml/badge.svg)](https://github.com/TheMitchyBoy/Concierge/actions/workflows/ci.yml)

Your side-hustle focus assistant.
A lightweight personal assistant + business analyst for a dev side-hustle —
It is **not** a chat app, Kanban board, or generic SaaS — it's a **cron job + a
PostgreSQL database + a Telegram bot + a web dashboard**. It runs on a schedule,
looks at your projects, and pushes you **one clear thing to do each day** so you
make money without burning out. Multiple users can sign up; each account's data
is isolated by `user_id`.

## Table of contents

- [Core idea — dual-track prioritization](#core-idea--dual-track-prioritization)
- [Stack](#stack)
- [Setup](#setup)
- [Run](#run)
- [Deploy to Railway](#deploy-to-railway-recommended-host)
- [Telegram commands](#telegram-commands)
- [Web dashboard](#web-dashboard)
- [Daily message format](#daily-message-format)
- [Progress-based accountability](#progress-based-accountability)
- [Project structure](#project-structure)
- [Data model](#data-model)
- [Roadmap](#roadmap-not-built-yet)
- [Contributing](#contributing)

## Core idea — dual-track prioritization

Every project is one of two types:

- **`fast`** — services / client work (local-business websites, paid software).
  This is income. **Always the priority.**
- **`passive`** — ads, affiliate, your own products. Long-game, slow to pay.
  Worked on only with leftover time.

Both are scored, but they live in separate queues. **Passive work can never push
fast/income work out of the day.**

### Scoring

```
speed = 6 - time_to_cash               # invert: faster cash scores higher
score = (revenue_potential * confidence * speed) / max(effort_remaining, 1)
```

### Daily allocation

- **Primary task** = `next_action` of the highest-scoring `fast` active project.
- **Secondary task** = `next_action` of the highest-scoring `passive` active
  project, time-boxed to 30 min, marked "only if you have time."
- **Deadline warnings** = any active project with a deadline within 3 days,
  surfaced at the top regardless of score.
- If there are **no fast active projects**, it says so plainly and tells you to
  go find/close a client — it never silently promotes passive work to primary.

## Stack

- TypeScript on Node 20+ (run directly with [`tsx`](https://github.com/privatenumber/tsx))
- [`pg`](https://node-postgres.com/) — PostgreSQL (multi-user, row-level isolation)
- [`bcryptjs`](https://github.com/dcodeIO/bcrypt.js) — password hashing
- [`node-cron`](https://github.com/node-cron/node-cron) — per-user timezone-aware scheduler
- [`telegraf`](https://telegraf.js.org/) — Telegram bot (linked per account)
- [`express`](https://expressjs.com/) — web dashboard API + signup/login (vanilla HTML/JS, no build step)
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) — optional AI chat agent (`claude-sonnet-4-6`)
- `dotenv` — config

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Add PostgreSQL

Locally, run Postgres (Docker example):

```bash
docker run -d --name concierge-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
export DATABASE_SSL=false
```

On Railway: add a **Postgres** service. Railway injects `DATABASE_URL` automatically
when you reference it on your app service.

### 3. Create a Telegram bot and get a token

1. In Telegram, open a chat with [**@BotFather**](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (give it a name and a username ending
   in `bot`).
3. BotFather replies with a token like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxx`.
   That's your `TELEGRAM_BOT_TOKEN`.

### 4. Fill in `.env`

```bash
cp .env.example .env
```

Then edit `.env`:

```ini
TELEGRAM_BOT_TOKEN=123456789:AAE...     # from @BotFather
DATABASE_URL=postgres://...             # PostgreSQL connection string
DATABASE_SSL=false                      # local only; omit on Railway
DAILY_TIME=07:30                        # default for new signups
CHECKIN_TIME=20:00                      # default for new signups
STALL_DAYS=4                            # default stall threshold
TZ=America/Chicago                      # default timezone for new signups
ANTHROPIC_API_KEY=                      # optional — enables AI assistant
```

### 5. Sign up and link Telegram

1. Start the app (`npm run dev`) and open the dashboard.
2. **Create an account** (email + password).
3. Open **Settings → Generate link code**, then send `/link YOUR_CODE` to your bot.
4. Per-user schedule (daily nudge, check-in, timezone) is editable in Settings.

## Run

### Long-running process (default)

Boots the DB, the bot, and the scheduler. The bot stays online for two-way
commands and fires the daily nudge at `DAILY_TIME`.

```bash
npm run dev      # with auto-reload while developing
# or
npm start        # plain run
```

On first signup the database auto-creates tables. Locally, new accounts may get
demo projects if `SEED_DEMO_DATA` is enabled (default locally, off on Railway).

### One-shot daily nudge (for external cron)

```bash
npm run daily -- user@example.com
```

Example GitHub Actions cron (`.github/workflows/daily.yml`):

```yaml
on:
  schedule:
    - cron: "30 13 * * *" # 07:30 America/Chicago == 13:30 UTC (adjust for DST)
jobs:
  nudge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run daily -- user@example.com
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TZ: America/Chicago
```

> The long-running process on Railway is preferred — it handles per-user schedules
> automatically. Use `npm run daily` only for one-off sends or external cron.

## Deploy to Railway (recommended host)

Concierge is a long-running process: Telegram bot (long polling), per-user
scheduler, and web dashboard. [Railway](https://railway.com) runs this well. The
repo ships `railway.json` so the service builds with Nixpacks and runs `npm start`.

**You need Postgres.** Add a Railway Postgres service and link `DATABASE_URL` to
your app. No volume mount is required for the database — Postgres persists data
across deploys.

### Steps

1. **Create the service.** *New Project → Deploy from GitHub repo* and pick this repo.
2. **Add Postgres.** *New → Database → PostgreSQL*. On your app service Variables,
   add a reference to `${{Postgres.DATABASE_URL}}` as `DATABASE_URL`.
3. **Set environment variables:**

   ```ini
   TELEGRAM_BOT_TOKEN=123456789:AAE...   # from @BotFather
   DAILY_TIME=07:30                      # default for new signups
   CHECKIN_TIME=20:00                    # default for new signups
   STALL_DAYS=4
   TZ=America/Chicago
   ANTHROPIC_API_KEY=sk-ant-...          # optional — AI assistant
   ```

4. **Expose the dashboard.** *Settings → Networking → Generate Domain*.
5. **Sign up** at your domain, then link Telegram in Settings.

Check deploy logs for `[db] postgres ready`, `[web] dashboard listening`, and
`[bot] online and listening for commands`.

### Notes & gotchas

- **Per-user schedules.** Each account sets daily nudge time, check-in time, and
  timezone in the dashboard Settings tab. Env `DAILY_TIME` / `CHECKIN_TIME` /
  `TZ` are defaults for **new signups** only.
- **Multiple replicas are OK** with Postgres (unlike SQLite). Still avoid running
  the same bot token in two places — only one process should long-poll Telegram.
- **`409: Conflict` from Telegram** means two instances are polling the same bot
  token. Stop duplicate deployments or local runs.

## Telegram commands

Link your account first (`/link CODE` from dashboard Settings). Then:

| Command | What it does |
| --- | --- |
| `/link CODE` | Link this Telegram chat to your dashboard account |
| `/unlink` | Disconnect Telegram from your account |
| `/today` | Re-send today's allocation on demand |
| `/list` | List active projects with id, name, type, score (compact) |
| `/add` | Guided add, one question at a time (name → type → revenue 1-5 → confidence 1-5 → time_to_cash 1-5 → effort hrs → next action) |
| `/next {id} {text}` | Set the `next_action` for a project (stamps progress) |
| `/done {id}` | Mark the current next action complete (stamps progress), then prompt for the new one |
| `/progress {id} [note]` | Log progress without changing the next action — resets the stall clock; an optional note is saved to `daily_log` |
| `/status {id} {status}` | Update status (`idea`/`active`/`blocked`/`shipped`/`paid`/`archived`) |
| `/skip` | Skip the evening check-in (reply to the check-in prompt) |
| `/cancel` | Abort an in-progress `/add` or `/done` follow-up |

## Web dashboard

Sign up with email/password. Each account has isolated projects, goals, and
settings. The dashboard runs in the same process as the bot and shares Postgres,
so edits show up immediately in `/today`, `/list`, etc.

- **Auth:** `POST /api/auth/signup`, `POST /api/auth/login` return a bearer token.
  All `/api/*` data routes require `Authorization: Bearer <token>`.
- **Settings tab:** per-user schedule (daily nudge, check-in, timezone, stall days)
  and Telegram link code generation.
- **No build step.** Static `public/index.html` + Express API in `src/server.ts`.

### AI chat agent (Assistant tab)

A dedicated agent that acts as your business analyst. It's built from
`@anthropic-ai/sdk` and, on every message, gets a system prompt assembled **live**
from your current goals, active projects (with scores, deadlines, stall info),
and the computed daily allocation — so its advice always reflects the real
state.

- **Opt-in.** The agent is enabled only when `ANTHROPIC_API_KEY` is set;
  otherwise the Assistant tab shows a "not configured" notice. Model defaults to
  `claude-sonnet-4-6` and is overridable via `ANTHROPIC_MODEL`.
- **Read-only context.** The agent reasons over your data and gives concrete,
  time-aware advice (it doesn't edit projects itself — you do that on the Manage
  tab). Ask things like "what should I focus on tonight?", "rank my fast
  projects and sharpen each next action", or "which projects are stalling?".
- Conversation history is kept in the browser session (not persisted
  server-side) and the most recent turns are sent with each request.

Run locally:

```bash
# set DATABASE_URL and DATABASE_SSL=false, then:
npm run dev
# open http://localhost:3000 and create an account
```

API (authenticated routes require `Authorization: Bearer <token>`):

| Method & path | Purpose |
| --- | --- |
| `POST /api/auth/signup` · `POST /api/auth/login` | Create account / sign in |
| `GET /api/auth/me` · `PATCH /api/auth/me` | Profile and schedule settings |
| `POST /api/auth/telegram-link` | Generate Telegram link code |
| `GET /api/projects` · `POST /api/projects` | List / create projects |
| `PATCH /api/projects/:id` · `DELETE /api/projects/:id` | Edit / delete a project |
| `GET /api/goals` · `POST /api/goals` | List / create goals |
| `PATCH /api/goals/:id` · `DELETE /api/goals/:id` | Edit / delete a goal |
| `GET /api/chat/status` | Whether the AI agent is enabled + its model |
| `POST /api/chat` | Send `{ messages: [{role, content}] }`, get `{ reply }` |

## Daily message format

```
☀️ Today's focus

⏰ Heads up:
• Joe's Pizza website (#1) — due in 2d

💰 PRIMARY (income): Joe's Pizza website
→ Send the final invoice and deploy the menu page
Why: closest to getting paid (score 7.5).

🌱 If you have 30 min spare: Niche affiliate blog
→ Write one 1500-word review post targeting a buyer keyword
(only if you have time after the above)

Reply /done {id} when you finish something.

⚠️ Stalling:
• Dental clinic booking tool (#2) — 6 days since progress
• Niche affiliate blog (#3) — 9 days since progress
Passive projects: quietly letting them rot is how they die.
```

## Progress-based accountability

Concierge tracks momentum, not just priority — it works for any project type
(client sites, sales, passive products), not just code.

- **Progress stamping.** Every project has a `last_progress_at` timestamp. It's
  set whenever you make progress: on `/done`, on `/next`, and via
  `/progress {id} [note]` (which stamps without changing the next action and
  optionally logs a note).
- **Stall detection.** An `active` project is *stalling* if it has no recorded
  progress, or its last progress is older than `STALL_DAYS` (default 4). A
  `⚠️ Stalling` section is appended to the daily message listing each one as
  `name — N days since progress`. If any stalled project is `passive`, a line
  reminds you that quietly letting them rot is how they die.
- **Evening check-in.** At `CHECKIN_TIME` (default 20:00, same timezone) the bot
  asks *"What did you move forward today?"* Reply in plain text and it's saved
  to the `daily_log` table; the bot confirms and lists anything still stalling so
  you end the day knowing what's slipping. Send `/skip` to skip logging. (An
  in-progress `/add` always takes priority, so the check-in can't collide with
  it.)

## Project structure

```
concierge/
  src/
    index.ts       # entry: boot DB, bot, scheduler, web server
    config.ts      # load + validate env
    db.ts          # PostgreSQL schema, pool, typed query helpers
    auth.ts        # signup/login, sessions, password hashing
    scoring.ts     # score() + allocateDay() — core prioritization logic
    messages.ts    # daily message + list formatting (shared by bot & scheduler)
    bot.ts         # Telegraf commands (/add wizard, check-in, /progress)
    scheduler.ts   # per-user timezone cron → daily nudge + evening check-in
    server.ts      # Express API + static dashboard
    ai.ts          # Anthropic assistant with live context + tools
    daily.ts       # one-shot: send allocation to one user and exit
  public/
    index.html     # web dashboard (vanilla HTML/CSS/JS, no build step)
  docs/
    ARCHITECTURE.md  # how modules connect at runtime
    DATABASE.md      # schema and storage notes
  .github/workflows/
    ci.yml           # typecheck on push/PR
  .env.example
  LICENSE
  CONTRIBUTING.md
  package.json
  README.md
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a runtime diagram and data-flow notes.

## Data model

> See [`docs/DATABASE.md`](docs/DATABASE.md) for how storage works, the
> SQLite-vs-Postgres rationale, and the database roadmap (backups, migrations,
> Phase 2/3 tables, and other future ideas).

Table `projects`:

| column | type | notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `name` | TEXT | required |
| `type` | TEXT | `fast` or `passive` |
| `client` | TEXT | nullable (for fast projects) |
| `revenue_potential` | INTEGER | 1–5 (5 = big money) |
| `confidence` | INTEGER | 1–5 (likelihood someone actually pays) |
| `time_to_cash` | INTEGER | 1–5 (1 = paid within days, 5 = months/never) |
| `effort_remaining` | INTEGER | estimated hours left to ship |
| `status` | TEXT | `idea` / `active` / `blocked` / `shipped` / `paid` / `archived` |
| `next_action` | TEXT | the single concrete next step |
| `deadline` | TEXT | ISO date, nullable |
| `notes` | TEXT | nullable |
| `last_progress_at` | TEXT | ISO datetime of most recent progress, nullable |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

Table `daily_log` (evening check-ins + `/progress` notes):

| column | type | notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `date` | TEXT | ISO date (YYYY-MM-DD) |
| `note` | TEXT | the free-text entry |
| `created_at` | TEXT | ISO datetime |

Table `goals` (edited from the web dashboard):

| column | type | notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `title` | TEXT | required |
| `detail` | TEXT | nullable |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

## Roadmap (not built yet)

- **Phase 2:** evening check-in + `daily_log` table are built; the Anthropic AI
  agent is available as the dashboard **Assistant** (see
  [AI chat agent](#ai-chat-agent-assistant-tab)). Still open: having the agent
  rewrite the formula-based allocation, and `/time {minutes}` to tailor
  suggestions to tonight's available time.
- **Phase 3:** Weekly review summary, calendar awareness. (An editable web
  dashboard — beyond the originally-planned read-only one — is already built; see
  [Web dashboard](#web-dashboard).)

The Phase 2/3 items above are intentionally **not** implemented yet.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, style, and PR expectations.
