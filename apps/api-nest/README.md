# API (`apps/api-nest`)

The MarginFront API, built with NestJS. It shares the database and Prisma
schema in `packages/db` with the dashboard.

Locally it runs at `http://localhost:4000`, with every route under `/v1`.

## What it does

The dashboard reads and writes most of its own data straight from the
database. The API handles what has to live on a server of its own:

- **Usage intake** from the SDK, the MCP server and the Code Cost Clarity meter
  (`/v1/sdk/...`, `/v1/usage/record`), with API-key checks and rate limits.
- **Invoice pages and checkout** for your customers (`/v1/public/invoices/...`).
- **Payment webhooks** from Stripe (`/v1/webhooks/stripe`).
- **Scheduled billing jobs** that issue invoices and mark overdue ones.
- **Spend-cap, credit-pool and customer-watch alerts.**
- **The customer portal API** used by `packages/react`.
- **Stripe Connect** for organizations connecting a Stripe account.
- **The REST API** the SDK and MCP server call for customers, invoices,
  subscriptions, analytics and more.

## Modules

Each folder in `src/modules` is one area.

| Module                                                      | What it covers                                           |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `sdk`, `event-processing`                                   | Usage intake and key checks for the client packages      |
| `auth`, `api-keys`, `users`, `team`, `organizations`        | Sign-in checks, API keys and roles, people and teams     |
| `customers`, `agents`, `signals`, `signal-events`           | The things usage is recorded against                     |
| `pricing-plans`, `pricing-strategies`, `service-pricing`    | Your prices, and the model price list                    |
| `subscription`, `invoices`, `invoice-calculator`, `pdf`     | Billing, invoices, PDFs and the revenue simulator        |
| `payment-providers`, `stripe-connect`, `webhooks`           | Payments                                                 |
| `public`, `public-invoice`, `portal-api`, `portal-sessions` | Routes your customers reach without a team account       |
| `cost-control`, `credit-pool`, `customer-alerts`            | Spend caps, credit pools and customer watches            |
| `analytics`, `filters`                                      | Revenue, cost and usage reports                          |
| `matters`                                                   | The legal vertical: cost by client matter                |
| `email`                                                     | Every email the API sends, through Resend                |
| `onboarding`                                                | The optional website-reading assistant used during setup |

## Authentication

Requests are accepted with any of:

1. **A dashboard session cookie.** The API checks it by calling the
   dashboard's sign-in server at `BETTER_AUTH_URL`.
2. **A token** signed by the dashboard's sign-in server, checked against its
   public keys.
3. **An API key** in the `x-api-key` header. Secret keys start `mf_sk_` and
   publishable keys `mf_pk_`. Each key carries a role. An ingest key can send
   usage and make a few status reads. Every other route refuses it. A key that
   names no role, or a role the API doesn't know, counts as an ingest key.
   Routes that need a higher role list the roles they accept.

## Settings

Every setting is in [`.env.example`](./.env.example), split into required and
optional. Copy it to `.env` in this folder and fill in the required block. The
API refuses to start, with a message naming what's missing, when a required
value is absent. [docs/configuration.md](../../docs/configuration.md) explains
each one.

## Scheduled jobs

Nothing runs on a timer inside the API. Your scheduler calls two URLs with the
header `Authorization: Bearer $CRON_SECRET`:

| Schedule (UTC) | Endpoint                              | What it does                                                                                              |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `0 4 * * *`    | `/v1/subscriptions/cron/dispatch`     | Issues due usage invoices and emails them, then runs the spend-cap, credit-pool and customer-watch alerts |
| `0 5 * * *`    | `/v1/subscriptions/cron/mark-overdue` | Marks issued invoices past their due date as overdue                                                      |

On Vercel these are declared in `vercel.json`. Anywhere else, use cron or any
scheduler. [docs/self-hosting.md](../../docs/self-hosting.md#scheduled-jobs) has
a ready-to-use crontab.

## Commands

From the repository root:

```bash
npm run dev --workspace=@marginfront/api-nest        # run with reload on change
npm run build --workspace=@marginfront/api-nest      # build into dist/
npm run start:prod --workspace=@marginfront/api-nest # run the build
npm run typecheck --workspace=@marginfront/api-nest  # type check against the baseline
npm test --workspace=@marginfront/api-nest           # unit tests
```

`npm run dev` and `npm run build` need `packages/db` built first. Starting
through Turborepo from the root does that for you:
`npm run dev -- --filter=@marginfront/api-nest`.

When the API runs as a normal server, it also serves interactive API docs at
`/api-docs` and a health check at `/health`.
