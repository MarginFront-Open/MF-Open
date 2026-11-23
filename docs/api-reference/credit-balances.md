# Credit balances

When a plan sells a credit pool ("5,000 tasks for $99 a month, then $0.03
each"), these endpoints watch it and act on it: two reads for the countdown,
and two writes for when a person steps in.

The numbers come from the same balance calculation the dashboard uses, so
your code, the dashboard and the invoice agree.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

> **Nothing stops at zero.** A pool is a meter, not a breaker. A customer past
> their pool keeps working, and the extra usage bills at the plan's overage
> rate. If your product should stop serving at zero, your code makes that call:
> read the balance and decide.

- [List credit balances](#list-credit-balances)
- [Get one subscription's balance](#get-one-subscriptions-balance)
- [Add units to a pool](#add-units-to-a-pool)
- [Pause or resume alert emails](#pause-or-resume-alert-emails)
- [The alert emails](#the-alert-emails)

## List credit balances

```
GET /credit-balances
```

One row per credit-pool subscription in your organization, emptiest first.
Subscriptions whose plan sells no pool aren't listed, so you never see a
made-up zero.

**Who can call it:** any secret key except an ingest-only or legal key. Reads
have no role limit beyond that.

| Query parameter | Type   | Notes                                                                                                                                                                                       |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customerId`    | UUID   | Only pools for this customer.                                                                                                                                                               |
| `agentId`       | UUID   | Only pools on subscriptions for this agent.                                                                                                                                                 |
| `belowPercent`  | number | -100 to 100. Only pools with this percent or less left. `20` is the near-empty cut the dashboard uses, `0` means at or past zero. Pools with no active period (see below) are left out. |

```bash
curl "https://billing.example.com/v1/credit-balances?belowPercent=20" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

**Response (`200 OK`):**

```json
{
  "balances": [
    {
      "subscriptionId": "00000000-0000-4000-8000-000000000201",
      "subscriptionName": "Acme Corp: Pro Plan",
      "customerId": "00000000-0000-4000-8000-000000000001",
      "customerName": "Acme Corp",
      "customerExternalId": "acme-001",
      "agentId": "00000000-0000-4000-8000-000000000301",
      "planId": "00000000-0000-4000-8000-000000000401",
      "planName": "Pro Plan",
      "poolSizeUnits": 5000,
      "consumedUnits": 5300,
      "remainingUnits": 1200,
      "overageInProgressUnits": 300,
      "remainingPercent": 24,
      "overageRatePerUnit": 0.03,
      "periodStart": "2026-08-01T00:00:00.000Z",
      "periodEnd": "2026-09-01T00:00:00.000Z",
      "alertsPaused": false,
      "noActivePeriod": false,
      "implicitFullPool": false
    }
  ],
  "asOf": "2026-08-18T14:00:00.000Z"
}
```

Responses may be cached privately for up to 30 seconds. `asOf` says when the
numbers were worked out.

### The fields

| Field                    | Type           | What it means                                                                                                                         |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptionId`         | UUID           | The subscription the pool belongs to. Use it for the single read and both writes.                                                    |
| `subscriptionName`       | string         | The subscription's name.                                                                                                              |
| `customerId`             | UUID           | The customer's MarginFront ID.                                                                                                        |
| `customerName`           | string or null | The customer's name.                                                                                                                  |
| `customerExternalId`     | string or null | Your own ID for the customer.                                                                                                         |
| `agentId`                | UUID           | The agent the subscription covers.                                                                                                    |
| `planId`                 | UUID           | The plan that sells the pool.                                                                                                         |
| `planName`               | string or null | The plan's name.                                                                                                                      |
| `poolSizeUnits`          | number         | How many units the pool holds each billing period.                                                                                   |
| `consumedUnits`          | number         | Units drawn in the current period. Top-ups don't change it.                                                                          |
| `remainingUnits`         | number         | Units left to draw, top-ups included. Goes negative once the pool is overdrawn.                                                     |
| `overageInProgressUnits` | number         | Units already billing as overage this period. This is the invoice's own math.                                                        |
| `remainingPercent`       | number         | `remainingUnits` as a percent of `poolSizeUnits`. Negative once overdrawn.                                                           |
| `overageRatePerUnit`     | number or null | The price of one unit past the pool, or `null` when the plan's tiers don't say.                                                      |
| `periodStart`            | string or null | The current billing period's start. `null` when the subscription has no billing period.                                              |
| `periodEnd`              | string or null | The current billing period's end. Same rule.                                                                                         |
| `alertsPaused`           | boolean        | `true` while this subscription's pool emails are paused. The countdown keeps counting.                                              |
| `noActivePeriod`         | boolean        | `true` when the subscription has no billing period yet, so nothing is counting down.                                                |
| `implicitFullPool`       | boolean        | `true` when no credit grant covers the pool right now, so `remainingUnits` reads as the full pool rather than zero.                |

### When one pool serves several signals, a unit is a credit

A plan can let several signals draw from one pool, each at its own number of
credits per unit (`creditRates` on the pricing strategy, see
[per-metric burn rates](../../packages/sdk/README.md#per-metric-burn-rates)).
Then every `...Units` field counts credits, not events.

For example, reports cost 4 credits and notes cost 0.5. Two reports and three
notes take 9.5 credits, and `consumedUnits` reads `9.5`. `overageRatePerUnit`
is then the price of one credit past the pool.

### Two numbers that can disagree, and why both are right

`remainingUnits` counts top-ups. `overageInProgressUnits` is the invoice's
overage math, which never sees top-ups. So a topped-up pool can show
`remainingUnits: 1200` and `overageInProgressUnits: 300` at once: the customer
has units left, and 300 units are already billing as overage this period. The
invoice always matches `overageInProgressUnits`. Count down with
`remainingUnits`; talk money with `overageInProgressUnits`.

### Pools with no active period

`noActivePeriod` is `true` when the subscription has no current billing
period, or when today falls outside it (the period hasn't started yet, or it
has lapsed). The row still appears, with the pool reading as full and
untouched. When there's no period at all, `periodStart` and `periodEnd` are
`null`.

A subscription made by the SDK's `customers.create` with an `agentCode` has no
billing period. You can't add one later, because a subscription's start date
can't be changed. Create a new subscription with
[`POST /subscriptions`](subscriptions.md) and a `startDate`, and the countdown
begins.

`implicitFullPool: true` also shows up between one period ending and the next
period's credit grant being created. A gap like that isn't an empty pool.

## Get one subscription's balance

```
GET /subscriptions/{subscriptionId}/credit-balance
```

The same row the list returns, for one subscription. Same access rule and
cache as the list.

```bash
curl https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000201/credit-balance \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

**Errors:**

- `404 Not Found`: the subscription isn't in your organization, or its plan
  doesn't sell a credit pool.

**SDK and MCP:**

```ts
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

const { balances } = await mf.creditBalances.list({ belowPercent: 20 });
const pool = await mf.creditBalances.get("00000000-0000-4000-8000-000000000201");
```

The SDK builds from this repository (see [packages.md](../packages.md)). In
MCP, `get_credit_balances` covers both reads.

## Add units to a pool

```
POST /subscriptions/{subscriptionId}/credit-topup
```

Gives a customer more units right now, mid-period: a goodwill credit, a side
deal, a support fix.

**Who can call it:** an owner, admin or finance member, or a key with one of
those roles.

| Field            | Type   | Required | Notes                                                                                                                              |
| ---------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `units`          | number | Yes      | How many units to add. Above zero. The same units the plan sells and the invoice bills, never dollars.                            |
| `idempotencyKey` | string | Yes      | Your own key for this top-up, up to 255 characters, not blank. Send it again and you get the same grant back, never a second one. |
| `note`           | string | No       | Why you added the units, up to 1,000 characters. Stored on the grant.                                                             |

```bash
curl -X POST https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000201/credit-topup \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "units": 1500,
    "idempotencyKey": "topup-acme-2026-08-goodwill",
    "note": "Goodwill credit"
  }'
```

**Response (`201 Created`):**

```json
{
  "grantId": "00000000-0000-4000-8000-000000000501",
  "subscriptionId": "00000000-0000-4000-8000-000000000201",
  "unitsAdded": 1500,
  "idempotencyKey": "topup-acme-2026-08-goodwill",
  "note": "Goodwill credit",
  "createdBy": "api-key:00000000-0000-4000-8000-000000000601",
  "createdAt": "2026-08-18T14:03:00.000Z",
  "created": true,
  "remainingUnits": 1200
}
```

`created: false` means the key was already used, and you're looking at the
original grant. `remainingUnits` is the pool's balance after the top-up.
`createdBy` is the user's ID for a dashboard action, or `api-key:<key ID>` for
an API call. The grant itself is the audit trail.

**Rules worth knowing:**

- **Top-ups never expire.** Each period's own grant is drawn first, so what's
  left of a top-up carries into the next period.
- **A top-up raises `remainingUnits`. It doesn't lower
  `overageInProgressUnits`.** Overage already recorded this period stays on
  the bill.
- **Reuse a key only to retry the same top-up.** The same key with different
  units, or on another subscription, is refused with `409`.

**Errors:**

- `400 Bad Request`: `units` missing or not above zero, a blank
  `idempotencyKey`, or a plan with no credit pool. Add a credit-pool pricing
  strategy to the plan first (see [pricing-strategies.md](pricing-strategies.md)).
- `403 Forbidden`: the caller isn't an owner, admin or finance member.
- `404 Not Found`: no such subscription in your organization.
- `409 Conflict`: the key was already used with different units or on a
  different subscription. The message names both.

## Pause or resume alert emails

```
POST /subscriptions/{subscriptionId}/credit-alerts-pause
```

Quiets the pool emails for one subscription, or turns them back on. Useful
when you've talked to the customer and the overage is expected.

**Who can call it:** owner, admin or finance, the same as a top-up.

| Field    | Type    | Required | Notes                                                                                                         |
| -------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `paused` | boolean | Yes      | The state you want: `true` silences the emails, `false` turns them back on. Two identical calls change nothing. |

```bash
curl -X POST https://billing.example.com/v1/subscriptions/00000000-0000-4000-8000-000000000201/credit-alerts-pause \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "paused": true }'
```

**Response (`200 OK`):**

```json
{ "subscriptionId": "00000000-0000-4000-8000-000000000201", "alertsPaused": true }
```

**What pausing does:**

- The pool emails for this subscription stop. Nothing else changes.
- The countdown keeps counting, and the dashboard's credit pool list marks the
  pool **Alerts paused**.
- While paused, a crossed level isn't recorded as sent. Resume mid-period and
  any level the pool crossed while paused can email on the next check.

**Errors:**

- `403 Forbidden`: the caller isn't an owner, admin or finance member.
- `404 Not Found`: no such subscription in your organization.

## The alert emails

As a pool drains, the API emails at four levels: 50% used, 80% used, 95% used,
and empty. Each level emails once per billing period, only the highest newly
crossed level is sent, and every level re-arms when a new period starts.
Recipients are the organization's billing contact email if one is set, and
otherwise every current owner and finance member.

**These emails need your email provider turned on.** Without `RESEND_API_KEY`
on the API, no pool email is sent and nothing is recorded as sent, so the
level is tried again on the next check. See
[alerts-and-notifications.md](../alerts-and-notifications.md#email) for the
setup, and
[spend, credit and customer alerts](../alerts-and-notifications.md#spend-credit-and-customer-alerts)
for when the checks run.

Related: [pricing-strategies.md](pricing-strategies.md) for creating a pool,
and [errors.md](errors.md) for the error format.
