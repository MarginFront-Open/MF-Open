# Recipe: OpenAI

This recipe adds usage tracking to a Node.js app that calls OpenAI. When it's
done, every OpenAI call your app makes for a customer shows up in your
MarginFront dashboard with its model, tokens and cost. If the customer has a
subscription, the same events feed their invoice.

The [Anthropic recipe](anthropic.md) is the same pattern with different field
names. For the ideas behind `signalName` and `quantity`, see
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
3. An OpenAI API key.
4. The SDK built from this repository and installed into your app. See
   [packages.md](../packages.md):

   ```bash
   npm install /path/to/marginfront/packages/sdk
   npm install openai express
   ```

5. These settings in your app's environment:

   ```bash
   export MARGINFRONT_API_URL="https://billing.example.com/v1"
   export MF_API_SECRET_KEY="mf_sk_your_secret_key"
   export OPENAI_API_KEY="sk-your-openai-key"
   ```

You don't need to create the customer, agent or signal first. The first event
with a new `customerExternalId`, `agentCode` or `signalName` creates it. You
can rename them in the dashboard later.

## A complete example

An Express route that takes a customer's question, asks OpenAI, sends the
answer back, then records the usage.

```typescript
import express from "express";
import OpenAI from "openai";
import { MarginFrontClient } from "@marginfront/sdk";

const app = express();
app.use(express.json());

// Create both clients once, at startup.
const openai = new OpenAI(); // reads OPENAI_API_KEY
const mf = new MarginFrontClient(process.env.MF_API_SECRET_KEY!); // reads MARGINFRONT_API_URL

app.post("/chat", async (req, res) => {
  const { customerId, message } = req.body;

  // 1. Call OpenAI.
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: message }],
  });

  // 2. Answer the customer first.
  res.json({ answer: response.choices[0].message.content });

  // 3. Record the usage. The customer isn't waiting for this.
  await mf.usage.record({
    customerExternalId: customerId, // your own ID for this customer
    agentCode: "cs-bot", // which product did the work
    signalName: "messages", // what the customer pays for
    model: response.model, // the model OpenAI actually used
    modelProvider: "openai",
    inputTokens: response.usage!.prompt_tokens,
    outputTokens: response.usage!.completion_tokens,
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

| MarginFront field | Where it comes from                                   | Example    |
| ----------------- | ----------------------------------------------------- | ---------- |
| `model`           | `response.model`                                      | `"gpt-4o"` |
| `inputTokens`     | `response.usage.prompt_tokens`                        | `523`      |
| `outputTokens`    | `response.usage.completion_tokens`                    | `117`      |
| `cacheReadTokens` | `response.usage.prompt_tokens_details.cached_tokens`  | `256`      |

`customerExternalId`, `agentCode`, `signalName` and `modelProvider` come from
your own code.

The catalog matches `model` without regard to case and drops a trailing date,
so `gpt-4o-2024-08-06` is priced as `gpt-4o` when the dated name has no row of
its own.

## Prompt caching

If your calls use OpenAI's prompt cache, pass the cached count as
`cacheReadTokens` so those tokens are priced at the cheaper cache-read rate.

OpenAI's `prompt_tokens` already includes the cached tokens, and the API
prices `inputTokens` and `cacheReadTokens` separately and adds them up. So
take the cached tokens out of `inputTokens`, or they're billed twice:

```typescript
const cached = response.usage!.prompt_tokens_details?.cached_tokens ?? 0;

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "cs-bot",
  signalName: "messages",
  model: response.model,
  modelProvider: "openai",
  inputTokens: response.usage!.prompt_tokens - cached,
  cacheReadTokens: cached,
  outputTokens: response.usage!.completion_tokens,
});
```

The Code Cost Clarity meter does the same subtraction for Codex
(`packages/code-cost-clarity/src/forwarder.ts`).

If the model's price row has no cache-read rate and you send
`cacheReadTokens` above zero, the event is stored with no cost and listed
under **Needs attention**, rather than pricing the cache at $0.

## Streaming

With `stream: true`, ask OpenAI to send usage in the last chunk, then record
the event once the stream ends:

```typescript
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: message }],
  stream: true,
  stream_options: { include_usage: true },
});

let usage: OpenAI.CompletionUsage | undefined;
let model = "gpt-4o";

for await (const chunk of stream) {
  const text = chunk.choices[0]?.delta?.content ?? "";
  // send `text` to the customer here
  if (chunk.usage) usage = chunk.usage;
  if (chunk.model) model = chunk.model;
}

if (usage) {
  await mf.usage.record({
    customerExternalId: customerId,
    agentCode: "cs-bot",
    signalName: "messages",
    model,
    modelProvider: "openai",
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
  });
}
```

If you record an event without token counts, it's stored with no cost and
flagged `MISSING_VOLUME_DATA` (see
[concepts.md](../concepts.md#events-that-need-attention)).

## Several models in one agent

If your agent picks a model per task, pass the one that ran. Each model is
priced from its own catalog row:

```typescript
const response = await openai.chat.completions.create({
  model: isSimpleQuestion ? "gpt-4o-mini" : "gpt-4o",
  messages: [{ role: "user", content: message }],
});

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "cs-bot",
  signalName: "messages",
  model: response.model,
  modelProvider: "openai",
  inputTokens: response.usage!.prompt_tokens,
  outputTokens: response.usage!.completion_tokens,
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
    agentCode: "cs-bot",
    signalName: "messages",
    model: response.model,
    modelProvider: "openai",
    inputTokens: response.usage!.prompt_tokens,
    outputTokens: response.usage!.completion_tokens,
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

**MCP:** ask your assistant, and it calls `get_customer_revenue`,
`get_cost_metrics` or `get_mrr` with the same `customerId`.

What each number means is in
[concepts.md](../concepts.md#the-four-revenue-labels).
