# Make it yours

MarginFront's components work together out of the box. A few of them connect
to services you choose: payments, email, a scheduler, sign-in, file storage,
hosting and Redis. This page lists each one: what to wire in, where the seam
is in the code, and what done looks like.

- [Payments](#payments)
- [Your email provider](#your-email-provider)
- [Your scheduler for the billing jobs](#your-scheduler-for-the-billing-jobs)
- [Your sign-in providers and who can sign up](#your-sign-in-providers-and-who-can-sign-up)
- [Your hosting](#your-hosting)
- [Your Redis](#your-redis)
- [Your brand](#your-brand)
- [What's public, and who sees money](#whats-public-and-who-sees-money)
- [Roles and sessions](#roles-and-sessions)
- [API keys and rate limits](#api-keys-and-rate-limits)
- [Alerts to other channels](#alerts-to-other-channels)
- [Invoice reminders](#invoice-reminders)
- [Product analytics](#product-analytics)
- [Model recommendations](#model-recommendations)
- [New pages and routes](#new-pages-and-routes)

## Payments

Stripe is the payment provider. The Stripe code sits behind one interface,
`PaymentAdapter`, in
`apps/api-nest/src/modules/payment-providers/interfaces/payment-adapter.interface.ts`.
The billing code calls that interface and never the Stripe SDK.

### Your Stripe keys and webhook endpoint

**Wire in:** a Stripe account for each organization that collects payments.

1. In the dashboard, open **Settings**, then **Integrations**.
2. On the Stripe card, open **Use API keys instead** and paste the secret key.
3. In Stripe, create a webhook endpoint at the address the dialog shows:
   `https://<your API address>/v1/webhooks/stripe/<organization ID>`.
4. Subscribe it to `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `payment_intent.payment_failed`,
   `refund.created` and `refund.updated`.
5. Paste the endpoint's signing secret into the dialog and connect.

**Where the seam is:** the keys are saved encrypted by
`PaymentProvidersService.create` and read back by `PaymentAdapterFactory`. The
webhook route is `WebhooksController` in
`apps/api-nest/src/modules/webhooks`.

**Done looks like:** you open an issued invoice's pay link, pay with a
[Stripe test card](https://docs.stripe.com/testing), and the invoice shows as
paid in the dashboard once Stripe's webhook arrives.

### One Stripe account for every organization (Stripe Connect)

**Wire in:** your own Stripe Connect platform, so organizations click
**Connect with Stripe** and paste no keys.

1. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
   `STRIPE_CONNECT_CLIENT_ID` in the API settings.
2. Set `NEXT_PUBLIC_APP_URL` in the dashboard settings and rebuild.
3. In your Stripe platform, add
   `<your dashboard address>/stripe-connect/callback` as a redirect address.
4. Point a Connect webhook at `https://<your API address>/v1/webhooks/stripe`
   with the five events listed above.

**If you don't run a Connect platform:** the connect flow can't finish
without those settings. Remove the **Connect with Stripe** button from
`ProviderNotConnectedCard` in
`apps/dashboard/src/features/settings/integrations/index.tsx`, so
organizations go straight to the API-key form.

**Where the seam is:** `apps/api-nest/src/modules/stripe-connect` runs the
connect flow. `WebhooksService.handleStripeWebhookFallback` handles messages
sent to the platform address and verifies them with `STRIPE_WEBHOOK_SECRET`.

**Card details on Connect payments:** after a payment, the adapter asks Stripe
for the card brand, last four digits, receipt link and fee
(`StripeAdapter.extractCheckoutCompleted`). On the platform address that call
runs on your platform account. To fetch those details from the connected
account, pass the event's `account` value as the `stripeAccount` request option
there. The payment is recorded either way.

**Done looks like:** an organization connects with one click, a test payment on
its invoice marks the invoice paid, and the payment's saved details include the card brand
and last four digits.

### Which Stripe events do something

**Wire in:** any Stripe event you want the API to act on.

**Where the seam is:** `StripeAdapter.verifyWebhook` in
`apps/api-nest/src/modules/payment-providers/adapters/stripe.adapter.ts` maps
Stripe event types to five normalized ones: `checkout.completed`,
`payment.failed`, `refund.created`, `refund.updated` and `ignored`.
`WebhooksService` then routes each normalized type to a handler. Every Stripe
event type the map doesn't name is `ignored`: the API answers 200 and changes
nothing.

To act on another event:

1. Add its `case` in `StripeAdapter.verifyWebhook`.
2. Add a handler for it in `WebhooksService`.
3. Add the event name to `webhookEvents` in
   `apps/dashboard/src/features/settings/integrations/index.tsx`, so the
   settings page tells people to subscribe to it.

Refunds arrive as `refund.created` and `refund.updated`. `charge.refunded` is
not in the map. Add it the same way if your Stripe account sends it and you want
it handled.

Delayed payment methods, such as bank debits, send
`checkout.session.async_payment_failed` when the money doesn't arrive. It isn't
in the map, so that payment stays `pending`. To mark it failed, add a case for
it in `StripeAdapter.verifyWebhook` and a handler in `WebhooksService` that
finds the pending payment by its checkout session ID, as
`handleCheckoutCompleted` does, and sets its status to `failed`.

**Done looks like:** the tests in
`apps/api-nest/src/modules/webhooks/webhooks.service.spec.ts` under "platform
Stripe webhook with no organization" show the pattern. They build an event by
hand, sign it with a made-up secret and check what changed. Copy one for your
event.

### The webhook status badge

**Wire in:** a real status for the "Webhook Status" line on a connected Stripe
card.

**Where the seam is:** `ProviderCard` in
`apps/dashboard/src/features/settings/integrations/index.tsx` reads
`provider.settings.webhookId`. Nothing writes that field, so the badge reads
"Not Set" for a connection made with API keys, whether or not a signing secret
was saved. Save a value into `settings` when the organization connects (the
`updatePaymentProvider` action in
`apps/dashboard/app/actions/payment-providers.ts` merges settings), or change
the badge to read whatever you track.

**Done looks like:** the badge says "Active" for a connection whose webhook is
registered.

### Minimum charges in other currencies

**Wire in:** Stripe's minimum charge for each currency you bill in.

**Where the seam is:** `StripeAdapter.createCheckoutSession` checks a balance
against Stripe's $0.50 minimum before it opens checkout, for USD only
(`STRIPE_MIN_CHARGE_CENTS_USD` in
`apps/api-nest/src/modules/payment-providers/adapters/stripe.adapter.ts`). In
other currencies Stripe refuses a too-small charge with its own error. Add the
minimums from
[Stripe's list](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts)
as a map by currency and check every charge against it.

**Done looks like:** a balance below the minimum in any of your currencies
gets the same plain message as a small USD balance.

### Your file storage for invoice PDFs

**Wire in:** a place to keep invoice PDFs, such as an object store.

**Where the seam is:** `PdfService.generateInvoicePDF` in
`apps/api-nest/src/modules/pdf/pdf.service.ts` renders the PDF to a file in the
server's temporary folder and returns that file path as `s3Location`. The
billing job saves it as the invoice's `pdfUrl`, and the customer portal's
**Download PDF** button and `GET /v1/public/invoices/<invoice ID>/pdf` hand
that value out. Upload the file to your storage inside `generateInvoicePDF` and
return its web address as `s3Location` and its key as `s3Key`.

**Done looks like:** `GET /v1/public/invoices/<invoice ID>/pdf` returns a `url`
that opens the PDF in a browser.

### Another payment provider

**Wire in:** a provider besides Stripe.

1. Write a class that implements `PaymentAdapter`, next to
   `adapters/stripe.adapter.ts`.
2. Return it from `PaymentAdapterFactory.createAdapter` for your provider type.
3. Add the type to `enum_payment_providers_type` and
   `enum_inbound_webhooks_source` in `packages/db/prisma/schema.prisma`, and to
   `enum_invoice_payments_paymentMethod` if payments should be labeled with it.
   Then create a migration with `npm run db:migrate --workspace=@marginfront/db`.
4. Add the type to `PaymentProviderType` in
   `apps/api-nest/src/modules/payment-providers/dto/create-payment-provider.dto.ts`.
5. Add a webhook route to `WebhooksController` and a service method that
   builds your adapter, modeled on `handleStripeWebhook`.
6. In the dashboard, add the type to `PaymentProviderType` and
   `getSupportedProviders` in `apps/dashboard/src/lib/api/payment-providers.ts`,
   and an entry to `PROVIDER_CONFIGS` in the integrations settings page.

**Done looks like:** your provider's card appears under **Settings**, then
**Integrations**, and a test payment through it marks an invoice paid.

### If you change the API prefix

The API reads Stripe webhook bodies raw so signatures can be checked. That
raw-body handling is mounted on the literal path `/v1/webhooks/stripe` in
`apps/api-nest/src/main.ts`. If you set `API_PREFIX` to something other than
`v1`, change that path to match.

## Your email provider

**Wire in:** an email service. Resend is wired in already: set `RESEND_API_KEY`
and the sender addresses in both apps (see
[configuration.md](configuration.md#email)). Sign-in, invitations, invoices,
receipts and alerts all go by email.

**Where the seam is:** every API email goes through `sendEmail` in
`apps/api-nest/src/modules/email/email.service.ts`. The dashboard sends from
`app/lib/auth.ts`, `app/actions/onboarding.ts`, `app/actions/invoices.ts`,
`app/actions/send-customer-portal-link.ts` and
`app/api/portal-auth/send-magic-link/route.ts`, all under `apps/dashboard`. To
use another provider, replace the Resend call in each of those places.

**Done looks like:** a sign-in link and an invoice email both arrive from your
own domain.

## Your scheduler for the billing jobs

**Wire in:** anything that can call a URL on a timetable: cron, a Kubernetes
CronJob, GitHub Actions or your host's scheduler. Without it, no usage invoice
is ever issued.

**Where the seam is:** two routes, `GET /v1/subscriptions/cron/dispatch` and
`GET /v1/subscriptions/cron/mark-overdue`, each called with
`Authorization: Bearer <CRON_SECRET>`. The schedule and a ready crontab are in
[self-hosting.md](self-hosting.md#scheduled-jobs).

**Done looks like:** the morning after a billing period ends, the
subscription's invoice is issued and its customer has the email.

## Your sign-in providers and who can sign up

**Wire in:** the sign-in methods you want, the bot check, and a rule for who
may create an account.

1. Email links and one-time codes work once email is set up. Password
   sign-up is off.
2. Add Google or GitHub with their client ID and secret. See
   [integrations.md](integrations.md#sign-in).
3. Turn on Cloudflare Turnstile so sign-in and email requests can't be
   scripted. See [integrations.md](integrations.md#the-bot-check).
4. By default, any email address that signs in gets an account and can create
   its own organization. To limit that, add a `user.create.before` hook to
   `databaseHooks` in `apps/dashboard/app/lib/auth.ts` that refuses addresses
   you don't allow. Every sign-in method creates users through it. You can
   also put an identity provider or a network rule in front of the dashboard.

**Where the seam is:** `apps/dashboard/app/lib/auth.ts` configures
[Better Auth](https://www.better-auth.com), and
`apps/dashboard/app/lib/social-providers.ts` reads the provider keys.

**Done looks like:** your chosen methods appear on the sign-in page, and an
address outside your rule is refused.

## Your hosting

**Wire in:** two public addresses, one for the dashboard and one for the API,
behind HTTPS. [self-hosting.md](self-hosting.md) has the full checklist. The
items that are easy to miss:

- **Trusted origins.** Set `AUTH_TRUSTED_ORIGINS` on the dashboard and
  `CORS_ORIGIN` on the API to your real addresses. The sign-in server also
  trusts `http://localhost:3000` and `http://localhost:3001` when
  `AUTH_TRUSTED_ORIGINS` is unset, and the API always accepts cookies from
  `http://localhost:3000` and `http://localhost:4000`
  (`apps/api-nest/src/common/utils/cors.ts`). Trim those lists for production
  if no one runs a browser on the server itself.
- **One reverse proxy in front of the API.** The API reads the caller's
  address from `X-Forwarded-For` and trusts exactly one hop, so rate limits
  need a proxy that sets that header.
- **The customer portal host.** Any host whose first label is `portal` (or
  starts with `portal-`) is served as the portal, as well as the host in
  `PORTAL_BASE_URL` (`apps/dashboard/middleware.ts`).
- **The API reference.** `/api-docs` on the API is public. Block the path at
  your proxy if you'd rather not serve it.
- **A Content-Security-Policy.** The dashboard sets the basic security headers
  in `apps/dashboard/next.config.ts` under `headers()`. Add a
  `Content-Security-Policy` there or at your proxy, allowing your API, Stripe,
  Cloudflare Turnstile and Sentry if you use them.
- **Invoice PDFs.** They're rendered with `@sparticuz/chromium`, a Chromium
  build for Linux, so run the API on Linux. The template,
  `apps/api-nest/src/templates/invoice.hbs`, uses pre-built Tailwind CSS
  inlined in the file (rebuild with
  `npm run build:invoice-css --workspace=@marginfront/api-nest` after editing
  template classes) with no CDN calls. To prevent SSRF, invoice PDF rendering
  only fetches public `https://` logo URLs by default and blocks all other
  outbound requests; air-gapped or intranet operators who intentionally host
  logos on a private network can adjust that check in
  `apps/api-nest/src/modules/pdf/pdf-url-safety.ts`.
- **Site icons during onboarding.** The onboarding screen shows a website's
  icon from Google's favicon service when the site doesn't give one. The
  addresses are built in
  `apps/dashboard/src/features/quick-onboarding/components/shared/WebsiteScanner.tsx`
  and `apps/api-nest/src/modules/onboarding/onboarding.service.ts`. Point them
  at your own icon service or drop the fallback.
- **Dashboard fonts.** `apps/dashboard/app/layout.tsx` loads Inter, JetBrains
  Mono and Space Grotesk through `next/font/google`, which downloads them at
  build time. Switch to `next/font/local` with font files you host to build
  with no outbound calls.
- **Settings files, not shell variables.** Turborepo passes only listed
  variables to the apps, so keep settings in each app's env file
  (`turbo.json` lists what it passes).
- **Logs.** The dashboard logs the address each sign-in email goes to, and
  outside production with no email key the portal logs the sign-in link it
  would have sent. Treat your logs as personal data.
- **Dependencies.** Run `npm audit` and decide which advisories matter for
  your deployment before you go live.

**Container files.** `apps/api-nest/Dockerfile` and `apps/dashboard/Dockerfile`
build each app from the repository root with the lockfile, and `compose.yaml`
runs PostgreSQL for local work. They're a starting point: adapt the base image,
the build-time settings and the start command to your platform. See
[self-hosting.md](self-hosting.md#containers).

**Done looks like:** both apps answer on your HTTPS addresses, `GET /health`
on the API returns `{"status":"ok",...}`, and you can sign in.

## Your Redis

**Wire in:** any Redis server, once you run more than one API process.

**Where the seam is:** set `REDIS_URL`. Rate limits, payment-webhook
de-duplication, failure alerts to Slack and the failed-key throttle use it.
[self-hosting.md](self-hosting.md#redis) shows what changes without it.

**Done looks like:** the API starts with no `REDIS_URL` warnings.

## Your brand

**Wire in:** your name, logo, links and email wording.

**Where the seam is:** the `NEXT_PUBLIC_COMPANY_NAME`,
`NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_TERMS_URL` and
`NEXT_PUBLIC_PRIVACY_URL` settings cover footers and links (see
[configuration.md](configuration.md#your-branding-and-links)). Email text,
colors and layout are in the templates: `apps/dashboard/app/lib/email-html.ts`
and the senders listed under [Your email provider](#your-email-provider) for
the dashboard, and `apps/api-nest/src/modules/email` for the API. Each
organization sets its own logo and colors during setup.

**Done looks like:** a sign-in email and an invoice carry your name and
colors.

## What's public, and who sees money

**Wire in:** a decision on each of these. They're public or open on purpose,
and each one has a seam if you want it closed.

- **Price lists.** `GET /v1/public/org/<slug or ID>/pricing` and `/config`
  return an organization's plans, prices, name and logo with no sign-in, so a
  pricing page can read them. To close them, remove or guard the routes in
  `apps/api-nest/src/modules/public/public.controller.ts`.
- **Portal sign-in pages.** `<portal host>/<slug>/login` shows the
  organization's name and logo.
- **Payment links.** Anyone with an invoice's payment link can open checkout.
  The ID in the link is long and random.
- **Portal sign-in emails** are limited to five an hour per address, so
  someone who knows a customer's address can use up that hour. Links your team
  sends from the dashboard still work. The limit is in
  `apps/dashboard/app/api/portal-auth/send-magic-link/route.ts`.

**Done looks like:** each item is either something you want public or closed
by your change.

## Roles and sessions

**Wire in:** the rule for who may change the books, and how fast a removed
member loses access.

- **Classification rules and the chart of accounts.** Their write actions in
  `apps/dashboard/app/actions/classification-rules.ts`,
  `chart-of-accounts.ts` and `signal-classification.ts` each start with
  `assertMoneyManager`, so owners, admins and finance can change them. To let
  another role edit, or to narrow it, swap that call for another helper in
  `apps/dashboard/app/actions/_shared` or add one there.
- **Removing a member.** `removeMember` in
  `apps/dashboard/app/actions/team.ts` and `TeamService.removeMember` in
  `apps/api-nest/src/modules/team/team.service.ts` delete the membership and
  the person's stored sign-in sessions for that organization, so their next
  request is refused. The dashboard issues no signed tokens. If you add
  Better Auth's `jwt` plugin to `apps/dashboard/app/lib/auth.ts`, the API
  accepts those tokens in `CombinedAuthGuard.validateJwt`
  (`apps/api-nest/src/modules/auth/guards/combined-auth.guard.ts`). A token
  isn't stored, so one issued before a removal works until it expires. To end
  access at once, record revoked token IDs at removal and refuse them in
  `validateJwt`.

**Done looks like:** a member without the role can't save a rule or a GL code,
and a removed member's next request is refused.

## API keys and rate limits

**Wire in:** the key lifetime and limits that fit your traffic.

- **Expiry.** The API refuses a key past its `expiresAt` date, and keys made
  in the dashboard have none, so they last until revoked. To issue expiring
  keys, set `expiresAt` where keys are created in
  `apps/dashboard/app/actions/api-keys.ts`.
- **Rate limits.** 1,200 requests a minute per organization for signed-in and
  key traffic, 60,000 a minute for usage intake, and 60 a minute per address
  for anonymous public routes. They're set in
  `apps/api-nest/src/common/throttler/throttler.config.ts`.
- **Spend per key.** Nothing caps how much usage one key can record. Watch for
  a looping client with a customer watch, and revoke a leaked key under
  **Build**, then **API keys**.
- **Request bodies.** Unknown fields are ignored, not rejected. To reject
  them, set `whitelist` and `forbidNonWhitelisted` to `true` in the
  `ValidationPipe` in `apps/api-nest/src/main.ts` and run the API tests.

**Done looks like:** your limits and expiry rules hold in a quick test with a
throwaway key.

## Alerts to other channels

**Wire in:** a chat tool, SMS or webhook for spend-cap, credit-pool and
customer-watch alerts, which go by email.

**Where the seam is:** `sendCapAlertEmail`, `sendPoolAlertEmail` and
`sendCustomerAlertEmail` in `apps/api-nest/src/modules/email/email.service.ts`.
Their callers are in `cost-control`, `credit-pool` and `customer-alerts` under
`apps/api-nest/src/modules`. The operator failure alerts in
`apps/api-nest/src/modules/auth/customer-failure-alert.service.ts` already
post to a Slack webhook and show the pattern.

**Done looks like:** an alert that crosses its threshold arrives in your
channel as well as by email.

## Invoice reminders

**Wire in:** a schedule for overdue reminders.

**Where the seam is:** `POST /v1/invoices/<invoice ID>/reminders/send` sends
one reminder, and `/reminders/pause` and `/reminders/resume` control them
(`apps/api-nest/src/modules/invoices/invoices.controller.ts`). Nothing calls
them on a timer. Add a job next to `mark-overdue` in
`apps/api-nest/src/modules/subscription/subscription.controller.ts` that
sends one for each overdue invoice, and schedule it with the other two.

**Done looks like:** a customer with an overdue invoice gets a reminder the
day after it's marked overdue.

## Product analytics

**Wire in:** a product analytics service, if you want one. MarginFront sends
no analytics anywhere.

**Where the seam is:** the dashboard's root layout, `apps/dashboard/app/layout.tsx`,
for page views, and the server actions and API services for named events.
Decide what personal data you're comfortable sending, and mask secrets: the
screens that show API keys and portal links carry the `sentry-mask` class, so
a session recorder can reuse it.

**Done looks like:** your service shows page views and the events you chose,
with no keys or portal links in recordings.

## Prices for your own tools

**Wire in:** a price for each third-party API or MCP tool your agents call.
The catalog prices models and the tools that ship inside Claude Code and
Codex. Any other name lands under **Needs attention** with no cost until it
has a row.

**Where the seam is:** `BUILT_IN_ROWS` in
`packages/db/scripts/sync-service-pricing.ts`. Add one row per tool. The cost
meter sends a tool call with the provider `tool` and the tool's name as the
model, so key the row `tool/` plus that name in lowercase:

```ts
{
  externalId: "tool/mcp__search__query",
  displayName: "Search MCP: query",
  provider: "tool",
  serviceType: "Agent Built-in",
  inputCost: 5,
  outputCost: null,
  costUnit: "1K requests",
  contextWindow: null,
  source: "builtin",
  isApi: true,
},
```

The price is in dollars per `costUnit`, and the unit must be one of
`KNOWN_COST_UNITS` in the same file. Load it with `npm run db:seed-pricing`,
or `npm run db:sync-pricing` if you keep live prices. Calls already waiting
under **Needs attention** get their cost when you map them to the new row
there with **Map & backfill**.

**Done looks like:** a new call to that tool lands with a cost, and none are
left under **Needs attention**.

## Model recommendations

**Wire in:** suggestions of cheaper models with similar quality, if you want
them. The price catalog gives you the cost side.

**Where the seam is:** add a table of model scores next to `service_pricing`
in `packages/db/prisma/schema.prisma`, a job that fills it, and a card on
**MFiQ** (see [features.md](features.md#mfiq)). Public score sources include
Epoch AI's benchmark data (CC-BY-4.0), the LMArena leaderboard dataset on
Hugging Face (CC-BY-4.0), the Berkeley Function-Calling Leaderboard
(Apache-2.0) and tau2-bench (MIT). Check each source's licence and terms
before you store or show its data.

**Done looks like:** an agent running an expensive model gets a card naming a
cheaper one with a comparable score and the monthly saving.

## New pages and routes

**Wire in:** your own screens and endpoints.

**Where the seam is:** the dashboard's middleware only checks that a session
cookie exists. The real checks are in each page and action, so every new one
needs its own:

- Pages: `requireRouteRoles(...)` from `apps/dashboard/app/lib/require-route-roles.ts`.
- Server actions: the `assert-*` helpers in `apps/dashboard/app/actions/_shared`.
- API routes: `@UseGuards(OrgRoleGuard)` with `@OrgRoles(...)`, using the role
  sets in `packages/db/src/lib/org-roles.ts`.

Money math goes through `@marginfront/db` and follows
[packages/db/CANON.md](../packages/db/CANON.md).

**Done looks like:** a member without the role gets a clean refusal from your
new page, action and route.
