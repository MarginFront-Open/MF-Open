# Subscriptions

A subscription puts one customer on one pricing plan, for one agent, from a
start date. It's what tells MarginFront how to charge that customer. Without
one, usage events are still recorded, but there's no price to bill them at.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is the final word on every request and response shape.

- [What you need first](#what-you-need-first)
- [Who can call these routes](#who-can-call-these-routes)
- [Create a subscription](#create-a-subscription)
- [Read a subscription](#read-a-subscription)
- [Read a subscription with revenue](#read-a-subscription-with-revenue)
- [List subscriptions](#list-subscriptions)
- [Update a subscription](#update-a-subscription)
- [Change invoice dates](#change-invoice-dates)
- [Read the change log](#read-the-change-log)
- [Using the SDK and MCP](#using-the-sdk-and-mcp)

## What you need first

A subscription ties together four things that must already exist in your
organization:

1. A **customer**. See [customers.md](customers.md).
2. An **agent**. See [agents.md](agents.md).
3. The **signals** you bill on, on that agent. See [signals.md](signals.md).
4. A **pricing plan** with its strategies. See
   [pricing-plans.md](pricing-plans.md) and
   [pricing-strategies.md](pricing-strategies.md).

Once the subscription exists, the usage you send for that customer is priced
by the plan and rolled into invoices. See [invoices.md](invoices.md).

## Who can call these routes

Send a secret key (`mf_sk_...`) in the `x-api-key` header. See
[authentication.md](authentication.md).

- **Reads** work with any secret key except an ingest-only or legal key.
- **Writes** (create, update, invoice dates) need a key whose role is owner,
  admin or finance. Any other role gets `403`.
- A publishable key (`mf_pk_...`) gets `403` on every route on this page.

## Create a subscription

```
POST /subscriptions
```

**Required:**

- `name` (string): a label you'll recognize in the dashboard.
- `planId` (UUID): the pricing plan's `id`.
- `agentId` (UUID): the agent's `id`.
- `customerId` (UUID): the customer's MarginFront `id`, not its
  `externalId`.
- `startDate` (ISO 8601 date): when billing starts. It can be in the past or
  the future.

**Common options:**

- `status`: `upcoming`, `active` or `ended`. When you leave it out, it's
  `active` if `startDate` has passed and `upcoming` if it hasn't.
- `billingCycle`: `monthly`, `yearly` or `custom`. Defaults to `monthly`.
- `billingModel`: `subscription`, `usage` or `hybrid`. Defaults to
  `subscription`. See the warning below.
- `netTerms` (number, zero or more): days to pay after an invoice is issued.
  Defaults to `30`.

> **`billingModel` decides what the scheduled billing job invoices.** The job
> issues invoices only for active subscriptions whose `billingModel` is
> `usage` or `hybrid`. If you charge for usage, set `usage` (usage only) or
> `hybrid` (fees plus usage). With the default, `subscription`, nothing is
> invoiced on a schedule. Generate those invoices yourself with
> [`POST /invoices/generate`](invoices.md#generate-a-draft-invoice) or from
> the dashboard.

**Other options:**

- `endDate` (ISO date): for a subscription that ends on a set date.
- `isForever` (boolean): defaults to `false`.
- `customCycleDays` (number, 1 or more): the cycle length when
  `billingCycle` is `custom`.
- `billingDay` (1 to 31): the day of the month to bill. Defaults to the day
  of `startDate`.
- `seatsCount` (number, zero or more): for `seat_based` strategies. Defaults
  to `0`.
- `proratedAmount` (number)
- `timezone` (string): defaults to the customer's timezone, then `UTC`.
- `autoCollectPayment` (boolean): defaults to `false`. When `true`, the
  scheduled job starts a Stripe Checkout session as it issues each usage
  invoice.
- `invoiceMemo` (string)
- `subscriptionDetails` and `metadata` (objects): your own key/value pairs.

**Example:**

```bash
curl -X POST https://billing.example.com/v1/subscriptions \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme on Pro",
    "planId": "00000000-0000-4000-8000-000000000004",
    "agentId": "00000000-0000-4000-8000-000000000002",
    "customerId": "00000000-0000-4000-8000-000000000001",
    "startDate": "2026-04-10T00:00:00.000Z",
    "billingCycle": "monthly",
    "billingModel": "hybrid"
  }'
```

**Returns `201`** with the subscription (abridged here):

```json
{
  "id": "00000000-0000-4000-8000-000000000006",
  "name": "Acme on Pro",
  "planId": "00000000-0000-4000-8000-000000000004",
  "agentId": "00000000-0000-4000-8000-000000000002",
  "customerId": "00000000-0000-4000-8000-000000000001",
  "startDate": "2026-04-10T00:00:00.000Z",
  "status": "active",
  "billingCycle": "monthly",
  "billingModel": "hybrid",
  "currentBillingPeriodStart": "2026-04-10T00:00:00.000Z",
  "currentBillingPeriodEnd": "2026-05-10T00:00:00.000Z",
  "createdAt": "2026-04-10T14:30:00.000Z"
}
```

The first billing period starts on `startDate`, and its end follows from the
billing cycle.

**Errors:**

- `400`: a required field is missing, an ID isn't a UUID, `startDate` isn't
  a date, or an option is outside its allowed values.
- `404`: the customer, plan or agent isn't in your organization.

## Read a subscription

```
GET /subscriptions/{subscriptionId}
```

Add `?includeDetails=true` for more related data.

## Read a subscription with revenue

Revenue, cost and margin for one subscription over a date range.

```
GET /subscriptions/{subscriptionId}/revenue
```

**Query parameters (both optional):**

- `startDate`: start of the range, as an ISO date.
- `endDate`: end of the range, as an ISO date. Defaults to now.

With no `startDate`, the range is the 30 days before `endDate`.

```bash
curl "https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000006/revenue?startDate=2026-04-01&endDate=2026-04-30T23:59:59.999Z" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

It returns the same revenue object as `GET /analytics/revenue`, worked out the
same way, scoped to this subscription. See
[analytics-revenue.md](analytics-revenue.md) for its fields.

## List subscriptions

```
GET /subscriptions
```

**Query parameters (all optional):**

- `customerId`, `agentId`, `planId`
- `status`: `upcoming`, `active` or `ended`.
- `billingCycle`, `billingModel`
- `startDate`: subscriptions starting on or after this date.
- `endDate`: subscriptions ending on or before this date.
- `search`: matches the subscription name.
- `includeDetails`: `true` for more related data.
- `page` (default `1`) and `limit` (1 to 100, default `10`).

**Returns** `{ results, page, limit, totalPages, totalResults }`.

## Update a subscription

```
PATCH /subscriptions/{subscriptionId}
```

**Required:** `changeReason` (string), a note on why. It goes into the change
log.

Send any of these and only they change: `name`, `planId`, `agentId`,
`status`, `endDate`, `isForever`, `billingCycle`, `customCycleDays`,
`billingDay`, `billingModel`, `netTerms`, `proratedAmount`, `timezone`,
`autoCollectPayment`, `invoiceMemo`, `subscriptionDetails` and `metadata`.
`status` accepts `active`, `pending`, `upcoming`, `expired`, `canceled` and
`ended`.

```bash
curl -X PATCH https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000006 \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "canceled", "changeReason": "Customer asked to cancel"}'
```

**The billing dates can't change after create.** `startDate`,
`currentBillingPeriodStart` and `currentBillingPeriodEnd` decide which usage
each invoice picks up, so they're locked. Sending any of them returns `400`
with a message naming the fields. To bill on a different schedule, end this
subscription and create a new one that starts on the dates you want.

**Errors:** `400` for a missing `changeReason`, a locked date, or a value
outside its allowed list; `404` when the subscription isn't in your
organization.

## Change invoice dates

```
PATCH /subscriptions/{subscriptionId}/invoice-dates
```

Moves when future invoices go out, for example to bill on the 15th instead of
the 1st. Only works on an `active` subscription.

**Body:**

- `changeReason` (string, required)
- `billingDay` (1 to 31)
- `subscriptionInvoiceIssuanceDate` (ISO date)
- `endDate` (ISO date)
- `isForever` (boolean)

**Errors:** `400` when the subscription isn't `active` or `changeReason` is
missing; `404` when it isn't found.

## Read the change log

```
GET /subscriptions/{subscriptionId}/changelog
```

The history of changes to the subscription: creation, updates, status and
plan changes, with the reason given for each.

**Query parameters (all optional):**

- `changeType`: `created`, `updated`, `status_change`, `plan_change` or
  `renewal`.
- `startDate`, `endDate`: only changes in this range.
- `sortBy`, `sortOrder`
- `page` (default `1`) and `limit` (1 to 100, default `10`).

The log records changes made by signed-in people. Changes made with an API key
aren't written to it.

## Using the SDK and MCP

The SDK reads subscriptions. It can't create or update them. Create a
subscription with `POST /subscriptions`, as above, or with the MCP tool
`create_subscription`.

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1", // or set MARGINFRONT_API_URL
});

// customerExternalId works here too
const { subscriptions } = await client.subscriptions.list({
  customerExternalId: "acme-001",
  status: "active",
});

const sub = await client.subscriptions.get("00000000-0000-4000-8000-000000000006");

// The subscription and its revenue in one call. Both requests run in parallel.
const { subscription, revenue } = await client.subscriptions.getWithRevenue(
  "00000000-0000-4000-8000-000000000006",
  { startDate: "2026-04-01", endDate: "2026-04-30T23:59:59.999Z" },
);
```

The SDK's list and get call the `/sdk/subscriptions` routes, which page 20 at
a time by default. Build the SDK from source first, as in
[packages.md](../packages.md). More examples are in the
[SDK README](../../packages/sdk/README.md). Through MCP:
`create_subscription` and `list_subscriptions`.
