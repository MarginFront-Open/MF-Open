# Concepts

This page names the moving parts of MarginFront and how they connect: what you
send, what the API works out for you, and the four different numbers it calls
revenue. API paths are relative to your API address including `/v1`, and the
interactive API reference is at `/api-docs` on a running API. When this page
and `/api-docs` disagree, `/api-docs` is right, because it's built from the
code.

- [The building blocks](#the-building-blocks)
- [Your handles and the API's IDs](#your-handles-and-the-apis-ids)
- [Signals face out, costs face in](#signals-face-out-costs-face-in)
- [Charge types and pricing models](#charge-types-and-pricing-models)
- [Credit pools](#credit-pools)
- [How a period's usage is priced](#how-a-periods-usage-is-priced)
- [Signals with no price](#signals-with-no-price)
- [Events that need attention](#events-that-need-attention)
- [The four revenue labels](#the-four-revenue-labels)
- [Margin and MRR](#margin-and-mrr)
- [Invoice statuses](#invoice-statuses)
- [Subscriptions and billing periods](#subscriptions-and-billing-periods)
- [Choosing a signal name and quantity](#choosing-a-signal-name-and-quantity)
- [One event, several services](#one-event-several-services)
- [Setup order](#setup-order)
- [Three ways to send events](#three-ways-to-send-events)

## The building blocks

Everything below belongs to one **organization**. Your customers, agents,
signals, plans, subscriptions and invoices all live inside it. If you run a
multi-tenant product, your own customers are customer records inside your
organization, not organizations of their own.

### 1. Agent

The thing that does billable work. A support bot is one agent, a research
assistant another. If you sell one product, you have one agent. If you sell
three products that price differently, you have three.

Each agent has an **agent code**, a short handle you pick, such as `cs-bot`.
Your app sends it with every event so the API knows which product did the
work.

### 2. Customer

Who you bill. One of your own users or companies.

Each customer has an **external ID**: the ID your own system already uses,
such as `acme-001`. Events name the customer by that ID, so you never have to
look up the API's own customer ID. Create customers in the dashboard, through
`POST /customers`, the SDK or MCP, or let the first event create them.

### 3. Signal

The unit a customer pays for: what shows up on their invoice. Each signal
belongs to one agent.

Good signals are things the customer cares about: `messages`,
`reports-generated`, `pages-processed`. Bad signals are internal details the
customer doesn't care about: `gpt-4o-call`, `api-requests`. The rule for
picking one is in
[Choosing a signal name and quantity](#choosing-a-signal-name-and-quantity).

### 4. Usage event

A record that something happened: "agent `cs-bot` sent one message for
customer `acme-001` using `gpt-4o` from `openai`, with 523 input tokens and 117
output tokens." Everything else, from cost to invoices, is worked out from
events.

Send events to `POST /usage/record` (also served at `POST /sdk/usage/record`),
or call `usage.record()` in the SDK. One request carries 1 to 100 records.

### 5. Cost

What the work cost you. You don't set it. The API looks up the event's
`model` and `modelProvider` in the price catalog and prices the tokens, or
the quantity for a service priced per unit, and stores the result with the
event.

Your customers never see cost. It's for your own margin: "what did it cost me
to serve this customer this month?"

The catalog that ships with the repository is a LiteLLM snapshot plus built-in
rows, and `npm run db:sync-pricing` can add OpenRouter prices. See
[features.md](features.md#usage-metering-and-the-model-price-catalog). An
event whose model isn't in the catalog is still stored, with no cost. See
[Events that need attention](#events-that-need-attention).

To see which names the catalog knows before you send events, list it with
`GET /services?provider=openai`, `client.services.list({ provider: "openai" })`
in the SDK, or the MCP tool `list_catalog_services`.

### 6. Pricing plan

Turns usage into prices. A plan is a container, like a "Starter" or "Pro" plan
on your pricing page. You link a plan to one or more agents.

### 7. Pricing rule

One rule inside a plan, such as "$0.10 per message" or "$99 a month". The API
and the SDK call it a **pricing strategy**. A plan holds one or more of them,
and they do the actual price math. See
[Charge types and pricing models](#charge-types-and-pricing-models).

### 8. Subscription

Ties a customer to an agent through a plan: "from August 1, bill Acme for
`cs-bot` on the Pro plan, monthly."

Without a subscription the API still tracks cost, but it can't work out
revenue or issue invoices.

### 9. Invoice

The bill for one billing period of a subscription. It has a line for each
pricing rule, such as "Messages: 150 x $0.10 = $15.00", a total, a status and
a due date. The scheduled billing jobs issue them (see
[self-hosting.md](self-hosting.md#scheduled-jobs)).

### API keys

Your code's credential. Create keys in the dashboard under **Build**, then
**API keys**. A secret key starts with `mf_sk_` and belongs on servers only. A
publishable key starts with `mf_pk_` and is refused by almost every route.
Send the key in the `x-api-key` header.

A key belongs to one organization, so you never pass an organization ID with
it. To see which organization a key belongs to, call `GET /verify` and read
`organization.id`. Every key also carries a role, and roles are always
enforced. See [features.md](features.md#teams-and-roles).

## Your handles and the API's IDs

You pick three string handles:

| Handle        | Names a    | Example    |
| ------------- | ---------- | ---------- |
| External ID   | customer   | `acme-001` |
| Agent code    | agent      | `cs-bot`   |
| Signal name   | signal     | `messages` |

Usage events use these handles: `customerExternalId`, `agentCode` and
`signalName`. The signal name is matched against the signal's name within that
agent.

Everything else uses the API's own IDs (UUIDs) in paths and bodies. Creating a
subscription takes `customerId`, `agentId` and `planId` as UUIDs, and the
analytics routes filter by `customerId` as a UUID. Both kinds point at the same
records.

The first event that names a handle the API hasn't seen creates that customer,
agent or signal. That's handy, and it also means a typo creates a new record
instead of failing. If events turn up under a name you don't recognize, check
the handles your code sends.

## Signals face out, costs face in

The same events give two views.

- Your customer sees their invoice: `Messages: 150 x $0.10 = $15.00`.
- You see your margin: `Messages: 150 events, $2.34 model cost, $15.00 revenue`.

Signals face outward, to billing. Costs face inward, to profitability.

## Charge types and pricing models

Every pricing rule has a **charge type**, which decides when it bills, and
usage rules also have a **pricing model**, which decides how the number is
worked out.

### Charge types

| Charge type  | When it bills                                                                    | Example                                              |
| ------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `usage`      | On the usage of one signal in the billing period.                                | $0.10 per message.                                   |
| `recurring`  | Once per billing period, used or not.                                            | $99 a month.                                         |
| `seat_based` | Once per billing period, priced by the subscription's `seatsCount`.              | $10 a seat. Five seats is $50 a month.               |
| `onetime`    | Once, in the billing period that contains the subscription's start date.         | A $500 setup fee.                                    |

A partial period prorates recurring and seat fees. A rule can carry a minimum
commitment, so a usage or seat rule never bills for less than that quantity.

### Pricing models

- **`flat`:** one rate per unit. Quantity times rate.
- **`graduated`:** tiers with their own rates. Units 1 to 10 at one rate, 11 to
  50 at another, 51 and up at a third. Each unit pays the rate of its own tier.
- **`volume`:** tiers, but every unit pays one rate: the rate of the tier the
  period's total lands in.
- **`credit_pool`:** a flat fee buys a pool of units each period, and units
  past the pool bill at an overage rate. See [Credit pools](#credit-pools).

The tier math is one file, `packages/db/src/lib/revenue-calc.ts`, shared by
the dashboard, the API and the invoices.

## Credit pools

A credit pool is "5,000 tasks for $99 a month, then 3 cents a task." You
describe it with three numbers: the pool size, the pool price and the overage
rate. A plan can have one active credit pool, and a pool can't have a minimum
commitment, because the pool fee already is the minimum.

A pool is also a live countdown. Every usage event draws its quantity from the
pool as it arrives, and you can read the balance at any time from the
dashboard, `GET /credit-balances`, the SDK's `creditBalances` or the MCP tool
`get_credit_balances`. Each billing period starts a fresh pool, and unused
units don't roll over.

Three things to know:

1. **Nothing stops at zero.** The pool is a meter, not a breaker. A customer
   past their pool keeps working, and the extra units bill at the overage
   rate. If your product should stop at zero, your code makes that call by
   reading the balance first.
2. **Your team gets emails as the pool drains,** at 50%, 80% and 95% used and
   when it runs out. They go to your organization's billing email if one is
   set, otherwise to every owner and finance member. Alert emails need your
   email provider set up (see
   [alerts-and-notifications.md](alerts-and-notifications.md)).
3. **You can add units mid-period** with a top-up. Top-ups don't expire.

The walkthrough, with every call, is in
[recipes/credit-pools.md](recipes/credit-pools.md).

## How a period's usage is priced

Usage rules price the period's total, not each event. The API adds up the
quantity of every event for that signal in the billing period, runs the total
through the pricing model once, and writes one invoice line.

So one event with `quantity: 1500` bills the same as three events with
`quantity: 500` each. More events give you more detail in the history. The
total is what lands on the invoice.

## Signals with no price

A signal with no pricing rule on the customer's plan still records events and
cost. Its revenue is zero: not unknown, not missing. That's useful for:

- costs you don't pass on to customers,
- a new signal you haven't priced yet,
- internal tools that are part of your running cost.

The cost still shows in your margin. The customer never sees the signal on an
invoice.

## Events that need attention

The API never throws an event away because something about it is off. It
stores it and flags it, and the dashboard lists flagged events under **Needs
attention**. Each stored event has one of these states:

| State                 | What it means                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROCESSED`           | Stored and priced.                                                                                                                                  |
| `NEEDS_COST_BACKFILL` | Stored with no cost. The model and provider aren't in the catalog, or the model's price row has no rate for the cache tokens the event reported.    |
| `MISSING_VOLUME_DATA` | Stored with no cost because the volume is missing: token counts for a model priced by tokens, or `quantity` for a service priced per unit.          |

A missing cost is stored as empty, never as zero, so nothing is quietly
priced at $0. An unknown model can be mapped to a catalog entry under **Needs
attention** with **Map & backfill**. That prices the waiting events, and later
events with the same model and provider price on arrival. To price your own
tool, add a price row: see
[make-it-yours.md](make-it-yours.md#prices-for-your-own-tools).

A flagged event still bills. Revenue comes from the event's quantity and your
plan, not from its cost.

If an event leaves out `quantity`, it's stored as 1. That default applies
after the volume check, so a service priced per unit with no `quantity` is
still flagged `MISSING_VOLUME_DATA`.

## The four revenue labels

MarginFront reports four different dollar figures that could each be called
"revenue." They answer different questions and they're not the same number.
The definitions are in [packages/db/CANON.md](../packages/db/CANON.md).

### Agent-Earned

**What your agents produced in the window, at your usage rates.** No fees, no
proration. Every usage rule's quantity for the window, run through its pricing
model, added up.

Use it to spot activity early. It moves the moment events arrive, before any
invoice exists.

### Revenue

**What the customer owed for the window.** Agent-Earned plus recurring and
seat fees prorated to the window, plus one-time fees when the subscription
started inside the window.

Use it for "what did we earn this month, invoiced or not?"

### Billed

**What you invoiced and haven't been paid for yet.** The total of every
invoice with status `issued` or `overdue` whose invoice date is in the window.
Draft and void invoices never count. Paid invoices count under Collected
instead.

Use it to track accounts receivable.

### Collected

**Cash that arrived.** Every successful payment in the window, minus what was
refunded. It counts by the date the payment landed, not the date on the
invoice, so a payment this month counts this month even if the invoice was
dated last month.

Use it for cash flow.

### Why four

They happen in order:

1. Your agent does work. **Agent-Earned** goes up.
2. A billing period ends and an invoice is issued. **Billed** goes up.
3. The customer pays. **Collected** goes up.

If Agent-Earned is strong and Billed is weak, look at invoicing. If Billed is
strong and Collected is weak, look at collections. Keeping the four apart
shows you where the leak is.

## Margin and MRR

**Margin** is any of the four figures minus cost, so there's an Agent-Earned
margin, a Billed margin and so on. Margin percent is margin divided by that
figure. When the figure is zero there's no percent, and the dashboard shows a
dash.

**MRR** comes in three versions:

- **MRR:** what your active and pending subscriptions commit to per month
  today, from their recurring and seat fees. Usage isn't included.
- **Run-Rate MRR:** those fees plus the last 30 days of usage, as a monthly
  figure. "What would we bill per month if the last 30 days kept going?"
- **Committed MRR:** the contractual floor. Fees plus usage minimums only,
  whatever customers actually use.

Multiply any of them by 12 for the yearly figure. Read them from
`GET /analytics/mrr`, the SDK's `analytics.mrr()`, `runRateMrr()` and
`committedMrr()`, or the MCP tool `get_mrr`.

## Invoice statuses

| Status     | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `draft`    | Not issued yet. Never counted as Billed.                                                 |
| `issued`   | Sent to the customer and waiting for payment.                                            |
| `paid`     | Paid.                                                                                    |
| `overdue`  | Issued and past its due date without payment.                                            |
| `void`     | Cancelled. Never counted anywhere.                                                       |
| `refunded` | Every payment on it was refunded.                                                        |
| `pending`  | In the status list, but no revenue figure counts it.                                     |

The invoice date decides which window an invoice falls in for Billed. Not the
creation date, not the due date.

## Subscriptions and billing periods

A subscription has a start date, an optional end date and a billing cycle:
`monthly`, `yearly` or `custom` (with `customCycleDays`). One turn of the
cycle is a **billing period**, and each period gets one invoice.

A subscription's status is one of `upcoming`, `active`, `ended`, `canceled`,
`expired` or `pending`.

A subscription also has a `billingModel`: `subscription` (the default),
`usage` or `hybrid`. The scheduled job that issues usage invoices,
`dispatchUsageInvoices` in
`apps/api-nest/src/modules/subscription/subscription-billing.service.ts`,
only picks up subscriptions set to `usage` or `hybrid`. Set one of those on a
subscription whose plan bills usage.

**Net terms** are the days a customer has to pay after an invoice is issued.
They're 30 unless you set them on the customer or the subscription.

## Choosing a signal name and quantity

Before you write any code, decide one thing: **what unit should your customer
see on their invoice?** That's your signal name. The rest follows from it.

1. **Send one event per business outcome.** A finished report is one event. A
   finished call is one event. Not one per page, per minute or per token.
2. **The signal name is the billing unit.** Bill per page? Name it `pages`.
   Per report? `reports`. Per minute? `minutes`.
3. **`quantity` is how many of that unit this one event covers.** A 50-page
   report sent as `pages` has `quantity: 50`. The same report sent as
   `reports` has `quantity: 1`.
4. **Cost and revenue are separate.** The API works out cost from the model,
   provider and token counts. Revenue is quantity times your plan's rate. The
   gap is your margin.

Here's the same model call, a 50-page research report, billed three ways:

| Signal name         | Quantity | Rate                | Invoice line                        |
| ------------------- | -------- | ------------------- | ----------------------------------- |
| `reports_generated` | 1        | $50.00 per report   | 1 report x $50.00 = $50.00          |
| `report_pages`      | 50       | $2.00 per page      | 50 pages x $2.00 = $100.00          |
| `tokens_used`       | 15,000   | $0.00001 per token  | 15,000 tokens x $0.00001 = $0.15    |

Same call, same cost, three different invoices.

Don't loop. If your agent writes a 50-page report, send one event with
`quantity: 50`, not 50 events with `quantity: 1`. Looping floods your history
and wastes requests for nothing.

When in doubt, pick the word your customer would say if you asked "what am I
paying for?"

## One event, several services

Most real work uses more than one service for one outcome. An outreach agent
finds a contact with a search API, writes the message with a model and sends
it with an email API. To the customer that's one outreach. To you it's three
costs.

Send it as one event with a `services` array. The parent event is the
customer-facing outcome, and each entry is one service with its own cost:

```typescript
await client.usage.record({
  customerExternalId: "acme-001",
  agentCode: "outreach-bot",
  signalName: "outreaches-sent",
  quantity: 1, // one outreach
  services: [
    { model: "people-search", modelProvider: "search-api", quantity: 1 },
    {
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
      inputTokens: 4500,
      outputTokens: 1200,
    },
    { model: "transactional-email", modelProvider: "email-api", quantity: 1 },
  ],
});
```

| Shape          | When to use it                                    | Top level                                       | `services`                     |
| -------------- | ------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| Single service | One event, one service. Most chat features.       | `model`, `modelProvider` and the volume fields  | Leave it out                   |
| Several        | One event backed by several services.             | `quantity` is the signal count (default 1)      | 1 to 100 entries, one per service |

Send `model` and `modelProvider`, or `services`, never both and never
neither. A request that mixes them is refused with a message saying which to
drop.

The top-level `quantity` stays the signal count. Each entry carries its own
volume: tokens for a model, `quantity` for a service priced per unit. The
parent's cost is the sum of its entries, and it stays empty if any entry
can't be priced.

## Setup order

For cost tracking, which is the place to start:

1. Create a secret key under **Build**, then **API keys**.
2. Send one usage event with `customerExternalId`, `agentCode`, `signalName`,
   `model` and `modelProvider`. The customer, agent and signal are created on
   that call.
3. Open the dashboard and see the cost.

For revenue and invoices, add these after cost tracking works. None of them
happen on their own:

1. Create a pricing plan.
2. Add pricing rules to it.
3. Link the plan to the agent.
4. Create a subscription for the customer on that plan.

From then on, each event counts toward both cost and revenue, and invoices
follow on the billing cycle.

## Three ways to send events

- **The SDK,** for Node.js apps. It retries failed sends from memory in the
  background and never stalls your app by default. Build it from this
  repository: see [packages.md](packages.md) and
  [packages/sdk](../packages/sdk/README.md). The recipes show it end to end:
  [OpenAI](recipes/openai.md), [Anthropic](recipes/anthropic.md),
  [services that aren't models](recipes/non-llm.md) and
  [credit pools](recipes/credit-pools.md).
- **The REST API,** from any language. `POST /usage/record` with your key in
  the `x-api-key` header and a body of `{ "records": [ ... ] }`. The fields
  are in `/api-docs`.
- **MCP,** for an AI assistant working on your billing data in plain language:
  backfilling events, asking about revenue or cost, fixing unknown models,
  managing plans. It isn't the way to instrument your product. Use the SDK or
  the REST API for that. See [packages/mcp](../packages/mcp/README.md).
