# Signals

A signal is the unit you measure and bill on. It belongs to one agent. A
chatbot might have `messages`, a document analyzer `pages_processed`, an image
generator `images_generated`.

You don't have to create a signal before you send usage. An event with a
`signalName` its agent doesn't have yet creates the signal. Create one
yourself when you want to set its type or short name up front, or to attach a
pricing strategy to it before the first event arrives.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is the final word on every request and response shape.

- [Name the signal after what you bill](#name-the-signal-after-what-you-bill)
- [Signal types](#signal-types)
- [Who can call these routes](#who-can-call-these-routes)
- [Create a signal](#create-a-signal)
- [Create or update several signals](#create-or-update-several-signals)
- [Read a signal](#read-a-signal)
- [List signals](#list-signals)
- [Update a signal](#update-a-signal)
- [Set a signal's cost category](#set-a-signals-cost-category)
- [Delete a signal](#delete-a-signal)
- [Signals in usage events](#signals-in-usage-events)
- [How signals fit the billing chain](#how-signals-fit-the-billing-chain)

## Name the signal after what you bill

The signal is the unit on your customer's invoice. If you bill per page, name
it `pages` and send one event per report with `quantity` set to the page
count. If you bill per report, name it `reports` and send one event with
`quantity: 1`. Same work, different invoice line. The
[SDK README](../../packages/sdk/README.md#picking-signalname-and-quantity)
walks through more examples.

## Signal types

Every signal can carry a `type`:

| Type     | Means                                   | Example                                |
| -------- | --------------------------------------- | -------------------------------------- |
| `usage`  | Billed per result delivered (outcome)   | Each document analyzed successfully    |
| `volume` | Billed per attempt, success or not      | Each API call, whatever its result     |

The type is a label for people and reports. The pricing math doesn't read it:
what a customer pays comes from the pricing strategy on the signal and the
`quantity` you send. A signal created by a usage event has no type until you
set one.

## Who can call these routes

Send a secret key (`mf_sk_...`) in the `x-api-key` header. See
[authentication.md](authentication.md).

- **Reads** work with any secret key except an ingest-only or legal key.
- **Writes** need a key whose role is owner, admin or developer. Setting the
  cost category is the exception: it needs owner, admin or finance.
- A publishable key (`mf_pk_...`) gets `403` on every route on this page.

## Create a signal

```
POST /signals
```

**Required:**

- `name` (string, up to 255 characters): the signal's name. Usage events
  match a signal by this name, within its agent. Leading and trailing spaces
  are trimmed.
- `agentId` (UUID): the agent's `id`, not its `agentCode`.

**Optional:**

- `shortName` (string, up to 255 characters): a second, machine-friendly
  name, such as `docs_analyzed`. Left empty when you don't send one.
- `type`: `usage` or `volume`.

Within one agent, both `name` and `shortName` must be unique.

**Example:**

```bash
curl -X POST https://billing.example.com/v1/signals \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "messages",
    "shortName": "msgs",
    "agentId": "00000000-0000-4000-8000-000000000002",
    "type": "usage"
  }'
```

**Returns `201`** with the signal (abridged here):

```json
{
  "id": "00000000-0000-4000-8000-000000000003",
  "name": "messages",
  "shortName": "msgs",
  "type": "usage",
  "agentId": "00000000-0000-4000-8000-000000000002",
  "costCategory": "UNCLASSIFIED",
  "createdAt": "2026-04-10T14:30:00.000Z"
}
```

**Errors:**

- `400`: `name` is missing or too long, or `agentId` isn't a UUID.
- `404`: no agent with that `agentId` exists in your organization.
- `409`: this agent already has a signal with that `name` or `shortName`. The
  message says which.

Create a signal once per unit you bill, during setup. Usage itself goes to the
usage endpoint ([usage-events.md](usage-events.md)), never here.

## Create or update several signals

```
POST /signals/bulk
```

Creates and updates up to 50 signals in one transaction. Each item has the
create fields plus `isNew`:

- `isNew: true` creates the signal.
- `isNew: false` updates the signal named by `id`, which is then required.

```json
{
  "signals": [
    {
      "isNew": true,
      "name": "pages_processed",
      "agentId": "00000000-0000-4000-8000-000000000002",
      "type": "usage"
    },
    {
      "isNew": false,
      "id": "00000000-0000-4000-8000-000000000003",
      "name": "messages",
      "agentId": "00000000-0000-4000-8000-000000000002",
      "type": "volume"
    }
  ]
}
```

**Returns `201`** with an array of the created signals followed by the updated
ones.

**Errors:** `400` for an empty list, more than 50 items, or an update with no
`id`; `404` when an agent or an updated signal isn't found. The message lists
the missing IDs.

## Read a signal

```
GET /signals/{signalId}
```

The response includes an `agent` object with the agent's `id`, `name` and
`agentCode`. **Errors:** `404` when the signal doesn't exist or was deleted.

## List signals

```
GET /signals
```

**Query parameters (all optional):**

- `name`: partial, case-insensitive match.
- `agentId`: only this agent's signals.
- `type`: `usage` or `volume`.
- `sortBy` (default `createdAt`) and `sortOrder` (`asc` or `desc`, default
  `desc`).
- `page` (default `1`) and `limit` (default `10`).

**Returns** `{ results, page, limit, totalPages, totalResults }`.

## Update a signal

```
PATCH /signals/{signalId}
```

Send any field from create. Only the fields you send change. Sending a new
`agentId` moves the signal to that agent, which must exist in your
organization.

**Rename with care.** Usage events find the signal by `name`. After a rename,
the next event that still sends the old name creates a new signal with that
name, and usage splits across the two.

**Errors:** `404` when the signal, or the new agent, doesn't exist.

## Set a signal's cost category

```
PATCH /signals/{signalId}/classification
```

Sets which accounting bucket the signal's cost goes to. Send one field,
`costCategory`, set to one of `PRODUCTION_COGS`, `DEVELOPMENT_RD`, `SALES_SM`,
`GENERAL_GA`, `INTERNAL_TOOL` or `UNCLASSIFIED` (the default).

```bash
curl -X PATCH https://billing.example.com/v1/signals/00000000-0000-4000-8000-000000000003/classification \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"costCategory": "PRODUCTION_COGS"}'
```

**Errors:** `400` for a value not in the list; `404` when the signal doesn't
exist.

## Delete a signal

```
DELETE /signals/{signalId}
```

A soft delete: the signal is hidden from reads and lists, and its events and
pricing strategies stay in the database. **Returns `204`** with no body.

A usage event that sends the deleted signal's name for the same agent brings
the signal back. To retire a signal, stop sending its name. Delete is mostly
for cleaning up test data or setup mistakes.

**Errors:** `404` when the signal doesn't exist.

## Signals in usage events

The SDK has no signals resource. It names the signal with `signalName` when
you record usage, and that has to match the signal's `name`:

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1", // or set MARGINFRONT_API_URL
});

await client.usage.record({
  customerExternalId: "acme-001",
  agentCode: "support-bot",
  signalName: "messages", // matches the signal's name
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});
```

An unknown `signalName` creates a minimal signal with that name and no type.
That's handy while you prototype. Set the type afterwards with
`PATCH /signals/{signalId}`.

Build the SDK from source first, as in [packages.md](../packages.md). Through
MCP: `create_signal` and `list_signals`.

## How signals fit the billing chain

```
Customer --+
           |
Agent -----+---- Signal ---- Pricing strategy ---- Pricing plan ---- Subscription
           |    (the unit)   (the price per unit)  (the bundle)     (per customer)
           |
Usage event (one customer, one agent, one signal, a quantity)
```

- **Customer:** who is billed.
- **Agent:** what does the work.
- **Signal:** what you count.
- **Pricing strategy:** what each unit of a signal costs. See
  [pricing-strategies.md](pricing-strategies.md).
- **Pricing plan:** the set of strategies a customer is on. See
  [pricing-plans.md](pricing-plans.md).
- **Subscription:** puts one customer on one plan for one agent. See
  [subscriptions.md](subscriptions.md).
- **Usage event:** one measurement. See [usage-events.md](usage-events.md).

When an invoice is generated, the API totals the period's usage events for
each signal, prices them with the strategies on the customer's plan, and adds
the plan's fees. See [invoices.md](invoices.md).
