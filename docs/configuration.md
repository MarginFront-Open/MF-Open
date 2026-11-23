# Configuration

Every setting MarginFront reads, app by app. Each table follows the order of
that app's `.env.example` file, which is the starting point for your own copy.

- **API:** copy `apps/api-nest/.env.example` to `apps/api-nest/.env`.
- **Dashboard:** copy `apps/dashboard/.env.example` to `apps/dashboard/.env.local`.
- **Database package:** copy `packages/db/.env.example` to `packages/db/.env`.

On a hosting platform you put the same names in its settings screen instead of
a file.

Two things to know first:

1. **Variables starting with `NEXT_PUBLIC_` are copied into the dashboard's
   browser code when you run `next build`.** Changing one means rebuilding. Never
   put a secret in one.
2. **When you start the apps through Turborepo** (`npm run dev` or
   `npm run build` from the repository root), Turborepo passes only the
   variables listed in `turbo.json` from your shell to each app. The apps read
   their own `.env` files directly, so settings in those files always arrive.
   Settings you only export in your shell may not.

"Default" is what the code does when the variable is unset or empty. "Template"
is the value the `.env.example` file ships with, when it isn't empty.

## API (`apps/api-nest/.env`)

The API checks its settings when it starts. If something required is missing,
it stops with a message that names it.

### Required

| Name                    | Required?            | Default                                                      | What it controls                                                                                                                   | When you'd change it                                                                                           |
| ----------------------- | -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Required             | none                                                         | The Postgres database the API reads and writes.                                                                                    | Always. Point it at your database.                                                                             |
| `DATABASE_URL_UNPOOLED` | Required             | none                                                         | A direct (not pooled) connection, used by Prisma migrations.                                                                       | Set it to the same value as `DATABASE_URL` unless a connection pooler sits in front of the database.           |
| `ENCRYPTION_KEY`        | Required             | none: the API won't start                                    | The 32-byte key that encrypts stored Stripe secrets. Generate it with `openssl rand -base64 32`.                                   | Once, at install. Never change it afterwards: secrets saved with the old key can't be read with a new one.     |
| `FRONTEND_URL`          | Required             | none: the API won't start. Template: `http://localhost:3000` | Your dashboard's address. Every link in emails and every checkout redirect is built from it.                                       | When the dashboard moves to its real address.                                                                  |
| `BETTER_AUTH_URL`       | Required             | Template: `http://localhost:3000`                            | The dashboard's sign-in server. The API calls it to check dashboard sessions.                                                      | Usually the same as `FRONTEND_URL`.                                                                            |
| `CRON_SECRET`           | Required for billing | none: every scheduled call is refused                        | The shared secret your scheduler sends as `Authorization: Bearer <value>` to the billing jobs. The dashboard needs the same value. | Once. Generate it with `openssl rand -hex 24`. If you rotate it, change it in the dashboard and scheduler too. |

### Server

| Name              | Required? | Default                                         | What it controls                                                                                                                                                                                                                                  | When you'd change it                                                            |
| ----------------- | --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `NODE_ENV`        | Optional  | `development`                                   | Runtime mode.                                                                                                                                                                                                                                     | Set `production` on a real deployment.                                          |
| `PORT`            | Optional  | `4000`                                          | The port the API listens on.                                                                                                                                                                                                                      | When 4000 is taken or your host assigns a port.                                 |
| `API_PREFIX`      | Optional  | `v1`                                            | The path prefix on every route.                                                                                                                                                                                                                   | Leave it at `v1`. Some routes and the scheduled-job paths assume `/v1`.         |
| `LOG_LEVEL`       | Optional  | `info`                                          | `debug` also logs every database query.                                                                                                                                                                                                           | Set `debug` while you chase a problem.                                          |
| `CORS_ORIGIN`     | Optional  | none. Template: `http://localhost:3000`         | Browser origins allowed to send cookies to the API, comma-separated. Wildcards like `https://*-yourteam.example.com` work. `http://localhost:3000` and `http://localhost:4000` are always allowed. Requests with an API key work from any origin. | Add your dashboard's real address when you deploy.                              |
| `PRODUCT_NAME`    | Optional  | `Usage Billing`                                 | The name in email footers and on invoices for an organization that has no branding of its own.                                                                                                                                                    | Set it to your product or company name.                                         |
| `SUPPORT_EMAIL`   | Optional  | none                                            | An address quoted in some API error messages. Empty quotes none.                                                                                                                                                                                  | When you want people who hit those errors to know where to write.               |
| `PORTAL_BASE_URL` | Optional  | `BETTER_AUTH_URL`, then `http://localhost:3000` | The customer portal address used in portal sign-in links the API creates.                                                                                                                                                                         | When the portal runs on its own host, for example `https://portal.example.com`. |

`VERCEL`, `AWS_LAMBDA_FUNCTION_NAME` and `VERCEL_GIT_COMMIT_SHA` are also read,
but your host sets them. Don't set them by hand.

### Email

With `RESEND_API_KEY` empty, email is off. The API runs normally, logs one
warning at startup and logs each email instead of sending it. Manual invoice
sends and reminders answer with an error that says email is off.

| Name                        | Required?                             | Default                                                | What it controls                                                        | When you'd change it                                               |
| --------------------------- | ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `RESEND_API_KEY`            | Optional                              | none: email off                                        | Turns email on, sent through Resend.                                    | When you want invoices, receipts and alerts to go out.             |
| `RESEND_FROM_EMAIL`         | Required once `RESEND_API_KEY` is set | none: the API won't start without it if the key is set | The sender for email to your own team: alerts and "invoice sent" notes. | Set it to an address on a domain you verified in Resend.           |
| `RESEND_INVOICE_FROM_EMAIL` | Optional                              | `RESEND_FROM_EMAIL`                                    | The sender for email to your customers: invoices and receipts.          | Use a no-reply address so replies don't land in your team's inbox. |

### Rate limiting and Redis

| Name                            | Required? | Default                       | What it controls                                                                                                                                                                                                                                                                                                                                                  | When you'd change it                                                                                   |
| ------------------------------- | --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `REDIS_URL`                     | Optional  | none: counters live in memory | Redis for rate-limit counters, payment-webhook de-duplication, the failure alerts and the failed-key throttle. `REDIS_URL_REDIS_URL` is also accepted, because some hosted Redis integrations name the variable that way. It wins if both are set.                                                                                                                | As soon as you run more than one API process. See [self-hosting.md](self-hosting.md#redis).            |
| `RATE_LIMIT_STORE_FAILURE_MODE` | Optional  | `closed-anonymous`            | What happens when the rate limiter itself fails, usually because Redis is unreachable. `closed-anonymous` refuses requests that carry no key or session with a 503 and lets the rest through. `closed` refuses every rate-limited request. `open` lets everything through. Scheduled jobs and payment webhooks are never refused. An unknown value stops startup. | Rarely. `open` keeps public invoice pages working during a Redis outage, at the cost of no rate limit. |

### Payments

Each organization normally connects its own Stripe account in the dashboard
with its own keys. These settings are only for the platform-level flows named
below.
See [integrations.md](integrations.md#payments).

| Name                       | Required? | Default | What it controls                                                                                                                                                                                 | When you'd change it                  |
| -------------------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `STRIPE_SECRET_KEY`        | Optional  | none    | Your platform Stripe key. Used for Stripe Connect and for Stripe webhooks sent to `/v1/webhooks/stripe`, or to an organization's address when that organization has no active Stripe connection. | When you offer "Connect with Stripe". |
| `STRIPE_WEBHOOK_SECRET`    | Optional  | none    | The signing secret for webhooks sent to `/v1/webhooks/stripe`. Webhooks there are rejected without it.                                                                                           | Together with `STRIPE_SECRET_KEY`.    |
| `STRIPE_CONNECT_CLIENT_ID` | Optional  | none    | The client ID of your Stripe Connect platform, needed for "Connect with Stripe".                                                                                                                 | When you offer "Connect with Stripe". |

### Alerts to Slack

These need Redis. Without `AUTH_FAILURE_SLACK_WEBHOOK_URL` there are no Slack
alerts, and the per-request log lines still appear. See
[alerts-and-notifications.md](alerts-and-notifications.md#slack-alerts).

| Name                                           | Required? | Default | What it controls                                                                        | When you'd change it                                     |
| ---------------------------------------------- | --------- | ------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `AUTH_FAILURE_SLACK_WEBHOOK_URL`               | Optional  | none    | The Slack incoming-webhook address that receives the failure alerts.                    | When you want those alerts in a Slack channel.           |
| `AUTH_FAILURE_ALERT_THRESHOLD`                 | Optional  | `5`     | Rejected API keys from one IP address before an alert.                                  | Raise it if the alert is noisy.                          |
| `AUTH_FAILURE_ALERT_WINDOW_SECONDS`            | Optional  | `900`   | The window, in seconds, those rejections are counted over.                              | With the threshold.                                      |
| `AUTH_FAILURE_ALERT_COOLDOWN_SECONDS`          | Optional  | `3600`  | The minimum gap between two alerts of this kind.                                        | Lower it to hear sooner, raise it to hear less.          |
| `CUSTOMER_FAILURE_BAD_DATA_THRESHOLD`          | Optional  | `5`     | Rejected usage records (HTTP 400 or 422) before an alert.                               | Raise it if the alert is noisy.                          |
| `CUSTOMER_FAILURE_BAD_DATA_WINDOW_SECONDS`     | Optional  | `900`   | The counting window for rejected usage records.                                         | With the threshold.                                      |
| `CUSTOMER_FAILURE_BAD_DATA_COOLDOWN_SECONDS`   | Optional  | `3600`  | The minimum gap between two alerts of this kind.                                        | Lower it to hear sooner, raise it to hear less.          |
| `CUSTOMER_FAILURE_FORBIDDEN_THRESHOLD`         | Optional  | `5`     | Publishable keys that try to write (HTTP 403) before an alert.                          | Raise it if the alert is noisy.                          |
| `CUSTOMER_FAILURE_FORBIDDEN_WINDOW_SECONDS`    | Optional  | `900`   | The counting window for those 403s.                                                     | With the threshold.                                      |
| `CUSTOMER_FAILURE_FORBIDDEN_COOLDOWN_SECONDS`  | Optional  | `3600`  | The minimum gap between two alerts of this kind.                                        | Lower it to hear sooner, raise it to hear less.          |
| `CUSTOMER_FAILURE_RATE_LIMIT_THRESHOLD`        | Optional  | `50`    | Rate-limited requests (HTTP 429) before an alert.                                       | Raise it if a busy customer trips it often.              |
| `CUSTOMER_FAILURE_RATE_LIMIT_WINDOW_SECONDS`   | Optional  | `300`   | The counting window for those 429s.                                                     | With the threshold.                                      |
| `CUSTOMER_FAILURE_RATE_LIMIT_COOLDOWN_SECONDS` | Optional  | `21600` | The minimum gap between two alerts of this kind.                                        | Lower it to hear sooner, raise it to hear less.          |
| `REVOKED_KEY_NOTICE_COOLDOWN_SECONDS`          | Optional  | `3600`  | The minimum gap between two "a revoked key is still in use" emails to one organization. | Raise it if an old deployment keeps using a revoked key. |

### Failed-key throttle

After too many failed API-key attempts from one IP address, further failures
get HTTP 429 instead of 401. Valid keys are never affected. It needs Redis and
is off without it.

| Name                                   | Required? | Default | What it controls                                                                                                                                      | When you'd change it                               |
| -------------------------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `AUTH_FAILURE_THROTTLE_ENABLED`        | Optional  | `true`  | `false` turns the throttle off.                                                                                                                       | When a shared office address keeps getting caught. |
| `AUTH_FAILURE_THROTTLE_THRESHOLD`      | Optional  | `50`    | Failed attempts from one IP within the window before 429s start. Keep it above `AUTH_FAILURE_ALERT_THRESHOLD`, or that alert never reaches its count. | Lower it for a stricter brake.                     |
| `AUTH_FAILURE_THROTTLE_WINDOW_SECONDS` | Optional  | `900`   | The counting window, and how long the block lasts, in seconds.                                                                                        | With the threshold.                                |
| `AUTH_FAILURE_THROTTLE_TIMEOUT_MS`     | Optional  | `400`   | How long to wait for Redis before letting a request through uncounted.                                                                                | Raise it if your Redis is far away.                |

### Error tracking

Nothing is sent anywhere unless you set your own Sentry project's DSN. See
[integrations.md](integrations.md#error-tracking-with-sentry).

| Name                 | Required? | Default       | What it controls                        | When you'd change it                                 |
| -------------------- | --------- | ------------- | --------------------------------------- | ---------------------------------------------------- |
| `SENTRY_DSN`         | Optional  | none: off     | Your Sentry project for API errors.     | When you want API errors in Sentry.                  |
| `SENTRY_ENVIRONMENT` | Optional  | `development` | The environment name on Sentry reports. | Set `production` (or your own name) on a deployment. |

### Onboarding assistant

An optional helper during organization setup that reads a company's website.
Both keys are off when empty.

| Name                   | Required? | Default             | What it controls                                                 | When you'd change it         |
| ---------------------- | --------- | ------------------- | ---------------------------------------------------------------- | ---------------------------- |
| `OPENAI_API_KEY`       | Optional  | none: assistant off | The OpenAI key the assistant uses.                               | When you want the assistant. |
| `OPENAI_MODEL`         | Optional  | `gpt-4o-2024-08-06` | The OpenAI model it uses.                                        | To try another model.        |
| `FIRECRAWL_API_KEY`    | Optional  | none: fetching off  | The Firecrawl key used to fetch the website the assistant reads. | When you want the assistant. |
| `FIRECRAWL_TIMEOUT_MS` | Optional  | `30000`             | How long to wait for a website fetch, in milliseconds.           | Raise it for slow sites.     |

## Dashboard (`apps/dashboard/.env.local`)

### Required

| Name                          | Required?                                | Default                                                     | What it controls                                                                                                                        | When you'd change it                                     |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`                | Required                                 | none                                                        | The same Postgres database the API uses.                                                                                                | Always. Point it at your database.                       |
| `AUTH_SECRET`                 | Required                                 | none                                                        | Signs sign-in sessions. Generate it with `openssl rand -hex 32`.                                                                        | Once. Changing it signs everyone out.                    |
| `BETTER_AUTH_URL`             | Required                                 | Template: `http://localhost:3000`                           | The dashboard's public address, used by the sign-in server.                                                                             | When you deploy: your real `https` address.              |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | Required                                 | Template: `http://localhost:3000`                           | The same address, readable by the browser. Build time.                                                                                  | Keep it equal to `BETTER_AUTH_URL`.                      |
| `NEXT_PUBLIC_API_BASE_URL`    | Required                                 | none: the build fails. Template: `http://localhost:4000/v1` | Your API's address including `/v1`. The dashboard calls it, and prints it in every copy-and-paste code sample. Build time.              | When you deploy the API.                                 |
| `CRON_SECRET`                 | Required for invoicing                   | none                                                        | The secret the dashboard sends when it asks the API to generate an invoice. Must equal the API's `CRON_SECRET`.                         | Together with the API's value.                           |
| `RESEND_API_KEY`              | Required for email sign-in in production | none                                                        | Resend, for sign-in codes and links, invites, invoices and the welcome email. On localhost you can use `SKIP_MAGIC_LINK_EMAIL` instead. | When you deploy, or want real email locally.             |
| `RESEND_FROM_EMAIL`           | Required with `RESEND_API_KEY`           | Template: `Your Company <team@yourdomain.com>`              | The sender for email to your team: sign-in codes, invites, welcome.                                                                     | Set it to an address on a domain you verified in Resend. |

### Your branding and links

Each of these is empty by default, and whatever would show it is hidden.

| Name                          | Required? | Default            | What it controls                                                                                                                                                                                                                      | When you'd change it                          |
| ----------------------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `NEXT_PUBLIC_COMPANY_NAME`    | Optional  | none: hidden       | Your organization's name in footers ("© 2026 Your Company") and as the welcome email's signature.                                                                                                                                     | When you want your name shown.                |
| `NEXT_PUBLIC_SUPPORT_EMAIL`   | Optional  | none: hidden       | A support address shown in the footer of sign-in and invitation emails.                                                                                                                                                               | When you have a support inbox.                |
| `NEXT_PUBLIC_DOCS_URL`        | Optional  | none: links hidden | Your own docs site. The dashboard adds paths such as `/sdk/tracking-events`. Unset hides every docs link and points the code samples at the READMEs in the source.                                                                    | If you host a copy of the docs.               |
| `NEXT_PUBLIC_TERMS_URL`       | Optional  | none: hidden       | A Terms link under customer-portal sign-in.                                                                                                                                                                                           | When you have terms of service.               |
| `NEXT_PUBLIC_PRIVACY_URL`     | Optional  | none: hidden       | A Privacy Policy link under customer-portal sign-in.                                                                                                                                                                                  | When you have a privacy policy.               |
| `NEXT_PUBLIC_SOURCE_REPO_URL` | Optional  | none               | The git address your team clones to build the SDK, MCP server and meter. While it's empty, the install commands the dashboard shows say `<your MarginFront source URL>` and can't be run, and the "Source code" links are plain text. | Before you hand the install kit to your team. |
| `NEXT_PUBLIC_COMPANY_WEBSITE` | Optional  | none               | Your company website. It's read into the dashboard's config, but no page displays it.                                                                                                                                                 | You can leave it empty.                       |

### Email

| Name                        | Required?            | Default             | What it controls                                                                                                                                                                                                                                                          | When you'd change it                                               |
| --------------------------- | -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `RESEND_INVOICE_FROM_EMAIL` | Optional             | `RESEND_FROM_EMAIL` | The sender for email your customers receive: portal links and invoices. With neither set, sending a portal link fails with a message that says what to set.                                                                                                               | Use a no-reply address so replies don't land in your team's inbox. |
| `SKIP_OTP_EMAIL`            | Optional, local only | off                 | `true` prints sign-in codes in the server log instead of emailing them. Works only when `NODE_ENV` isn't `production`, `BETTER_AUTH_URL` is a localhost address and the request arrives on localhost. Anywhere else it's ignored, the email is sent and the log says why. | For local development without an email account.                    |
| `SKIP_MAGIC_LINK_EMAIL`     | Optional, local only | off                 | The same switch for sign-in links. The quick start uses this one.                                                                                                                                                                                                         | For local development without an email account.                    |

The customer portal's sign-in limits count requests per caller address, read
from the `X-Forwarded-For` header. Run the dashboard behind a reverse proxy that
overwrites that header with the real client address (most hosts do). Behind a
proxy that only appends to it, a caller can dodge the per-address limit. With no
proxy at all, every caller shares one limit.

### Sign-in

| Name                             | Required?                                   | Default                                                                                                                                        | What it controls                                                                                                                        | When you'd change it                                                      |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `AUTH_TRUSTED_ORIGINS`           | Optional                                    | `http://localhost:3000`, `http://localhost:3001`, the host's `VERCEL_URL` and `NEXT_PUBLIC_BETTER_AUTH_URL`. Template: `http://localhost:3000` | Extra addresses the sign-in server accepts requests from, comma-separated.                                                              | Add your production address and any other host that serves the dashboard. |
| `GOOGLE_CLIENT_ID`               | Optional                                    | none                                                                                                                                           | Google sign-in. The "Continue with Google" button shows only when both Google values are set.                                           | When you want Google sign-in.                                             |
| `GOOGLE_CLIENT_SECRET`           | Optional                                    | none                                                                                                                                           | The secret for the Google sign-in app.                                                                                                  | Together with `GOOGLE_CLIENT_ID`.                                         |
| `GITHUB_CLIENT_ID`               | Optional                                    | none                                                                                                                                           | GitHub sign-in. It turns on when both GitHub values are set. The sign-in page has no GitHub button.                                     | When you want GitHub sign-in.                                             |
| `GITHUB_CLIENT_SECRET`           | Optional                                    | none                                                                                                                                           | The secret for the GitHub sign-in app.                                                                                                  | Together with `GITHUB_CLIENT_ID`.                                         |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Required when the bot check is on           | none                                                                                                                                           | The Cloudflare Turnstile site key the sign-in page shows. Build time.                                                                   | When you turn the bot check on.                                           |
| `TURNSTILE_SECRET_KEY`           | Optional                                    | none: bot check off                                                                                                                            | Turns the Cloudflare Turnstile bot check on for sign-in and email requests. In production, the dashboard logs a warning while it's off. | Before you open sign-in to the public.                                    |
| `TURNSTILE_ALLOWED_HOSTNAMES`    | Required when `TURNSTILE_SECRET_KEY` is set | none: every check fails                                                                                                                        | The hostnames the dashboard is served from, comma-separated.                                                                            | When you turn the bot check on.                                           |

### Customer portal

| Name                         | Required? | Default                        | What it controls                                                                                                                                                    | When you'd change it                                       |
| ---------------------------- | --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `PORTAL_BASE_URL`            | Optional  | `http://portal.localhost:3000` | The customer billing portal's address. Requests to this host are treated as portal requests. So is any host whose first label is `portal` or starts with `portal-`. | When you deploy, for example `https://portal.example.com`. |
| `PORTAL_FALLBACK_URL`        | Optional  | none: a plain 404              | Where a portal visit with no organization in the path is sent.                                                                                                      | When you want those visits to land on your own site.       |
| `PORTAL_SESSION_DURATION_MS` | Optional  | one hour                       | How long a portal session lasts, in milliseconds.                                                                                                                   | To keep customers signed in longer or shorter.             |

Locally, `portal.localhost` needs a line in `/etc/hosts` that points it at
`127.0.0.1`. macOS doesn't resolve nested `.localhost` names on its own.

### Other server addresses

| Name                  | Required? | Default                       | What it controls                                                                                                                                      | When you'd change it                                            |
| --------------------- | --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `API_BASE_URL`        | Optional  | `NEXT_PUBLIC_API_BASE_URL`    | The API address as seen from the dashboard's server, when it differs from the public one.                                                             | When the dashboard reaches the API over a private network name. |
| `FRONTEND_URL`        | Optional  | `NEXT_PUBLIC_BETTER_AUTH_URL` | The address in "pay this invoice" links inside invoice emails the dashboard sends.                                                                    | Rarely.                                                         |
| `NEXT_PUBLIC_APP_URL` | Optional  | `http://localhost:3000`       | Where Stripe sends people back to after they connect an account. Also the welcome email's button address when `BETTER_AUTH_URL` is unset. Build time. | Set it to the dashboard's real address when you deploy.         |

### Integrations

| Name                | Required? | Default            | What it controls                                                             | When you'd change it                                |
| ------------------- | --------- | ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `GEMINI_API_KEY`    | Optional  | none: off          | Google Gemini, for the pricing-page reader in `apps/dashboard/lib/pricing`.  | When you want that helper.                          |
| `GOOGLE_AI_API_KEY` | Optional  | none               | Another name for the same Gemini key. `GEMINI_API_KEY` wins if both are set. | Only if your key is already stored under this name. |
| `GEMINI_MODEL`      | Optional  | `gemini-2.5-flash` | The Gemini model to use.                                                     | To try another model.                               |

### Error tracking and logs

Nothing is sent anywhere unless you put your own account's keys here.

| Name                                   | Required?       | Default                        | What it controls                                                                                                                                        | When you'd change it                                             |
| -------------------------------------- | --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `NEXT_PUBLIC_SENTRY_DSN`               | Optional        | none: Sentry never starts      | Your Sentry project for dashboard errors. Sentry also stays off while `NEXT_PUBLIC_APP_ENV` is `development`. Build time.                               | When you want dashboard errors in Sentry.                        |
| `NEXT_PUBLIC_SENTRY_REPLAY_UNMASK`     | Optional        | off                            | Session replays mask all text and inputs and block media by default. `true` records readable text and media. Inputs stay masked either way. Build time. | Only if you accept readable billing data in your Sentry project. |
| `SENTRY_ORG`                           | Optional, build | none: no upload                | Your Sentry organization, for uploading source maps during the build.                                                                                   | When you want readable stack traces in Sentry.                   |
| `SENTRY_PROJECT`                       | Optional, build | none: no upload                | Your Sentry project, for the same upload.                                                                                                               | With `SENTRY_ORG`.                                               |
| `SENTRY_AUTH_TOKEN`                    | Optional, build | none: no upload                | The token that allows the upload.                                                                                                                       | With `SENTRY_ORG`.                                               |
| `NEXT_PUBLIC_INTERNAL_EMAIL_DOMAINS`   | Optional        | none: nobody tagged            | Email domains whose signed-in users are tagged `is_internal` in Sentry, comma-separated, so you can filter your own team out.                           | When you use Sentry and want to filter your team.                |
| `NEXT_PUBLIC_BETTERSTACK_SOURCE_TOKEN` | Optional        | none: logs stay in the console | Sends dashboard logs to Better Stack.                                                                                                                   | When you use Better Stack for logs.                              |

### Development switches

| Name                            | Required? | Default                 | What it controls                                                                                                                                           | When you'd change it               |
| ------------------------------- | --------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `NEXT_PUBLIC_APP_ENV`           | Optional  | Template: `development` | `development`, `preview`, `production` or `test`. Picks the config file under `src/config/environments` and turns Sentry off in `development`. Build time. | Set `production` on a deployment.  |
| `NEXT_PUBLIC_DEBUG_MODE`        | Optional  | none                    | Overrides a debug flag in the dashboard's config. No code reads that flag.                                                                                 | You can leave it empty.            |
| `NEXT_PUBLIC_USE_MOCK_INVOICES` | Optional  | off                     | `true` makes the invoices screen use built-in sample data instead of the API.                                                                              | Only while working on that screen. |

`NODE_ENV`, `NEXT_RUNTIME`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_COMMIT_SHA`,
`NEXT_PUBLIC_VERCEL_URL` and `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` are set by your
host or by Next.js. Don't set them by hand.

## Database package (`packages/db/.env`)

Read by `prisma migrate`, `prisma generate` and the price scripts.

| Name                    | Required? | Default                                                               | What it controls                                                                                      | When you'd change it                                                                                   |
| ----------------------- | --------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | Required  | Template: `postgresql://postgres:postgres@localhost:5432/marginfront` | The database the migrations and price scripts use. `npm run db:setup` creates it if it doesn't exist. | When your database is on another host or needs a different user, password or TLS (`?sslmode=require`). |
| `DATABASE_URL_UNPOOLED` | Required  | Template: the same address                                            | The connection migrations use. Migrations can't run through a connection pooler.                      | Only when `DATABASE_URL` goes through a pooler. Then point this one straight at the database.          |

A variable already set in your shell wins over the file.

## SDK, MCP server and meter

These packages have no `.env.example`. They read one server-address setting,
`MARGINFRONT_API_URL`, plus a key. See [packages.md](packages.md) for the full
list.

## Tests and CI only

`MF_TEST_BASE_URL`, `MF_TEST_SECRET_KEY` and `MF_TEST_PUBLISHABLE_KEY` turn on
the live SDK and API contract tests, which are skipped when they're unset. `SHADOW_DATABASE_URL` is used by
`npm run db:check-migrations`. None of these belong in a deployment.
