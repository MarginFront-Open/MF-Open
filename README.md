# MarginFront

MarginFront meters AI usage and prices every call from a catalog of 1,936
model and tool prices that ships with the repository. It turns that into cost,
revenue and margin per customer, per agent and per piece of work, and bills
your customers through Stripe. It's an open-source framework: the components
below work together out of the box, and you wire in your own services.

## What you can do with it

Each item links to its section in [docs/features.md](docs/features.md).

- **[Meter AI usage and price it automatically.](docs/features.md#usage-metering-and-the-model-price-catalog)**
  Send one event per outcome with the model and token counts, and the cost is
  worked out from the built-in price catalog, so you know what every call cost
  without typing in a rate.
- **[Treat each agent as a product.](docs/features.md#agents)** An agent is
  the unit you meter and price. It can be one AI feature or a standalone AI
  product with its own plans, customers and margin.
- **[Test and switch pricing plans.](docs/features.md#pricing-plans-and-simulators)**
  Usage, seat, recurring, one-time, tiered and credit-pool pricing per agent,
  with simulators that project revenue and margin before a customer sees a
  plan, and plan changes kept in a change log.
- **[Attribute revenue and cost.](docs/features.md#revenue-attribution)**
  Margin by customer, agent, signal, plan and model, so a money-losing
  customer or agent shows up before the invoice does.
- **[Bill through Stripe.](docs/features.md#billing-through-stripe)**
  Subscriptions, invoices on each billing cycle, emailed payment links to
  Stripe Checkout, and payments recorded from Stripe's webhook. Stripe is the
  only payment provider built in; adding another one is a welcome contribution.
- **[Give customers a portal.](docs/features.md#customer-portals)** Each
  customer signs in to see their usage, what each agent did and their
  invoices, and React components put the same views in your own app.
- **[Show the ROI of AI.](docs/features.md#roi)** Goals with baselines, a
  "without AI" estimate next to real cost and revenue, finished work with its
  AI cost beside it, and a board-ready printed report.
- **[Run AI Accounting for finance.](docs/features.md#ai-accounting)**
  Classification rules for COGS and R&D, chart-of-accounts and GL mapping, a
  journal preview, journal exports and a month-end close that freezes the
  numbers.
- **[Keep the books clean with MFiQ.](docs/features.md#mfiq)** A 0 to 10
  hygiene score with the fixes that raise it, plus recommendation, attention
  and customer-alert cards you can extend with your own rules.
- **[Track and cap AI coding spend.](docs/features.md#internal-ai-spend-and-the-code-cost-clarity-meter)**
  The Code Cost Clarity meter records Claude Code and Codex spend per
  developer, repository and branch, with caps that alert or pause tool calls.
- **[Get alerts before money surprises you.](docs/features.md#alerts)**
  Spend-cap, credit-pool and customer-watch emails.
- **[Bill by matter.](docs/features.md#matters)** Matter-based AI cost for
  law firms, or any work billed against a case, project or ticket, with
  routing rules and an audit export.
- **[Work from an AI assistant.](docs/features.md#the-mcp-server)** An MCP
  server with 58 tools covers usage, customers, pricing, subscriptions,
  invoices, analytics, portals, spend caps, alerts and matters.
- **[Refund a payment.](docs/features.md#refunds)** Full or partial refunds,
  sent back through Stripe or recorded by hand, with the invoice status kept
  in step.
- **[Build billing into your own app.](docs/features.md#the-sdk-and-react-components)**
  A Node.js SDK for sending usage and reading billing data, and React
  components for a pricing table, invoices, a usage chart and a full customer
  portal.
- **[Help visitors pick a plan.](docs/features.md#the-plan-quiz-and-roi-calculator)**
  A plan quiz that recommends one of your plans and an ROI calculator that
  works out a visitor's yearly saving, for your pricing page.
- **[Give each person the right access.](docs/features.md#teams-and-roles)**
  Owner, admin, finance, developer, member and legal roles, and API keys that
  carry a role too.
- **[Arrange your own dashboards.](docs/features.md#page-layouts)** Unit
  Economics, AI Accounting and Build open on a grid of tiles each person can
  rearrange.
- **[Draft a billing setup from a website.](docs/features.md#onboarding-assistant)**
  An onboarding assistant reads a company's site and pricing page and drafts
  agents, signals and plans to review before anything is created.

## What's in the repository

| Part                    | Folder                       | What it does                                                                                                       |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Dashboard               | `apps/dashboard`             | The web app (Next.js): sign-in, customers, plans, subscriptions, invoices, cost and margin views, customer portal. |
| API                     | `apps/api-nest`              | The server (NestJS): usage intake, invoice checkout, payment webhooks, the scheduled billing jobs.                 |
| Database package        | `packages/db`                | The Prisma schema, one baseline migration, the model price catalog and the shared billing math.                    |
| SDK                     | `packages/sdk`               | A Node.js library your app uses to send usage and read billing data.                                               |
| MCP server              | `packages/mcp`               | Lets an AI assistant (Claude Desktop, Claude Code, Cursor) read and record billing data through your API.          |
| Code Cost Clarity meter | `packages/code-cost-clarity` | A background meter that records what your team spends in Claude Code and Codex.                                    |
| React components        | `packages/react`             | A pricing table, invoice views, a usage chart and a customer portal for your own pages.                            |

## Requirements

- **Node.js 20.12 or newer.** Running the test suite needs 22.15 or newer. CI
  uses Node 24.
- **npm**, which comes with Node. Don't use pnpm or yarn.
- **PostgreSQL 15 or newer.** The database user needs permission to create a
  database, or you create an empty one yourself first.
- **git** and **openssl** (for generating secrets).
- About 2.5 GB of free disk space for dependencies and build output.

## Quick start: a signed-in dashboard on your machine

You'll edit two files and keep one terminal running. Every command runs from the
repository root.

1. Check your Node version.

   ```bash
   node --version
   ```

   You should see `v20.12.0` or higher. If it's lower, install a newer Node
   first.

2. Check that Postgres is running.

   ```bash
   pg_isready -h localhost
   ```

   You should see `localhost:5432 - accepting connections`. If you see
   `no response`, start Postgres before you go on. With Docker installed,
   `docker compose up -d` in the cloned repository starts one that matches
   the settings in step 6.

3. Clone the repository.

   ```bash
   git clone <repository URL> marginfront
   ```

   You should see a new `marginfront` folder.

4. Move into it.

   ```bash
   cd marginfront
   ```

5. Install the dependencies.

   ```bash
   npm ci
   ```

   This takes a few minutes. It ends with a summary line that starts with
   `added` and a package count. Warnings about funding or deprecated packages
   are normal.

6. Create the database settings file.

   ```bash
   cp packages/db/.env.example packages/db/.env
   ```

   The file points at `postgresql://postgres:postgres@localhost:5432/marginfront`.
   If your Postgres user or password is different, edit both lines in
   `packages/db/.env` now.

7. Create the tables and load the model prices.

   ```bash
   npm run db:setup
   ```

   You should see `All migrations have been successfully applied.` and then
   `Price catalog loaded from the 2026-11-18 snapshot: 1935 created, 1 updated.`
   It needs no internet, and it creates the `marginfront` database if it isn't
   there. If it says `DATABASE_URL is not set`, step 6 didn't happen. If it
   says `P1001`, Postgres isn't reachable at that address.

8. Create the API settings file.

   ```bash
   cp apps/api-nest/.env.example apps/api-nest/.env
   ```

9. Fill in the API settings. Open `apps/api-nest/.env` and set these four
   lines. Leave everything else as it is.
   - `DATABASE_URL` and `DATABASE_URL_UNPOOLED`: the same value you used in
     `packages/db/.env`.
   - `ENCRYPTION_KEY`: paste the output of `openssl rand -base64 32`.
   - `CRON_SECRET`: paste the output of `openssl rand -hex 24`. You'll need
     the same value in step 11.

10. Create the dashboard settings file.

    ```bash
    cp apps/dashboard/.env.example apps/dashboard/.env.local
    ```

11. Fill in the dashboard settings. Open `apps/dashboard/.env.local` and set
    these four lines. Leave everything else as it is.
    - `DATABASE_URL`: the same database address again.
    - `AUTH_SECRET`: paste the output of `openssl rand -hex 32`.
    - `CRON_SECRET`: the same value as in the API file.
    - `SKIP_MAGIC_LINK_EMAIL="true"`: this prints sign-in links in the
      terminal instead of emailing them, so you don't need an email account.
      It works only on localhost and never in production.

    `NEXT_PUBLIC_API_BASE_URL` is already `http://localhost:4000/v1`. That's
    the one setting the dashboard needs at build time: it won't build without
    it.

12. Start the API and the dashboard together.

    ```bash
    npm run dev -- --filter=@marginfront/api-nest --filter=marginfront-dashboard
    ```

    The first run builds the shared packages, then starts both apps. When
    they're ready you'll see `MarginFront NestJS API running on: http://localhost:4000`
    and `Ready in`. Keep this terminal open. Before that, the API prints a few
    `ERROR` lines about `REDIS_URL`. They're expected when you don't run Redis,
    and the app still works. If the API stops with
    `The API cannot start because its configuration is incomplete`, the message
    names the line to fix in `apps/api-nest/.env`.

13. Open <http://localhost:3000> in your browser. You should land on a sign-in
    page that says "Welcome to MarginFront".

14. Type any email address and press the arrow button. The page says "We sent a
    login link to" your address.

15. Find the link in the terminal from step 12. Look for the line that starts
    with `[Better Auth] Magic link URL (email disabled):` and copy the address
    after it.

16. Paste that address into your browser. You're signed in, on a setup screen
    that says "Let's get your organization set up".

17. Optional: fill your organization with sample data. Finish the setup screen
    first, because it creates your organization. Then, in a second terminal at
    the repository root:

    ```bash
    npm run db:seed-sample
    ```

    You should see `Sample data written to` your organization's name, then
    `3 customers, 2 agents, 2 plans, 475 usage events, 6 invoices.` Reload the
    dashboard. Its pages show three invented customers on `example.com`
    addresses, about three months of usage and two months of invoices, all
    dated relative to today. Running it
    again replaces the sample rows with fresh dates and leaves your own data
    alone. It only runs on a database with exactly one organization, and it
    says so if there are more.

That's a running copy. Each address you sign in with this way becomes a new
account.

To send your first usage event, create a key pair under **Build**, then **API
keys**, and follow [packages/sdk/README.md](packages/sdk/README.md).

> **Scheduled jobs:** nothing runs on a timer inside the API. Without a
> scheduler calling the two billing URLs, invoices are never issued. Set one up
> before you bill anyone: [docs/self-hosting.md](docs/self-hosting.md#scheduled-jobs).

## Make it yours

The quick start above needs only PostgreSQL. To run it for real customers, you
bring the services below. [docs/make-it-yours.md](docs/make-it-yours.md) says
what to wire in for each, where the seam is in the code, and what done looks
like.

| You bring                               | Needed                         | Without it                                                                                                        |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 15 or newer                  | Always                         | Nothing runs.                                                                                                     |
| A scheduler that calls two billing URLs | To bill                        | Invoices are never issued.                                                                                        |
| An email provider (Resend is wired in)  | In production                  | No sign-in links, invitations, invoices, receipts or alerts go out. The terminal sign-in works on localhost only. |
| A Stripe account                        | To take payments               | Invoices are issued, but customers can't pay online. You record payments by hand.                                 |
| Hosting for two apps behind HTTPS       | In production                  | It runs on your machine only. The API needs Linux to render invoice PDFs.                                         |
| Storage for invoice PDFs                | In production                  | PDFs stay in the API server's temporary folder.                                                                   |
| Redis                                   | With more than one API process | Rate limits count per process, and Slack failure alerts and the failed-key throttle are off.                      |
| Google or GitHub sign-in                | Optional                       | People sign in with email links and codes.                                                                        |
| Cloudflare Turnstile                    | Optional                       | Sign-in forms have no bot check.                                                                                  |
| Sentry                                  | Optional                       | No error tracking.                                                                                                |
| OpenAI and Firecrawl keys               | Optional                       | The onboarding assistant is off.                                                                                  |

## Self-hosting

[docs/self-hosting.md](docs/self-hosting.md) covers running both apps on your
own servers, the reverse proxy, the database, Redis, the scheduled billing jobs
and upgrades. `apps/api-nest/Dockerfile`, `apps/dashboard/Dockerfile` and
`compose.yaml` (PostgreSQL only) are a starting point to adapt to your
platform. See [Containers](docs/self-hosting.md#containers).

## Documentation

| Page                                                                 | What's in it                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [docs/features.md](docs/features.md)                                 | Every feature: the problem, how to use it, how to build on it.            |
| [docs/make-it-yours.md](docs/make-it-yours.md)                       | The services you wire in, and where.                                      |
| [docs/configuration.md](docs/configuration.md)                       | Every setting for each app.                                               |
| [docs/self-hosting.md](docs/self-hosting.md)                         | Production, containers, the database, Redis, scheduled jobs and upgrades. |
| [docs/integrations.md](docs/integrations.md)                         | Stripe, sign-in providers, the bot check, error tracking and logs.        |
| [docs/alerts-and-notifications.md](docs/alerts-and-notifications.md) | The emails it sends and the alerts you can turn on.                       |
| [docs/packages.md](docs/packages.md)                                 | Building the SDK, the MCP server, the meter and the React components.     |
| [docs/concepts.md](docs/concepts.md)                                 | The building blocks and the words the rest of the docs use.               |
| [docs/api-reference/README.md](docs/api-reference/README.md)         | The REST API, one page per resource, and what to call first.              |
| Recipes in [docs/recipes/](docs/recipes/)                            | [Anthropic](docs/recipes/anthropic.md), [OpenAI](docs/recipes/openai.md), [credit pools](docs/recipes/credit-pools.md) and [non-LLM services](docs/recipes/non-llm.md), start to finish. |
| [docs/openai-hard-ceiling.md](docs/openai-hard-ceiling.md)           | A hard spend ceiling for Codex, set in your OpenAI account.               |
| [packages/db/CANON.md](packages/db/CANON.md)                         | The rules every cost, revenue and margin number follows.                  |

The API serves an interactive reference at `/api-docs` when it runs as a
server, for example <http://localhost:4000/api-docs>.

## Tests

Run every unit suite from the repository root:

```bash
npm test
```

Each package with tests also runs them with `npm test` in its own folder. The meter's
tests install and remove files under `HOME`, so `npm test` at the root gives
them a throwaway one; on their own, run `HOME=$(mktemp -d) npx vitest run` in
`packages/code-cost-clarity`.

The suites are there to lean on while you wire in your own pieces. The billing
math, the price catalog, the Stripe webhook handling and the role checks each
have tests that build real inputs and check the result, so a change to your
payment adapter, a new pricing rule or a new route shows straight away whether
it still bills, prices and guards the way the rest of the product expects. Add
yours next to them.

A few suites need more than `npm test`:

- The SDK's live-API tests run when you set `MF_TEST_SECRET_KEY` (and
  `MF_TEST_BASE_URL` if your API isn't at `http://localhost:4000/v1`). The MCP
  server's run when you set `MF_API_SECRET_KEY` and `MARGINFRONT_API_URL`.
- `npm run test:integration` in `packages/db` and `apps/dashboard` needs a
  scratch database.
- The browser tests in `apps/dashboard/playwright` run against a running
  dashboard with `npx playwright test`, in your installed Chrome. Before the
  first run, sign in once, save the browser's storage state to
  `~/.marginfront-playwright-state.json` (or set `PLAYWRIGHT_STORAGE_STATE`),
  and send a few events that use more than one service to that organization.

## No telemetry

MarginFront sends nothing to its authors. Its outbound calls go to the
services you configure, such as Stripe, Resend, Sentry or the price sources
when you run `npm run db:sync-pricing`. Two things reach public hosts with
no setting: the onboarding screen shows site icons from Google's favicon service,
and the dashboard build downloads its fonts from Google Fonts.
[docs/make-it-yours.md](docs/make-it-yours.md#your-hosting) shows where each
one lives. Next.js and Turborepo report their own usage unless you set
`NEXT_TELEMETRY_DISABLED=1` and `TURBO_TELEMETRY_DISABLED=1`.
Prisma's command-line tool, which runs during database setup, migrations and
builds, checks for updates and reports its own usage to
`checkpoint.prisma.io` unless you set `CHECKPOINT_DISABLE=1`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run and how to send a
change, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

MIT. See [LICENSE](LICENSE). Data from other projects that ships with this
repository is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Credits

Created by Wade Brogdon (CEO) and F. Manuel Gomez III (Head of Product). See [AUTHORS](AUTHORS).
