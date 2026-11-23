# Usage analytics

`GET /analytics/usage` reads your raw usage back out: event counts, quantity
totals and cost, for any customer, agent, signal and date range. Use it to:

- show "usage so far this month" in your own product,
- show customers what they've used,
- feed your own reports.

It's read-only.

> **Looking for revenue, margin or MRR?** This page covers the raw usage
> roll-up. For revenue and margin, see [analytics-revenue.md](analytics-revenue.md).
> For cost broken down by agent, customer, signal, day, plan or model, see
> [analytics-cost.md](analytics-cost.md). For monthly recurring revenue, see
> [analytics-mrr.md](analytics-mrr.md).

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

## The endpoint

```
GET /analytics/usage
```

Send a secret key in the `x-api-key` header. Publishable, ingest-only and
legal keys get `403 Forbidden`.

## Query parameters

| Parameter     | Type     | Required | Notes                                                                                                                       |
| ------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `startDate`   | ISO date | Yes      | Start of the range.                                                                                                         |
| `endDate`     | ISO date | Yes      | End of the range. The whole end day is included. At most 366 days after `startDate`.                                        |
| `customerId`  | UUID     | No       | One customer, by MarginFront ID (not your own ID for them).                                                                 |
| `agentId`     | UUID     | No       | One agent.                                                                                                                  |
| `signalId`    | UUID     | No       | One signal.                                                                                                                 |
| `groupBy`     | string   | No       | Bucket size for `timeSeriesData`: `daily` (default), `weekly` or `monthly`.                                                |
| `breakdownBy` | string   | No       | Adds a `dimensionBreakdown` section split by `customer`, `agent` or `signal`. Without it, there's no `dimensionBreakdown`. |

A bad value for any of them gets `400 Bad Request` with a message naming the
problem. A range wider than 366 days gets `400` too, and the message says to
split it into smaller requests.

## Examples

```bash
# Everything for April 2026
curl "https://billing.example.com/v1/analytics/usage?startDate=2026-04-01&endDate=2026-04-30" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# One customer
curl "https://billing.example.com/v1/analytics/usage?customerId=00000000-0000-4000-8000-000000000001&startDate=2026-04-01&endDate=2026-04-30" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# Weekly totals for one agent
curl "https://billing.example.com/v1/analytics/usage?agentId=00000000-0000-4000-8000-000000000301&startDate=2026-04-01&endDate=2026-04-30&groupBy=weekly" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# Totals split by customer
curl "https://billing.example.com/v1/analytics/usage?startDate=2026-04-01&endDate=2026-04-30&breakdownBy=customer" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

## What you get back

**Response (`200 OK`):**

```json
{
  "dateRange": {
    "start": "2026-04-01",
    "end": "2026-04-30",
    "groupBy": "daily"
  },
  "filters": {},
  "summary": {
    "totalEvents": 1247,
    "totalQuantity": 1247,
    "totalCost": 42.18,
    "avgCostPerEvent": 0.0338
  },
  "timeSeriesData": [
    {
      "date": "2026-04-01",
      "eventCount": 87,
      "totalQuantity": 87,
      "totalCost": 2.94
    }
  ],
  "metadata": {
    "signals": {
      "00000000-0000-4000-8000-000000001201": "Messages Processed"
    },
    "customers": {
      "00000000-0000-4000-8000-000000000001": "Acme Corp"
    },
    "agents": {
      "00000000-0000-4000-8000-000000000301": "Support Bot"
    }
  }
}
```

With `breakdownBy`, a `dimensionBreakdown` section is added:

```json
{
  "dimensionBreakdown": {
    "dimensionType": "customer",
    "summary": [
      {
        "dimensionId": "00000000-0000-4000-8000-000000000001",
        "dimensionLabel": "Acme Corp",
        "totalEvents": 412,
        "totalQuantity": 412,
        "totalCost": 18.23
      }
    ],
    "timeline": [
      {
        "date": "2026-04-01",
        "dimensionId": "00000000-0000-4000-8000-000000000001",
        "dimensionLabel": "Acme Corp",
        "eventCount": 14,
        "totalQuantity": 14,
        "totalCost": 0.62
      }
    ]
  }
}
```

### Reading the response

- **`summary`**: totals for the whole range: `totalEvents`, `totalQuantity`,
  `totalCost` and `avgCostPerEvent`.
- **`timeSeriesData`**: one row per bucket that had events. `date` is the day,
  the Monday that starts the week, or the first of the month, depending on
  `groupBy`. The row's count field is `eventCount`, not `totalEvents`.
- **`metadata`**: names for the signal, customer and agent IDs in the results,
  so you can show labels without another request.
- **`dimensionBreakdown`**: only with `breakdownBy`. `summary` has one row per
  customer, agent or signal, highest cost first, up to 500 rows. `timeline`
  has one row per bucket for each of them.
- **`dateRange`** and **`filters`**: echo what you asked for. `filters` holds
  only the parameters you sent, so it's `{}` with none.

All values are numbers. Events with no cost yet add `0` to `totalCost`.

If the `customerId`, `agentId` or `signalId` you send doesn't exist, you get
an empty result with zero totals, not an error.

## Using the SDK

```ts
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

const stats = await mf.analytics.usage({
  customerId: "00000000-0000-4000-8000-000000000001",
  startDate: "2026-04-01",
  endDate: "2026-04-30T23:59:59.999Z",
});

console.log(`Usage cost so far: $${stats.summary.totalCost}`);
```

The SDK method calls `GET /sdk/analytics/usage`, a sibling route with a
smaller response: `dateRange`, a `summary` with `totalEvents`, `totalCost`,
`uniqueCustomers`, `uniqueAgents` and `uniqueSignals`, and `data`, one row per
bucket with `date`, `cost` and `eventCount`. It also accepts
`customerExternalId` and `subscriptionId`. On that route a bare `endDate`
means midnight at the start of that day, so pass a full timestamp such as
`2026-04-30T23:59:59.999Z` to include the whole day.

The SDK builds from this repository. See [packages.md](../packages.md). MCP's
`get_usage_analytics` calls `GET /analytics/usage`, the route this page
describes.

## What this endpoint is for, and what it isn't

**Use it for** live usage widgets, projections and simple reports.

**Don't use it for:**

- **Revenue, margin or MRR.** See [analytics-revenue.md](analytics-revenue.md)
  and [analytics-mrr.md](analytics-mrr.md).
- **Cost split by agent, customer, signal, day, plan or model.** See
  [analytics-cost.md](analytics-cost.md).
- **What was actually billed.** See [invoices.md](invoices.md). Invoices are
  the finished billing documents.
- **One row per event.** This endpoint returns totals. For single events, use
  `GET /events`.
