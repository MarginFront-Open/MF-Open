# Invoices

An invoice is the bill a customer pays. MarginFront builds invoices from each
subscription's plan and the usage you send. The API lets you read them, show
them in your own product, sync them to accounting, generate one on demand and
email it.

Invoices go out on their own once you run the scheduled billing jobs. Without
a scheduler calling them, no usage invoice is ever issued. See
[make-it-yours.md](../make-it-yours.md#your-scheduler-for-the-billing-jobs).
You can also generate a draft for any subscription at any time with
[`POST /invoices/generate`](#generate-a-draft-invoice).

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is the final word on every request and response shape.

- [Who can call these routes](#who-can-call-these-routes)
- [List invoices](#list-invoices)
- [Read an invoice](#read-an-invoice)
- [Generate a draft invoice](#generate-a-draft-invoice)
- [Email an invoice](#email-an-invoice)
- [Other invoice routes](#other-invoice-routes)
- [Invoice statuses](#invoice-statuses)
- [Refunds](#refunds)
- [Using the SDK](#using-the-sdk)
- [Analytics or invoices?](#analytics-or-invoices)

## Who can call these routes

Send a secret key (`mf_sk_...`) in the `x-api-key` header. See
[authentication.md](authentication.md).

- **Reads** work with any secret key except an ingest-only or legal key.
- **Writes** (generate, send, finalize, void, payments, refunds) need a key
  whose role is owner, admin or finance. Any other role gets `403`.
- A publishable key (`mf_pk_...`) gets `403` on every route on this page.

## List invoices

```
GET /invoices
```

**Query parameters (all optional):**

- `customerId`: the customer's MarginFront `id`.
- `subscriptionId`
- `status`: one of the [statuses](#invoice-statuses) below.
- `search`
- `sortBy`, `sortOrder` (`asc` or `desc`)
- `page` (default `1`) and `limit` (default `10`).

```bash
curl "https://billing.example.com/v1/invoices?customerId=00000000-0000-4000-8000-000000000001&status=issued" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

**Returns** `{ results, page, limit, totalPages, totalResults }`. To filter by
your own `customerExternalId` instead, use the SDK's `invoices.list`, below.

## Read an invoice

```
GET /invoices/{invoiceId}
```

Returns the invoice with its line items: number, dates, status, subtotal,
tax, discount, total, amount paid and amount due.

```bash
curl https://billing.example.com/v1/invoices/00000000-0000-4000-8000-000000000007 \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

**Errors:** `404` when no invoice with that ID exists in your organization.

## Generate a draft invoice

Turns a subscription's billing period into a draft you can check, edit or
send. The API works out the lines from the period's usage events and the
plan's recurring, seat and one-time charges.

```
POST /invoices/generate
```

**Body:**

| Field                | Type   | Required | What it is                                                              |
| -------------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `customerId`         | UUID   | Yes      | The customer's MarginFront `id`, not your external ID.                  |
| `subscriptionId`     | UUID   | Yes      | The subscription to bill. It must belong to that customer.              |
| `billingPeriodStart` | date   | No       | ISO 8601. Defaults to the subscription's current period start.          |
| `billingPeriodEnd`   | date   | No       | ISO 8601. Defaults to the subscription's current period end.            |

Leave the dates out to bill the current period, which is what a "bill now"
button wants. Pass them to bill a past period again.

```bash
curl -X POST https://billing.example.com/v1/invoices/generate \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "00000000-0000-4000-8000-000000000001",
    "subscriptionId": "00000000-0000-4000-8000-000000000006"
  }'
```

**Returns `201`** with the draft invoice, its line items and totals. It
starts as a `draft`. Finalizing or sending it moves it to `issued`.

**Errors:**

- `400`: `customerId` or `subscriptionId` is missing or not a UUID, or the
  customer doesn't own that subscription.
- `404`: the subscription isn't in your organization.

## Email an invoice

Emails the invoice to the customer with a **Pay Now** link that opens Stripe
Checkout. Use it after generating a draft, or to resend an issued invoice. A
paid invoice goes out as a receipt.

```
POST /invoices/{invoiceId}/send
```

**Body (every field optional; send `{}` for the defaults):**

| Field            | Type   | What it does                                                                     |
| ---------------- | ------ | -------------------------------------------------------------------------------- |
| `recipientEmail` | string | Sends to this address instead of the customer's stored email.                    |
| `subject`        | string | Replaces the default subject, `Invoice {number} from {your organization name}`.  |
| `message`        | string | A note shown above the invoice details.                                          |

```bash
curl -X POST https://billing.example.com/v1/invoices/00000000-0000-4000-8000-000000000007/send \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "recipientEmail": "billing@customer.example.com",
    "subject": "Your May invoice",
    "message": "Your card on file will be charged in 5 days."
  }'
```

**Returns:**

```json
{
  "success": true,
  "message": "Invoice email sent successfully",
  "emailId": "00000000-0000-4000-8000-00000000000d",
  "recipientEmail": "billing@customer.example.com"
}
```

`emailId` is the email provider's ID for the message. `recipientEmail` is the
address it actually went to.

**A draft is issued when you send it.** If the invoice was a `draft`, sending
it moves it to `issued`. There's no separate finalize step to call first.

**After payment**, Stripe's webhook marks the invoice `paid`. You don't need to
poll. Stripe has to be connected for this; see
[make-it-yours.md](../make-it-yours.md#payments).

The **Pay Now** link points at your dashboard (`FRONTEND_URL`), at
`/i/{invoiceId}/pay`.

**Errors:**

- `400`: no recipient (no `recipientEmail` and no stored email), or the email
  provider refused the message.
- `404`: the invoice isn't in your organization.
- `503`: email is off on this server because `RESEND_API_KEY` isn't set.
  Nothing was sent or changed. See
  [alerts-and-notifications.md](../alerts-and-notifications.md#email).

## Other invoice routes

These exist too. Their shapes are in `/api-docs`.

| Route                                                         | What it does                              |
| ------------------------------------------------------------- | ----------------------------------------- |
| `POST /invoices`                                              | Create an invoice by hand.                |
| `PUT /invoices/{invoiceId}`                                   | Edit an invoice.                          |
| `POST /invoices/{invoiceId}/finalize`                         | Move a draft to `issued`.                 |
| `POST /invoices/{invoiceId}/mark-paid`                        | Mark an invoice `paid`.                   |
| `POST /invoices/{invoiceId}/void`                             | Mark an invoice `void`.                   |
| `GET /invoices/{invoiceId}/payments`                          | The invoice's payments.                   |
| `POST /invoices/{invoiceId}/payments`                         | Record a payment received outside Stripe. |
| `POST /invoices/{invoiceId}/payments/{paymentId}/refund`      | Refund a payment. See [Refunds](#refunds).|
| `GET /invoices/{invoiceId}/payments/{paymentId}/refunds`      | A payment's refunds.                      |

## Invoice statuses

Every invoice has exactly one of these seven statuses.

| Status     | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `draft`    | Still being built. Amounts can change. Never counts as billed.                           |
| `pending`  | In the list of statuses, but no revenue figure counts it.                               |
| `issued`   | Sent to the customer and waiting for payment. Counts as billed.                         |
| `paid`     | Paid.                                                                                   |
| `overdue`  | Past its due date without full payment. Still counts as billed.                         |
| `void`     | Canceled. Never counted anywhere.                                                       |
| `refunded` | Was paid, then fully refunded.                                                          |

The usual path is `draft`, then `issued`, then `paid` or `overdue`.

How the revenue figures read them:

- **Billed** adds up the totals of `issued` and `overdue` invoices.
- **Collected** adds up successful payments, less refunds, by payment date. It
  doesn't add up `paid` invoice totals.
- **Outstanding** is the total of `issued` and `overdue` invoices right now.

These rules live in [packages/db/CANON.md](../../packages/db/CANON.md).

## Refunds

A refund is made against a payment, not against the invoice:

```
POST /invoices/{invoiceId}/payments/{paymentId}/refund
```

**Body (both optional):**

- `amount`: how much to refund. Defaults to the whole payment.
- `reason`: a note.

For a Stripe payment, the API asks Stripe to send the money back and records
the refund as pending until Stripe's webhook confirms it. For a payment
recorded by hand, it records the refund straight away.

What happens to the invoice:

- A refund of the whole payment, when no other payment on the invoice still
  counts, moves the invoice to `refunded`.
- A partial refund, or a full refund while another payment still counts,
  leaves the status as it is and lowers the amount paid.
- For a payment recorded by hand, refunding more than the payment, or a
  payment that's already fully refunded, is refused with `400`.

Because collected revenue counts payments less refunds, a refund lowers it
straight away. If you build your own accounting sync, read `refunded` the way
you read `void` for revenue.

## Using the SDK

Build and install the SDK from this repository first, as in
[packages.md](../packages.md). Then:

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1", // or set MARGINFRONT_API_URL
});

// List a customer's invoices by your own ID (20 a page by default)
const { invoices } = await client.invoices.list({
  customerExternalId: "acme-001",
  status: "issued",
});

const invoice = await client.invoices.get("00000000-0000-4000-8000-000000000007");
console.log(`${invoice.invoiceNumber}: $${invoice.totalAmount}`);

// Draft an invoice for the subscription's current period
const draft = await client.invoices.generate({
  customerId: "00000000-0000-4000-8000-000000000001",
  subscriptionId: "00000000-0000-4000-8000-000000000006",
});

// Email it. A draft becomes "issued" as it's sent.
const sent = await client.invoices.send(draft.id);
console.log(`Sent to ${sent.recipientEmail}`);

// Another address, subject and note
await client.invoices.send(draft.id, {
  recipientEmail: "billing@customer.example.com",
  subject: "Your May invoice",
  message: "Your card on file will be charged in 5 days.",
});
```

The SDK calls the `/sdk/invoices` routes, which behave like the routes above.
Through MCP: `list_invoices`, `get_invoice`, `generate_invoice` and
`send_invoice`.

## Analytics or invoices?

Both show money. Pick by the question you're answering:

| Use analytics                                       | Use invoices                                  |
| --------------------------------------------------- | --------------------------------------------- |
| "How much has this customer used so far?"           | "What's the bill I'm sending them?"           |
| Live views and dashboards                           | Accounting, receivables, customer portals     |
| Any date range, including the current one           | Billing periods that have been invoiced       |

If the number has to match what the customer pays, use invoices. If it's a
"here's what you're using" view, use analytics. See
[analytics-revenue.md](analytics-revenue.md).
