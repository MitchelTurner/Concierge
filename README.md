# Operator

A lightweight personal-assistant + business-analyst for a dev side-hustle.
It is **not** a chat app, Kanban board, or SaaS — it's a **cron job + a SQLite
database + a Telegram bot**. It runs on a schedule, looks at your projects, and
pushes you **one clear thing to do each day** so you make money without burning
out.

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
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — one local DB file
- [`node-cron`](https://github.com/node-cron/node-cron) — scheduler
- [`telegraf`](https://telegraf.js.org/) — Telegram bot
- [`express`](https://expressjs.com/) — optional web dashboard API (vanilla HTML/JS frontend, no build step)
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) — optional AI chat agent (`claude-sonnet-4-6`)
- `dotenv` — config

## Setup

### 1. Install dependencies

```bash
npm install
```

> `better-sqlite3` is a native module and compiles on install. You need a
> working build toolchain (on Debian/Ubuntu: `apt-get install -y build-essential python3`).

### 2. Create a Telegram bot and get a token

1. In Telegram, open a chat with [**@BotFather**](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (give it a name and a username ending
   in `bot`).
3. BotFather replies with a token like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxx`.
   That's your `TELEGRAM_BOT_TOKEN`.

### 3. Find your numeric chat id

1. **Send any message to your new bot first** (e.g. `hi`). The bot can't message
   you until you've started a chat with it.
2. Open this URL in a browser, substituting your token:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Look for `"chat":{"id":123456789,...}`. That number is your
   `TELEGRAM_CHAT_ID`.
   - Alternatively, message [`@userinfobot`](https://t.me/userinfobot) and it
     replies with your id.

### 4. Fill in `.env`

```bash
cp .env.example .env
```

Then edit `.env`:

```ini
TELEGRAM_BOT_TOKEN=123456789:AAE...     # from @BotFather
TELEGRAM_CHAT_ID=123456789              # your numeric chat id
DAILY_TIME=07:30                        # 24h local time for the daily nudge
CHECKIN_TIME=20:00                      # 24h local time for the evening check-in
STALL_DAYS=4                            # no progress in this many days = "stalling"
TZ=America/Chicago                      # for cron correctness
ANTHROPIC_API_KEY=                      # Phase 2 only — leave blank
DATABASE_PATH=                          # optional; leave blank locally (defaults to data/operator.db)
```

## Run

### Long-running process (default)

Boots the DB, the bot, and the scheduler. The bot stays online for two-way
commands and fires the daily nudge at `DAILY_TIME`.

```bash
npm run dev      # with auto-reload while developing
# or
npm start        # plain run
```

On first run the database auto-creates at `data/operator.db` and is seeded with
example projects (2 fast, 2 passive) so you can see it work immediately, then
edit/replace them.

### One-shot (for GitHub Actions cron)

Builds today's allocation, sends it once, and exits. Drop-in alternative to the
long-running scheduler:

```bash
npm run daily
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
      - run: npm run daily
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          TZ: America/Chicago
```

> Note: GitHub Actions has an ephemeral filesystem, so the SQLite file does not
> persist between runs there. For a persistent DB use the long-running process
> on a host like Railway/Fly, or commit/restore the DB as a workflow artifact.

## Deploy to Railway (recommended host)

Operator is a long-running worker (no HTTP server, no inbound port needed — the
Telegram bot uses long polling). [Railway](https://railway.com) runs this kind
of process well. The repo ships a `railway.json` so the service builds with
Nixpacks and runs `npm start` with an automatic restart-on-failure policy.

**The one thing you must not skip:** Railway's filesystem is ephemeral and is
wiped on every redeploy. Attach a **persistent volume** and point the database
at it, or you'll lose your projects on each deploy.

### Steps

1. **Create the service.** In Railway, *New Project → Deploy from GitHub repo*
   and pick this repo. Railway detects `railway.json` and Node automatically.
   (CLI alternative: `npm i -g @railway/cli`, then `railway login` and
   `railway up` from the repo root.)
2. **Add a persistent volume.** On the service: *Settings → Volumes → Add
   Volume*, mount path `/data`. This directory now survives redeploys.
3. **Set environment variables.** On the service *Variables* tab, add:

   ```ini
   TELEGRAM_BOT_TOKEN=123456789:AAE...   # from @BotFather
   TELEGRAM_CHAT_ID=123456789            # your numeric chat id
   DAILY_TIME=07:30                      # local time of the daily nudge
   CHECKIN_TIME=20:00                    # local time of the evening check-in
   STALL_DAYS=4                          # no progress in N days = "stalling"
   TZ=America/Chicago                    # MUST match the times' locale
   DATABASE_PATH=/data/operator.db       # <-- points the DB at the volume
   DASHBOARD_PASSWORD=choose-a-strong-one # enables the web dashboard (see below)
   ANTHROPIC_API_KEY=sk-ant-...          # enables the Assistant AI agent (optional)
   # ANTHROPIC_MODEL=claude-sonnet-4-6   # optional model override
   ```

   `DATABASE_PATH` must live under the volume mount path (`/data`). The DB and
   its schema/seed are created automatically on first boot. Don't set `PORT` —
   Railway injects it.
4. **Expose the dashboard.** On the service: *Settings → Networking → Generate
   Domain* to get a public `https://…up.railway.app` URL. Open it — if you
   haven't set `DASHBOARD_PASSWORD` yet, the page tells you to; once it's set,
   log in with it.
5. **Deploy.** Railway builds and starts the service. Check the deploy logs for:

   ```
   [db] ready
   [scheduler] daily nudge scheduled at 07:30 (America/Chicago) [cron: "30 7 * * *"]
   [web] dashboard listening on port 8080
   [bot] online and listening for commands
   ```

   Then message your bot `/today` to confirm it responds, and open the domain
   to edit projects/goals.

### Notes & gotchas

- **`TZ` matters.** `node-cron` fires `DAILY_TIME` in the `TZ` you set, so make
  sure they agree (e.g. `07:30` + `America/Chicago`).
- **One replica only.** Keep `numReplicas: 1` (already set in `railway.json`).
  Two instances would double-send the daily message and both long-poll the same
  bot. SQLite is single-file and not meant for concurrent writers either.
- **`409: Conflict` from Telegram = two instances polling the same token.**
  Only one process may long-poll a bot at a time. Causes: an overlapping deploy
  still shutting down (transient — the boot now retries with backoff and the web
  dashboard stays up regardless), a duplicate Railway service/deployment using
  the same `TELEGRAM_BOT_TOKEN`, or the bot also running somewhere else (e.g.
  locally). Make sure exactly **one** instance runs. If a stuck deployment keeps
  conflicting, redeploy so only the newest is active, and don't reuse the same
  token across two services.
- **Generate a domain to reach the dashboard.** The web server always listens,
  but it's only reachable once you generate a domain (step 4). Set a **strong**
  `DASHBOARD_PASSWORD` before exposing it, since the URL is public.
- **Node is pinned to 20 (LTS).** `package.json` `engines` (`20.x`), `.nvmrc`,
  and `nixpacks.toml` all agree on Node 20 so `better-sqlite3` installs its
  **prebuilt binary** instead of compiling from source. (On newer Node majors
  there may be no prebuilt binary yet, which forces a `node-gyp` build that
  needs Python + a C/C++ toolchain — `nixpacks.toml` installs those as a safety
  net, but pinning Node 20 avoids the compile entirely.)

## Telegram commands

Only your configured `TELEGRAM_CHAT_ID` is allowed to interact; everyone else is
ignored.

| Command | What it does |
| --- | --- |
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

An optional web UI for editing **projects (tasks)** and **goals** from a browser
— handy when you want to bulk-edit or write longer notes than is comfortable in
Telegram. It runs in the same process as the bot and shares the same SQLite
database, so edits show up immediately in `/today`, `/list`, etc.

- **Always served, but gated.** The web server always starts (Railway needs a
  listening port for its domain). All `/api/*` routes require the
  `DASHBOARD_PASSWORD` (sent as an `x-dashboard-password` header). Until that
  password is set, every API route returns `503` and the page shows a "set a
  password" notice — no data is ever served unauthenticated (an empty password
  can't authenticate). Use a strong password on Railway since the URL is public,
  and rely on Railway's HTTPS.
- **No build step.** The frontend is a single static `public/index.html`
  (vanilla HTML/CSS/JS). The backend is a small Express API in `src/server.ts`.
- **What you can do:** view all projects with their live priority score; create,
  edit every field of, and delete projects; create/edit/delete goals; and — on
  the **Assistant** tab — chat with an AI agent that has your goals, projects,
  scores, and today's allocation as live context.

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
DASHBOARD_PASSWORD=dev npm run dev
# then open http://localhost:3000 and log in with "dev"
```

API (all require the `x-dashboard-password` header):

| Method & path | Purpose |
| --- | --- |
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

Operator tracks momentum, not just priority — it works for any project type
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
operator/
  src/
    db.ts          # schema init, seed, typed query helpers
    scoring.ts     # score() + allocateDay()
    messages.ts    # daily message + list formatting (shared by bot & scheduler)
    bot.ts         # telegraf commands (incl. /progress, /skip, check-in reply)
    scheduler.ts   # node-cron -> daily nudge + evening check-in
    server.ts      # express API for the web dashboard (auth + projects/goals CRUD + chat)
    ai.ts          # AI chat agent: live-context system prompt + Anthropic call
    config.ts      # load + validate env
    index.ts       # boot: init db, start bot, schedulers, web server
    daily.ts       # one-shot allocation + send + exit (npm run daily)
  public/
    index.html     # web dashboard (vanilla HTML/CSS/JS, no build step)
  data/
    operator.db    # gitignored, auto-created
  .env.example
  .gitignore
  package.json
  README.md
```

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
