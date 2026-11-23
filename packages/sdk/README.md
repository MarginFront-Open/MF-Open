# @marginfront/sdk

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Node.js SDK for MarginFront: usage-based billing, invoicing, and analytics for AI agents.

This package is built from the MarginFront source and talks only to the MarginFront
server you run. It has no built-in server address and is not installed from a package
registry.

## Installation

You need a running MarginFront server of your own, a secret key from its dashboard
(**Build -> API keys**), and a checkout of the MarginFront source.

1. Build the SDK. From the root of the checkout:

   ```bash
   npm ci
   npx turbo run build --filter=@marginfront/sdk
   ```

   (`npx turbo` runs the build tool already installed in the checkout. It downloads
   nothing.)

2. Install the built package into your app from its folder:

   ```bash
   npm install /path/to/marginfront/packages/sdk
   ```

3. Tell it where your server is. Either pass `baseUrl` in code (below), or set
   `MARGINFRONT_API_URL` in your app's environment:

   ```bash
   export MARGINFRONT_API_URL="https://billing.example.com/v1"
   ```

### The server address

There is no default. Constructing a client with no address throws an
`InitializationError` that says what to set.

- The address is your server's API address including `/v1`, for example
  `https://billing.example.com/v1`, or `http://localhost:4000/v1` for a server on
  this machine.
- `baseUrl` in code wins. When it is left out, `MARGINFRONT_API_URL` is used.
- It must be `https://`, or `http://` to this machine only (`localhost`, `127.0.0.1`
  or `[::1]`).
- Plain `http://` to another machine is refused, because your key would travel
  unencrypted. If your server is on a private network you trust, pass
  `allowInsecureHttp: true` or set `MARGINFRONT_ALLOW_INSECURE_HTTP=1`. It is off by
  default.
- An address carrying a username, password, `?query` or `#fragment` is refused.
- Every request is checked against that one server before it is sent, and a redirect
  from the server is refused, so your key cannot follow one to another address. This
  holds in Node and in edge runtimes that use `fetch` (Cloudflare Workers, Vercel
  Edge). (In a browser the redirect rule cannot be enforced, because browsers follow
  redirects on their own. Use a publishable key there.)
- Proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`) are ignored. The SDK
  connects straight to the server you named, because routing through a proxy from
  those variables would send your key to the proxy unencrypted. Proxies are not
  supported.
- A path in front of `/v1` is kept: `https://example.com/billing/v1` works.

## Quick Start

> **You don't need to set anything up first.** When you fire an event with a new `customerExternalId`, `agentCode`, or `signalName`, MarginFront creates the customer, agent, or signal automatically. Your existing user IDs from your own database flow straight through. The dashboard updates the moment the event lands.
>
> **You invent these three IDs.** `test_user_001`, `report_writer`, and `report_generated` below are made up for this example. There's nothing to look up and nothing to create first: send whatever strings you like, and reuse the same ones for the same customer, agent, and signal.

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: "mf_sk_your_secret_key",
  baseUrl: "https://billing.example.com/v1", // your own MarginFront server
});

// signalName is the unit on your customer's invoice. name it after
// what they pay for (pages, reports, messages), NOT after the model.
// See "Picking signalName and quantity" below for the full rule.
await client.usage.record({
  customerExternalId: "test_user_001", // your own ID for this user. in real code, the one your database already uses
  agentCode: "report_writer", // a stable name for this agent
  signalName: "report_generated", // what the customer is paying for
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});
```

## Picking `signalName` and `quantity`

The most important decision you'll make before writing integration code: **what unit do you want your customer to see on their invoice?** That answer becomes your `signalName`.

Four rules cover it:

1. **Fire one event per business outcome**. a finished report, a completed call, a sent email. Not one per page, not one per minute, not one per token. The `quantity` field exists so you don't have to loop.
2. **The signal name IS the billing unit.** Bill per page → name it `pages`. Bill per report → name it `reports`. Bill per minute → name it `minutes`.
3. **`quantity` is the count of that billing unit for this one event.** A 50-page report fired as `pages` has `quantity: 50`. The same report fired as `reports` has `quantity: 1`. Same LLM call, same token cost, different invoice line.
4. **Cost and revenue are decoupled.** MarginFront calculates cost automatically from `model` + `modelProvider` + token counts. Revenue is `quantity × your pricing-plan rate`. The gap is your margin.

Same Claude call (a 50-page market research report), three different billing configurations:

| `signalName`        | `quantity` | Rate           | Invoice line         |
| ------------------- | ---------- | -------------- | -------------------- |
| `reports_generated` | 1          | $50 per report | "1 report × $50"     |
| `report_pages`      | 50         | $2 per page    | "50 pages × $2"      |
| `tokens_used`       | 15000      | $0.01 per 1K   | "15K tokens × $0.01" |

Bad signal names (internal details the customer shouldn't see): `llm_call`, `gpt-4o-call`, `api-requests`. Good signal names (what the customer is actually paying for): `messages`, `reports-generated`, `pages`, `minutes`, `sms-sent`.

## Documentation

- [Configuration Options](#configuration)
- [Usage Tracking](#usage-tracking)
- [Customer Management](#customer-management)
- [Error Handling](#error-handling)
- [Retry Buffer](#retry-buffer)
- [Required Fields Reference](#required-fields-reference)
- [Event states and how to fix them](#event-states-and-how-to-fix-them)
- [What happens when the model isn't recognized](#what-happens-when-the-model-isnt-recognized)
- [Before you ship](#before-you-ship)
- [Advanced Features](#advanced-features)

## Configuration

```typescript
const client = new MarginFrontClient("mf_sk_your_secret_key", {
  baseUrl: "https://billing.example.com/v1", // required here or in MARGINFRONT_API_URL
  timeout: 5000, // 5 seconds (default)
  retries: 3, // retry failed requests up to 3 times (default)
  retryDelay: 300, // milliseconds between retries
  fireAndForget: true, // (default) usage.record() never throws. network errors retry, auth errors drop with a warning
  logging: {
    enabled: true,
    level: "info",
  },
  telemetry: {
    enabled: true,
    sampleRate: 1,
  },
});

await client.connect();
```

## Usage Tracking

Every event you track needs `model` and `modelProvider` (or a `services[]` array for multi-service events) so MarginFront knows what service was used and can calculate costs automatically.

### LLM event (OpenAI, Anthropic, etc.)

When your agent calls a language model, pass the token counts and MarginFront handles the cost math. Note that `signalName` is the billing unit, not the model name:

```typescript
await client.usage.record({
  customerExternalId: "cust_123",
  agentCode: "cs-bot",
  signalName: "support-reply",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});
```

### Non-LLM event (Twilio, AWS, etc.)

For services that aren't LLMs, use `quantity` instead of token counts:

```typescript
await client.usage.record({
  customerExternalId: "cust_123",
  agentCode: "notification-agent",
  signalName: "sms_sent",
  model: "twilio-sms",
  modelProvider: "twilio",
  quantity: 3,
});
```

### Multi-service event (one outcome, multiple services)

Real agents often use several services for one outcome. A research agent runs a web search, fetches the top pages, writes the report with Claude Opus, and emails it. From your customer's perspective that's ONE report. From your cost perspective four services contributed.

Track it as ONE event with a `services[]` array. Each entry becomes a per-service cost line under one parent event. The dashboard shows one event with the rolled-up total; the customer's invoice still bills per signal (one report = one charge, regardless of how many services contributed):

```typescript
await client.usage.record({
  customerExternalId: "cust_123",
  agentCode: "research-agent",
  signalName: "reports-generated",
  // Top-level quantity stays signal-level: ONE report
  quantity: 1,
  services: [
    { model: "web-search", modelProvider: "search-api", quantity: 1 },
    { model: "page-fetch", modelProvider: "scraper-api", quantity: 5 },
    {
      // LLM entries can carry tokens AND quantity together
      model: "claude-opus-4-1",
      modelProvider: "anthropic",
      inputTokens: 4500,
      outputTokens: 1200,
      quantity: 1,
    },
    { model: "transactional-email", modelProvider: "email-api", quantity: 1 },
  ],
});
```

Send `model` + `modelProvider` (single-service shape) OR send `services[]` (multi-service shape), never both, never neither. The SDK rejects mixed-shape requests before the network call leaves your code.

### Prompt-cache tokens

If you use prompt caching, send the cache counts in their own fields so cached
tokens are priced at the model's cache rates instead of the full input rate. Both
fields are optional whole numbers, on a single-service event or on each entry in
`services[]`.

The cost is added up term by term: `inputTokens` at the input rate,
`cacheReadTokens` at the cache-read rate, `cacheWriteTokens` at the cache-write
rate, and `outputTokens` at the output rate. So `inputTokens` must be the fresh
input only. Anthropic already reports it that way. OpenAI counts cached tokens
inside `prompt_tokens`, so take them out first, or they're billed twice.

| MarginFront field  | Anthropic response field      | OpenAI Chat Completions response field                         |
| ------------------ | ----------------------------- | -------------------------------------------------------------- |
| `inputTokens`      | `input_tokens`                | `prompt_tokens` minus `prompt_tokens_details.cached_tokens`    |
| `cacheReadTokens`  | `cache_read_input_tokens`     | `prompt_tokens_details.cached_tokens`                          |
| `cacheWriteTokens` | `cache_creation_input_tokens` | leave it out                                                   |
| `outputTokens`     | `output_tokens`               | `completion_tokens`                                            |

```typescript
const message = await anthropic.messages.create({ /* ... */ });

await client.usage.record({
  customerExternalId: "cust_123",
  agentCode: "cs-bot",
  signalName: "support-reply",
  model: message.model,
  modelProvider: "anthropic",
  inputTokens: message.usage.input_tokens,
  outputTokens: message.usage.output_tokens,
  cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
});
```

Anthropic bills cache writes at two rates: 1.25x input for the 5-minute cache and
2x input for the 1-hour cache. For Anthropic models the price catalog stores the
1-hour rate, so a cache write is never priced low. If your calls use the 5-minute cache, add
`metadata: { cacheWriteTtl: "5m" }` to the event and its cache writes are priced at
1.25x input. Any other value, or none, keeps the 1-hour rate.

A cache count above zero needs a matching cache rate on the model's price row. If
the row has none, the event is stored with no cost as `NEEDS_COST_BACKFILL` rather
than pricing the cache at $0. A count of zero never triggers this. See
[Event states and how to fix them](#event-states-and-how-to-fix-them).

### Batch tracking

Send multiple events at once. You can mix single-service LLM, single-service non-LLM, and multi-service events in the same batch:

```typescript
await client.usage.recordBatch([
  {
    customerExternalId: "cust_123",
    agentCode: "research-agent",
    signalName: "reports-generated",
    model: "claude-sonnet-4-20250514",
    modelProvider: "anthropic",
    inputTokens: 1024,
    outputTokens: 256,
  },
  {
    customerExternalId: "cust_456",
    agentCode: "notification-agent",
    signalName: "sms_sent",
    model: "twilio-sms",
    modelProvider: "twilio",
    quantity: 5,
  },
  {
    // Multi-service entry mixed into the same batch
    customerExternalId: "cust_123",
    agentCode: "research-agent",
    signalName: "reports-generated",
    quantity: 1,
    services: [
      { model: "web-search", modelProvider: "search-api", quantity: 1 },
      {
        model: "claude-opus-4-1",
        modelProvider: "anthropic",
        inputTokens: 4500,
        outputTokens: 1200,
        quantity: 1,
      },
    ],
  },
]);
```

### Knowing what an event auto-provisioned (`created` flags)

The first event for a new `customerExternalId`, `agentCode`, or `signalName` creates that customer, agent, or signal automatically. The response tells you when that happened:

```typescript
const result = await client.usage.record({
  customerExternalId: "cust_789", // first event for this customer
  agentCode: "cs-bot",
  signalName: "support-reply",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});

result.results.success[0].created;
// { customer: true, agent: false, signal: true }
```

Three things to know before branching on these flags:

- **`created` appears on stored failures too.** Entities are provisioned before pricing resolves, so an event stored as `NEEDS_COST_BACKFILL` (unknown model) still created its customer/agent/signal, and the failed row says so.
- **`undefined` isn't `false`.** An idempotent replay (a retry that collapsed into an already-recorded event via `idempotencyKey`) returns **no `created` field at all**. The replay says nothing about provisioning. A transport failure also leaves it absent. `{ customer: false, ... }` is a positive statement ("everything already existed"); `undefined` means "no information". Check `if (created?.customer)` and you're safe; check `if (created.customer === false)` only when you know `created` is present.
- **Resurrection reports `false`.** Re-ingesting a customer, agent, or signal that was deleted in the dashboard revives the original record (same ID, billing history intact) instead of creating a duplicate or failing. Because the row pre-existed, the flag is `false`, not `true`. (Subscriptions deleted along with a customer stay deleted; recreate the subscription in the dashboard if you want billing to resume.)

### Tagging events for COGS / R&D classification

If your team needs to classify AI spend as Cost of Goods Sold (production usage that serves customers) vs Research & Development (internal experiments, staging, test runs), tag every event with an `environment`:

```typescript
await client.usage.record({
  customerExternalId: "cust_123",
  agentCode: "cs-bot",
  signalName: "support-reply",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
  environment: "production", // "production" | "staging" | "development" | "testing"
});
```

The first time a signal sees an event with `environment`, MarginFront auto-classifies the signal's `costCategory`:

| `environment` you send | Signal's `costCategory` becomes                                          |
| ---------------------- | ------------------------------------------------------------------------ |
| `production`           | `PRODUCTION_COGS`                                                        |
| `development`          | `DEVELOPMENT_RD`                                                         |
| `testing`              | `DEVELOPMENT_RD`                                                         |
| `staging`              | `UNCLASSIFIED` (intentionally ambiguous: set it manually in the dashboard) |

Auto-classification only fires while the signal is still `UNCLASSIFIED`. Once you set a classification in the dashboard, manual overrides win: incoming `environment` values are recorded on each event but no longer alter the parent signal.

`environment` is optional. Omit it and your events flow through unchanged; the signal's classification stays whatever it was set to manually (default `UNCLASSIFIED`). See your dashboard's Cost Management page.

### Customer Management

```typescript
// Create a customer
const customer = await client.customers.create({
  name: "Acme Corp",
  email: "billing@acmecorp.example",
  externalId: "acme-123",
});

// List customers
const customers = await client.customers.list({
  limit: 10,
  page: 1,
});

// Get, update and delete customers
const customer = await client.customers.get("customer_id");
await client.customers.update("customer_id", { name: "Updated Name" });
await client.customers.delete("customer_id");
```

### Invoices

```typescript
// List invoices with filters
const { invoices, totalResults } = await client.invoices.list({
  customerId: "cust_123",
  status: "pending",
  page: 1,
  limit: 20,
});

// Get a specific invoice
const invoice = await client.invoices.get("inv_abc");
console.log(`Invoice ${invoice.invoiceNumber}: $${invoice.totalAmount}`);

// Generate a draft invoice from a subscription's accumulated usage events.
// Line items come from real signal_events in the billing period plus any
// recurring/seat/onetime strategies on the plan. Defaults to the
// subscription's current billing period, the right answer for one-click
// "bill now" flows. Pass overrides to re-bill a past period.
const draft = await client.invoices.generate({
  customerId: "cust_123",
  subscriptionId: "sub_abc",
  // billingPeriodStart: "2026-05-01T00:00:00Z",
  // billingPeriodEnd:   "2026-06-01T00:00:00Z",
});
console.log(`$${draft.subtotal} in ${draft.invoice_line_items.length} lines`);

// Email the invoice to the customer with a Stripe Checkout pay button.
// If the invoice is still a draft, send() auto-finalizes it to "issued"
// as a side effect. Customer's stored email is used by default.
const sendResult = await client.invoices.send(draft.id);
console.log(
  `Sent to ${sendResult.recipientEmail} (resend id: ${sendResult.emailId})`,
);

// Override the recipient + subject + add a custom note
await client.invoices.send("inv_abc", {
  recipientEmail: "billing@customer.example",
  subject: "May usage invoice. Auto-charge in 5 days.",
  message: "Card on file will be charged automatically.",
});
```

### Analytics

```typescript
const analytics = await client.analytics.usage({
  startDate: "2024-01-01",
  endDate: "2024-01-31",
  groupBy: "daily",
  customerId: "cust_123",
  subscriptionId: "sub_abc", // optional filter
});

console.log(`Total usage: ${analytics.summary.totalQuantity}`);
console.log(`Total cost: $${analytics.summary.totalCost}`);

// Time series data
analytics.data.forEach((point) => {
  console.log(`${point.date}: ${point.quantity} units, $${point.cost}`);
});
```

### Revenue & Cost Analytics (canonical)

Nine methods return the canonical shapes the dashboard uses internally. Every
dollar amount is a plain `number` (not string), and `marginPercent` is `null`
when revenue is zero (never `0%`, never `NaN`).

#### Which method answers which question

| Question                                                         | Method                    |
| ---------------------------------------------------------------- | ------------------------- |
| How many units did we record, and what did they cost, over time? | `analytics.usage`         |
| What did we earn in this window, fees included?                  | `analytics.revenue`       |
| Where is the money going, by agent, customer or model?           | `analytics.costBreakdown` |
| What did usage alone earn, leaving out fixed fees?               | `analytics.agentEarned`   |
| What did we bill, collect, and what's still owed?                | `analytics.invoiceTotals` |
| What do active subscriptions commit to per month, today?         | `analytics.mrr`           |
| What would we bill per month at the last 30 days' pace?          | `analytics.runRateMrr`    |
| What's the contractual floor, whatever the usage?                | `analytics.committedMrr`  |

`agentEarned` and `revenue` give different numbers for the same window on purpose:
`revenue` adds recurring, seat and one-time fees on top of what usage earned.

#### Revenue metrics

```typescript
// Canonical revenue. org-wide for the last 30 days
const metrics = await client.analytics.revenue({
  startDate: "2024-01-01",
  endDate: "2024-01-31",
});

console.log(`Revenue:  $${metrics.revenue.toFixed(2)}`);
console.log(`Cost:     $${metrics.cost.toFixed(2)}`);
console.log(`Margin:   $${metrics.margin.toFixed(2)}`);
console.log(`Margin %: ${metrics.marginPercent?.toFixed(1) ?? "-"}%`);

// Revenue decomposes by charge type
console.log(`Usage:     $${metrics.usageRevenue}`);
console.log(`Recurring: $${metrics.recurringRevenue}`);
console.log(`Seat:      $${metrics.seatRevenue}`);
console.log(`Onetime:   $${metrics.onetimeRevenue}`);

// Scoped by customer, agent, signal, or subscription
const perCustomer = await client.analytics.revenue({
  startDate: "2024-01-01",
  endDate: "2024-01-31",
  customerId: "cust_123",
});
```

#### Cost breakdown

```typescript
const cost = await client.analytics.costBreakdown({
  startDate: "2024-01-01",
  endDate: "2024-01-31",
  includePriorWindow: true, // period-over-period trend
});

console.log(`Total cost: $${cost.cost.toFixed(2)}`);
console.log(`Events:     ${cost.eventCount}`);
console.log(`Needs attention (null cost): ${cost.eventCountWithNullCost}`);

// Six breakdown arrays for drill-downs
cost.byAgent.forEach((row) => console.log(`${row.agentId}: $${row.cost}`));
cost.byModel.forEach((row) => console.log(`${row.model}: $${row.cost}`));

// Prior-window trend (when includePriorWindow: true)
if (cost.prior) {
  const delta = cost.cost - cost.prior.cost;
  console.log(`Δ vs prior window: $${delta.toFixed(2)}`);
}
```

#### MRR (three variants)

```typescript
// MRR1. canonical. "What do active subscriptions commit to per month, today?"
const { mrr, arr } = await client.analytics.mrr();
console.log(`MRR: $${mrr}, ARR: $${arr}`); // arr === mrr * 12

// MRR2. run-rate. "What would we bill per month at the 30-day pace?"
const runRate = await client.analytics.runRateMrr();
console.log(`Run-rate MRR: $${runRate.mrr}`);
runRate.breakdown.forEach((row) => {
  console.log(`  ${row.subscriptionId}: total $${row.total}`);
});

// MRR3. committed. "Contractual floor regardless of usage."
const committed = await client.analytics.committedMrr();
console.log(`Committed MRR floor: $${committed.mrr}`);
// Invariant: committed.mrr ≤ runRate.mrr (floor ≤ trajectory)
```

#### Invoice totals (billed, collected, outstanding)

```typescript
const totals = await client.analytics.invoiceTotals({
  startDate: "2024-01-01",
  endDate: "2024-01-31",
});

console.log(`Billed:      $${totals.billed}`);
console.log(`Collected:   $${totals.collected}`);
console.log(`Outstanding: $${totals.outstanding}`); // open receivables right now
console.log(`Draft:       $${totals.draft}`);
if (totals.overdueCount > 0) {
  console.log(`${totals.overdueCount} overdue ($${totals.overdueAmount})`);
}
```

#### Agent-Earned (activity-only revenue)

```typescript
// Events × pricing rate only. excludes recurring / seat / onetime.
// The "did my agent do billable work?" number, independent of invoice cadence.
const earned = await client.analytics.agentEarned({
  startDate: "2024-01-01",
  endDate: "2024-01-31",
  agentId: "agent_abc", // optional scope
});

console.log(`Activity revenue: $${earned.revenue}`);
console.log(`Events:           ${earned.eventCount}`);
```

### Subscriptions

```typescript
// List subscriptions
const { subscriptions } = await client.subscriptions.list({
  status: "active",
  customerId: "cust_123",
});

// Get subscription with usage details
const sub = await client.subscriptions.get("sub_abc");
console.log(`Usage this period: ${sub.usage.totalQuantity}`);

// Get subscription + canonical revenue in one parallel call
const result = await client.subscriptions.getWithRevenue("sub_abc");
console.log(`Plan: ${result.subscription.plan.name}`);
console.log(`Revenue: $${result.revenue.revenue}`);
console.log(`Margin:  ${result.revenue.marginPercent?.toFixed(1) ?? "-"}%`);

// Same, but with an explicit window
const custom = await client.subscriptions.getWithRevenue("sub_abc", {
  startDate: "2024-01-01",
  endDate: "2024-01-31",
});
```

### Customers (with revenue)

```typescript
// Get customer + canonical revenue in one parallel call
const { customer, revenue } = await client.customers.getWithRevenue("cust_123");
console.log(`${customer.name}: $${revenue.revenue} revenue`);
console.log(`Cost: $${revenue.cost}, Margin: $${revenue.margin}`);
```

### Portal Sessions

```typescript
// Create a portal session (requires secret key mf_sk_*)
// The returned `url` and `token` are single-use. Save them if you need them again.
const session = await client.portalSessions.create({
  customerId: "cust_123",
  returnUrl: "https://app.example.com/account",
  features: ["invoices", "subscriptions", "usage", "profile"],
});

// Redirect customer to the portal
res.redirect(session.url);

// List recent portal sessions for a customer.
// Returns a flat ListedPortalSession[] array (not enveloped).
// Items omit `url` and `token` for security; only create() surfaces those.
const sessions = await client.portalSessions.list({
  customerId: "cust_123",
  includeExpired: false,
});
sessions.forEach((s) => console.log(s.id, s.isUsed, s.expiresAt));

// Look up an existing session by ID. Same shape as the list items (no url, no token).
const meta = await client.portalSessions.get("ps_abc");
console.log(meta.customerId, meta.isExpired, meta.usedAt);

// Revoke a session immediately. Use when you sent the link to the wrong email.
await client.portalSessions.revoke("ps_abc");
```

## Error Handling

### Default behavior: fireAndForget (recommended)

By default, `fireAndForget` is `true`. This means `usage.record()` will **never throw an error** into your code. Your agent keeps running no matter what.

- **Network failures** (server down, timeout, etc.) go into the retry buffer and get retried automatically in the background.
- **Validation errors** (missing required fields, bad data) log a warning to the console and drop the event. There's nothing to retry if the data is wrong.
- **Auth failures (401/403)** drop the event immediately with a warning naming the key as the cause. No amount of retrying fixes a revoked key, so the SDK tells you the truth instead of pretending a retry will save it.

```typescript
// This will never crash your app, even if the network is down
await client.usage.record({
  customerExternalId: "cust_123",
  agentCode: "cs-bot",
  signalName: "support-reply",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});
// Execution continues immediately. no try/catch needed
```

### Opt-out: throw errors normally

If you want to handle errors yourself (e.g. in a testing environment), turn off `fireAndForget`:

```typescript
const client = new MarginFrontClient("mf_sk_your_secret_key", {
  fireAndForget: false, // errors throw normally, no retry buffer
});

try {
  await client.usage.record({
    /* ... */
  });
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(`Authentication failed. Request ID: ${error.requestId}`);
  } else if (error instanceof RateLimitError) {
    console.error(`Rate limit exceeded. Retry after ${error.retryAfter}s`);
  } else if (error instanceof ValidationError) {
    console.error(`Validation error: ${error.message}`);
  } else if (error instanceof MarginFrontError) {
    console.error(`API Error (${error.statusCode}): ${error.message}`);
  }
}
```

To branch on a dead key without checking two error classes, use `isAuthFailure`. It returns `true` for any 401 or 403:

```typescript
import { isAuthFailure } from "@marginfront/sdk";

try {
  await client.usage.record({
    /* ... */
  });
} catch (error) {
  if (isAuthFailure(error)) {
    // The key is the problem. Retrying can't succeed; rotate the key instead.
  }
}
```

## Retry Buffer

When `fireAndForget` is `true` (the default), failed events go into an in-memory retry buffer instead of throwing. Think of it like an outbox that keeps trying to deliver your events.

- **Capacity:** Holds up to 1,000 events. If the buffer is full, the oldest event is dropped with a warning.
- **Retries:** Each event gets up to 5 attempts before being dropped.
- **Backoff:** Waits 10s, then 20s, then 40s, then 60s between retries (exponential with a ceiling). Resets on success.
- **Dead key:** A 401/403 during a retry doesn't burn an attempt and doesn't escalate the backoff. The buffer waits one more cycle (about 10s) and destroys the held events only if the key is rejected again, so a transient auth blip on the server can't wipe your queue. When delivery resumes, a single warning reports how many events were lost. (Code Cost Clarity behaves differently: it parks its records on disk during an auth hold and never destroys them. The SDK buffer is memory only and has nowhere durable to park.)
- **Overhead:** Zero when empty. No background timer runs unless there are actually events to retry.
- **Caveat:** The buffer lives in memory only. If your process crashes, any buffered events are lost, and a restart also resets the auth-failure count, so a fresh process treats its first 401 as unconfirmed. For most use cases this is fine. the buffer only holds events during brief network blips.

## Required Fields Reference

Every call to `usage.record()` needs these fields. The SDK validates them before sending anything to the server.

| Field                | Type        | Required | Default | Notes                                                                                           |
| -------------------- | ----------- | -------- | ------- | ----------------------------------------------------------------------------------------------- |
| `customerExternalId` | string      | Yes      | --      | Your customer's ID in your system                                                               |
| `agentCode`          | string      | Yes      | --      | The agent/product code from the dashboard                                                       |
| `signalName`         | string      | Yes      | --      | The billing unit, matching your invoice line (e.g. "messages", "reports-generated", "sms-sent") |
| `model`              | string      | Yes      | --      | Model identifier (e.g. "gpt-4o", "twilio-sms")                                                  |
| `modelProvider`      | string      | Yes      | --      | Provider in lowercase (e.g. "openai", "twilio")                                                 |
| `inputTokens`        | number      | No       | --      | Prompt tokens (LLM events)                                                                      |
| `outputTokens`       | number      | No       | --      | Completion tokens (LLM events)                                                                  |
| `cacheReadTokens`    | number      | No       | --      | Prompt-cache read tokens (see [Prompt-cache tokens](#prompt-cache-tokens))                      |
| `cacheWriteTokens`   | number      | No       | --      | Prompt-cache write tokens (see [Prompt-cache tokens](#prompt-cache-tokens))                     |
| `quantity`           | number      | No       | 1       | Billing units (non-LLM events)                                                                  |
| `usageDate`          | string/Date | No       | now     | When the event happened                                                                         |
| `metadata`           | object      | No       | {}      | Custom key-value pairs for your own tracking                                                    |

## Event states and how to fix them

The server stores every well-formed event it receives, even when it can't price it
yet. Each stored event ends in one of three states:

| State                 | Cost              | What it means                                                                                                                                                                       |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROCESSED`           | Calculated        | The model was found and the event had the numbers it needed. Nothing to do.                                                                                                        |
| `MISSING_VOLUME_DATA` | `null` until fixed | The model was found, but the event left out what it's priced by: `inputTokens` and `outputTokens` for a model priced per token, or `quantity` for anything else. An explicit `0` counts as sent. |
| `NEEDS_COST_BACKFILL` | `null` until fixed | Either the `model` and `modelProvider` aren't in the price catalog, or they are but the row has no cache rate for the cache tokens the event reported.                              |

A multi-service event takes the state of its worst service, and the per-service
states are listed in `servicesStatus` on the failed result.

`PROCESSED` events land in `results.success`. The other two land in
`results.failed` with `stored: true`, the state in `code`, and a plain-English
`error` that names the cause:

```typescript
const result = await client.usage.record({ /* ... */ });

for (const failure of result.results.failed) {
  if (failure.stored) {
    // Saved with no cost yet. Fix it on the server; don't send it again.
    console.warn(`${failure.code}: ${failure.error}`);
  }
}
```

Don't send a `stored: true` event again. It's already saved, and a second copy
would be billed twice. An `INTERNAL_ERROR` comes back with `stored: false`: nothing
was saved, and sending it again is safe.

### Fixing `MISSING_VOLUME_DATA`

Fill in the missing numbers under **Needs attention** in the dashboard, or call
`POST /events/fill-volume` with `sourceModel`, `sourceProvider` and either
`inputTokens` and `outputTokens` (models priced per token) or `quantity` (anything
else). The numbers apply to every waiting event for that model and provider, and
each one gets its cost. MCP has the same fix as `get_missing_volume` and
`fill_volume`.

Then fix the code that sent it, so new events carry the numbers.

### Fixing `NEEDS_COST_BACKFILL`

**The model isn't in the catalog.** Map it to a known model under **Needs
attention** with **Map & backfill**, or call `POST /events/map-model` with
`sourceModel`, `sourceProvider`, and either `targetPricingId` or `targetModel` with
`targetProvider`. Every waiting event for that model gets its cost, and future
events with the same name are priced on arrival. The mapping applies to your
organization only. MCP has the same fix as `get_needs_attention` and `map_model`.

If the model has no row to map to, add one first
([prices for your own tools](../../docs/make-it-yours.md#prices-for-your-own-tools)).

**The model is known but has no cache rate.** Give its price row the missing rate:
run `npm run db:sync-pricing` to pull current rates, or add the rate to the row
yourself. Then map the model to that row with **Map & backfill** to price the
waiting events.

Both repair routes need the owner, admin or developer role, on your dashboard
account or on the API key. Check the exact request shapes at `/api-docs` on your
running API.

## What happens when the model isn't recognized

If you send a `model` value that MarginFront hasn't seen before (say, a brand new OpenAI model that launched today):

1. **The event is stored normally** with a `null` cost. It's never dropped and never assigned a zero cost.
2. **The dashboard shows it under "Needs attention"** so you or your team can see it immediately.
3. **You map it to a known model with one click** in the dashboard.
4. **Future events with that same model auto-resolve.** No code changes needed.

Bottom line: you can ship new models without worrying about breaking billing. MarginFront catches up.

## Before you ship

- [ ] The client uses a secret key (`mf_sk_*`). A publishable key (`mf_pk_*`)
      reaches only `verify` and `me/key`. It can't read data or record usage.
- [ ] The client knows your server: `baseUrl` in code, or `MARGINFRONT_API_URL` in
      the app's environment.
- [ ] `customerExternalId` is the ID your own database already uses for that
      customer, sent the same way every time.
- [ ] `agentCode` and `signalName` are fixed strings, and `signalName` is the unit
      on your customer's invoice.
- [ ] `modelProvider` is lowercase, and `model` matches a catalog name. Check with
      `client.services.list({ search: "gpt-4o" })` before your first event.
- [ ] LLM events carry `inputTokens` and `outputTokens` from the provider's
      response, and cache counts go in their own fields
      ([Prompt-cache tokens](#prompt-cache-tokens)).
- [ ] Non-LLM events carry `quantity`.
- [ ] `usage.record()` runs after the work is done: after the model answers, after
      the SMS sends.
- [ ] `fireAndForget` is on (the default), or the call is wrapped in try/catch, so
      billing can never break your product.
- [ ] Nothing sends an event again when it came back with `stored: true`.
- [ ] One test event shows up in the dashboard with a cost, not under **Needs
      attention**.

## Spend Controls

Read and manage your internal **code-spend caps** from code: the same caps you
set on the dashboard's Internal AI Spend page. A cap watches (or hard-stops) how much your team
spends on coding-agent providers (Claude, Codex, Gemini, …) per day / week / month.

Best-effort guardrail, not a hard limit. For a hard ceiling, set a spend limit in
your Anthropic or OpenAI account.

`list`, `spend`, and `coverage` work with every key role, including an ingest-only
key: that's how the on-device brake reads the cap it enforces. `breakdown` needs
**owner, admin, or finance**. Writes (`create` / `update` / `delete`) are
**owner/finance only**, the same gate the dashboard uses. A key without the role
gets the server's own plain-English error, surfaced as-is.

```typescript
// See every cap, each with its plain-English sentence
const caps = await client.spendControls.list();
caps.forEach((c) => console.log(c.sentence));
// "Stop AI spend at $5,000 across the whole team per month"

// How much have we spent against the cap this week?
const week = await client.spendControls.spend("week");
console.log(week.org.spentUsd); // e.g. 42.5, or null if nothing priced yet

// …and one teammate's slice
const alice = await client.spendControls.spend("week", "alice@acme.example");
console.log(alice.dev?.spentUsd);

// How many teammates actually have the cap check running right now?
// Per tool, never blended: Claude Code and Codex arm by different mechanisms,
// and `unknown` is a teammate we could not vouch for, never a covered one.
const { claudeCode, codex } = await client.spendControls.coverage();
for (const [tool, c] of [
  ["Claude Code", claudeCode],
  ["Codex", codex],
] as const) {
  if (!c) continue; // the server didn't report this tool
  console.log(
    `${tool}: ${c.armed} of ${c.total} have the cap check running, ` +
      `${c.unknown} we can't tell about`,
  );
}
```

Grouped by repo or branch, one more read shows where the AI spend actually went:

```typescript
// Internal AI spend for the current period, grouped by git repo or branch.
// Claude Code + Codex events only, never customer billing.
const byBranch = await client.spendControls.breakdown("week", "branch");

byBranch.rows.forEach((r) => {
  // r.spentUsd is null when none of that branch's events are priced yet
  console.log(
    `${r.key}: ${r.spentUsd === null ? "unpriced" : "$" + r.spentUsd}`,
  );
});

// Events recorded with no repo/branch tag land in their own bucket
console.log("untracked:", byBranch.noMetadata.spentUsd);

// coveragePercent says how much of the activity even had a repo/branch to group by
console.log(`${byBranch.coveragePercent ?? 0}% tagged`);
```

**Branch is the honest stand-in for "cost per pull request."** The pipeline records the git repo, branch, and commit on each event, not pull-request numbers, so there's deliberately no `"pr"` dimension. Read a branch's spend as a rough stand-in for that PR's cost, not an exact number: it runs low when work happened before the branch was created, and high when one branch carried several pull requests. `spentUsd` comes back `null` (never a coerced `0`) for any bucket with no priced usage, exactly like `spend()` and the dashboard.

```typescript
// Set an org ceiling (owner/finance only)
const cap = await client.spendControls.create({
  scope: "org", // "org" | "dev"
  providerScope: "all", // "all" or one provider, e.g. "anthropic"
  amountUsd: 5000,
  period: "month", // "day" | "week" | "month"
  mode: "enforce", // "track" (alert only) | "enforce" (hard stop)
});
console.log(cap.sentence);

// A per-teammate cap. scopeValue is the teammate's customerExternalId (email).
await client.spendControls.create({
  scope: "dev",
  scopeValue: "alice@acme.example",
  providerScope: "anthropic",
  amountUsd: 200,
  period: "week",
  mode: "enforce",
});

// Adjust or remove
await client.spendControls.update(cap.id, { amountUsd: 8000 });
const { sentence } = await client.spendControls.delete(cap.id);
console.log(`Removed: ${sentence}`);
```

**Honest numbers.** `spentUsd` is `null` (not `0`) when there's no priced usage
yet, and `coverage().asOf` is `null` when there's been no recent activity. The SDK
never fakes a value. A team cap or a single-provider cap has no spend number in the
read-back, exactly as the dashboard shows it.

**The ceiling rule.** A team or dev cap can never exceed the org ceiling for the
same provider. If you try, `create`/`update` throws with the server's plain message.

## Credit pools

A credit pool is "$99 a cycle buys 5,000 credits, and anything past that costs
3 cents each." The fee bills every cycle, even if the customer never touches the
pool. Nothing stops when the pool empties. The overage keeps billing.

### One call sets up a pool

```typescript
const pool = await client.pricingStrategies.createCreditPool("plan_uuid", {
  name: "Content Pool",
  agentId: "agent_uuid",
  signalId: "signal_report_uuid",
  poolSize: 5000,
  poolPrice: 99,
  overageRate: 0.03,
});
```

A pool is really a two-tier strategy whose FIRST tier rate is a flat fee for
the whole pool while the second is per unit. That asymmetry is easy to get
backwards, so send the three numbers and let the server compile the tiers.

### Per-metric burn rates

Out of the box, only the pool's own metric draws from it, one credit per unit.
`creditRates` opens the pool to other metrics and says how expensive each one
is:

```typescript
await client.pricingStrategies.update("plan_uuid", "strategy_uuid", {
  creditRates: {
    signal_report_uuid: 4, // one report burns 4 credits
    signal_video_uuid: 10, // one video burns 10
    signal_note_uuid: 0.5, // two notes burn 1
  },
});
```

The server enforces the rules, with a plain-English rejection when a write
breaks one:

- **Every rate has to be above zero.** To make a metric free, leave it out of
  the map. A zero is rejected rather than honored, because it reads as a field
  someone forgot to fill in.
- **Every key has to be a live signal in your organization.** A typo'd id would
  sit in the map forever, silently matching nothing.
- **A metric can't burn pool credits and carry its own usage strategy on the
  same plan.** It would draw the pool down and bill per unit, so the customer
  would pay twice for one unit of work.
- **The pool's own metric is a member whether or not you name it,** at rate 1.
  Name it only to change that.
- **Rates belong on a `credit_pool` strategy and nowhere else.** Send `{}` to
  clear them; omit the field to leave the stored rates alone.

### One countdown, not one per metric

Members draw from a single balance, so the customer watches one number:

```typescript
const balance = await client.creditBalances.get("sub_abc");
console.log(
  `${balance.remainingUnits} of ${balance.poolSizeUnits} credits left`,
);
```

Two reports and three notes at the rates above burn 9.5 credits, not "2 of one
thing and 3 of another." Overage reads the same way: credits past the pool
size, priced at the overage rate. The balance fields keep their `...Units`
names so single-metric pools stay wire-compatible. Once rates are on, read
"unit" as "credit."

### Want a hard cap per metric? Sell two plans

A pool is one balance. There's no per-metric ceiling inside it, so "100 reports
AND 50 videos, each capped separately" isn't a rate question at all. Sell that
as two plans, each with its own pool and its own cap, and the two balances stay
independent. Burn rates express relative cost, not separate allowances.

### Careful: don't price the same unit twice

Don't send the credit cost AS the quantity (a report that "costs" 4 credits
sent as `quantity: 4`) on a pool that has rates. The two compose badly: with a
rate of 4 and events that arrive pre-multiplied, every report burns 16
credits.

Pick one or the other. If you're moving off pre-multiplied quantities, set the rates and
reset those events to real units (one report is `quantity: 1`) in the same
change. Events already recorded keep the quantity they were recorded with, so
make the switch at a period boundary unless you want a mixed period on the
bill.

## Advanced Features

### Request Retries

```typescript
const client = new MarginFrontClient("mf_sk_your_secret_key", {
  retries: 3,
  retryDelay: 300,
});
```

### Logging & Telemetry

The SDK includes a telemetry system that tracks API request performance and usage patterns:

```typescript
const client = new MarginFrontClient("mf_sk_your_secret_key", {
  logging: {
    enabled: true,
    level: "debug",
    handler: (level, message, data) => {
      myLoggingSystem.log(level, message, data);
    },
  },
  telemetry: {
    enabled: true,
    sampleRate: 0.5, // Track 50% of requests
    handler: (metrics) => {
      myMonitoringSystem.trackApiRequest(metrics);
    },
  },
});
```

You can access telemetry statistics programmatically:

```typescript
// Get current statistics
const stats = client.getTelemetryStats();
console.log(`Total Requests: ${stats.requestCount}`);
console.log(`Success Rate: ${(stats.successRate * 100).toFixed(2)}%`);
```

## Updating

Nothing checks for updates. To update, pull the MarginFront repository, build the
package again, and reinstall it into your app.

`checkForUpdate()` is still exported so existing code keeps compiling. It makes no
network call and always resolves to `{ latest: null, updateAvailable: false }`.

## CLI (Testing Tool)

The SDK ships with a lightweight CLI (`mf`) for testing your integration without writing code.

> **Note:** The CLI is a testing tool only. It has no effect on the SDK when used as a library in your application.

### Run it

After building the package, run the CLI with node from the root of the checkout:

```bash
node packages/sdk/dist/cli/index.js verify --base-url http://localhost:4000/v1
node packages/sdk/dist/cli/index.js track-event --customer-id customer-1 --agent-code my-agent --signal CALL_MINUTES --quantity 10
```

To get the short `mf` command instead, link the built package once with
`npm link ./packages/sdk`. The examples below use `mf`.

### Commands

#### `mf verify`

Verifies your API key and returns organization details.

```bash
mf verify [options]

Options:
  --api-key <key>    API key (mf_sk_* or mf_pk_*)
  --base-url <url>   Your MarginFront server's API address (or set MARGINFRONT_API_URL)
  --debug            Enable debug output
```

#### `mf track-event`

Sends a single usage event to the API.

```bash
mf track-event [options]

Options:
  --api-key <key>      API key (mf_sk_*)
  --base-url <url>     Your MarginFront server's API address (or set MARGINFRONT_API_URL)
  --customer-id <id>   Customer external ID
  --agent-code <code>  Agent code (external ID set in the UI)
  --signal <name>      Signal name (e.g. CALL_MINUTES)
  --quantity <number>  Quantity to record (default: 1)
  --metadata <json>    Optional metadata as a JSON string
  --debug              Enable debug output
```

### Default values via `.env.marginfront.cli`

To avoid repeating flags, create a `.env.marginfront.cli` file in the directory where you run the CLI. Any value set here is used as a default and can be overridden by passing the flag directly.

```env
# ⚠️  FOR TESTING ONLY
# This file is NOT used when the SDK is imported as a library.
# It only applies when running the mf CLI.

MF_API_SECRET_KEY=mf_sk_your_key_here
MARGINFRONT_API_URL=http://localhost:4000/v1
MF_AGENT_CODE=your-agent-code
MF_CUSTOMER_ID=customer-1
MF_SIGNAL=CALL_MINUTES
MF_QUANTITY=10
MF_DEBUG=false
```

**Priority:** CLI flags > your shell's environment (for `MARGINFRONT_API_URL`) > `.env.marginfront.cli`. There is no built-in server address: with none given, the command stops and says what to set.

| CLI Flag        | `.env` Key          |
| --------------- | ------------------- |
| `--api-key`     | `MF_API_SECRET_KEY` |
| `--base-url`    | `MARGINFRONT_API_URL` |
| `--customer-id` | `MF_CUSTOMER_ID`    |
| `--agent-code`  | `MF_AGENT_CODE`     |
| `--signal`      | `MF_SIGNAL`         |
| `--quantity`    | `MF_QUANTITY`       |
| `--debug`       | `MF_DEBUG`          |

Add `.env.marginfront.cli` to your `.gitignore` to avoid committing test credentials.

## License

MIT License. See [LICENSE](./LICENSE) for details.
