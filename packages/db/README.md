# @marginfront/db

The database for MarginFront: the Prisma schema, one baseline migration, the
model price catalog, and the shared billing and cost math.

## What you need

- PostgreSQL 15 or newer. No extensions are required.
- Node.js and `npm install` run once at the repository root.

## Set up a new database

Run these from the repository root.

1. Copy `packages/db/.env.example` to `packages/db/.env`.
2. Open `packages/db/.env` and put your connection string on both lines. For a
   plain Postgres the two lines are identical.
3. Run:

   ```bash
   npm run db:setup --workspace=@marginfront/db
   ```

That one command does three things, in order:

| Step                  | The command it runs           | What you should see                                                       |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| Build the client      | `prisma generate`             | `Generated Prisma Client`                                                 |
| Create every table    | `prisma migrate deploy`       | `All migrations have been successfully applied.`                          |
| Load the model prices | `tsx scripts/seed-pricing.ts` | `Price catalog loaded from the <date> snapshot: 1935 created, 1 updated.` |

`migrate deploy` creates the database itself if it does not exist yet, as long
as the user in your connection string is allowed to create databases. None of
the three steps uses the internet.

Running `db:setup` again is safe. It applies nothing new and reloads the prices
from the same snapshot, which has three effects worth knowing:

- A price you edited by hand, for a model that is in the snapshot, goes back to
  the snapshot's value. To keep your own number, add the model under your own
  id instead of editing a snapshot row.
- A price that is switched off stays off and is not touched.
- Once you have run `db:sync-pricing`, your prices are newer than the snapshot.
  `db:setup` then leaves them alone, says so, and still finishes cleanly.

If you see `DATABASE_URL is not set`, step 1 or 2 was skipped. If you see
`P1001: Can't reach database server`, Postgres is not running or the host and
port in the connection string are wrong.

## Each step by itself

```bash
npm run db:generate --workspace=@marginfront/db        # build the Prisma client
npm run db:migrate:deploy --workspace=@marginfront/db  # create or upgrade tables
npm run db:seed-pricing --workspace=@marginfront/db    # load prices, offline
npm run db:seed-sample --workspace=@marginfront/db     # optional: sample data
```

`db:seed-sample` fills the database's one organization with invented
customers, agents, plans, usage events and invoices, dated relative to today.
It needs the prices loaded first, and a second run replaces its own rows.

## Model prices

MarginFront turns usage into dollars with a price list in the `service_pricing`
table. There are two ways to fill it.

| Command               | Needs internet | What it does                                                                                                                                   |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:seed-pricing`     | No             | Loads the snapshot in `data/price-catalog-snapshot.json`, plus the built-in rows in `scripts/sync-service-pricing.ts`.                         |
| `db:sync-pricing`     | Yes            | Fetches today's prices from OpenRouter and LiteLLM, updates the table, and switches off models the feeds no longer list.                       |
| `db:snapshot-pricing` | Yes            | For maintainers. Rewrites the snapshot file from today's LiteLLM file so the next offline seed is newer. Touches no database. Commit the file. |

The snapshot records the day it was captured (`capturedOn`) and its source.
Prices change, so a snapshot gets stale. Run `db:sync-pricing` whenever you
want current prices; a weekly schedule is a reasonable default.

`db:seed-pricing` never switches a price off or back on: a price that is
switched off keeps its values and stays off. For every other model in the
snapshot it replaces the stored price with the snapshot's.

It stops with an error, and changes nothing, if the database already holds
model prices newer than the snapshot, because loading the snapshot would put
older prices back. Add `-- --force` to load it anyway, or `-- --skip-if-newer`
to leave the newer prices alone without an error (this is what `db:setup`
does).

### Where the prices come from

- LiteLLM `model_prices_and_context_window.json`, MIT License, Copyright (c)
  2023 Berri AI: <https://github.com/BerriAI/litellm>. The full notice is in
  `THIRD-PARTY-NOTICES.md` at the repository root.
- Built-in rows: the tools that ship inside Claude Code and Codex, and the
  finished-work row, in `BUILT_IN_ROWS` in `scripts/sync-service-pricing.ts`.
  Add your own tools there.

To add OpenRouter prices, run `npm run db:sync-pricing`. It reads the
OpenRouter models API (<https://openrouter.ai/api/v1/models>) along with
LiteLLM. LiteLLM is the feed it needs: if OpenRouter doesn't answer, the sync
carries on with LiteLLM alone and switches off the OpenRouter rows. To skip
OpenRouter on purpose:

```bash
npm run db:sync-pricing --workspace=@marginfront/db -- --litellm-only
```

The snapshot itself holds LiteLLM rows only. To rebuild it from a copy of
LiteLLM's file you already have:

```bash
npm run db:snapshot-pricing --workspace=@marginfront/db -- --litellm-file <path>
```

These are public list prices. Your negotiated rates may differ.

## Changing the schema

1. Edit `prisma/schema.prisma`.
2. Run `npm run db:migrate --workspace=@marginfront/db` and give the change a
   name. Prisma writes a new folder under `prisma/migrations/`.
3. Commit the folder. Everyone else picks it up with `db:migrate:deploy`.

Never edit `prisma/migrations/0_init/migration.sql` once you have a database
built from it. It was generated from the schema and then edited by hand in the
places marked "Not expressible in schema.prisma". If you ever regenerate it,
carry those edits and the reference rows at the bottom forward.
