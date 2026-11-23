# Services catalog

The services catalog is the price list the API uses to cost your usage
events: every model and tool it has a price for. When you record an event
with `model` and `modelProvider`, the API finds the matching catalog row and
uses its rates to work out the event's cost.

> **Check names here before you send events.** If your model is in the
> catalog, send its `canonicalName` as `model` and its `provider` as
> `modelProvider`, and the cost is worked out as the event arrives. If it
> isn't, the event is still stored, but with no cost and the status
> `NEEDS_COST_BACKFILL`, and it shows under **Needs attention** in the
> dashboard.

The catalog is shared by every organization on your server. These endpoints
only read it.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

- [Where the prices come from](#where-the-prices-come-from)
- [List services](#list-services)
- [Get one service](#get-one-service)
- [How an event finds its price](#how-an-event-finds-its-price)
- [When your model or tool isn't listed](#when-your-model-or-tool-isnt-listed)

## Where the prices come from

The rows come from three sources, named in each row's `source`:

- **`litellm`**: a snapshot of LiteLLM's public price list ships with this
  repository. `npm run db:setup` loads its 1,877 rows with no internet needed.
  They cover chat and completion models, embeddings, image, video and speech
  models, and more.
- **`builtin`**: 59 rows the product itself needs, written in
  `packages/db/scripts/sync-service-pricing.ts`. They're the tools that ship
  inside Claude Code and Codex (provider `tool`), which the Code Cost Clarity
  meter forwards, and the row that prices finished work (provider `outcome`).
- **`openrouter`**: optional. `npm run db:sync-pricing` fetches today's prices
  from OpenRouter and LiteLLM, updates the catalog and switches off models the
  sources no longer list. It needs internet. Without it, there are no
  `openrouter` rows.

There are no other sources. To price something else, such as a third-party
API or your own MCP tool, add a row yourself (see
[below](#when-your-model-or-tool-isnt-listed)). [features.md](../features.md#usage-metering-and-the-model-price-catalog)
covers the catalog in more depth.

## List services

```
GET /services
```

Returns catalog rows a page at a time, sorted by provider, then service type,
then name. Switched-off rows are never listed.

Send a secret key in the `x-api-key` header.

| Parameter     | Type    | Notes                                                                                                                                                     |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`    | string  | One provider, ignoring case, such as `openai`, `anthropic`, `google` or `tool`.                                                                           |
| `serviceType` | string  | One category, ignoring case, such as `LLM`, `Embeddings`, `Image Generation`, `Speech-to-Text`, `Web Search` or `Agent Built-in`.                         |
| `isApi`       | boolean | `true` for rows marked as API services, `false` for the rest. Leave it out for both. See the field notes below.                                           |
| `search`      | string  | Text to find anywhere in `canonicalName` or `displayName`, ignoring case.                                                                                 |
| `page`        | integer | From 1. Defaults to `1`.                                                                                                                                  |
| `limit`       | integer | 1 to 100. Defaults to `50`.                                                                                                                               |

**Examples:**

```bash
# Every OpenAI row
curl "https://billing.example.com/v1/services?provider=openai" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# Find a model by name
curl "https://billing.example.com/v1/services?search=gpt-4o-mini" \
  -H "x-api-key: $MF_API_SECRET_KEY"

# The built-in tool rows
curl "https://billing.example.com/v1/services?provider=tool" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

**Response (`200 OK`):**

```json
{
  "data": [
    {
      "id": "00000000-0000-4000-8000-000000001401",
      "externalId": "litellm/gpt-4o-mini",
      "canonicalName": "gpt-4o-mini",
      "displayName": "GPT 4o Mini",
      "provider": "openai",
      "serviceType": "LLM",
      "inputCost": "0.15",
      "outputCost": "0.6",
      "costUnit": "1M tokens",
      "contextWindow": 128000,
      "source": "litellm",
      "isApi": false,
      "isActive": true
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1,
    "totalPages": 1
  }
}
```

### The fields

| Field           | What it means                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | The row's UUID. Use it with `GET /services/{serviceId}`.                                                                                                                       |
| `externalId`    | Where the row came from, such as `litellm/gpt-4o-mini` or `tool/websearch`.                                                                                                    |
| `canonicalName` | The lowercase name to send as `model` in your usage events. This is what the price lookup matches.                                                                             |
| `displayName`   | A readable name for screens. Not used for matching.                                                                                                                            |
| `provider`      | The lowercase name to send as `modelProvider`.                                                                                                                                 |
| `serviceType`   | The category, such as `LLM` or `Web Search`.                                                                                                                                   |
| `inputCost`     | Dollars per `costUnit` on the input side, as a string so no precision is lost. On token-priced rows this is dollars per million tokens. `null` when there's no input rate.     |
| `outputCost`    | Dollars per `costUnit` for output tokens, as a string. `null` when there's no output rate.                                                                                     |
| `costUnit`      | The unit the rates are in, such as `1M tokens`, `1M characters`, `second`, `image`, `request` or `1K requests`.                                                               |
| `contextWindow` | The model's context window in tokens, or `null`.                                                                                                                               |
| `source`        | `litellm`, `openrouter` or `builtin`.                                                                                                                                          |
| `isApi`         | `true` on the built-in rows and on any API rows you add. `false` on every LiteLLM and OpenRouter row, including image, video and speech models.                                |
| `isActive`      | Always `true` here, because switched-off rows aren't returned.                                                                                                                 |

The catalog also stores prompt-cache read and write rates for models that
have them. These endpoints don't return them, but the cost of an event with
cache tokens uses them.

## Get one service

```
GET /services/{serviceId}
```

One row by its UUID, in the same shape as a row in the list.

```bash
curl "https://billing.example.com/v1/services/00000000-0000-4000-8000-000000001401" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

**Errors:**

| Code  | Cause                                         |
| ----- | --------------------------------------------- |
| `401` | No key, or a key that isn't valid.            |
| `404` | No such row, or the row has been switched off. |

## How an event finds its price

When an event arrives, the API lowercases and trims its `model` and
`modelProvider`, then looks for an active row with that `canonicalName` and
`provider`. If there's none, it tries again with a trailing date or version
removed from the model name, so `gpt-4o-2024-08-06` can match `gpt-4o`. If
that fails too, it checks your organization's own model mappings. With no
match, the event is stored without a cost.

## When your model or tool isn't listed

1. Search first: `GET /services?search=<name>` or `?provider=<provider>`.
2. If a row fits, send its `canonicalName` as `model` and its `provider` as
   `modelProvider`. Costs are worked out on arrival.
3. If events already arrived under another name, map that name to an existing
   row with `POST /events/map-model` (or **Map & backfill** under **Needs
   attention**, or MCP's `map_model`). Waiting events get their cost, and
   later events with that name are priced on arrival. The mapping applies to
   your organization only. See [usage-events.md](usage-events.md).
4. If no row fits, add one. Put a row in `BUILT_IN_ROWS` in
   `packages/db/scripts/sync-service-pricing.ts` and load it with
   `npm run db:seed-pricing`. See
   [prices for your own tools](../make-it-yours.md#prices-for-your-own-tools).
   Until the row exists, events for it are stored with no cost and wait under
   **Needs attention**.

Mapping points a name at a row that already exists. It can't create a price.

## Using the SDK and MCP

```ts
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

const { data } = await mf.services.list({ search: "gpt-4o-mini" });
const row = await mf.services.get(data[0].id);
```

The SDK builds from this repository. See [packages.md](../packages.md). MCP
has the same list as `list_catalog_services`.
