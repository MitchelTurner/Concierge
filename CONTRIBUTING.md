# Contributing

Thanks for your interest in **Concierge**. This project is a focused side-hustle assistant — cron + Postgres + Telegram + a small web dashboard — and contributions that keep it simple are welcome.

## Getting started

1. Fork and clone the repo.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `TELEGRAM_BOT_TOKEN`.
4. Run locally: `npm run dev`

See [README.md](README.md) for full setup (Postgres, Telegram linking, Railway deploy).

## Development workflow

1. Create a branch from `main`.
2. Make your changes with a clear, minimal diff.
3. Run the type checker before opening a PR:

   ```bash
   npm run typecheck
   ```

4. Open a pull request describing **what** changed and **why**.

## Code style

- **TypeScript** with ES modules (`"type": "module"`).
- Match existing patterns: small modules, explicit types, no unnecessary abstractions.
- Comments should explain *why* or non-obvious business rules (e.g. dual-track prioritization), not restate the code.
- Prefer extending existing helpers in `db.ts`, `scoring.ts`, and `messages.ts` over duplicating logic.

## Project layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Process entry — boots DB, bot, scheduler, web server |
| `src/db.ts` | PostgreSQL schema and typed query helpers |
| `src/scoring.ts` | Priority formula and daily allocation |
| `src/messages.ts` | Telegram message formatting |
| `src/bot.ts` | Telegraf command handlers |
| `src/scheduler.ts` | Per-user timezone-aware cron |
| `src/server.ts` | Express API + static dashboard |
| `src/ai.ts` | Optional Anthropic assistant with tools |
| `public/index.html` | Vanilla web dashboard (no build step) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces connect at runtime.

## Reporting issues

Include:

- What you expected vs what happened
- Steps to reproduce
- Relevant env (local vs Railway, linked Telegram or not)
- Log lines if the bot or scheduler failed

## Scope

This is intentionally **not** a generic project-management SaaS. PRs that add large frameworks, heavy UI build pipelines, or features from the [roadmap](README.md#roadmap-not-built-yet) may be better discussed in an issue first.
