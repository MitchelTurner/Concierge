# Database

This document explains how Operator stores data today, why it's built this way,
and the ideas/updates planned (or worth considering) for the future.

## TL;DR

- Storage is a **single SQLite file** (`better-sqlite3`), not a database server.
- Its location is controlled by the `DATABASE_PATH` env var.
- This is deliberate and correct for a one-person tool. **Don't move to Postgres
  unless Operator becomes multi-user.**

## How it works today

### One file, no server

SQLite is not a separate service — it's a library that reads and writes one file
on disk. There's no connection string, no port, no credentials, no extra process
to run. The app talks to it synchronously via `better-sqlite3`.

The schema and seed data are created automatically on first boot (see
`src/db.ts`); there is no manual setup step.

### Where the file lives — `DATABASE_PATH`

```
DATABASE_PATH (env)  ->  if set, the DB file is here (resolved to absolute)
unset                ->  defaults to <project>/data/operator.db
```

- **Locally:** leave `DATABASE_PATH` blank. The file is `data/operator.db` in the
  project (gitignored, so it never gets committed).
- **On Railway (or any ephemeral host):** the container filesystem is wiped on
  every redeploy. You must:
  1. Attach a **persistent volume** (mount path `/data`), and
  2. Set `DATABASE_PATH=/data/operator.db`.

  The volume is the only storage that survives deploys, so the DB has to live
  there. The parent directory is created automatically on boot.

### Schema (table `projects`)

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

`type` and `status` are enforced with `CHECK` constraints. WAL journal mode is
enabled for safer concurrent reads.

### Schema (table `goals`)

High-level goals that frame why the projects matter, edited from the web
dashboard. Seeded with one example on first run.

| column | type | notes |
| --- | --- | --- |
| `id` | INTEGER | PK autoincrement |
| `title` | TEXT | required |
| `detail` | TEXT | nullable |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

## Why SQLite (and not Postgres)

For this app SQLite is the right tool, not a compromise:

- **Tiny workload.** One user, a handful of projects, a few writes a day from
  Telegram commands, one scheduled read. SQLite handles this effortlessly.
- **Operationally trivial.** No server to run, no connection pool, no
  `DATABASE_URL`, no second Railway service to pay for.
- **Minimal dependencies.** Matches the project's "keep it small" constraint.

Postgres's strengths — many concurrent clients, network access, replication —
are things this tool never needs. Adding it would mean another service, a driver
or ORM, migrations tooling, and credentials, all to store a few rows. That's
strictly worse here.

### When Postgres *would* make sense later

Revisit only if the shape of the project changes:

- **Multi-user / multi-tenant** (e.g. turning this into a SaaS for other
  freelancers) — concurrent writers are where SQLite gets awkward.
- **Stateless/serverless host with no persistent disk** (e.g. multiple
  Lambda/Vercel functions) — nowhere to keep a file. Not an issue on Railway
  with a volume.
- **Heavy concurrent writes or cross-region replication/backup needs.**

The migration path is mechanical: the schema maps almost 1:1 to Postgres, and
you'd swap `better-sqlite3` for the `pg` driver (and make the query helpers
async). The dual-track scoring/allocation logic is storage-agnostic and wouldn't
change.

## Future updates & ideas

> These are **not implemented yet** — a backlog to track intent. Phase 2/3 items
> mirror the build spec; the rest are durability/quality-of-life ideas.

### Phase 2 (planned in the spec)

- **`daily_log` table.** Evening check-in: the bot asks "what did you get done?",
  you reply in plain text, and it's logged here with a date, then used to
  re-prioritize tomorrow. Likely columns: `id`, `logged_at`, `project_id`
  (nullable FK), `entry` (TEXT), `created_at`.
- **AI-assisted fields.** When `ai.ts` (Anthropic) sharpens `next_action` per
  project, consider storing the AI's suggested action/ranking separately (e.g.
  `ai_next_action`, `ai_score`, `ai_updated_at`) so the raw formula stays as a
  visible fallback.

### Phase 3 (planned in the spec)

- **Weekly review data.** Querying "shipped this week / revenue booked / what's
  stalled" benefits from status-change history rather than just the current
  `status`. See "status history" below.
- **Calendar awareness.** Possibly an `events`/`availability` table or a cached
  view of free time per day.

### Durability & operations (recommended, not in spec yet)

- **Backups.** Since everything is one file, add either:
  - a `/backup` Telegram command that sends you the `.db` file via Telegram, or
  - a small `npm run backup` script that copies `operator.db` to a timestamped
    file (use SQLite's online backup API / `VACUUM INTO` for a consistent copy
    while the app is running), optionally pushed to object storage.
- **Schema migrations / versioning.** Today the schema is created with
  `CREATE TABLE IF NOT EXISTS`, which is fine for additive first setup but won't
  evolve an existing DB. Before Phase 2 adds tables/columns, introduce a tiny
  migration runner keyed off `PRAGMA user_version` (a sequence of numbered
  migration steps), so existing databases upgrade cleanly without data loss.
- **Seed guard.** Seeding only runs when the table is empty; keep it that way so
  redeploys never re-insert examples over real data.

### Data-model quality-of-life ideas

- **Status-change history.** A `status_events` table (`project_id`, `from`,
  `to`, `changed_at`) would power weekly reviews and "time-to-paid" analytics.
- **Revenue tracking.** An explicit `amount`/`currency` field (or a
  `payments` table) once you want real income reporting instead of the 1–5
  `revenue_potential` estimate.
- **Soft delete.** The `archived` status already acts as a soft delete; avoid
  hard `DELETE`s so history stays intact for reviews.
- **Indexes.** At current scale none are needed. If the table ever grows large,
  add an index on `status` (and maybe `type`) since allocation filters on them.
- **Timezone-aware dates.** `deadline` is a plain ISO date; if precise deadline
  reminders matter later, consider storing a full timestamp + timezone.

## Related files

- `src/db.ts` — schema, seed, and typed query helpers.
- `src/config.ts` — resolves `DATABASE_PATH`.
- `src/scoring.ts` — scoring/allocation (storage-agnostic).
- `README.md` — setup and the Railway deploy steps (volume + `DATABASE_PATH`).
