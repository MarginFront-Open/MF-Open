# API reference

These pages describe how to talk to your MarginFront API from your own code:
each route, its fields, curl examples, and the errors you can get back in
plain English.

- [What's here](#whats-here)
- [Addresses in the examples](#addresses-in-the-examples)
- [The final authority](#the-final-authority)
- [Start here](#start-here)
- [The integration chain](#the-integration-chain)
- [Every page](#every-page)
- [One key, one organization](#one-key-one-organization)
- [Testing your integration](#testing-your-integration)

## What's here

One page per resource, plus three pages every integration needs:
authentication, usage events and errors. Each resource page covers its routes
under `/v1/<resource>`, the fields they take, example calls and the common
errors.

> **You don't need to set anything up first.** When you send a usage event
> with a `customerExternalId`, `agentCode` or `signalName` the API hasn't
> seen, it creates that customer, agent or signal for you. Most integrations
> only ever call `POST /v1/usage/record`. The other routes are for when you
> want control over those records (renaming, enriching, deleting), or to set
> up pricing plans and subscriptions.

## Addresses in the examples

Every example uses `https://billing.example.com/v1` as the API address.
Replace it with your own API's address, including `/v1`. On your own machine
that's `http://localhost:4000/v1`.

The SDK has no built-in address either. Pass `baseUrl` in code or set
`MARGINFRONT_API_URL`. See [packages.md](../packages.md#the-one-server-setting).

## The final authority

A running API serves an interactive reference at `/api-docs`, built from the
code itself, for example <http://localhost:4000/api-docs>. When a page here
and `/api-docs` disagree, `/api-docs` is right. When a call fails in a way
these pages don't explain, the API's own logs say what happened.

## Start here

Read these in order:

1. [authentication.md](authentication.md): how keys work, which role a key
   needs, and how to send one from Bash or Windows PowerShell.
2. [usage-events.md](usage-events.md): the route you'll call most, its fields,
   and what happens when a model isn't in the price catalog.
3. [errors.md](errors.md): every status code the API returns, in plain English.

## The integration chain

Everything in MarginFront traces through this chain:

```
Customer  ──┐
            │
Agent ──────┼── Signal ──── Pricing plan ──── Subscription
            │   (metric)    (how to price)    (per customer)
            │
Usage event (logged per signal, per customer)
```

**For cost tracking (the minimum):** call `POST /v1/usage/record` with
`customerExternalId`, `agentCode`, `signalName`, `model` and `modelProvider`,
plus the token counts or quantity. The API creates the customer, agent and
signal the first time it sees each one, and works out what the call cost from
the price catalog.

**Add these when you want revenue and invoices:**

1. A **pricing plan** for the agent: how much you charge per unit of the
   signal. See [pricing-plans.md](pricing-plans.md).
2. A **subscription** that ties the customer to that plan. See
   [subscriptions.md](subscriptions.md).

Without those two, MarginFront tracks costs but can't calculate revenue or
issue invoices. Add them whenever you're ready.

## Every page

| Page                                          | What it's for                                                         |
| --------------------------------------------- | --------------------------------------------------------------------- |
| [README.md](README.md)                         | This page.                                                            |
| [authentication.md](authentication.md)         | API keys, key roles, and sending a key from Bash or PowerShell.       |
| [usage-events.md](usage-events.md)             | Record what your customers use, and fix events that came in unpriced. |
| [errors.md](errors.md)                         | Every status code and error code, and what to do about each.          |
| [customers.md](customers.md)                   | The people and companies you bill.                                    |
| [agents.md](agents.md)                         | The products or features that do billable work.                       |
| [signals.md](signals.md)                       | What you measure and bill on.                                         |
| [pricing-plans.md](pricing-plans.md)           | How much things cost.                                                 |
| [pricing-strategies.md](pricing-strategies.md) | The pricing rules inside a plan.                                      |
| [subscriptions.md](subscriptions.md)           | Tie a customer to a pricing plan.                                     |
| [invoices.md](invoices.md)                     | Create, issue and read invoices.                                      |
| [portal-sessions.md](portal-sessions.md)       | Short-lived links to a customer's own billing pages.                  |
| [credit-balances.md](credit-balances.md)       | Read and top up credit pools.                                         |
| [customer-alerts.md](customer-alerts.md)       | Watches on a customer's cost or revenue.                              |
| [matters.md](matters.md)                       | Bill AI cost to legal matters, by tag or by rule.                     |
| [spend-controls.md](spend-controls.md)         | Cap your own team's AI spend and read it back.                        |
| [analytics.md](analytics.md)                   | Usage rollups for dashboards and projections.                         |
| [analytics-cost.md](analytics-cost.md)         | What your AI usage cost.                                              |
| [analytics-revenue.md](analytics-revenue.md)   | What you earned.                                                      |
| [analytics-mrr.md](analytics-mrr.md)           | Monthly recurring revenue.                                            |
| [services.md](services.md)                     | The model price catalog and how to look a model up in it.             |

## One key, one organization

The API key alone tells the API which organization you are. You never pass an
organization ID in the address. Some routes also answer at
`/v1/sdk/<resource>` or `/v1/org/<organization ID>/<resource>`. Those take the
organization from the key too, and these pages use the plain
`/v1/<resource>` form. See [authentication.md](authentication.md).

## Testing your integration

`scripts/test-api-surface.sh` runs the main routes end to end against a
running API: it creates a customer, agent, signal, pricing plan and
subscription, records a usage event, reads everything back, checks that a
publishable key can't write, and cleans up.

1. Create `scripts/.env.local` with an owner or admin secret key and a
   publishable key:

   ```
   MF_API_SECRET_KEY=mf_sk_...
   MF_API_PUBLISHABLE_KEY=mf_pk_...
   ```

   That file is ignored by git.

2. Run it from the repository root:

   ```bash
   bash scripts/test-api-surface.sh
   ```

It talks to `http://localhost:4000` unless you set `MF_API_BASE_URL` (the
address without `/v1`). For any address other than localhost it stops and asks
you to type `yes-production` first.
