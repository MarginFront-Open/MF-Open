# Recipe: credit pools

You sell an AI agent and want to price it the way customers like to buy:
"5,000 tasks for $99 a month, then 3 cents a task after that." That's a
**credit pool**. This recipe walks the whole loop:

1. Create the agent, the signal and the plan with its pool.
2. Subscribe a customer.
3. Record usage.
4. Read the countdown from your own code, so your product and the invoice say
   the same thing.

One rule holds the whole way through: **nothing stops when the pool hits
zero.** The pool is a meter, not a breaker. A customer who uses up their pool
keeps working, and the extra units bill at your overage rate. If you want work
to stop at zero, that decision lives in your code, and
[the last section](#if-you-sell-strict-prepaid) shows how.

API paths are relative to your API address including `/v1`. Every route and
field here is also in `/api-docs` on your running API.

- [Before you start](#before-you-start)
- [Step 1: Create the agent and the signal](#step-1-create-the-agent-and-the-signal)
- [Step 2: Create the plan and the pool](#step-2-create-the-plan-and-the-pool)
- [Step 3: Link the plan to the agent](#step-3-link-the-plan-to-the-agent)
- [Step 4: Create the customer](#step-4-create-the-customer)
- [Step 5: Create the subscription](#step-5-create-the-subscription)
- [Step 6: Record usage](#step-6-record-usage)
- [Step 7: Read the balance](#step-7-read-the-balance)
- [Several signals drawing from one pool](#several-signals-drawing-from-one-pool)
- [The two numbers on a balance](#the-two-numbers-on-a-balance)
- [What zero and below mean](#what-zero-and-below-mean)
- [Alert emails](#alert-emails)
- [When a pool runs low in the dashboard](#when-a-pool-runs-low-in-the-dashboard)
- [Topping up](#topping-up)
- [If you sell strict prepaid](#if-you-sell-strict-prepaid)

## Before you start

1. A running MarginFront server and its API address including `/v1`, such as
   `https://billing.example.com/v1`.
2. A secret key (`mf_sk_...`) from the dashboard: **Build**, then **API keys**.
   Use a key with the owner or admin role for this walkthrough. Creating
   agents and signals needs owner, admin or developer, and creating plans,
   pools and subscriptions needs owner, admin or finance.
3. For the SDK examples, the SDK built from this repository and installed into
   your app (see [packages.md](../packages.md)), with `MARGINFRONT_API_URL`
   set to your API address:

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient(process.env.MF_API_SECRET_KEY!); // reads MARGINFRONT_API_URL
```

Usage tracking alone needs no setup, because events create agents, signals and
customers. A pool is different: it prices a **signal**, so the agent and the
signal have to exist before you can create the pool. If events have already
created them, find their IDs with `GET /agents` and `GET /signals` and skip
step 1.

## Step 1: Create the agent and the signal

The **agent** is your product. The **signal** is the unit you sell, in the
word your customer would use: tasks, reports, messages.

```bash
curl -X POST https://billing.example.com/v1/agents \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Task Runner", "agentCode": "task-runner" }'
```

```bash
curl -X POST https://billing.example.com/v1/signals \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "tasks", "agentId": "00000000-0000-4000-8000-000000000001" }'
```

Keep the `id` from each response. The rest of this recipe uses these made-up
IDs:

| What         | ID                                     |
| ------------ | -------------------------------------- |
| Agent        | `00000000-0000-4000-8000-000000000001` |
| Signal       | `00000000-0000-4000-8000-000000000002` |
| Plan         | `00000000-0000-4000-8000-000000000003` |
| Customer     | `00000000-0000-4000-8000-000000000004` |
| Subscription | `00000000-0000-4000-8000-000000000005` |

You can also create both in the dashboard under **Build**, then **Agents**, or
with the MCP tools `create_agent` and `create_signal`.

## Step 2: Create the plan and the pool

A **plan** is the container, such as "Pro". The pool is one pricing rule
inside it, described by three numbers:

| Number        | Meaning                                                  | Example |
| ------------- | -------------------------------------------------------- | ------- |
| `poolSize`    | How many units the pool covers each billing period       | 5000    |
| `poolPrice`   | The flat fee charged every period, used or not           | 99      |
| `overageRate` | The price per unit after the pool runs out               | 0.03    |

First the plan:

```bash
curl -X POST https://billing.example.com/v1/pricing-plans \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Pro" }'
```

Then the pool. **SDK:**

```typescript
const pool = await mf.pricingStrategies.createCreditPool(
  "00000000-0000-4000-8000-000000000003",
  {
    name: "Task pool",
    agentId: "00000000-0000-4000-8000-000000000001",
    signalId: "00000000-0000-4000-8000-000000000002",
    poolSize: 5000,
    poolPrice: 99,
    overageRate: 0.03,
  },
);
```

**curl:**

```bash
curl -X POST https://billing.example.com/v1/pricing-plans/00000000-0000-4000-8000-000000000003/pricing-strategies \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "Task pool",
      "agentId": "00000000-0000-4000-8000-000000000001",
      "signalId": "00000000-0000-4000-8000-000000000002",
      "chargeType": "usage",
      "pricingModel": "credit_pool",
      "creditPool": { "poolSize": 5000, "poolPrice": 99, "overageRate": 0.03 }
    }
  ]'
```

The body is an array because this route creates rules in bulk. One rule still
goes in an array.

**MCP:** ask your assistant to add a credit pool to the Pro plan: 5,000 tasks
for $99, then 3 cents each. It calls `create_pricing_strategy` with the same
`creditPool` block.

The API turns the three numbers into the two tiers it stores. It also
enforces two rules, each with a message naming the fix:

- **One active pool per plan.** Put a second pool on its own plan.
- **No minimum commitment on a pool.** The pool fee already is the minimum the
  customer pays every period.

## Step 3: Link the plan to the agent

```bash
curl -X POST https://billing.example.com/v1/pricing-plans/00000000-0000-4000-8000-000000000003/agents \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "00000000-0000-4000-8000-000000000001" }'
```

Or in the SDK:

```typescript
await mf.pricingPlans.linkAgent(
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000001",
);
```

## Step 4: Create the customer

```typescript
const customer = await mf.customers.create({
  name: "Acme Corp",
  externalId: "acme-001",
  email: "billing@acme.example.com",
});
```

`externalId` is the ID from your own system. It's how your usage events find
this customer later.

## Step 5: Create the subscription

The subscription ties the customer to the plan and starts the clock. The
pool's countdown lives inside each billing period.

```bash
curl -X POST https://billing.example.com/v1/subscriptions \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corp: Pro",
    "planId": "00000000-0000-4000-8000-000000000003",
    "agentId": "00000000-0000-4000-8000-000000000001",
    "customerId": "00000000-0000-4000-8000-000000000004",
    "startDate": "2026-12-01T00:00:00Z",
    "billingCycle": "monthly",
    "billingModel": "usage"
  }'
```

`billingModel` matters here. The scheduled job that issues usage invoices only
picks up subscriptions set to `usage` or `hybrid`, and the default is
`subscription`.

Each period gets 5,000 fresh units, unused units don't roll over, and the $99
fee bills every period either way.

The SDK reads subscriptions but doesn't create them. Use the API, the
dashboard (from the customer's page, or **Unit Economics**, then
**Subscriptions**) or the MCP tool `create_subscription`.

## Step 6: Record usage

This is the normal integration. Send one event per business outcome, with
`quantity` counting the signal's units:

```typescript
await mf.usage.record({
  customerExternalId: "acme-001",
  agentCode: "task-runner",
  signalName: "tasks",
  model: "claude-sonnet-4-6",
  modelProvider: "anthropic",
  inputTokens: 1200,
  outputTokens: 300,
  quantity: 1, // one task done
});
```

Each event's quantity comes out of the pool as it arrives. Record 250 tasks
and the pool reads 4,750 left. An event still draws from the pool when its
cost can't be worked out, because it still bills.

## Step 7: Read the balance

This is what keeps your product and your bill telling the same story. The
dashboard, the API, the SDK and MCP all read the same balance.

**SDK:**

```typescript
// Every pool, with the time of the reading in `asOf`.
const { balances, asOf } = await mf.creditBalances.list();

// One subscription.
const pool = await mf.creditBalances.get("00000000-0000-4000-8000-000000000005");
console.log(`${pool.remainingUnits} of ${pool.poolSizeUnits} units left`);

// Only pools with 20% or less left.
const lowPools = await mf.creditBalances.list({ belowPercent: 20 });
```

**curl:**

```bash
curl https://billing.example.com/v1/credit-balances \
  -H "x-api-key: $MF_API_SECRET_KEY"

curl https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000005/credit-balance \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

`GET /credit-balances` also filters by `customerId` and `agentId`.
`belowPercent` runs from -100 to 100, and 0 narrows the list to pools at or
past zero. Asking for one subscription whose plan has no pool returns 404.

**MCP:** ask "how many tasks does Acme have left?" and the assistant calls
`get_credit_balances`.

Any key role can read balances except an ingest-only or legal key, which gets a 403.

## Several signals drawing from one pool

Out of the box a pool counts one thing: the signal you priced, at one credit
per unit. Most products sell more than one thing, and a report may cost you
more than a note. `creditRates` maps each signal to how many credits one unit
of it burns:

```typescript
await mf.pricingStrategies.update(
  "00000000-0000-4000-8000-000000000003", // plan
  "00000000-0000-4000-8000-000000000006", // the pool rule
  {
    creditRates: {
      "00000000-0000-4000-8000-000000000007": 4, // one report burns 4 credits
      "00000000-0000-4000-8000-000000000008": 10, // one video burns 10
      "00000000-0000-4000-8000-000000000009": 0.5, // two notes burn 1
    },
  },
);
```

Now "5,000 credits for $99" buys any mix: 1,250 reports, 500 videos, 10,000
notes, or a blend that adds up to 5,000.

### The rules the API enforces

Each one comes back as a 400 with a message naming the fix:

- **Every rate must be above zero.** To make a signal free, leave it out of
  the map.
- **Every key must be a live signal in your organization.**
- **A signal either burns pool credits or bills per unit, never both.** If a
  signal in the map also has its own usage rule on the same plan, the
  customer would pay twice for one piece of work, so the write is refused.
- **Rates only apply to a credit pool.** Send `{}` to clear them. Leave the
  field out and the stored rates stay as they are.

The pool's own signal always counts, at one credit per unit unless you give
it another rate.

### One countdown, not one per signal

Every signal in the map draws from one balance, so the customer watches one
number. Two reports and three notes at the rates above take 9.5 credits. Past
the pool size, credits bill at the overage rate. The balance fields keep their
`...Units` names. With rates set, read "unit" as "credit."

### A separate ceiling per signal means two plans

There's no per-signal limit inside a pool. "100 reports and 50 videos, each
capped on its own" isn't something rates can say. Sell that as two plans,
each with its own pool. Rates describe relative cost, not separate
allowances.

### Don't count a unit twice

Without rates, one way to fake a multi-signal pool is to send the credit cost
as the quantity: a report that costs 4 credits goes in as `quantity: 4`. If
you then set a rate of 4 while events still arrive multiplied, every report
takes 16 credits.

Pick one. If you move to rates, switch those events back to real units (one
report is `quantity: 1`) in the same change. Events already recorded keep
their quantity, so make the switch at the start of a billing period unless you
want a mixed period.

### When a rate change takes effect

A draw uses the rate in force when its event arrived, and the invoice uses the
rates the rule has when the period's invoice is worked out. So an edit applies
to the period that's running now.

## The two numbers on a balance

Every balance carries two numbers that can disagree, and both are right:

- **`remainingUnits`** is the countdown. It counts your top-ups.
- **`overageInProgressUnits`** is the invoice's own overage math. The invoice
  never sees top-ups, so this field never disagrees with the bill.

Say Acme uses all 5,000 units, then 300 more, and you top them up with 1,500
units. The balance reads `remainingUnits: 1200` and
`overageInProgressUnits: 300`. Acme has units left, and 300 units are billing
as overage this period. Show `overageInProgressUnits` when you tell a customer
what they'll owe, and `remainingUnits` when you tell them what's left.

## What zero and below mean

`remainingUnits` goes below zero once the pool is overdrawn. Nothing else
changes:

- The customer's work keeps going. MarginFront doesn't block or drop anything.
- Every unit past the pool bills at the overage rate on the period's invoice.
- The next billing period starts a fresh pool.

## Alert emails

As a pool drains, MarginFront emails your team at four stages: **50% used,
80% used, 95% used and empty** (empty means no units left).

- **Who gets them:** your organization's billing email if one is set
  (**Settings**, then **Billing**), otherwise every owner and finance member.
- **They need email turned on.** Without an email provider, no alert goes out.
  See [alerts-and-notifications.md](../alerts-and-notifications.md).
- **When they're checked:** as usage arrives, and again by the daily dispatch
  job (see [self-hosting.md](../self-hosting.md#scheduled-jobs)).
- **One email per stage per period.** Every stage re-arms when the next
  billing period starts.
- **Only the highest new stage emails.** A pool that jumps from fresh to 97%
  at once gets one 95% email, not three.
- **Pause and resume any time.** Pausing silences the emails for one
  subscription and nothing else: the countdown keeps counting and the balance
  stays visible everywhere. Send the state you want:

  ```bash
  curl -X POST https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000005/credit-alerts-pause \
    -H "x-api-key: $MF_API_SECRET_KEY" \
    -H "Content-Type: application/json" \
    -d '{ "paused": true }'
  ```

  Send `{ "paused": false }` to turn them back on.

The emails link to the dashboard's **Needs attention** page.

## When a pool runs low in the dashboard

**Needs attention** has a credit pools tab listing every pool under 20% left
or at or past zero, marked "Working as designed: nothing is blocked, the overage keeps
billing." Pools with paused alerts still show, labelled Paused, because
pausing emails doesn't hide the situation.

Each row has a **Top up or pause** button for the two fixes people reach for:
add units now, or quiet the emails for a customer you've already spoken to.
The same button is under **Unit Economics**, then **Plans**, in the **Credit
pools** section, and on the subscription's page.

## Topping up

A top-up adds units to a customer's pool mid-period:

```bash
curl -X POST https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000005/credit-topup \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "units": 1500,
    "idempotencyKey": "topup-acme-2026-12-goodwill",
    "note": "Goodwill credit after a service issue"
  }'
```

- **`idempotencyKey` is required.** Send the same key twice, from a retry or a
  double click, and the same grant comes back instead of a second one, so a
  customer is never credited twice. Reusing a key with different units, or on
  a different subscription, returns 409. Any string unique to the top-up
  works, such as a UUID.
- **Top-ups don't expire.** Draws take units that expire soonest first, so the
  period's own pool is used before a top-up.
- **A top-up doesn't reduce overage already counted.** It raises
  `remainingUnits` from here on. See
  [The two numbers on a balance](#the-two-numbers-on-a-balance).
- **`note`** is stored with the grant, so "why does this customer have extra
  units?" has an answer.

Top-ups and pausing alerts need the owner, admin or finance role. Anything
else gets a 403. A subscription whose plan has no pool gets a 400.

## If you sell strict prepaid

Maybe your promise is "when the credits run out, the agent stops."
MarginFront won't stop it for you, on purpose: a billing problem should never
take your product down, and many businesses want the overage revenue. Your
code is where the stop goes, and the balance read is there so you can make
that call:

```typescript
async function runTask(customerExternalId: string, subscriptionId: string) {
  const pool = await mf.creditBalances.get(subscriptionId);

  if (pool.remainingUnits <= 0) {
    // Your product's decision, made by your code.
    return { ok: false, message: "You're out of credits. Top up to keep going." };
  }

  const result = await doTheWork();

  await mf.usage.record({
    customerExternalId,
    agentCode: "task-runner",
    signalName: "tasks",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    quantity: 1,
  });

  return { ok: true, result };
}
```

What to know about this pattern:

- A balance read is a snapshot, and the response allows caching for up to 30
  seconds. Work already running when the pool empties still lands and bills
  as overage. For most products a few units of slack doesn't matter. If it
  does, keep your own count between reads.
- Reading before every request adds a network call to your hot path. A middle
  ground is to read every Nth request, or only once `remainingUnits` drops
  under 10% of `poolSizeUnits`.
- If you stop at zero, tell the customer how to carry on: a top-up, or their
  next billing period.

The tier math behind the pool is `calcCreditPool` in
`packages/db/src/lib/revenue-calc.ts`, and the balance and draws are in
`packages/db/src/lib/credit-ledger.ts`.
