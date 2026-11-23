# Self-hosting

How to run MarginFront in production on your own accounts. Get the
[quick start](../README.md#quick-start-a-signed-in-dashboard-on-your-machine)
working on your machine first: everything here builds on it.

## What you're running

| Piece      | What it is                                                         | Needed?                                                                                                      |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | One database, version 15 or newer, shared by the API and dashboard | Yes                                                                                                          |
| API        | A Node.js server (`apps/api-nest`), port 4000 by default           | Yes                                                                                                          |
| Dashboard  | A Next.js server (`apps/dashboard`), port 3000 by default          | Yes                                                                                                          |
| Scheduler  | Anything that can call a URL on a timetable                        | Yes, or no invoices go out. See [Scheduled jobs](#scheduled-jobs).                                           |
| Redis      | Any Redis server                                                   | Once you run more than one API process. See [Redis](#redis).                                                 |
| Resend     | An email account                                                   | Yes in production: sign-in uses email links. See [alerts-and-notifications.md](alerts-and-notifications.md). |

The dashboard and the API talk to each other in both directions. The dashboard
calls the API for invoice pages, checkout and invoice generation. The API calls
the dashboard's sign-in server (`BETTER_AUTH_URL`) to check sessions. Each must
be able to reach the other's address.

## Before you deploy

1. Pick the two public addresses, for example `https://app.example.com` for the
   dashboard and `https://api.example.com` for the API.
2. Fill in both settings files for production. [configuration.md](configuration.md)
   lists every setting. At minimum, change these from the local values:
   - API: `NODE_ENV=production`, `FRONTEND_URL`, `BETTER_AUTH_URL`,
     `CORS_ORIGIN`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`.
   - Dashboard: `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`,
     `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_ENV=production`,
     `AUTH_TRUSTED_ORIGINS`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
     `PORTAL_BASE_URL`.
3. Remove `SKIP_OTP_EMAIL` and `SKIP_MAGIC_LINK_EMAIL`. In production they're
   ignored and the dashboard logs an error at startup while they're set.
4. Turn the bot check on: set `TURNSTILE_SECRET_KEY`,
   `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_ALLOWED_HOSTNAMES`. Without
   it, anyone can script sign-up and sign-in email requests.
5. If you build and run the apps through Turborepo, turn off the build tools'
   own usage reporting by setting `NEXT_TELEMETRY_DISABLED=1` and
   `TURBO_TELEMETRY_DISABLED=1`. MarginFront itself sends no telemetry.

## Build and run on a server of your own

These steps run both apps on one Linux or macOS machine with Node installed.
Put a reverse proxy (nginx, Caddy, or your platform's load balancer) in front
of both for HTTPS.

1. Get the code onto the server and install dependencies.

   ```bash
   npm ci
   ```

2. Apply database migrations (see [Migrations](#migrations)).

   ```bash
   npm run db:migrate:deploy
   ```

3. Build everything. The dashboard reads its `NEXT_PUBLIC_` settings now, so
   they must already be in `apps/dashboard/.env.local` or exported in this
   shell.

   ```bash
   npm run build
   ```

   It ends with `Tasks: 7 successful, 7 total`. If the dashboard build fails
   with `NEXT_PUBLIC_API_BASE_URL is not set`, that setting is missing.

4. Start the API.

   ```bash
   npm run start:prod --workspace=@marginfront/api-nest
   ```

   You should see `MarginFront NestJS API running on: http://localhost:4000`.
   `GET /health` answers `{"status":"ok",...}`. Point your health checks there.

5. Start the dashboard, in a second process.

   ```bash
   npm run start --workspace=marginfront-dashboard
   ```

   It listens on port 3000, or on `PORT` if you set it.

6. Keep both running with your process manager of choice (systemd, pm2, your
   platform's service runner) and restart them after every deploy.

The API serves interactive API documentation at `/api-docs` when it runs this
way. It's public. If you don't want it reachable, block that path at your
reverse proxy.

### The reverse proxy

- The API trusts exactly one proxy hop when it reads the caller's address for
  rate limits. Run it behind one proxy that sets `X-Forwarded-For`. With no
  proxy, a caller can send a made-up `X-Forwarded-For` and get a fresh
  rate-limit bucket on every request.
- The dashboard's customer-portal sign-in limits also read `X-Forwarded-For`.
  Use a proxy that overwrites that header rather than appending to it.
- If the customer portal has its own host (for example
  `portal.example.com`), route it to the dashboard too and set
  `PORTAL_BASE_URL`.

### Other hosting options

- **Vercel.** Both apps carry a `vercel.json`. The API's file declares the two
  scheduled jobs, and on Vercel the dashboard's build runs
  `db:migrate:deploy` for you. The API's Vercel build doesn't, so run
  migrations before you deploy it.
- **Invoice PDFs** are rendered with `@sparticuz/chromium`, a Chromium build
  made for Linux servers, so run the API on Linux. See
  [make-it-yours.md](make-it-yours.md#your-file-storage-for-invoice-pdfs) for
  where to plug in file storage for the PDFs.

### Containers

The container files are a starting point to adapt to your platform. Build
both images from the repository root.

- **API:** `docker build -f apps/api-nest/Dockerfile -t marginfront-api .`
  The image installs from `package-lock.json`, builds the API and the database
  package with Turborepo, and adds the system libraries Chromium needs for
  invoice PDFs. Run it with your API settings, for example
  `docker run --env-file apps/api-nest/.env -p 4000:4000 marginfront-api`.
- **Dashboard:** the `NEXT_PUBLIC_` settings are compiled in at build time, so
  the build reads your settings file as a build secret:
  `docker build --secret id=dashboard_env,src=apps/dashboard/.env.local -f apps/dashboard/Dockerfile -t marginfront-dashboard .`
  The file is mounted for the build step only and isn't copied into the
  image. Run it with the same file:
  `docker run --env-file apps/dashboard/.env.local -p 3000:3000 marginfront-dashboard`.
- **PostgreSQL for local work:** `docker compose up -d` starts PostgreSQL 17
  on `127.0.0.1:5432` with the user, password and database name that
  `packages/db/.env.example` already points at.

`docker run --env-file` reads values literally, so remove the quotes around
values in a file you pass to it. Run migrations from a checkout with
`npm run db:migrate:deploy` before you start a new API image.

## The database

- PostgreSQL 15 or newer. No extensions are needed. The baseline migration
  uses `NULLS NOT DISTINCT`, which older versions don't have.
- `DATABASE_URL` is what the apps use. `DATABASE_URL_UNPOOLED` is what
  migrations use. If a connection pooler (PgBouncer or a hosted "pooler" host)
  sits in front of the database, point `DATABASE_URL` at the pooler and
  `DATABASE_URL_UNPOOLED` straight at the database. Otherwise set both to the
  same value.
- Hosted databases usually need `?sslmode=require` on the connection string.
- Back up with `pg_dump` on a schedule. Nothing in this repository does it for
  you.

### Model prices

`npm run db:setup` loads a price list for 1,936 models and tools from a snapshot
in the repository, dated in its `capturedOn` field. Prices change, so refresh
them from the live sources whenever you like, for example weekly. To add
OpenRouter prices, run:

```bash
npm run db:sync-pricing
```

It fetches today's prices from OpenRouter and from LiteLLM's file on GitHub. It
also switches off models the sources no longer list. LiteLLM is the one it
can't do without: if OpenRouter doesn't answer, it carries on with LiteLLM
alone. To skip OpenRouter on purpose, run:

```bash
npm run db:sync-pricing --workspace=@marginfront/db -- --litellm-only
```

[packages/db/README.md](../packages/db/README.md) has the details.

## Redis

The API works without Redis on a single process. It keeps rate-limit counters
in memory and logs a warning (in production, a line starting `ALERT`). Here's
what changes without it:

| Feature                        | With Redis                         | Without Redis                                                 |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| Rate limits                    | Shared across every API process    | Counted per process, so two processes allow twice the traffic |
| Payment-webhook de-duplication | Checked in Redis, then in Postgres | Checked in Postgres only                                      |
| Failure alerts to Slack        | On, if a webhook is set            | Off                                                           |
| Failed-key throttle            | On                                 | Off: wrong keys can be retried with no slow-down              |

Set `REDIS_URL` to any Redis server. `RATE_LIMIT_STORE_FAILURE_MODE` decides
what happens if Redis becomes unreachable later. See
[configuration.md](configuration.md#rate-limiting-and-redis).

## Scheduled jobs

Nothing runs on a timer inside the API. Billing happens when something calls
these URLs. Without a scheduler, no usage invoices are issued, nothing is marked
overdue, and the daily alert checks don't run.

| Endpoint                              | Method | Suggested schedule (UTC) | What it does                                                                                                                                                                                           |
| ------------------------------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/v1/subscriptions/cron/dispatch`     | GET    | Daily at 04:00           | Issues every usage invoice that's due, builds its PDF, emails the customer and your team, and moves the subscription to its next period. Then checks spend-cap, credit-pool and customer-watch alerts. |
| `/v1/subscriptions/cron/mark-overdue` | GET    | Daily at 05:00           | Marks issued invoices past their due date as overdue.                                                                                                                                                  |

Both need the header `Authorization: Bearer <CRON_SECRET>`, using the API's
`CRON_SECRET`. A wrong secret gets `401 Invalid cron secret`. An API with no
`CRON_SECRET` refuses every call with `401 Cron secret not configured on server`.
Both are safe to call twice: the dispatch job never issues the same invoice
twice, and marking overdue changes nothing the second time. Neither is rate
limited.

One more route uses the same secret: `POST /v1/invoices/generate-internal`. The
dashboard calls it when someone generates an invoice by hand, which is why the
dashboard needs the same `CRON_SECRET`. You don't schedule it.

### Try a job by hand

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://api.example.com/v1/subscriptions/cron/mark-overdue
```

You should see a small JSON summary such as
`{"scanned":0,"marked":0,"errors":0}`.

### A crontab you can use

Run `crontab -e` on any machine that can reach the API and add these lines,
with your own secret and address:

```cron
CRON_SECRET=replace-with-your-cron-secret
MARGINFRONT_API=https://api.example.com
0 4 * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" "$MARGINFRONT_API/v1/subscriptions/cron/dispatch" > /dev/null
0 5 * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" "$MARGINFRONT_API/v1/subscriptions/cron/mark-overdue" > /dev/null
```

cron uses the machine's time zone. The exact hour doesn't matter much, but keep
the overdue job an hour after the dispatch job. `curl -f` exits with an error
on a failed call, so cron's mail (if your machine sends it) tells you when a
run fails.

### Platform schedulers

Any scheduler that can send a GET request with a header works: Kubernetes
CronJobs, GitHub Actions on a `schedule` trigger, or your host's cron feature.
Store `CRON_SECRET` in the scheduler's secret store, not in the job definition.
On Vercel, the API's `vercel.json` already declares both jobs, and Vercel sends
the `Authorization` header from the project's `CRON_SECRET` setting.

## Migrations

The schema lives in `packages/db/prisma/schema.prisma`. Migrations live in
`packages/db/prisma/migrations`, starting with one baseline, `0_init`.

- **Every deploy:** run `npm run db:migrate:deploy` before you start the new
  version. It applies only migrations the database hasn't seen, and prints
  `No pending migrations to apply.` when there are none.
- **A new database:** `npm run db:setup` runs the migrations and loads the
  model prices. It's safe to run again.
- **After you change the schema:** see [CONTRIBUTING.md](../CONTRIBUTING.md#database-changes).
