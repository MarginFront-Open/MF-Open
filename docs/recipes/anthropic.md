# Recipe: Anthropic

This recipe adds usage tracking to a Node.js app that calls Anthropic's Claude
models. When it's done, every Claude call your app makes for a customer shows
up in your MarginFront dashboard with its model, tokens and cost. If the
customer has a subscription, the same events feed their invoice.

It's the same pattern as the [OpenAI recipe](openai.md). Anthropic names its
token fields differently, and its prompt cache has a write price as well as a
read price. For the ideas behind `signalName` and `quantity`, see
[concepts.md](../concepts.md#choosing-a-signal-name-and-quantity).

- [Before you start](#before-you-start)
- [A complete example](#a-complete-example)
- [Where each field comes from](#where-each-field-comes-from)
- [Prompt caching](#prompt-caching)
- [Streaming](#streaming)
- [Several models in one agent](#several-models-in-one-agent)
- [If your MarginFront server is down](#if-your-marginfront-server-is-down)
- [Catching errors yourself](#catching-errors-yourself)
- [Reading back what you earned](#reading-back-what-you-earned)

## Before you start

1. A running MarginFront server and its API address including `/v1`, such as
   `https://billing.example.com/v1`.
2. A secret key (`mf_sk_...`) from the dashboard: **Build**, then **API keys**.
3. An Anthropic API key.
4. The SDK built from this repository and installed into your app. See
   [packages.md](../packages.md):

   ```bash
   npm install /path/to/marginfront/packages/sdk
   npm install @anthropic-ai/sdk express
   ```

5. These settings in your app's environment:

   ```bash
   export MARGINFRONT_API_URL="https://billing.example.com/v1"
   export MF_API_SECRET_KEY="mf_sk_your_secret_key"
   export ANTHROPIC_API_KEY="your-anthropic-key"
   ```

You don't need to create the customer, agent or signal first. The first event
with a new `customerExternalId`, `agentCode` or `signalName` creates it. You
can rename them in the dashboard later.

## A complete example

An Express route that takes a customer's question, asks Claude, sends the
answer back, then records the usage.

```typescript
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { MarginFrontClient } from "@marginfront/sdk";

const app = express();
app.use(express.json());

// Create both clients once, at startup.
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
const mf = new MarginFrontClient(process.env.MF_API_SECRET_KEY!); // reads MARGINFRONT_API_URL

app.post("/research", async (req, res) => {
  const { customerId, question } = req.body;

  // 1. Call Claude.
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: question }],
  });

  // 2. Answer the customer first.
  const first = response.content[0];
  res.json({ answer: first.type === "text" ? first.text : "" });

  // 3. Record the usage. The customer isn't waiting for this.
  await mf.usage.record({
    customerExternalId: customerId, // your own ID for this customer
    agentCode: "research-bot", // which product did the work
    signalName: "analyses", // what the customer pays for
    model: response.model, // the model Anthropic actually used
    modelProvider: "anthropic",
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });
});

app.listen(3000);
```

To pass the address in code instead of the environment:

```typescript
const mf = new MarginFrontClient(process.env.MF_API_SECRET_KEY!, {
  baseUrl: "https://billing.example.com/v1",
});
```

## Where each field comes from

| MarginFront field  | Where it comes from                          | Example               |
| ------------------ | -------------------------------------------- | --------------------- |
| `model`            | `response.model`                             | `"claude-sonnet-4-6"` |
| `inputTokens`      | `response.usage.input_tokens`                | `1024`                |
| `outputTokens`     | `response.usage.output_tokens`               | `512`                 |
| `cacheReadTokens`  | `response.usage.cache_read_input_tokens`     | `15626`               |
| `cacheWriteTokens` | `response.usage.cache_creation_input_tokens` | `23488`               |

`customerExternalId`, `agentCode`, `signalName` and `modelProvider` come from
your own code.

The one thing that trips people up is the token field names:

| Provider  | Input tokens          | Output tokens             |
| --------- | --------------------- | ------------------------- |
| OpenAI    | `usage.prompt_tokens` | `usage.completion_tokens` |
| Anthropic | `usage.input_tokens`  | `usage.output_tokens`     |

MarginFront always takes `inputTokens` and `outputTokens`.

The catalog matches `model` without regard to case and drops a trailing
eight-digit date, so `claude-haiku-4-5-20251001` is priced from its own row,
and a dated name with no row of its own is priced from the undated one.

## Prompt caching

If you use Claude's prompt cache, pass both cache counts. The API prices
fresh input, cache reads and cache writes at their own rates and adds them up.
Leave the fields out and cache adds nothing to the cost.

```typescript
await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "research-bot",
  signalName: "analyses",
  model: response.model,
  modelProvider: "anthropic",
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
  cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  metadata: { cacheWriteTtl: "5m" }, // only if your cache entries live 5 minutes
});
```

**Cache writes and their lifetime.** Anthropic charges more to write a cache
entry that lives an hour than one that lives five minutes. The catalog's
Anthropic rows hold the one-hour write rate, twice the input rate, so an event
that doesn't say which it used is never priced low. If your cache entries live
five minutes, add `metadata: { cacheWriteTtl: "5m" }` and the write is priced
at 1.25 times the input rate instead. Only the exact value `"5m"` changes the
price, and only for `modelProvider: "anthropic"`. The code is
`applyCacheWriteTtl` in `packages/db/src/lib/model-pricing.ts`.

If the model's price row has no rate for the cache tokens you send, the event
is stored with no cost and listed under **Needs attention**, rather than
pricing the cache at $0.

## Streaming

The Anthropic SDK's stream gives you the finished message, usage included,
once it ends:

```typescript
const stream = anthropic.messages.stream({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: question }],
});

stream.on("text", (text) => {
  // send `text` to the customer here
});

const finalMessage = await stream.finalMessage();

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "research-bot",
  signalName: "analyses",
  model: finalMessage.model,
  modelProvider: "anthropic",
  inputTokens: finalMessage.usage.input_tokens,
  outputTokens: finalMessage.usage.output_tokens,
});
```

If you record an event without token counts, it's stored with no cost and
flagged `MISSING_VOLUME_DATA` (see
[concepts.md](../concepts.md#events-that-need-attention)).

## Several models in one agent

If your agent picks a model per task, pass the one that ran. Each model is
priced from its own catalog row, so a Haiku call costs less than a Sonnet call
on your dashboard:

```typescript
const response = await anthropic.messages.create({
  model: needsDeepAnalysis ? "claude-sonnet-4-6" : "claude-haiku-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: question }],
});

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "research-bot",
  signalName: "analyses",
  model: response.model,
  modelProvider: "anthropic",
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

## If your MarginFront server is down

By default the SDK runs with `fireAndForget: true`, so `usage.record()` never
throws into your code:

- **Server unreachable or timing out:** the event goes into an in-memory retry
  buffer and is retried in the background, up to 5 attempts.
- **Validation error:** a warning is logged and the event is dropped. Retrying
  bad data can't help.
- **Key refused (401 or 403):** a warning names the key and the event is
  dropped.
- **Your process stops:** anything still in the buffer is lost, because it
  lives in memory.

Your customer gets their answer either way. The buffer's limits are in
[packages/sdk](../../packages/sdk/README.md#retry-buffer).

## Catching errors yourself

Turn off `fireAndForget` and errors throw normally, with no retry buffer:

```typescript
const mf = new MarginFrontClient(process.env.MF_API_SECRET_KEY!, {
  fireAndForget: false,
});

try {
  await mf.usage.record({
    customerExternalId: customerId,
    agentCode: "research-bot",
    signalName: "analyses",
    model: response.model,
    modelProvider: "anthropic",
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });
} catch (error) {
  // Log it. Don't let it break the request.
  console.error("Recording usage failed:", error);
}
```

## Reading back what you earned

Revenue, cost and MRR come from the same data through the SDK, the API and
MCP. The analytics calls take the API's customer ID (a UUID), not your
external ID. Find it with `client.customers.list()` or on the customer's page.

**SDK:**

```typescript
const customerId = "00000000-0000-4000-8000-000000000001";

const revenue = await mf.analytics.revenue({
  startDate: "2026-10-01",
  endDate: "2026-10-31T23:59:59.999Z",
  customerId,
});

const cost = await mf.analytics.costBreakdown({
  startDate: "2026-10-01",
  endDate: "2026-10-31T23:59:59.999Z",
  customerId,
});

const mrr = await mf.analytics.mrr({ customerId });
```

**REST:**

```bash
curl "https://billing.example.com/v1/analytics/revenue?customerId=00000000-0000-4000-8000-000000000001&startDate=2026-10-01&endDate=2026-10-31T23:59:59.999Z" \
  -H "x-api-key: $MF_API_SECRET_KEY"

curl "https://billing.example.com/v1/analytics/cost?customerId=00000000-0000-4000-8000-000000000001&startDate=2026-10-01&endDate=2026-10-31T23:59:59.999Z" \
  -H "x-api-key: $MF_API_SECRET_KEY"

curl "https://billing.example.com/v1/analytics/mrr?customerId=00000000-0000-4000-8000-000000000001" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

In Windows PowerShell, call `curl.exe` instead of `curl`, put a backtick
instead of a backslash at the end of each continued line, and read the key as
`$env:MF_API_SECRET_KEY`.

**MCP:** ask your assistant, and it calls `get_customer_revenue`,
`get_cost_metrics` or `get_mrr` with the same `customerId`.

What each number means is in
[concepts.md](../concepts.md#the-four-revenue-labels).
