# MRR analytics

`GET /analytics/mrr` reads monthly recurring revenue (MRR). It returns one of
three kinds of MRR, or all three at once. Use it to answer:

- What do our active subscriptions commit to each month, right now?
- If the last 30 days kept going, what would we bill each month?
- What's the floor we bill each month even if usage drops to zero?
- How much of each does one customer or one subscription account for?

Each kind answers a different question, so they can and do give different
numbers. Pick the one that matches what you want to show. It's read-only.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

## The endpoint

```
GET /analytics/mrr
```

Send a secret key in the `x-api-key` header. Publishable, ingest-only and
legal keys get `403 Forbidden`.

## Query parameters

| Parameter        | Type   | Required | Notes                                                                       |
| ---------------- | ------ | -------- | --------------------------------------------------------------------------- |
| `variant`        | string | No       | `canonical` (default), `runRate`, `committed` or `all`.                     |
| `customerId`     | UUID   | No       | One customer, by MarginFront ID (not your own ID for them).                 |
| `subscriptionId` | UUID   | No       | One subscription.                                                           |

There's no date range. All three look forward from today.

## The three kinds of MRR

All three look at subscriptions that are active or pending, and turn every
fee into a monthly number: a yearly subscription's fees are divided by 12.
Any other billing cycle counts as monthly. One-time fees never count.

### `canonical`: what active subscriptions commit to

**In plain English:** "What do our subscriptions promise to pay each month,
today?"

For each subscription, add up its recurring fees and its seat fees, made
monthly. Usage isn't included. It counts a brand-new subscription from day
one rather than waiting for its first invoice, and drops a subscription as
soon as it stops being active.

Good for: board decks and anything where "contracted monthly revenue" is the
number you want.

### `runRate`: the last 30 days, kept going

**In plain English:** "If the current pace keeps up, what would we bill each
month?"

The `canonical` amount, plus each subscription's actual usage from the last
30 days priced on its plan. A credit pool counts its fee even with no usage,
because the invoice would.

Good for: forecasts and growth charts.

### `committed`: the contractual floor

**In plain English:** "What will we bill each month even if usage goes to
zero?"

The `canonical` amount, plus each usage strategy priced at its minimum
commitment (zero when it has none). A credit pool's fee counts here too,
because it's owed whether or not the customer shows up.

Good for: how predictable revenue is, and churn-risk checks.

### `all`

All three in one response, for a side-by-side view.

## Examples

```bash
# Contracted MRR (the default)
curl "https://billing.example.com/v1/analytics/mrr" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# Run-rate MRR for one customer
curl "https://billing.example.com/v1/analytics/mrr?variant=runRate&customerId=00000000-0000-4000-8000-000000000001" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# All three
curl "https://billing.example.com/v1/analytics/mrr?variant=all" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

## What you get back

### `variant=canonical`

```json
{
  "variant": "canonical",
  "mrr": 4249.5,
  "arr": 50994.0
}
```

- **`mrr`**: the monthly recurring and seat fees of active subscriptions.
- **`arr`**: `mrr` times 12.

### `variant=runRate`

```json
{
  "variant": "runRate",
  "mrr": 13842.5,
  "breakdown": [
    {
      "subscriptionId": "00000000-0000-4000-8000-000000000201",
      "customerId": "00000000-0000-4000-8000-000000000001",
      "agentId": "00000000-0000-4000-8000-000000000301",
      "planId": "00000000-0000-4000-8000-000000000401",
      "recurring": 299.0,
      "seatBased": 50.0,
      "usage": 493.5,
      "total": 842.5
    }
  ]
}
```

- **`mrr`**: the sum of `total` across the subscriptions.
- **`breakdown`**: one row per active or pending subscription in scope.
- **`recurring`**: the subscription's recurring fees, made monthly.
- **`seatBased`**: the seat fee times the number of seats, or the minimum
  commitment when that's higher, made monthly.
- **`usage`**: the last 30 days of usage, priced on the plan.
- **`total`**: `recurring + seatBased + usage`.

### `variant=committed`

```json
{
  "variant": "committed",
  "mrr": 10948.0,
  "breakdown": [
    {
      "subscriptionId": "00000000-0000-4000-8000-000000000201",
      "customerId": "00000000-0000-4000-8000-000000000001",
      "agentId": "00000000-0000-4000-8000-000000000301",
      "planId": "00000000-0000-4000-8000-000000000401",
      "recurring": 299.0,
      "seatBased": 50.0,
      "usage": 200.0,
      "total": 549.0
    }
  ]
}
```

The same fields as `runRate`, but `usage` is the contractual floor described
above.

### `variant=all`

```json
{
  "variant": "all",
  "canonical": { "mrr": 4249.5, "arr": 50994.0 },
  "runRate": { "mrr": 13842.5, "breakdown": [] },
  "committed": { "mrr": 10948.0, "breakdown": [] }
}
```

All money fields are numbers, not strings.

## When to use this, and when not

- **This endpoint:** MRR or ARR.
- [analytics-revenue.md](analytics-revenue.md): revenue for any date range,
  with cost and margin.
- [invoices.md](invoices.md): what was actually billed, invoice by invoice.

## Using the SDK

```ts
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

// Contracted MRR
const { mrr, arr } = await mf.analytics.mrr();
console.log(`MRR: $${mrr}, ARR: $${arr}`);

// Run-rate MRR, with one row per subscription
const runRate = await mf.analytics.runRateMrr();
for (const row of runRate.breakdown) {
  console.log(`${row.subscriptionId}: $${row.total} a month`);
}

// The contractual floor
const committed = await mf.analytics.committedMrr();
console.log(`Committed floor: $${committed.mrr}`);
```

Each SDK method takes an optional `{ customerId, subscriptionId }` and drops
the `variant` field from the result. The SDK builds from this repository. See
[packages.md](../packages.md). MCP has the same read as `get_mrr`.

## Errors

- `400 Bad Request`: `variant` isn't one of `canonical`, `runRate`,
  `committed` or `all`, or an ID filter isn't a UUID.
- `401 Unauthorized`: no key, or a key that isn't valid.
- `403 Forbidden`: a publishable, ingest-only or legal key.
