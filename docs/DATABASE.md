# Database

Concierge uses **PostgreSQL** for multi-user SaaS: row-level isolation per account,
session auth, and a central database shared across app instances.

## TL;DR

- Storage is **PostgreSQL** via the `pg` driver and `DATABASE_URL`.
- Each user has their own projects, goals, and daily log — scoped by `user_id`.
- Auth uses email/password + bearer session tokens (not a shared dashboard password).
- Telegram is linked per-user via a one-time `/link CODE` command.

## Connection

Set `DATABASE_URL` to your Postgres connection string. On Railway, add a Postgres
service and reference `${{Postgres.DATABASE_URL}}` on your app service.

For local Postgres without SSL:

```
DATABASE_SSL=false
```

## Schema

### `users`

| column | type | notes |
| --- | --- | --- |
| `id` | SERIAL | PK |
| `email` | TEXT | unique, required |
| `password_hash` | TEXT | bcrypt |
| `name` | TEXT | nullable |
| `telegram_chat_id` | TEXT | unique, nullable — linked Telegram chat |
| `telegram_link_code` | TEXT | nullable — one-time link code from dashboard |
| `daily_time` | TEXT | `HH:MM` for morning nudge |
| `checkin_time` | TEXT | `HH:MM` for evening check-in |
| `timezone` | TEXT | IANA timezone for cron |
| `stall_days` | INTEGER | days without progress = stalling |
| `weekly_review_day` | INTEGER | 0 (Sunday) – 6 (Saturday) for the weekly review |
| `weekly_review_time` | TEXT | `HH:MM` for the weekly review |
| `last_daily_nudge_date` | DATE | prevents duplicate daily sends |
| `last_checkin_nudge_date` | DATE | prevents duplicate check-in sends |
| `last_weekly_review_date` | DATE | prevents duplicate weekly review sends |

### `sessions`

Bearer tokens for dashboard auth. Expire after 30 days.

### `projects`, `goals`, `daily_log`, `project_tasks`, `meeting_notes`

Same columns as defined in `src/db.ts`, plus `user_id INTEGER NOT NULL REFERENCES users(id)`
on user-owned tables. All queries are scoped by `user_id` for row-level isolation.

**Task-first focus:** daily allocation uses the first open row in `project_tasks`
(ordered by `sort_order`), falling back to `projects.next_action` only when no
open tasks exist.

**`project_tasks`** — checklist items per project (`title`, `done`, `sort_order`).

**`meeting_notes`** — call/meeting capture from the web dashboard (`title`, `body`,
`type`, `participants`, optional `project_id`).

**`daily_log`** — free-text progress from Telegram evening check-ins and
`/progress` commands. Readable via `GET /api/daily-log`.

## Multi-instance / SaaS

Postgres is the right choice when you need:

- **Multiple users** with per-account data isolation
- **Multiple app instances** writing concurrently (Railway replicas, rolling deploys)
- **Managed backups and replication** (Railway Postgres handles this)
- **Central DB** reachable from web, bot, and cron workers

## Related files

- `src/db.ts` — schema, migrations-on-boot, typed query helpers
- `src/auth.ts` — signup, login, sessions
- `src/config.ts` — `DATABASE_URL` resolution
- `README.md` — setup and Railway deploy steps
