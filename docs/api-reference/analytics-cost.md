# Cost analytics

`GET /analytics/cost` reads cost with a full breakdown attached. Use it to
answer:

- Which agents cost the most to run?
- Which customers drive the cost?
- How is cost moving day by day?
- How does this range compare to the one before it?

Cost doesn't depend on pricing or subscriptions. An event counts as long as
it has a cost, whether or not its customer has a plan, so this works before
you bill anyone. It's read-only.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

## The endpoint

```
GET /analytics/cost
```

Send a secret key in the `x-api-key` header. Publishable, ingest-only and
legal keys get `403 Forbidden`.

## Query parameters

| Parameter            | Type     | Required | Notes                                                                                |
| -------------------- | -------- | -------- | ------------------------------------------------------------------------------------ |
| `startDate`          | ISO date | Yes      | Start of the range, for example `2026-04-01`.                                        |
| `endDate`            | ISO date | Yes      | End of the range, included. At most 366 days after `startDate`. See the note below.  |
| `customerId`         | UUID     | No       | One customer, by MarginFront ID.                                                     |
| `subscriptionId`     | UUID     | No       | One subscription.                                                                    |
| `agentId`            | UUID     | No       | One agent.                                                                           |
| `signalId`           | UUID     | No       | One signal.                                                                          |
| `includePriorWindow` | boolean  | No       | `true` adds a `prior` section covering the same number of days just before `startDate`. |

**About `endDate`:** a bare date like `2026-04-30` means midnight UTC at the
start of that day, so events later that day are left out. To include the
whole last day, pass `2026-04-30T23:59:59.999Z`.

### How the prior window works

With `includePriorWindow=true`, the API counts the days in your range, then
runs the same breakdown over a range of that many days ending at 23:59:59.999
UTC on the day before `startDate`. Both come back in one response, which is
what a "vs last period" widget needs.

## Examples

```bash
# Cost for April 2026
curl "https://billing.example.com/v1/analytics/cost?startDate=2026-04-01&endDate=2026-04-30T23:59:59.999Z" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# One customer, with the prior window for a trend
curl "https://billing.example.com/v1/analytics/cost?customerId=00000000-0000-4000-8000-000000000001&startDate=2026-04-01&endDate=2026-04-30T23:59:59.999Z&includePriorWindow=true" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

## What you get back

**Response (`200 OK`):**

```json
{
  "cost": 3122.18,
  "eventCount": 41233,
  "eventCountWithNullCost": 12,
  "byAgent": [
    { "agentId": "00000000-0000-4000-8000-000000000301", "cost": 1982.4, "eventCount": 24102 }
  ],
  "byCustomer": [
    { "customerId": "00000000-0000-4000-8000-000000000001", "cost": 742.8, "eventCount": 9801 }
  ],
  "bySignal": [
    { "signalId": "00000000-0000-4000-8000-000000001201", "cost": 2104.5, "eventCount": 28940 }
  ],
  "byDay": [
    { "date": "2026-04-01T00:00:00.000Z", "cost": 94.82, "eventCount": 1243 }
  ],
  "byPlan": [
    { "planId": "00000000-0000-4000-8000-000000000401", "cost": 2843.1, "eventCount": 37120 },
    { "planId": null, "cost": 279.08, "eventCount": 4113 }
  ],
  "byModel": [
    { "model": "gpt-4o-mini", "cost": 1820.4, "eventCount": 22014 },
    { "model": null, "cost": 0, "eventCount": 30 }
  ],
  "byRepo": [{ "repo": null, "cost": 3122.18, "eventCount": 41233 }],
  "byBranch": [{ "branch": null, "cost": 3122.18, "eventCount": 41233 }],
  "byCostCategory": [
    { "costCategory": "PRODUCTION_COGS", "cost": 3122.18, "eventCount": 41233 }
  ],
  "byEnvironment": [
    { "environment": "production", "cost": 3122.18, "eventCount": 41233 }
  ]
}
```

With `includePriorWindow=true`, a `prior` section with the same fields
(except its own `prior`) is added at the top level.

### Reading the response

- **`cost`**: the total cost of every event in the range.
- **`eventCount`**: every event in the range, including those with no cost.
- **`eventCountWithNullCost`**: the events whose cost isn't known yet, usually
  because their model has no price. They're in `eventCount` but add `0` to
  `cost`. Treat a non-zero value as "needs attention" (see
  [services.md](services.md)).
- **`byAgent`, `byCustomer`, `bySignal`, `byPlan`**: one row per agent,
  customer, signal or plan, with its cost and event count.
- **`bySignal`** can have a row with `signalId: null` for events with no
  signal.
- **`byPlan`** can have a row with `planId: null` for events with no
  subscription, or whose subscription was deleted. They still count toward
  cost.
- **`byDay`**: one row per UTC day with activity. `date` is midnight UTC.
- **`byModel`**: one row per model name the events were sent with.
  `model: null` covers events with no model, such as non-model events.
- **`byRepo` and `byBranch`**: cost by the git repository and branch the Code
  Cost Clarity meter records on internal coding events. `branch` is written
  as `<repo>#<branch>`. Events without them land in the `null` row.
- **`byCostCategory`**: cost by each signal's accounting category:
  `PRODUCTION_COGS`, `DEVELOPMENT_RD`, `SALES_SM`, `GENERAL_GA`,
  `INTERNAL_TOOL` or `UNCLASSIFIED`.
- **`byEnvironment`**: cost by the event's `environment`: `production`,
  `staging`, `development`, `testing`, or `null` when none was sent.
- **`prior`**: only with `includePriorWindow=true`.

In `byPlan`, `byModel`, `byRepo` and `byBranch`, the `null` row comes last.
All money fields are numbers, not strings.

## When to use this, and when not

- **This endpoint:** cost split by agent, customer, signal, day, plan, model
  and more.
- [analytics-revenue.md](analytics-revenue.md): revenue and margin as well.
- [analytics.md](analytics.md): event counts and quantity totals.

## Using the SDK

```ts
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

const cost = await mf.analytics.costBreakdown({
  startDate: "2026-04-01",
  endDate: "2026-04-30T23:59:59.999Z",
  includePriorWindow: true,
});

console.log(`Cost this month: $${cost.cost.toFixed(2)}`);
if (cost.prior) {
  console.log(`Change vs prior window: $${(cost.cost - cost.prior.cost).toFixed(2)}`);
}
```

The SDK builds from this repository. See [packages.md](../packages.md) and
the [SDK's analytics section](../../packages/sdk/README.md#revenue--cost-analytics-canonical).
MCP has the same read as `get_cost_metrics`.

## Errors

- `400 Bad Request`: `startDate` or `endDate` missing or not a date, a range
  over 366 days, or an ID filter that isn't a UUID.
- `401 Unauthorized`: no key, or a key that isn't valid.
- `403 Forbidden`: a publishable, ingest-only or legal key.
