# Revenue analytics

`GET /analytics/revenue` reads revenue, cost and margin, with the same math
the dashboard uses. Use it to answer:

- How much did we earn in this range?
- What did it cost us to earn it?
- What's our margin, in dollars and percent?
- Where did the revenue come from, by subscription and by pricing strategy?

It's read-only.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

## The endpoint

```
GET /analytics/revenue
```

Send a secret key in the `x-api-key` header. Publishable, ingest-only and
legal keys get `403 Forbidden`.

## Query parameters

| Parameter        | Type     | Required | Notes                                                                    |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `startDate`      | ISO date | Yes      | Start of the range, for example `2026-04-01`.                            |
| `endDate`        | ISO date | Yes      | End of the range, included. At most 366 days after `startDate`.          |
| `variant`        | string   | No       | Send `canonical` to get the shape on this page. See below.               |
| `customerId`     | UUID     | No       | One customer, by MarginFront ID (not your own ID for them).              |
| `subscriptionId` | UUID     | No       | One subscription.                                                        |
| `agentId`        | UUID     | No       | One agent.                                                               |
| `signalId`       | UUID     | No       | One signal.                                                              |

**About `variant`:** with `customerId`, `subscriptionId` or `signalId` set,
you always get the shape on this page. Without any of those, send
`variant=canonical`. Leave it out on an organization-wide call and you get the
dashboard's own breakdown instead, which this page doesn't cover. The SDK
always sends `variant=canonical`.

**About `endDate`:** a bare date like `2026-04-30` means midnight UTC at the
start of that day, so events later that day are left out. To include the
whole last day, pass `2026-04-30T23:59:59.999Z`.

## Examples

```bash
# Organization-wide revenue for April 2026
curl "https://billing.example.com/v1/analytics/revenue?startDate=2026-04-01&endDate=2026-04-30T23:59:59.999Z&variant=canonical" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# One customer
curl "https://billing.example.com/v1/analytics/revenue?customerId=00000000-0000-4000-8000-000000000001&startDate=2026-04-01&endDate=2026-04-30T23:59:59.999Z" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# One subscription
curl "https://billing.example.com/v1/analytics/revenue?subscriptionId=00000000-0000-4000-8000-000000000201&startDate=2026-04-01&endDate=2026-04-30T23:59:59.999Z" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

## What you get back

**Response (`200 OK`):**

```json
{
  "revenue": 12480.75,
  "cost": 3122.18,
  "margin": 9358.57,
  "marginPercent": 74.98,

  "usageRevenue": 8231.25,
  "recurringRevenue": 3999.0,
  "seatRevenue": 250.5,
  "onetimeRevenue": 0,

  "eventCount": 41233,
  "eventCountWithNullCost": 12,

  "bySubscription": [
    {
      "subscriptionId": "00000000-0000-4000-8000-000000000201",
      "customerId": "00000000-0000-4000-8000-000000000001",
      "agentId": "00000000-0000-4000-8000-000000000301",
      "planId": "00000000-0000-4000-8000-000000000401",
      "revenue": 842.0,
      "cost": 184.2,
      "margin": 657.8,
      "usageRevenue": 543.0,
      "recurringRevenue": 299.0,
      "seatRevenue": 0,
      "onetimeRevenue": 0,
      "eventCount": 2710
    }
  ],

  "byStrategy": [
    {
      "strategyId": "00000000-0000-4000-8000-000000001301",
      "chargeType": "usage",
      "pricingModel": "flat",
      "signalId": "00000000-0000-4000-8000-000000001201",
      "revenue": 8231.25,
      "quantity": 823125
    }
  ]
}
```

### Reading the response

- **`revenue`**: usage charges plus recurring, seat and one-time fees.
  Recurring and seat fees are prorated when a subscription only partly
  overlaps the range. A one-time fee counts only when the subscription
  started inside the range.
- **`cost`**: the cost of the usage events in the range.
- **`margin`**: `revenue` minus `cost`.
- **`marginPercent`**: margin as a percent of revenue, so `74.98` means
  74.98%. It's `null` when revenue is `0`, never `0` and never `NaN`, so "no
  revenue yet" looks different from "zero margin".
- **`usageRevenue`, `recurringRevenue`, `seatRevenue`, `onetimeRevenue`**:
  revenue split by charge type. They add up to `revenue`.
- **`eventCount`**: every usage event in the range.
- **`eventCountWithNullCost`**: the events whose cost isn't known yet, usually
  because their model has no price. They're in `eventCount` but add `0` to
  `cost`. Treat a non-zero value as "needs attention" (see
  [services.md](services.md)).
- **`bySubscription`**: one row per subscription in scope. Handy for customer
  and subscription pages.
- **`byStrategy`**: one row per pricing strategy that earned revenue in the
  range. `chargeType` is `usage`, `recurring`, `seat_based` or `onetime`.
  `pricingModel` is `flat`, `graduated`, `volume`, `credit_pool` or `null`.
  `quantity` is the total units for a usage strategy and `0` for the rest.

All money fields are numbers, not strings.

## When to use this, and when not

- **This endpoint:** revenue, cost and margin for a range.
- [analytics.md](analytics.md): raw event counts and quantity totals.
- [analytics-cost.md](analytics-cost.md): cost split by agent, customer,
  signal, day, plan or model, without revenue.
- [analytics-mrr.md](analytics-mrr.md): monthly recurring revenue.
- [invoices.md](invoices.md): what was actually billed. Analytics gives you
  the revenue math; invoices are the documents you sent.

## Using the SDK

```ts
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

const metrics = await mf.analytics.revenue({
  startDate: "2026-04-01",
  endDate: "2026-04-30T23:59:59.999Z",
});

console.log(`Revenue: $${metrics.revenue.toFixed(2)}`);
console.log(`Margin: ${metrics.marginPercent ?? "n/a"}%`);
```

The SDK builds from this repository. See [packages.md](../packages.md) and
the [SDK's analytics section](../../packages/sdk/README.md#revenue--cost-analytics-canonical).
MCP has a per-customer read as `get_customer_revenue`.

## Errors

- `400 Bad Request`: `startDate` or `endDate` missing or not a date, a range
  over 366 days, an unknown `variant`, or an ID filter that isn't a UUID.
- `401 Unauthorized`: no key, or a key that isn't valid.
- `403 Forbidden`: a publishable, ingest-only or legal key.
