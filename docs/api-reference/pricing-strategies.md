# Pricing strategies

A pricing strategy is one price rule inside a plan. If the plan is "Pro", its
strategies are the lines: "1 cent per API call", "$49 a month platform fee",
"5,000 calls for $99, then 3 cents each".

Most plans combine a few:

- a **usage** strategy that prices a signal per unit,
- a **recurring** strategy for a fixed fee each billing cycle,
- a **onetime** strategy for a setup fee,
- a **seat_based** strategy for per-seat pricing.

Each strategy has a **charge type** (what kind of charge) and, for usage and
seats, a **pricing model** (how the math works). The math lives in one file,
`packages/db/src/lib/revenue-calc.ts`, shared by invoices, analytics and the
dashboard simulator.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is the final word on every request and response shape.

- [Charge types](#charge-types)
- [Pricing models](#pricing-models)
- [Credit pools](#credit-pools)
- [Letting several signals share one pool](#letting-several-signals-share-one-pool)
- [Credit-pool rules](#credit-pool-rules)
- [Who can call these routes](#who-can-call-these-routes)
- [Create strategies](#create-strategies)
- [List strategies](#list-strategies)
- [Read a strategy](#read-a-strategy)
- [Update a strategy](#update-a-strategy)
- [Update and create in one call](#update-and-create-in-one-call)
- [Delete a strategy](#delete-a-strategy)
- [How strategies fit the billing chain](#how-strategies-fit-the-billing-chain)

## Charge types

| Charge type  | What it charges                                             | Example                |
| ------------ | ----------------------------------------------------------- | ---------------------- |
| `usage`      | Each unit of a signal, from the usage events you send       | 1 cent per API call    |
| `recurring`  | A fixed fee each billing cycle                              | $49 a month            |
| `onetime`    | A single fee, for the period the subscription starts in     | $500 setup fee         |
| `seat_based` | Each seat on the subscription (its `seatsCount`)            | $10 a seat a month     |

A `usage` strategy prices the signal named by its `signalId`. Recurring and
seat fees are prorated when a billing period covers only part of a cycle.

## Pricing models

### Flat

Every unit costs `rate`.

```
quantity x rate = total
1,000 calls x $0.01 = $10.00
```

### Graduated

Like tax brackets. Each tier bills the units that fall inside it, at its own
rate. Tiers fill in order of their `upper` bound.

```json
[
  { "lower": 0, "upper": 1000, "rate": 0.01 },
  { "lower": 1000, "upper": 5000, "rate": 0.008 },
  { "lower": 5000, "upper": null, "rate": 0.005 }
]
```

```
1,200 calls -> (1,000 x $0.01) + (200 x $0.008) = $11.60
```

### Volume

The total quantity picks one tier, and every unit is billed at that tier's
rate. The tier is the highest one whose `lower` the quantity reaches.

```json
[
  { "lower": 0, "upper": 999, "rate": 0.01 },
  { "lower": 1000, "upper": 4999, "rate": 0.008 },
  { "lower": 5000, "upper": null, "rate": 0.005 }
]
```

```
1,200 calls -> 1,200 x $0.008 = $9.60   (all units at the second tier's rate)
```

### Credit pool

A flat fee buys a pool of units each cycle. Past the pool, each unit costs the
overage rate. The fee is charged whether the customer uses one unit, all of
them or none.

```
Pool:    5,000 calls for $99
Overage: $0.03 a call after that

3,000 calls -> $99           (the pool covers it)
6,000 calls -> $99 + $30     (1,000 over x $0.03)
```

### Minimum commitment

`minimumCommitment` sets the fewest units (or seats) to bill for. A usage
strategy with a minimum of 1,000 bills 1,000 units in a period with 400. A
credit pool can't have one: its fee already is the minimum.

## Credit pools

Stored, a pool is two tiers:

```json
[
  { "lower": 0, "upper": 5000, "rate": 99 },
  { "lower": 5000, "upper": null, "rate": 0.03 }
]
```

The first tier's `rate` is the **flat fee for the whole pool**, not a price
per unit. The second tier's `rate` is the **price per unit** past the pool.

That's easy to get backwards, so you don't have to build it. Send a
`creditPool` block instead and the API builds the tiers:

```json
{ "creditPool": { "poolSize": 5000, "poolPrice": 99, "overageRate": 0.03 } }
```

- `poolSize`: how many units the pool covers each cycle.
- `poolPrice`: the flat fee charged every cycle, used or not.
- `overageRate`: the price per unit after the pool runs out.

Nothing stops when the pool empties. The overage keeps billing.

Every strategy the API returns carries a `creditPool` field with the same
three numbers, worked out from its tiers. It's `null` when the stored tiers
aren't a clean two-tier pool.

## Letting several signals share one pool

By default a pool counts one signal, the one in its `signalId`, at one credit
per unit. `creditRates` lets other signals draw from the same pool and says
how many credits one unit of each costs:

```json
{
  "creditRates": {
    "00000000-0000-4000-8000-00000000000a": 4,
    "00000000-0000-4000-8000-00000000000b": 10,
    "00000000-0000-4000-8000-00000000000c": 0.5
  }
}
```

Here one report takes 4 credits, one video takes 10, and two notes take 1.
They all draw down the same balance, so the customer watches one number. The
pool bills on the combined credit total, and a member signal never gets its
own line on the invoice.

- The pool's own signal is a member whether you list it or not, at 1 credit
  per unit. List it only to change that.
- Send `{}` to clear every rate. Leave the field out to keep the stored
  rates.
- A pool with no `creditRates` counts its own signal only.

## Credit-pool rules

The API checks every write that touches a pool: create, update and both bulk
routes. On an update it checks the stored strategy with your changes applied.
Each failure is a `400` whose message names the fix.

- **`creditPool` needs all three numbers.** The message lists the missing
  ones.
- **The numbers must make sense.** `poolSize` above zero; `poolPrice` and
  `overageRate` zero or more.
- **Send `creditPool` or `tiers`, never both.**
- **`creditPool` and `creditRates` only apply when `pricingModel` is
  `credit_pool`.** If you move a strategy to another model, clear the rates
  (`creditRates: {}`) in the same update.
- **One active credit pool per plan.** A second live pool would make the
  countdown ambiguous. Put it on its own plan.
- **No `minimumCommitment` on a pool.**
- **Hand-built tiers are checked too.** Exactly two tiers. The pool tier
  starts at 0 with an `upper` above zero. The overage tier starts exactly
  where the pool ends and has `upper: null`.
- **Every `creditRates` value is a number above zero.** To make a signal
  free, leave it out of the map. A `0` is refused.
- **Every `creditRates` key is a live signal in your organization.** A
  mistyped or deleted ID is refused.
- **A signal either burns pool credits or bills per unit, never both.** If a
  key names a signal that also has its own active `usage` strategy on the same
  plan, the write is refused, because the customer would pay twice. Turning on
  such a strategy later is refused the same way.

## Who can call these routes

Send a secret key (`mf_sk_...`) in the `x-api-key` header. See
[authentication.md](authentication.md).

- **Reads** work with any secret key except an ingest-only or legal key.
- **Writes** need a key whose role is owner, admin or finance. Any other role
  gets `403`.
- A publishable key (`mf_pk_...`) gets `403` on every route on this page.

## Create strategies

```
POST /pricing-plans/{planId}/pricing-strategies
```

The body is an **array** of strategies, even for one. Every row is checked
before any is written, so one bad row means none are created.

**Each strategy:**

- `name` (string, required, up to 255 characters)
- `agentId` (UUID, required): the agent the strategy belongs to.
- `chargeType` (required): `usage`, `recurring`, `onetime` or `seat_based`.
- `signalId` (UUID): the signal a `usage` strategy prices. It must belong to
  the same agent.
- `pricingModel`: `flat`, `graduated`, `volume` or `credit_pool`.
- `billingFrequency`: `monthly` or `yearly`.
- `rate` (number, zero or more): the price for `flat`, and the fee for
  `recurring` and `onetime`.
- `tiers` (array of `{ lower, upper, rate }`, with `upper: null` for no
  ceiling): for `graduated`, `volume` and hand-built `credit_pool`.
- `creditPool` (object): the pool shortcut, `{ poolSize, poolPrice,
  overageRate }`.
- `creditRates` (object): `{ signalId: creditsPerUnit }` for a shared pool.
- `minimumCommitment` (whole number)
- `active` (boolean): defaults to `true`.
- `tags` (array of strings)

**Example: a pool, a monthly fee and a setup fee in one call:**

```bash
curl -X POST https://billing.example.com/v1/pricing-plans/00000000-0000-4000-8000-000000000004/pricing-strategies \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "API call pool",
      "agentId": "00000000-0000-4000-8000-000000000002",
      "chargeType": "usage",
      "pricingModel": "credit_pool",
      "signalId": "00000000-0000-4000-8000-000000000003",
      "creditPool": { "poolSize": 5000, "poolPrice": 99, "overageRate": 0.03 }
    },
    {
      "name": "Platform fee",
      "agentId": "00000000-0000-4000-8000-000000000002",
      "chargeType": "recurring",
      "billingFrequency": "monthly",
      "rate": 49
    },
    {
      "name": "Setup fee",
      "agentId": "00000000-0000-4000-8000-000000000002",
      "chargeType": "onetime",
      "rate": 500
    }
  ]'
```

**Returns `201`** with an array of the created strategies, each with its `id`
and `creditPool` view.

**Errors:**

- `400`: an empty array, or any credit-pool rule above. The message names
  the strategy and the fix.
- `404`: the plan, the agent, or a strategy's signal isn't in your
  organization.

**With the SDK** (build it from source first, as in
[packages.md](../packages.md)):

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1", // or set MARGINFRONT_API_URL
});

const planId = "00000000-0000-4000-8000-000000000004";

const created = await client.pricingStrategies.createBulk(planId, [
  {
    name: "Platform fee",
    agentId: "00000000-0000-4000-8000-000000000002",
    chargeType: "recurring",
    rate: 49,
  },
]);

// A pool on its own: the charge type and pricing model are filled in for you.
const pool = await client.pricingStrategies.createCreditPool(planId, {
  name: "API call pool",
  agentId: "00000000-0000-4000-8000-000000000002",
  signalId: "00000000-0000-4000-8000-000000000003",
  poolSize: 5000,
  poolPrice: 99,
  overageRate: 0.03,
});
```

More on pools in the [SDK README](../../packages/sdk/README.md#credit-pools).

## List strategies

```
GET /pricing-plans/{planId}/pricing-strategies
```

**Query parameters (all optional):**

- `name`
- `chargeType`: `usage`, `recurring`, `onetime` or `seat_based`.
- `pricingModel`: `flat`, `graduated`, `volume` or `credit_pool`.
- `active`: `true` or `false`.
- `sortBy`: `name`, `chargeType`, `createdAt` or `updatedAt`. `sortOrder`:
  `asc` or `desc` (default `desc`).
- `page` (default `1`) and `limit` (default `10`).

**Returns** `{ results, page, limit, totalPages, totalResults }`.

```typescript
const { results } = await client.pricingStrategies.list(planId, {
  chargeType: "usage",
  active: true,
});
```

## Read a strategy

```
GET /pricing-plans/{planId}/pricing-strategies/{strategyId}
```

```typescript
const strategy = await client.pricingStrategies.get(planId, pool.id);
```

**Errors:** `404` when the strategy isn't on that plan or was deleted.

## Update a strategy

```
PATCH /pricing-plans/{planId}/pricing-strategies/{strategyId}
```

Send any create field. Only the fields you send change. For a pool, the
simplest change is a new `creditPool` block. Here the overage goes from 3 to 5
cents:

```bash
curl -X PATCH https://billing.example.com/v1/pricing-plans/00000000-0000-4000-8000-000000000004/pricing-strategies/00000000-0000-4000-8000-000000000005 \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "creditPool": { "poolSize": 5000, "poolPrice": 99, "overageRate": 0.05 } }'
```

```typescript
await client.pricingStrategies.update(planId, pool.id, {
  creditPool: { poolSize: 5000, poolPrice: 99, overageRate: 0.05 },
});
```

**Errors:** `400` for a credit-pool rule; `404` when the strategy, a new
agent or a new signal isn't found.

## Update and create in one call

```
PATCH /pricing-plans/{planId}/pricing-strategies
```

Updates existing strategies and creates new ones together. Useful when you
rework a whole plan.

```json
{
  "strategies": {
    "new": [
      {
        "name": "Support add-on",
        "agentId": "00000000-0000-4000-8000-000000000002",
        "chargeType": "recurring",
        "rate": 29
      }
    ],
    "update": [{ "id": "00000000-0000-4000-8000-000000000006", "rate": 59 }]
  }
}
```

**Returns `200`** with `updated` and `created` counts. The SDK method is
`client.pricingStrategies.bulkUpdate(planId, { strategies })`.

**Errors:** `404` when the plan, or any strategy in `update`, isn't found. The
message lists the missing IDs.

## Delete a strategy

```
DELETE /pricing-plans/{planId}/pricing-strategies/{strategyId}
```

A soft delete: the strategy stops pricing anything and its row stays in the
database. **Returns `204`.**

```typescript
await client.pricingStrategies.delete(planId, pool.id);
```

## How strategies fit the billing chain

```
Pricing plan ("Pro")
    |
    +---- Strategy: "API call pool"   (usage, credit_pool)
    |        +-- Signal: api_calls
    +---- Strategy: "Platform fee"    (recurring, $49 a month)
    +---- Strategy: "Setup fee"       (onetime, $500)
    +---- Strategy: "Seats"           (seat_based, flat, $10 a seat)
    |
Subscription (one customer on this plan, for one agent)
    |
Invoice (every strategy's charge for the billing period)
```

Through MCP: `create_pricing_strategy` and `list_pricing_strategies`.
