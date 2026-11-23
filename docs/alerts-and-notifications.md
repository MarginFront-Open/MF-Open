# Alerts and notifications

What MarginFront sends, to whom, and what you set up so it can.

## Email

All email goes through [Resend](https://resend.com). There's no SMTP option and
no other provider built in.

### Connecting your Resend account

1. Create a Resend account and verify a sending domain in it.
2. Create an API key in Resend.
3. In `apps/api-nest/.env`, set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. Set
   `RESEND_INVOICE_FROM_EMAIL` too if your customers should see a no-reply
   address.
4. In `apps/dashboard/.env.local`, set the same three values.
5. Restart both apps.

The two apps send different emails, so both need the key. The sender addresses
must be on the domain you verified.

### What happens with email off

- **API:** it starts normally, logs `Email is turned off: RESEND_API_KEY is not set`
  once, and logs each email's subject instead of sending it. Sending or
  reminding about an invoice by hand answers with an error that says email is
  off, and changes nothing.
- **Dashboard:** in production, sign-in by email link or code fails, because
  there's no way to deliver the link. On localhost you can print links to the
  terminal instead with `SKIP_MAGIC_LINK_EMAIL` (see the
  [quick start](../README.md#quick-start-a-signed-in-dashboard-on-your-machine)).
  The welcome email is skipped.

### Emails the dashboard sends

| Email                | When                                                            | Sent to            |
| -------------------- | --------------------------------------------------------------- | ------------------ |
| Sign-in link         | Someone signs in or signs up with their email address           | That person        |
| Sign-in code         | Someone asks for a one-time code                                | That person        |
| Team invitation      | An owner or admin invites a teammate, or resends the invite     | The invited person |
| Welcome              | Someone finishes setting up their first organization            | That person        |
| Invoice              | Someone sends an invoice from the dashboard                     | The customer       |
| Customer portal link | Your team sends a customer a link to their billing portal       | The customer       |
| Portal sign-in link  | A customer asks for a sign-in link on the portal's sign-in page | The customer       |

Sign-in links and codes expire after 10 minutes.

### Emails the API sends

| Email                       | When                                                                                  | Sent to                    |
| --------------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| Invoice ready to pay        | The daily dispatch job issues a usage invoice                                         | The customer               |
| Invoice sent                | Right after that, as a note to you                                                    | Your organization's owners |
| Invoice (manual send)       | Someone sends an invoice through the API                                              | The recipient they choose  |
| Invoice reminder            | Someone sends a reminder through the API, for an issued, pending or overdue invoice   | The customer               |
| Payment receipt             | Stripe reports a successful payment                                                   | The customer               |
| Spend-cap alert             | Spending crosses one of a cap's alert levels                                          | Alert recipients           |
| Credit-pool alert           | A credit pool crosses 50%, 80% or 95% used, or runs out                               | Alert recipients           |
| Customer watch alert        | A watched customer's cost or revenue crosses its threshold                            | The watch's recipient      |
| Customer watch confirmation | Someone creates a customer watch                                                      | The watch's recipient      |
| Revoked key still in use    | A revoked API key keeps being used (at most once an hour per organization by default) | Alert recipients           |

**Alert recipients** are the organization's billing contact email if one is
set, and otherwise every current owner and finance member. If nobody qualifies,
the alert is skipped.

`PRODUCT_NAME` sets the name in the API's email footers. The sign-in, invite
and welcome emails from the dashboard say "MarginFront" in their text. Changing
that wording, colors or layout means editing the templates in the code.

### Using a different email provider

There's no setting for it. You'd change code in two places:

- **API:** `sendEmail` in `apps/api-nest/src/modules/email/email.service.ts`.
  Every API email goes through it.
- **Dashboard:** the Resend calls in `app/lib/auth.ts`,
  `app/actions/onboarding.ts`, `app/actions/invoices.ts`,
  `app/actions/send-customer-portal-link.ts` and
  `app/api/portal-auth/send-magic-link/route.ts` (all under `apps/dashboard`).

## Slack alerts

The API can post one kind of alert to Slack: a warning that some caller keeps
failing in the same way. That's usually a customer's integration with a wrong
key, bad data or too much traffic.

| Alert                   | Counts                                                | Default: alert after | Then quiet for |
| ----------------------- | ----------------------------------------------------- | -------------------- | -------------- |
| Rejected API keys       | Requests refused for a bad key, per caller IP address | 5 within 15 minutes  | 1 hour         |
| Bad usage data          | Usage records refused as invalid (HTTP 400 or 422)    | 5 within 15 minutes  | 1 hour         |
| Publishable key writing | A publishable key used on a write route (HTTP 403)    | 5 within 15 minutes  | 1 hour         |
| Rate limited            | Requests refused for going over the limit (HTTP 429)  | 50 within 5 minutes  | 6 hours        |

To turn them on:

1. In Slack, create an incoming webhook for the channel that should receive
   the alerts.
2. In `apps/api-nest/.env`, set `AUTH_FAILURE_SLACK_WEBHOOK_URL` to the
   webhook's address.
3. Make sure `REDIS_URL` is set. The counting lives in Redis, so without it
   these alerts are off.
4. Restart the API.

Every threshold, window and quiet period has its own setting. See
[configuration.md](configuration.md#alerts-to-slack). Without a webhook the
API still logs each failed request.

Nothing else posts to Slack. The dashboard sends nothing to Slack at all.

## Spend, credit and customer alerts

Three kinds of alert watch money and usage. They all send email only (customer
watches also show in the dashboard), so they need email turned on.

| Alert                 | What it watches                                                                                | Levels                                                                            | Where you set it up                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Spend-cap alerts      | Your team's own AI spend, as measured by the Code Cost Clarity meter, against a spend cap      | Each cap has its own levels, 50%, 80% and 100% unless you change them, up to five | The dashboard's internal AI spend controls, the SDK or the MCP server |
| Credit-pool alerts    | How much of a customer's prepaid credit pool is used in the current period                     | 50%, 80%, 95% and "exhausted". Fixed                                              | Any subscription whose plan uses a credit pool                        |
| Customer watch alerts | One customer's cost or revenue, in dollars, over this month, the last 30 days or a fixed range | One threshold per watch                                                           | A customer's page in the dashboard, or the MCP server                 |

### What drives them

Each alert is checked two ways:

1. **Soon after usage arrives.** When the API stores a usage event, it checks
   the alerts that event could affect. Checks are spaced at least 5 minutes
   apart per organization within one API process, and run after the response
   is sent.
2. **Every day, as a backstop.** The daily dispatch job
   (`/v1/subscriptions/cron/dispatch`) checks every cap, pool and watch after it
   issues invoices. Revenue watches depend on this daily run, because no usage
   event moves revenue. Without a scheduler, see
   [self-hosting.md](self-hosting.md#scheduled-jobs), these checks happen only
   when usage arrives.

Each alert level fires once per period. If several levels are crossed at once,
only the highest one is emailed. A record of what fired is kept in the
database, so running a check twice never sends the same alert twice.
