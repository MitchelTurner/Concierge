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
   TZ=America/Chicago                    # MUST match DAILY_TIME's locale
   DATABASE_PATH=/data/operator.db       # <-- points the DB at the volume
   DASHBOARD_PASSWORD=choose-a-strong-one # enables the web dashboard (see below)
   # ANTHROPIC_API_KEY=                  # Phase 2 only, leave unset
   ```

   `DATABASE_PATH` must live under the volume mount path (`/data`). The DB and
   its schema/seed are created automatically on first boot. Don't set `PORT` —
   Railway injects it.
4. **Expose the dashboard (optional).** If you set `DASHBOARD_PASSWORD`, the web
   dashboard starts. On the service: *Settings → Networking → Generate Domain*
   to get a public `https://…up.railway.app` URL. Open it and log in with the
   password.
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
- **Public domain only needed for the dashboard.** If you don't set
  `DASHBOARD_PASSWORD`, no HTTP server starts and you don't need a domain. If you
  do, generate a domain (step 4) — and use a **strong** password, since the URL
  is public.
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
| `/next {id} {text}` | Set the `next_action` for a project |
| `/done {id}` | Mark the current next action complete, then prompt for the new one |
| `/status {id} {status}` | Update status (`idea`/`active`/`blocked`/`shipped`/`paid`/`archived`) |
| `/cancel` | Abort an in-progress `/add` or `/done` follow-up |

## Web dashboard

An optional web UI for editing **projects (tasks)** and **goals** from a browser
— handy when you want to bulk-edit or write longer notes than is comfortable in
Telegram. It runs in the same process as the bot and shares the same SQLite
database, so edits show up immediately in `/today`, `/list`, etc.

- **Opt-in & gated.** The server only starts when `DASHBOARD_PASSWORD` is set.
  All `/api/*` routes require the password (sent as an `x-dashboard-password`
  header); the static page itself holds no data. Use a strong password on
  Railway since the URL is public, and rely on Railway's HTTPS.
- **No build step.** The frontend is a single static `public/index.html`
  (vanilla HTML/CSS/JS). The backend is a small Express API in `src/server.ts`.
- **What you can do:** view all projects with their live priority score; create,
  edit every field of, and delete projects; and create/edit/delete goals.

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
```

## Project structure

```
operator/
  src/
    db.ts          # schema init, seed, typed query helpers
    scoring.ts     # score() + allocateDay()
    messages.ts    # daily message + list formatting (shared by bot & scheduler)
    bot.ts         # telegraf commands
    scheduler.ts   # node-cron -> allocateDay() -> send
    server.ts      # express API for the web dashboard (auth + projects/goals CRUD)
    config.ts      # load + validate env
    index.ts       # boot: init db, start bot, scheduler, web server
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
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

Table `goals` (edited from the web dashboard):

| column | type | notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `title` | TEXT | required |
| `detail` | TEXT | nullable |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

## Roadmap (not built yet)

- **Phase 2:** Anthropic-powered prioritization (`claude-sonnet-4-6`), evening
  check-in + `daily_log` table, `/time {minutes}` to tailor suggestions.
- **Phase 3:** Weekly review summary, calendar awareness. (An editable web
  dashboard — beyond the originally-planned read-only one — is already built; see
  [Web dashboard](#web-dashboard).)

The Phase 2/3 items above are intentionally **not** implemented yet.
