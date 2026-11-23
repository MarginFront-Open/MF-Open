# Integrations

The outside services MarginFront can use and what each one needs. Every
setting named here is described in [configuration.md](configuration.md). For
services you add yourself, see [make-it-yours.md](make-it-yours.md).

## Payments

Stripe is the payment provider. Customers pay invoices through a Stripe
Checkout page that the API creates. Each organization in your MarginFront
connects its own Stripe account under **Settings**, then **Integrations**. The
secrets it enters are encrypted with the API's `ENCRYPTION_KEY` before they're
stored.

An organization can connect Stripe in two ways.

### With its own keys

The organization opens **Use API keys instead** on the Stripe card and pastes a
Stripe secret key and a webhook signing secret. The dialog shows the webhook
address to register in Stripe. It's specific to the organization:

```
https://<your API address>/v1/webhooks/stripe/<organization ID>
```

Subscribe the webhook to these events, which are the ones the API acts on:

- `checkout.session.completed` and `checkout.session.async_payment_succeeded`:
  mark the invoice paid and email a receipt. A completed session that Stripe
  still reports as unpaid (a delayed payment method) waits for the second
  event.
- `payment_intent.payment_failed`: records the failed payment.
- `refund.created` and `refund.updated`: record refunds, including ones you
  start in the Stripe dashboard.

The API acknowledges every other event type and changes nothing. A message
with a bad signature is refused with a 400.

### With Stripe Connect

You, as the operator, register a Stripe Connect platform, and each organization
connects its Stripe account to it with the **Connect with Stripe** button.

1. In your Stripe platform account, add
   `<your dashboard address>/stripe-connect/callback` as a redirect address.
2. In the API settings, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
   `STRIPE_CONNECT_CLIENT_ID`.
3. In the dashboard settings, set `NEXT_PUBLIC_APP_URL` to the dashboard's
   address and rebuild.
4. Point a platform webhook at `https://<your API address>/v1/webhooks/stripe`,
   subscribed to the same events as above. That address verifies messages with
   `STRIPE_WEBHOOK_SECRET`.

### Build on it

The Stripe code sits behind one interface, `PaymentAdapter`, in
`apps/api-nest/src/modules/payment-providers`. To change what happens on a
payment, add an event, store invoice PDFs or add another provider, see
[make-it-yours.md](make-it-yours.md#payments).

## Sign-in

Sign-in runs inside the dashboard, on [Better Auth](https://www.better-auth.com).

| Method                 | Needs                                      | Notes                                                                                             |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Email link             | Email turned on                            | The sign-in page's main method. A new address gets a new account.                                 |
| One-time code by email | Email turned on                            | Codes last 10 minutes and allow 3 attempts.                                                       |
| Google                 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The "Continue with Google" button appears only when both are set.                                 |
| GitHub                 | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Turns on the provider. The sign-in page has no GitHub button.                                     |
| Team invitations       | Email turned on                            | Sent from **Settings**, then **Team**. Each invitation carries a role.                            |
| Customer portal        | Email turned on                            | Your customers sign in to their billing portal with an emailed link. Separate from team accounts. |

For Google or GitHub, register an OAuth app with the provider and use
`<your dashboard address>/api/auth/callback/google` (or `/github`) as the
redirect address. That's Better Auth's standard callback path.

### The bot check

Cloudflare Turnstile protects the sign-in and email-sending requests: password
sign-in, sending a code, sending a sign-in link and the two password-reset
requests. Checking a code or following a link isn't
challenged.

1. Create a Turnstile widget in Cloudflare for your dashboard's hostname.
2. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` to the widget's site key.
3. Set `TURNSTILE_SECRET_KEY` to its secret key.
4. Set `TURNSTILE_ALLOWED_HOSTNAMES` to the hostnames the dashboard is served
   from, comma-separated. Without it every check fails.
5. Rebuild and restart the dashboard.

With `TURNSTILE_SECRET_KEY` unset, the check is off, and in production the
dashboard logs a warning at startup.

## Error tracking with Sentry

Sentry is off by default. Nothing is sent unless you set your own Sentry
project's DSN.

- **API:** set `SENTRY_DSN`, and `SENTRY_ENVIRONMENT` to name the environment.
- **Dashboard:** set `NEXT_PUBLIC_SENTRY_DSN` and rebuild. The dashboard also
  keeps Sentry off while `NEXT_PUBLIC_APP_ENV` is `development`, so set it to
  `production` on a deployment.
- **Readable stack traces:** set `SENTRY_ORG`, `SENTRY_PROJECT` and
  `SENTRY_AUTH_TOKEN` at build time and the dashboard build uploads source maps.

With a DSN set, the dashboard records session replays for 10% of sessions and
for every session with an error. Replays mask all text and inputs and block
images and media. Fields that show API keys or portal links are masked even if
you set `NEXT_PUBLIC_SENTRY_REPLAY_UNMASK=true`, which unmasks other text and
media. Inputs stay masked either way.

`NEXT_PUBLIC_INTERNAL_EMAIL_DOMAINS` tags your own team's users in Sentry so you
can filter them out.

## Logs

The dashboard can send its logs to Better Stack when
`NEXT_PUBLIC_BETTERSTACK_SOURCE_TOKEN` is set. Otherwise logs go to the
console. The API logs to the console.
