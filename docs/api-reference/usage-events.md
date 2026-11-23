# Usage events

A usage event is one measurement: at this time, this customer used this agent
to do this much of this thing. Your app sends one each time an agent finishes
billable work. The API prices it against the model price catalog, stores it,
and at the end of the billing period rolls the events up against the
customer's pricing plan.

Everything else in the API is setup. This route is the everyday traffic.

> **You don't need to set anything up first.** When an event names a
> `customerExternalId`, `agentCode` or `signalName` the API hasn't seen, it
> creates that customer, agent or signal on the spot.

- [The route](#the-route)
- [Fields per record](#fields-per-record)
- [Limits](#limits)
- [Single-service, non-LLM and multi-service events](#single-service-non-llm-and-multi-service-events)
- [Example calls](#example-calls)
- [The response](#the-response)
- [When an event can't be priced](#when-an-event-cant-be-priced)
- [Fixing unpriced events](#fixing-unpriced-events)
- [Recording each event exactly once](#recording-each-event-exactly-once)
- [Tagging events for cost classification](#tagging-events-for-cost-classification)
- [Knowing what an event created](#knowing-what-an-event-created)
- [Listing events](#listing-events)
- [Deleting events](#deleting-events)
- [Common HTTP errors](#common-http-errors)
- [Using the SDK](#using-the-sdk)
- [When to send events](#when-to-send-events)

## The route

```
POST /v1/usage/record
```

`POST /v1/sdk/usage/record` is the same route under a second address.

**Key:** a secret key (`mf_sk_...`) of any role, including `ingest`. A
publishable key gets `403`. See [authentication.md](authentication.md).

**Body:** records always go in an array, even for one event. Send 1 to 100
records per request:

```json
{
  "records": [
    { "...": "one usage event" },
    { "...": "another usage event" }
  ]
}
```

## Fields per record

Each record takes one of two shapes:

- **Single-service:** one event backed by one model or service. Send `model`,
  `modelProvider` and the volume (tokens or quantity) at the top level.
- **Multi-service:** one business outcome backed by several services, for
  example a report that called two models. Send a `services` array, and leave
  `model`, `modelProvider` and the volume fields off the top level. Each entry
  carries its own.

Send one shape or the other. A record with both, or neither, gets `400` with a
message saying which.

### Always required

| Field                | Type   | Description                                                                                                                         |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `customerExternalId` | string | Your own ID for the customer, not MarginFront's. An ID the API hasn't seen creates the customer.                                    |
| `agentCode`          | string | A stable name for the agent or product that did the work. A new code creates the agent.                                             |
| `signalName`         | string | What the customer pays for, such as `messages` or `report_pages`. A new name creates the signal under that agent.                   |

### Single-service shape

| Field           | Type   | Description                                                                                                                                                                                                                  |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`         | string | The model name your provider returned, such as `response.model`. Matched against the catalog ignoring case and outer spaces. A trailing date or version suffix (`-2024-08-06`, `-20250514`, `-001`) is dropped if the full name isn't found. |
| `modelProvider` | string | The provider, such as `openai`, `anthropic` or `google`. Lowercased before matching. The provider is never guessed from the model name, because two providers can sell models with the same name.                               |

### Multi-service shape

| Field      | Type                | Description                                                                                                       |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `services` | array, 1 to 100 entries | One entry per service behind this outcome. The event is the thing the customer sees, and each entry is one cost line under it. |

Each entry in `services` takes:

| Field              | Type             | When                | Description                                                                                                                                 |
| ------------------ | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`            | string           | Always              | Same as the top-level `model`.                                                                                                              |
| `modelProvider`    | string           | Always              | Same as the top-level `modelProvider`.                                                                                                      |
| `inputTokens`      | whole number ≥ 0 | LLMs                | Input tokens for this service.                                                                                                              |
| `outputTokens`     | whole number ≥ 0 | LLMs                | Output tokens for this service.                                                                                                             |
| `cacheReadTokens`  | whole number ≥ 0 | LLMs, optional      | Prompt-cache reads (Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`). Priced at the cache-read rate.       |
| `cacheWriteTokens` | whole number ≥ 0 | LLMs, optional      | Prompt-cache writes (Anthropic `cache_creation_input_tokens`). Priced at the cache-write rate.                                                |
| `quantity`         | number ≥ 0       | Everything else     | Units for a service that isn't priced by tokens. Fractions are fine: send `14.137` seconds as it is.                                         |

### Optional fields

| Field              | Type                 | Default | Description                                                                                                                                                                                                                  |
| ------------------ | -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputTokens`      | whole number ≥ 0     | none    | Single-service only. Input tokens. Needed to price an LLM.                                                                                                                                                                  |
| `outputTokens`     | whole number ≥ 0     | none    | Single-service only. Output tokens. Needed to price an LLM.                                                                                                                                                                 |
| `cacheReadTokens`  | whole number ≥ 0     | none    | Single-service only. Prompt-cache reads, priced at the cache-read rate. Leave it off and cache adds nothing.                                                                                                                 |
| `cacheWriteTokens` | whole number ≥ 0     | none    | Single-service only. Prompt-cache writes, priced at the cache-write rate.                                                                                                                                                    |
| `quantity`         | number ≥ 0           | `1`     | The count of the billing unit for this event, used for revenue. For a single-service event that isn't priced by tokens, it's also the service's volume, and leaving it off stores the event without a cost (`MISSING_VOLUME_DATA`). |
| `usageDate`        | ISO 8601 string      | now     | When the usage happened. Use it to backfill past events.                                                                                                                                                                     |
| `metadata`         | object               | `{}`    | Your own key-value pairs, stored with the event. Two keys are read: `matterId` assigns the event to a matter (see [matters.md](matters.md)), and `cacheWriteTtl: "5m"` prices Anthropic cache writes at the five-minute rate. |
| `environment`      | string               | none    | `production`, `staging`, `development` or `testing`. See [Tagging events for cost classification](#tagging-events-for-cost-classification).                                                                                 |
| `idempotencyKey`   | string, ≤ 255 chars  | none    | A stable ID you choose so a retry can't count the event twice. See [Recording each event exactly once](#recording-each-event-exactly-once).                                                                                  |

`customerExternalId`, `agentCode`, `signalName`, `model` and `modelProvider`
are trimmed of outer spaces before they're used. Fields the route doesn't know are
refused with `400` (`property ... should not exist`), so a misspelled field
name fails loudly instead of being dropped.

Which services count as LLMs is decided by the catalog, not by you: a price
row whose unit is `1M tokens` needs `inputTokens` and `outputTokens`, and any
other row needs `quantity`.

## Limits

| What                               | Limit                                     |
| ---------------------------------- | ----------------------------------------- |
| Records per request                | 1 to 100                                  |
| Entries in `services`              | 1 to 100                                  |
| Request body                       | 2 MB                                      |
| JSON nesting in the whole body     | 16 levels                                 |
| `metadata`                         | 16 KB once serialized, nested 5 levels deep at most |
| `customerExternalId`, `agentCode`, `signalName`, `model`, `idempotencyKey` | 255 characters |
| `modelProvider`                    | 100 characters                            |
| Any token count or quantity        | 50,000,000                                |
| Requests                           | 60,000 a minute per organization          |

A value past a limit gets `400` (or `413` for the body size) with a message
that names the field and the limit. To change the request rate, see
[make-it-yours.md](../make-it-yours.md#api-keys-and-rate-limits).

## Single-service, non-LLM and multi-service events

All three use the same route. What changes is which fields carry the volume.

**An LLM call** is priced by tokens:

```json
{
  "customerExternalId": "acme-001",
  "agentCode": "support_bot",
  "signalName": "messages",
  "model": "gpt-4o",
  "modelProvider": "openai",
  "inputTokens": 523,
  "outputTokens": 117
}
```

**A service priced per unit** sends `quantity`. The catalog prices models and
the tools that ship inside Claude Code and Codex. For any other paid API, add a
price row first ([how](../make-it-yours.md#prices-for-your-own-tools)), or the
event is stored without a cost:

```json
{
  "customerExternalId": "acme-001",
  "agentCode": "notifier",
  "signalName": "sms_sent",
  "model": "acme-sms",
  "modelProvider": "acme",
  "quantity": 3
}
```

**A multi-service event** is one outcome backed by several services. Here a
report agent drafts with one model and reviews with another:

```json
{
  "customerExternalId": "acme-001",
  "agentCode": "report_writer",
  "signalName": "reports",
  "quantity": 1,
  "services": [
    {
      "model": "gpt-4o",
      "modelProvider": "openai",
      "inputTokens": 4200,
      "outputTokens": 1500
    },
    {
      "model": "claude-sonnet-4-6",
      "modelProvider": "anthropic",
      "inputTokens": 1800,
      "outputTokens": 300
    }
  ]
}
```

It's stored as one event with one cost line per service. The event's cost is
the sum of its services, and only when every
service is priced. If any one isn't, the whole event is stored without a cost
until it's fixed, never with a partial total.

You can mix all three in one batch.

## Example calls

**One LLM event:**

```bash
curl -X POST https://billing.example.com/v1/usage/record \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "customerExternalId": "acme-001",
        "agentCode": "support_bot",
        "signalName": "messages",
        "model": "gpt-4o",
        "modelProvider": "openai",
        "inputTokens": 523,
        "outputTokens": 117
      }
    ]
  }'
```

**One event with prompt-cache tokens:**

```bash
curl -X POST https://billing.example.com/v1/usage/record \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "customerExternalId": "acme-001",
        "agentCode": "research_agent",
        "signalName": "research_queries",
        "model": "claude-sonnet-4-6",
        "modelProvider": "anthropic",
        "inputTokens": 1024,
        "outputTokens": 512,
        "cacheReadTokens": 20000,
        "cacheWriteTokens": 4000
      }
    ]
  }'
```

**A mixed batch:**

```bash
curl -X POST https://billing.example.com/v1/usage/record \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {"customerExternalId": "acme-001", "agentCode": "support_bot", "signalName": "messages", "model": "gpt-4o", "modelProvider": "openai", "inputTokens": 100, "outputTokens": 50},
      {"customerExternalId": "globex-002", "agentCode": "support_bot", "signalName": "messages", "model": "claude-sonnet-4-6", "modelProvider": "anthropic", "inputTokens": 200, "outputTokens": 75},
      {"customerExternalId": "acme-001", "agentCode": "report_writer", "signalName": "reports", "quantity": 1, "services": [{"model": "gpt-4o", "modelProvider": "openai", "inputTokens": 4200, "outputTokens": 1500}, {"model": "claude-sonnet-4-6", "modelProvider": "anthropic", "inputTokens": 1800, "outputTokens": 300}]}
    ]
  }'
```

On Windows PowerShell, send the body through a here-string and a pipe. See
[authentication.md](authentication.md#windows-and-powershell).

## The response

A request that passes validation always gets `200 OK`, even when some records
weren't priced. Read the body to see what happened to each one.

```json
{
  "processed": 2,
  "successful": 1,
  "failed": 1,
  "results": {
    "success": [
      {
        "customerExternalId": "acme-001",
        "agentCode": "support_bot",
        "signalName": "messages",
        "totalCostUsd": "0.0024775000",
        "eventId": "00000000-0000-4000-8000-000000000011",
        "rawEventId": "00000000-0000-4000-8000-000000000012",
        "timestamp": "2026-04-12T20:10:54.218Z",
        "created": { "customer": false, "agent": false, "signal": false },
        "model": "gpt-4o",
        "modelProvider": "openai",
        "inputTokens": 523,
        "outputTokens": 117,
        "quantity": 1
      }
    ],
    "failed": [
      {
        "record": {
          "customerExternalId": "acme-001",
          "agentCode": "support_bot",
          "signalName": "messages",
          "model": "my-custom-llm",
          "modelProvider": "custom",
          "inputTokens": 400,
          "outputTokens": 90
        },
        "code": "NEEDS_COST_BACKFILL",
        "stored": true,
        "eventId": "00000000-0000-4000-8000-000000000013",
        "rawEventId": "00000000-0000-4000-8000-000000000014",
        "error": "Model \"my-custom-llm\" (provider \"custom\") not found in service_pricing. Event stored with usageCost: null. Map this model in the MarginFront dashboard under \"Needs attention\" to calculate cost and backfill this event.",
        "created": { "customer": false, "agent": false, "signal": false }
      }
    ]
  }
}
```

### Success entries

| Field                       | Description                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `customerExternalId`, `agentCode`, `signalName` | Echoed from your request.                                                          |
| `totalCostUsd`              | The cost in US dollars, as a string with 10 decimal places.                                         |
| `eventId`                   | The stored event's ID. Use it for lookups.                                                          |
| `rawEventId`                | The ID of the raw copy of your request kept for audit.                                              |
| `timestamp`                 | The event's usage date: your `usageDate`, or the time it arrived.                                   |
| `created`                   | Which records this event created. See [Knowing what an event created](#knowing-what-an-event-created). |
| `model`, `modelProvider`, token fields, `quantity` | Single-service only. Echoed, with `quantity` as `1` if you left it off.          |
| `services`                  | Multi-service only. One entry per service with its `model`, `modelProvider`, volume, `usageCost` and `eventStatus`. |

### Failed entries

| Field            | Description                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `record`         | The record you sent, so you can match it up.                                                                                      |
| `code`           | `NEEDS_COST_BACKFILL`, `MISSING_VOLUME_DATA` or `INTERNAL_ERROR`. For a multi-service event, the worst status among its services. |
| `stored`         | `true`: the event is saved, don't send it again. `false`: it wasn't saved, and it's safe to retry.                                |
| `eventId`        | The stored event's ID. Only when `stored` is `true`.                                                                              |
| `rawEventId`     | The raw audit copy's ID. `null` if even that couldn't be saved.                                                                   |
| `error`          | What happened, in words. For several failing services, their messages joined with ` \| `.                                        |
| `created`        | Same as on a success entry. Only when `stored` is `true`.                                                                         |
| `servicesStatus` | Multi-service only, when stored. `{ model, modelProvider, eventStatus }` for each service, so you can see which one needs fixing.   |

### The codes

| Code                  | Stored? | What happened                                                                                                                                                                                                                                          | What to do                                                                                                       |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `NEEDS_COST_BACKFILL` | Yes     | Saved without a cost. Either the model and provider aren't in the catalog, or they are but the price row has no cache rate and the event sent cache tokens. A missing cache rate is never priced as $0. The `error` says which case it is.                | Don't resend. See [Fixing unpriced events](#fixing-unpriced-events).                                             |
| `MISSING_VOLUME_DATA` | Yes     | Saved without a cost because the volume is missing: an LLM without both `inputTokens` and `outputTokens`, or a per-unit service without `quantity`. An explicit `0` counts as a volume.                                                                    | Don't resend. Send the volume next time, and fill in the stored ones (see [Fixing unpriced events](#fixing-unpriced-events)). |
| `INTERNAL_ERROR`      | No      | Something failed inside the API while saving the event.                                                                                                                                                                                                | Retry. If it keeps happening, the API's logs have the cause.                                                    |

A bad field (wrong type, negative number, missing required field) doesn't
show up here. It fails the whole request with `400` before anything is saved.
See [Common HTTP errors](#common-http-errors).

## When an event can't be priced

Events are never dropped and never priced at $0 by guesswork. If an event
can't be priced:

1. It's saved with `usageCost: null`. Null, not zero, so it can be priced
   later.
2. The response lists it under `results.failed` with `stored: true`.
3. The dashboard lists it under **Needs attention**, grouped by model and
   provider.
4. Once you fix the cause, the stored events are priced in place and future
   events with that model price on arrival.

**Don't resend an event with `stored: true`.** It's already saved, and a
resend without an `idempotencyKey` stores it twice.

## Fixing unpriced events

**A model the catalog doesn't know.** Either map it to a known price row, or
add a price row for it:

- In the dashboard, open **Needs attention**, pick a known model and choose
  **Map & backfill**.
- Through the API, call `POST /v1/events/map-model` (below).
- For your own tools and paid APIs, add a row to the catalog
  ([how](../make-it-yours.md#prices-for-your-own-tools)), then map the waiting
  events to it.

**A known model with no cache rate.** Give its price row the missing
`cacheReadCost` or `cacheWriteCost`, by running `npm run db:sync-pricing` if
the source now has the rate or by setting it on your own row, then map the
events again. See [features.md](../features.md#usage-metering-and-the-model-price-catalog).

**Missing volume.** Call `POST /v1/events/fill-volume` (below).

### List unpriced models

```
GET /v1/events/needs-cost-backfill
```

| Parameter   | Type     | Default     | Description                     |
| ----------- | -------- | ----------- | ------------------------------- |
| `startDate` | ISO 8601 | 30 days before `endDate` | Events on or after this date. |
| `endDate`   | ISO 8601 | now         | Events on or before this date.  |

```json
{
  "groups": [
    {
      "model": "my-custom-llm",
      "provider": "custom",
      "count": 3,
      "oldestEventDate": "2026-04-11T22:12:14.000Z"
    }
  ],
  "totalEvents": 3
}
```

Counts are per service, so a multi-service event with one unpriced service
counts once for that service's model.

### Map a model to a known price

```
POST /v1/events/map-model
```

Needs a key with the owner, admin or developer role.

Name the target by its price row ID:

```json
{
  "sourceModel": "my-custom-llm",
  "sourceProvider": "custom",
  "targetPricingId": "00000000-0000-4000-8000-000000000021"
}
```

Or by model and provider:

```json
{
  "sourceModel": "my-custom-llm",
  "sourceProvider": "custom",
  "targetModel": "gpt-4o",
  "targetProvider": "openai"
}
```

Response:

```json
{
  "backfilled": 3,
  "childrenUpdated": 3,
  "refused": 0,
  "refusedRates": [],
  "mappingId": "00000000-0000-4000-8000-000000000022"
}
```

The mapping belongs to your organization only, so later events with that
model price on arrival. The catalog itself isn't changed. `backfilled` counts
events, `childrenUpdated` counts the services priced, and `refused` counts
services still unpriced because the target row has no rate for the cache
tokens they reported. `refusedRates` names those missing rates. A target that
doesn't exist gets `404`.

### List events missing volume

```
GET /v1/events/missing-volume
```

Takes the same `startDate` and `endDate` as the unpriced list. Each group also
carries `costUnit`, so you know whether to send tokens (`1M tokens`) or a
quantity.

### Fill in missing volume

```
POST /v1/events/fill-volume
```

Needs a key with the owner, admin or developer role.

```json
{
  "sourceModel": "gpt-4o",
  "sourceProvider": "openai",
  "inputTokens": 500,
  "outputTokens": 120
}
```

For a per-unit service, send `quantity` instead of the token counts. The
values apply to every waiting event with that model and provider. An LLM
without both token counts, or a per-unit service without `quantity`, gets
`400`. The response has the same `backfilled`, `childrenUpdated`, `refused`
and `refusedRates` fields as `map-model`.

## Recording each event exactly once

The same event sometimes gets sent twice: a retry after a timeout, a worker
replaying its queue, a network blip that leaves you unsure. To keep each one
from counting twice, send an `idempotencyKey`: an ID you choose that stays the
same across retries of that one event.

```json
{
  "records": [
    {
      "customerExternalId": "acme-001",
      "agentCode": "support_bot",
      "signalName": "messages",
      "model": "gpt-4o",
      "modelProvider": "openai",
      "inputTokens": 523,
      "outputTokens": 117,
      "idempotencyKey": "chat-turn-9f8c2a"
    }
  ]
}
```

- **The first time** the API sees the key, the event is recorded normally.
- **Any later request with the same key** is a replay. Nothing new is stored,
  and the entry comes back in `results.success` with the original `eventId`
  and `totalCostUsd`.

Good to know:

- **One key per event.** Pick something you can recompute for the same piece
  of work: an order ID, a message ID, or a hash of the request. Two different
  events with the same key count as one.
- **Keys belong to your organization.** The same value from another
  organization never collides with yours.
- **A failed attempt can be retried.** Only a saved event blocks its key. If
  the first attempt failed before saving (`stored: false`), sending it again
  with the same key records it.
- **A replay of an unpriced event lands in `success`** with `totalCostUsd`
  set to `null`. A replay of a multi-service event echoes the services without
  their `usageCost` or `eventStatus`, and a replay has no `created` field.
- **Optional.** Without a key, every request is recorded on its own.

## Tagging events for cost classification

Finance teams often split AI spend into cost of goods sold (serving paying
customers) and research and development (experiments and tests). Add an
`environment` to each record:

```json
{
  "customerExternalId": "acme-001",
  "agentCode": "support_bot",
  "signalName": "messages",
  "model": "gpt-4o",
  "modelProvider": "openai",
  "inputTokens": 523,
  "outputTokens": 117,
  "environment": "production"
}
```

While a signal is still unclassified, the first event that carries an
`environment` classifies it:

| `environment` | The signal's cost category                        |
| ------------- | ------------------------------------------------- |
| `production`  | Production, cost of goods sold                    |
| `development` | Development, research and development             |
| `testing`     | Development, research and development             |
| `staging`     | Left unclassified, for you to choose              |

Once a signal has a category, events don't change it. Every event still stores
its own `environment`. Leave the field off and nothing about your events
changes.

## Knowing what an event created

Every new event's entry carries a `created` object:

```json
"created": { "customer": true, "agent": false, "signal": true }
```

That reads: this was the first event for that `customerExternalId` and that
`signalName`, so both were created. The agent already existed.

- **Stored failures have it too.** Records are created before pricing runs,
  so an event stored as `NEEDS_COST_BACKFILL` or `MISSING_VOLUME_DATA` still
  created its customer, agent and signal, and says so.
- **Missing isn't `false`.** An idempotent replay and an `INTERNAL_ERROR`
  entry have no `created` field. Treat a missing field as "no information" and
  `false` as "it already existed".
- **Bringing back a deleted record reports `false`.** An event for a customer,
  agent or signal you deleted brings the original back, with its ID and
  history, instead of making a copy.
- **A subscription deleted with its customer stays deleted.** Bringing the
  customer back doesn't bring it back. Create the subscription again to resume
  billing.

The flags catch typos early. A `customerExternalId` you expected to exist
coming back with `"customer": true` usually means it's misspelled. An unknown
ID never gets an error: it creates a new record.

## Listing events

```
GET /v1/events
```

**Key:** a secret key with any role but `ingest` or `legal`. A publishable,
`ingest` or `legal` key gets `403`.

| Parameter            | Type             | Default     | Description                                 |
| -------------------- | ---------------- | ----------- | ------------------------------------------- |
| `page`               | whole number ≥ 1 | `1`         | Page number.                                |
| `limit`              | whole number ≥ 1 | `10`        | Events per page.                            |
| `customerExternalId` | string           | none        | Only this customer's events, by your own ID. |
| `agentId`            | UUID             | none        | Only this agent's events.                   |
| `signalId`           | UUID             | none        | Only this signal's events.                  |
| `startDate`          | ISO 8601         | none        | Events on or after this time.               |
| `endDate`            | ISO 8601         | none        | Events on or before this time.              |
| `sortBy`             | string           | `usageDate` | The field to sort by.                       |
| `sortOrder`          | `asc` or `desc`  | `desc`      | Sort direction.                             |

```bash
curl "https://billing.example.com/v1/events?customerExternalId=acme-001&limit=20" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

```json
{
  "results": [
    {
      "id": "00000000-0000-4000-8000-000000000031",
      "customerExternalId": "acme-001",
      "customerId": "00000000-0000-4000-8000-000000000032",
      "subscriptionId": null,
      "organizationId": "00000000-0000-4000-8000-000000000001",
      "agentId": "00000000-0000-4000-8000-000000000033",
      "signalId": "00000000-0000-4000-8000-000000000034",
      "rawIngestEventId": "00000000-0000-4000-8000-000000000035",
      "usageDate": "2026-04-14T18:44:53.075Z",
      "quantity": "1",
      "metadata": {},
      "usageCost": "0.00225",
      "usageCostData": {
        "gpt-4o/input": { "cost": 0.00125, "units": 500, "costPerUnit": 0.0000025 },
        "gpt-4o/output": { "cost": 0.001, "units": 100, "costPerUnit": 0.00001 }
      },
      "eventProcessed": "PROCESSED",
      "eventProcessedAt": "2026-04-14T18:44:54.263Z",
      "environment": null,
      "idempotencyKey": null,
      "matterId": null,
      "matterSource": null,
      "createdAt": "2026-04-14T18:44:53.075Z",
      "updatedAt": "2026-04-14T18:44:53.075Z",
      "signal": {
        "id": "00000000-0000-4000-8000-000000000034",
        "name": "messages",
        "shortName": null
      }
    }
  ],
  "page": 1,
  "limit": 20,
  "totalPages": 42,
  "totalResults": 837
}
```

### Reading an event

- **`usageCost` and `quantity` are strings**, such as `"0.00225"`, so no
  precision is lost. Convert them before doing math.
- **`usageCostData` is the itemized cost.** Each key is
  `"<model>/<part>"`: `input`, `output`, and `cache_read` or `cache_write`
  when the event sent cache tokens. Each value has `cost` (dollars), `units`
  and `costPerUnit`. Two services on the same model share one key, with their
  costs and units added together.
- **`signal`** is the event's signal, so you don't need a second lookup.
- **`subscriptionId`** is `null` when the customer had no active subscription
  for that agent when the event arrived.

### Event states

`eventProcessed` says where the event stands:

| Value                 | Meaning                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PROCESSED`           | Priced. `usageCost` is set.                                                                                  |
| `NEEDS_COST_BACKFILL` | Stored without a cost: an unknown model, or cache tokens with no cache rate. See [Fixing unpriced events](#fixing-unpriced-events). |
| `MISSING_VOLUME_DATA` | Stored without a cost because the volume is missing. See [Fill in missing volume](#fill-in-missing-volume). |
| `PENDING`, `ERROR`    | Not priced. Treat these like the two above and check the API's logs.                                         |

When an event isn't `PROCESSED`, `usageCost` is `null`.

## Deleting events

```
DELETE /v1/events
```

Needs a key with the owner, admin or developer role.

```json
{ "eventIds": ["00000000-0000-4000-8000-000000000031"] }
```

Deletes for good, not into a trash. Answers `204` with no body, or `404` if
none of the IDs belong to your organization.

## Common HTTP errors

| Status | Cause                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | The batch is empty or has more than 100 records, a required field is missing, a field has the wrong type or is past its limit, both shapes or neither were sent, an unknown field was sent, or the body isn't valid JSON. The message names the field. Nothing in the request is saved. |
| `401`  | The key is missing, wrong, revoked or expired. A sign-in token instead of a key gets `401` with the code `use_api_key`.                                                                       |
| `403`  | A publishable key (`mf_pk_...`). Recording usage needs a secret key.                                                                                                                                   |
| `413`  | The body is over 2 MB. Send fewer records per request, or smaller `metadata`.                                                                                                                           |
| `429`  | Too many requests, or too many failed key attempts from your address. See [errors.md](errors.md#429-too-many-requests).                                                                                |
| `503`  | The API couldn't check your key because of a problem on its side. See [errors.md](errors.md#503-service-unavailable).                                                                                  |

## Using the SDK

The SDK wraps this route. Build it from this repository and point it at your
API: see [packages/sdk/README.md](../../packages/sdk/README.md).

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

await client.usage.record({
  customerExternalId: "acme-001",
  agentCode: "support_bot",
  signalName: "messages",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});

await client.usage.recordBatch([
  {
    customerExternalId: "acme-001",
    agentCode: "support_bot",
    signalName: "messages",
    model: "gpt-4o",
    modelProvider: "openai",
    inputTokens: 100,
    outputTokens: 50,
  },
  {
    customerExternalId: "globex-002",
    agentCode: "report_writer",
    signalName: "reports",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    inputTokens: 1800,
    outputTokens: 300,
  },
]);
```

With the default `fireAndForget: true`, `usage.record()` never throws: network
errors go to a local buffer and retry, and auth errors drop with a warning. See
the SDK README for the details.

## When to send events

Send an event right after the work is done, so it shows up in analytics and
projections sooner.

The SDK retries failed sends for you. To send several events in one request,
use `usage.recordBatch()`. Calling the API yourself, send up to 100
records per request every few seconds when traffic is high.
