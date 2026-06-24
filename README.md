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
    config.ts      # load + validate env
    index.ts       # boot: init db, start bot, start scheduler
    daily.ts       # one-shot allocation + send + exit (npm run daily)
  data/
    operator.db    # gitignored, auto-created
  .env.example
  .gitignore
  package.json
  README.md
```

## Data model

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

## Roadmap (not built yet)

- **Phase 2:** Anthropic-powered prioritization (`claude-sonnet-4-6`), evening
  check-in + `daily_log` table, `/time {minutes}` to tailor suggestions.
- **Phase 3:** Weekly review summary, calendar awareness, optional read-only web
  dashboard.

These are intentionally **not** implemented in Phase 1.
