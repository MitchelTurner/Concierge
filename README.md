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
- [Roadmap](#roadmap)
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

- **Primary task** = first open task on the highest-scoring `fast` active project
  (falls back to `next_action` only if no tasks exist).
- **Secondary task** = first open task on the highest-scoring `passive` active
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
OPENAI_API_KEY=                         # optional — enables Telegram voice-note transcription
SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASS= SMTP_FROM=   # optional — client outreach email sending
IMAP_HOST= IMAP_PORT= IMAP_USER= IMAP_PASS=              # optional — client reply detection
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
   OPENAI_API_KEY=sk-...                 # optional — voice-note transcription
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
| `/time {minutes}` | Fit tasks to a block of free time (income work first, ~30 min per task) |
| `/review` | Weekly review on demand (also sent automatically on your review day) |
| `/list` | List active projects with id, name, type, score (compact) |
| `/add` | Guided add, one question at a time (name → type → scoring → description → optional first task) |
| `/next {id} {text}` | Add a task to a project (stamps progress) |
| `/done {id}` | Mark the next open task complete (stamps progress), then prompt for a new one |
| `/progress {id} [note]` | Log progress without completing a task — resets the stall clock; an optional note is saved to `daily_log` |
| `/status {id} {status}` | Update status (`idea`/`active`/`blocked`/`shipped`/`paid`/`archived`) |
| `/contact {id} {name} {email}` | Save the client contact for a project |
| `/contacts` | List saved contacts |
| `/draft {id} {what you're waiting on}` | Draft a chase-up email to the project's client |
| `/outreach` | List open drafts and sent emails awaiting a reply |
| `/skip` | Skip the evening check-in (reply to the check-in prompt) |
| `/cancel` | Abort an in-progress `/add`, `/done` follow-up, or draft edit |
| `/reset` | Clear the AI assistant's conversation memory for this chat |

**Talk to it in plain language.** When `ANTHROPIC_API_KEY` is set, any message
that isn't a command (and isn't answering a wizard or check-in prompt) goes to
the same AI assistant as the dashboard's Assistant tab — with your live
portfolio as context and full tool access. So *"mark the invoice task done and
add a task to follow up with the client Friday"* just works from your phone.
Conversation history is kept in memory per chat (cleared on restart or
`/reset`).

**Send voice notes.** When `OPENAI_API_KEY` is set, a Telegram voice message is
transcribed, saved as a call note, and (with the AI assistant enabled) mined
for suggested follow-up tasks. The transcript is seeded into the assistant
conversation, so replying *"add those to project 3"* saves the tasks.

**Record calls live from the dashboard.** In the **Call notes** tab, hit
**Record & transcribe** to capture a call or meeting straight from your
microphone. Audio is streamed in short segments to the transcription endpoint
(`OPENAI_API_KEY`), so the transcript fills the notes box in near real time.
When the AI assistant is also configured (`ANTHROPIC_API_KEY`), a live panel
keeps two things up to date as you talk: **running notes** (key points,
decisions, commitments) and **questions to ask next** (scope, budget, timeline,
close). Link the capture to a project first and the suggestions use that
project's context. Stop the recording or hit **Save note** to store the
transcript like any other call note — then **Extract tasks** as usual.

**Morning nudge buttons.** The daily focus message ships with inline buttons:
**✅ On it** (commit to the task), **🔁 Swap task** (get the next-best
alternative from a different project), and **😴 Not today** (skip guilt-free).

**Proactive alerts.** Outside the fixed schedule, the bot checks hourly
(9:00–20:59 local) and pings you when a project's deadline enters the 3-day
window or an active project crosses your stall threshold. Each alert fires
once per condition — progress on a project re-arms its stall alert.

## Client outreach — chase what's blocking you

When a project is stuck waiting on a client (photos, content, approval,
payment), Concierge writes the chase-up email, you review and send it from
Telegram, and it tells you when the client replies.

1. **Save the contact** once per project: `/contact 3 Joe Rossi joe@pizza.com`
   (or in the dashboard's **Contacts** section, or tell the assistant
   *"the client for project 3 is Joe, joe@pizza.com"*).
2. **Draft the email**: `/draft 3 photos of the finished kitchen` — the AI
   writes a short, friendly nudge using project context and your saved
   memories (a plain template is used when AI is not configured). You can also
   just tell the assistant *"I'm still waiting on photos from Joe — chase him"*.
3. **Review in Telegram**: the draft arrives with **📤 Send**, **✏️ Edit**
   (describe changes in plain language or paste a replacement), and
   **🗑 Discard** buttons.
4. **Send** goes out over SMTP (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/
   `SMTP_PASS`/`SMTP_FROM` — any provider, e.g. a Gmail app password) and
   stamps progress on the project.
5. **Reply detection**: with IMAP configured (`IMAP_HOST`/`IMAP_USER`/
   `IMAP_PASS`), the inbox is polled every 5 minutes while replies are
   outstanding. Replies are matched by the email's `In-Reply-To` header (or
   sender address as a fallback), you get a Telegram ping with a snippet, and
   the AI adds a one-line read on whether the client actually sent what you
   need. `/outreach` shows what's still pending.

Setting a project to `blocked` (via `/status`) reminds you that `/draft` exists
when a contact is on file. Without SMTP you can still draft and copy emails;
without IMAP everything works except the automatic reply notification.

## Web dashboard

Sign up with email/password. Each account has isolated projects, goals, and
settings. The dashboard runs in the same process as the bot and shares Postgres,
so edits show up immediately in `/today`, `/list`, etc.

- **Auth:** `POST /api/auth/signup`, `POST /api/auth/login` return a bearer token.
  All `/api/*` data routes require `Authorization: Bearer <token>`.
- **Settings tab:** per-user schedule (daily nudge, check-in, weekly review
  day/time, timezone, stall days) and Telegram link code generation.
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
- **Default read-only, opt-in writes.** The agent reasons over your data and gives
  concrete, time-aware advice by default. If you explicitly allow writes for a
  message, it can create or update projects, goals, and tasks on your behalf.
  Ask things like "what should I focus on tonight?", "rank my fast projects and
  sharpen each next action", or "draft this new project and save it".
- Conversation history is kept in the browser session (not persisted
  server-side) and the most recent turns are sent with each request.
- **Memory.** Tell the assistant "remember that I only work on the business
  after 8pm" and it saves the fact to a per-user `user_memory` table (via the
  `save_memory` tool). Memories are included in every future chat — dashboard
  and Telegram — and can be reviewed or removed in Settings, or by asking the
  assistant to forget them.
- **Calendar context.** If a calendar ICS URL is set in Settings, the assistant
  sees today's events alongside your portfolio, so "what should I do today?"
  accounts for your meetings.

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
| `GET /api/projects` · `POST /api/projects` | List / create projects (with optional `tasks[]`) |
| `PATCH /api/projects/:id` · `DELETE /api/projects/:id` | Edit / delete a project |
| `POST /api/projects/:id/tasks` | Add one task (`title`) or bulk (`titles[]`) |
| `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id` | Update / delete a task |
| `POST /api/projects/:id/suggest-tasks` | AI task suggestions for a project |
| `GET /api/meeting-notes` · `POST /api/meeting-notes` | List / create call & meeting notes |
| `PATCH /api/meeting-notes/:id` · `DELETE /api/meeting-notes/:id` | Edit / delete a note |
| `POST /api/meeting-notes/:id/extract-tasks` | AI follow-up tasks from a note |
| `GET /api/notes/record-status` | Whether live recording (transcription) and live assist (AI) are configured |
| `POST /api/transcribe` | Transcribe one audio segment (raw audio body) → `{ text }` |
| `POST /api/meeting-notes/live-assist` | Running transcript → `{ notes[], questions[] }` for live capture |
| `GET /api/daily-log` | Recent progress log entries (Telegram check-ins & `/progress`) |
| `GET /api/goals` · `POST /api/goals` | List / create goals |
| `PATCH /api/goals/:id` · `DELETE /api/goals/:id` | Edit / delete a goal |
| `GET /api/memories` · `DELETE /api/memories/:id` | List / remove assistant memories |
| `GET /api/contacts` · `POST /api/contacts` | List / create client contacts |
| `PATCH /api/contacts/:id` · `DELETE /api/contacts/:id` | Edit / delete a contact |
| `GET /api/outreach` | Open outreach (drafts + sent awaiting reply); drafting/sending lives in Telegram |
| `GET /api/chat/status` | Whether the AI agent is enabled + its model |
| `POST /api/chat` | Send `{ messages: [{role, content}] }`, get `{ reply }` |

## Daily message format

```
☀️ Today's focus

📅 Today: 2 events, ~1.5h booked
• 09:00–09:30 Standup
• 13:00–14:00 Dentist

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

The calendar section appears only when an ICS URL is configured in Settings.
On Telegram the message also carries **On it / Swap task / Not today** inline
buttons.

## Progress-based accountability

Concierge tracks momentum, not just priority — it works for any project type
(client sites, sales, passive products), not just code.

- **Progress stamping.** Every project has a `last_progress_at` timestamp. It's
  set when you complete a task, add a task (web or Telegram), or use
  `/progress {id} [note]` (which stamps without completing a task and
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
  it.) When the AI assistant is configured, the check-in is also parsed: tasks
  you clearly finished are marked done and projects you mention get their stall
  clock reset — you report once and the system updates itself.
- **Weekly review.** Once a week (default Sunday 17:00 local, configurable in
  Settings) the bot sends a review: tasks shipped in the last 7 days grouped by
  project, check-in streak, anything stalling, and the suggested focus for next
  week. `/review` sends it on demand.

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
    bot.ts         # Telegraf commands (/add wizard, check-in, /time), voice notes, AI free-text chat
    scheduler.ts   # per-user timezone cron → nudges, weekly review, proactive alerts
    alerts.ts      # event-driven deadline/stall pings (once per condition)
    calendar.ts    # ICS feed fetch/parse → today's events (nudge + AI context)
    transcribe.ts  # OpenAI voice-note transcription (optional)
    email.ts       # SMTP sending + fallback chase-up template (optional)
    inbox.ts       # IMAP polling → client reply detection (optional)
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
| `next_action` | TEXT | legacy fallback when no open tasks exist |
| `deadline` | TEXT | ISO date, nullable |
| `notes` | TEXT | nullable |
| `last_progress_at` | TEXT | ISO datetime of most recent progress, nullable |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

Table `project_tasks` (checklist items — first open task drives daily focus):

| column | type | notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `project_id` | INTEGER | FK to projects |
| `title` | TEXT | task text |
| `done` | BOOLEAN | completion flag |
| `sort_order` | INTEGER | ordering within project |

Table `meeting_notes` (call & meeting capture from web dashboard):

| column | type | notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `project_id` | INTEGER | optional FK to projects |
| `title` | TEXT | note title |
| `body` | TEXT | note content |
| `type` | TEXT | `call` or `meeting` |
| `participants` | TEXT | nullable |
| `occurred_at` | TEXT | ISO datetime |

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

## Roadmap

- **Phase 2 (done):** evening check-in + `daily_log`, the Anthropic AI agent
  (dashboard **Assistant** tab *and* free-text Telegram chat), AI-parsed
  check-ins, and `/time {minutes}` to tailor suggestions to tonight's available
  time. Still open: having the agent rewrite the formula-based allocation.
- **Phase 3 (done):** weekly review summary (scheduled + `/review`), calendar
  awareness (ICS feed in the nudge and AI context), assistant memory, voice
  notes, proactive deadline/stall alerts, and inline nudge buttons. (An
  editable web dashboard — beyond the originally-planned read-only one — is
  also built; see [Web dashboard](#web-dashboard).)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, style, and PR expectations.
