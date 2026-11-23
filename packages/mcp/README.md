# @marginfront/mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Model Context Protocol](https://modelcontextprotocol.io) server for MarginFront. Lets you ask Claude, ChatGPT, Gemini, or any other MCP-compatible AI client to operate on your MarginFront account in plain English. Look up customers, query revenue, run backfills, fix unrecognized models, and trigger admin actions without writing code.

This package is built from the MarginFront source and talks only to the MarginFront
server you run. It has no built-in server address, it is not installed from a package
registry, and it never checks for updates.

Agent-readable reference for every tool: [`llms-mcp.txt`](./llms-mcp.txt), in this folder.

## What this is for

MCP is the operator interface for human-to-LLM ops on a MarginFront account. Use it when:

- You want to ask an AI to backfill historical events from a CSV or SQL dump.
- You're debugging in the dashboard and want to ask Claude to look up a specific customer's revenue or fix unrecognized models in bulk.
- You're a non-developer customer-success or finance person who wants to query MarginFront without learning the API.

**MCP is not how you instrument your product.** For per-event tracking from your own production code, use the SDK in [`packages/sdk`](../sdk/README.md) or call the REST API directly. SDK and API calls are typed, fast, and meant to run inline with your product logic. MCP runs through an LLM, which is great for ad-hoc work and terrible for per-request hot paths.

## What you get

58 tools that any MCP-compatible AI client can call directly. Organized by purpose:

**Connection**

- **`verify`**: confirm the API key works and see which organization it belongs to

**Usage recording**

- **`record_usage`** / **`record_usage_batch`**: log what your customers are using (tokens, quantity, metadata)

**Customer lookup**

- **`list_customers`** / **`get_customer`** / **`create_customer`**: manage your customer list

**Agents & signals**

- **`create_agent`** / **`list_agents`**: register and look up the agents you bill for (each agent's UUID feeds signals, pricing, and subscriptions)
- **`create_signal`** / **`list_signals`**: define and look up billing units per agent (usage and credit-pool pricing need the signalId up front)

**Invoices**

- **`list_invoices`** / **`get_invoice`**: read finalized bills and line items
- **`generate_invoice`**: build a draft invoice from a subscription's actual usage events: line items + totals computed from the period's real activity, ready to preview/edit/send
- **`send_invoice`**: email an invoice to the customer with a Stripe Checkout pay-now button (auto-finalizes drafts to "issued" as a side effect)

**Events**

- **`list_events`**: browse recorded usage events with filters (pass customerExternalId to scope by your own customer ID)

**Analytics (canonical)**

- **`get_usage_analytics`**: aggregated usage totals plus margin (pass customerExternalId to scope by your own customer ID)
- **`get_customer_revenue`**: canonical revenue, cost, margin, and marginPercent for a single customer over a window
- **`get_cost_metrics`**: canonical cost totals plus breakdown by agent, customer, signal, day, plan, and model
- **`get_mrr`**: canonical MRR (canonical, run-rate, committed, or all three)

**Subscriptions**

- **`list_subscriptions`** / **`create_subscription`**: track which customer is on which pricing plan

**Customer portal**

- **`create_portal_session`** / **`get_portal_session`** / **`list_portal_sessions`** / **`revoke_portal_session`**: mint, inspect, list, and revoke single-use 1-hour portal links so customers can view their plan, invoices, and usage without exposing your API key

**Pricing setup**

- **`create_pricing_plan`** / **`list_pricing_plans`** / **`get_pricing_plan`**: manage pricing plans
- **`create_pricing_strategy`** / **`list_pricing_strategies`**: add pricing rules (usage, recurring, credit pool, etc.) to plans
- **`link_plan_to_agent`**: connect a plan to an agent before subscribing customers

**Data repair**

- **`get_needs_attention`** / **`map_model`**: find and resolve events with unrecognized models
- **`get_missing_volume`** / **`fill_volume`**: find and resolve events with missing token or quantity counts

**Catalog discovery**

- **`list_catalog_services`**: browse the global `service_pricing` catalog so the AI can look up canonical model + provider names before firing usage events (avoids the "guess and check until cost resolves" cycle)

**Spend controls (internal code-spend caps)**

- **`get_spend_controls`**: read the caps, spend-so-far for a period, and cap-check coverage per tool (Claude Code and Codex reported separately, with an unknown bucket that never counts as covered) in one call. Works with every key role, including an ingest-only key, because that's the key the on-device brake reads it with.
- **`get_internal_spend_breakdown`**: internal coding-agent spend for the current period, grouped by git repo or branch. Branch spend is the closest stand-in for cost per pull request; events outside a tracked repo appear in the no-repo bucket. **Owner, admin, or finance only** (a developer or ingest-only key gets a clean 403 here even though it can read `get_spend_controls`).
- **`create_spend_cap`** / **`update_spend_cap`** / **`delete_spend_cap`**: set and change spend caps, **owner/finance only** (the role rides the API key; a key without it gets a clean 403). Each write echoes the cap's plain sentence so you see exactly what changed.

**Credit pools**

- **`get_credit_balances`**: how many pool units each customer has left, and how many are already billing as overage. Nothing stops at zero: the pool is a meter, not a breaker.

**Customer watch alerts**

- **`get_customer_alerts`** / **`create_customer_alert`** / **`update_customer_alert`** / **`delete_customer_alert`**: per-customer tripwires on cost or revenue ("email me when Acme's cost passes $500 this month"). **Owner, admin, or finance only**, because a watch exposes one customer's money, so there is no open-read posture here.

**Matters**

- **`list_matters`** / **`get_matter`** / **`create_matter`** / **`update_matter`** / **`delete_matter`**: the jobs AI work is billed against (a case, a project, a ticket), each with its AI cost
- **`list_unassigned_events`** / **`assign_event_to_matter`**: find events with no matter and assign them
- **`list_matter_rules`** / **`upsert_matter_rule`** / **`delete_matter_rule`** / **`apply_matter_rules`**: routing rules that assign events to matters automatically
- **`export_matter_audit`**: the per-matter audit trail

## Example: reading and setting spend caps

Ask the agent "what are our spend caps and how much have we used this week?" and it
calls `get_spend_controls`. To set one, it calls `create_spend_cap`:

```jsonc
// create_spend_cap arguments: a $200/week Claude cap for one teammate
{
  "scope": "dev", // "org" | "dev"
  "scopeValue": "alice@acme.example", // the teammate's customerExternalId (email)
  "providerScope": "anthropic", // "all" or one provider
  "amountUsd": 200,
  "period": "week", // "day" | "week" | "month"
  "mode": "enforce", // "track" (alert only) | "enforce" (hard stop)
}
```

The response leads with the plain sentence `Cap created: Stop Claude spend at
$200 for alice@acme.example per week`, followed by the full cap JSON. A team or dev
cap can never exceed the org ceiling for the same provider; the server refuses it
with a plain message the agent shows you. `spentUsd` comes back `null` (never a
fake `$0`) when there's no priced usage yet.

Best-effort guardrail, not a hard limit. For a hard ceiling, set a spend limit in
your Anthropic or OpenAI account.

## The signal-naming rule for AI agents

When you use `record_usage` via this MCP server, the `signal_name` you pick becomes the line item your user's customer reads on their invoice. Pick it deliberately:

1. **Fire ONE call per business outcome.** A finished 50-page report is ONE `record_usage` call with `quantity: 50`, not 50 calls with `quantity: 1`. Looping multiplies the bill.
2. **Match the signal name to how the user wants to bill.** Before creating a signal on a user's behalf, ask them what unit goes on the invoice. "Per page" → `signal_name: "pages"`. "Per report" → `signal_name: "reports"`. "Per minute" → `signal_name: "minutes"`.
3. **Don't invent internal-sounding names.** Bad: `llm_call`, `gpt-4o-call`, `api-requests`. Good: `messages`, `reports-generated`, `pages`, `sms-sent`, `minutes`.
4. **`quantity` is the count of that billing unit for this one outcome.** A 50-page report fired as `pages` has `quantity: 50`. Fired as `reports`, `quantity: 1`. Same underlying LLM call, different invoice.

Full mental model (including a three-way comparison of the same LLM call billed three different ways): "Picking `signalName` and `quantity`" in the [SDK README](../sdk/README.md).

## Installation

The MCP server runs as a Node.js process over stdio. You don't install it into your app; you build it once, then configure your MCP client (Claude Desktop, Claude Code, etc.) to start it with `node`.

You need a running MarginFront server of your own, a secret key from its dashboard (**Build -> API keys**), and a checkout of the MarginFront source.

### 1. Build it

From the root of the checkout:

```bash
npm ci
npx turbo run build --filter=@marginfront/mcp
```

(`npx turbo` runs the build tool already installed in the checkout. It downloads nothing.)

That writes `packages/mcp/dist/index.js`. MCP clients start servers from their own working folder, so use the full path to that file in the configs below.

### 2. Point your MCP client at it

**Claude Desktop.** Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (or the equivalent on Windows/Linux):

```json
{
  "mcpServers": {
    "marginfront": {
      "command": "node",
      "args": ["/absolute/path/to/marginfront/packages/mcp/dist/index.js"],
      "env": {
        "MF_API_SECRET_KEY": "mf_sk_your_secret_key_here",
        "MARGINFRONT_API_URL": "https://billing.example.com/v1"
      }
    }
  }
}
```

Restart Claude Desktop. The MarginFront tools appear automatically.

**Claude Code.** Add to your project's `.mcp.json`. This form reads both values from your shell, so no key is written into the file:

```json
{
  "mcpServers": {
    "marginfront": {
      "command": "node",
      "args": ["/absolute/path/to/marginfront/packages/mcp/dist/index.js"],
      "env": {
        "MF_API_SECRET_KEY": "${MF_API_SECRET_KEY}",
        "MARGINFRONT_API_URL": "${MARGINFRONT_API_URL}"
      }
    }
  }
}
```

**Cursor** uses the same shape in `.cursor/mcp.json`.

**VS Code.** Put it in `.vscode/mcp.json` in your project. The top-level key is `servers`, not `mcpServers`. That's the only difference from the configs above:

```json
{
  "servers": {
    "marginfront": {
      "command": "node",
      "args": ["/absolute/path/to/marginfront/packages/mcp/dist/index.js"],
      "env": {
        "MF_API_SECRET_KEY": "mf_sk_your_secret_key_here",
        "MARGINFRONT_API_URL": "https://billing.example.com/v1"
      }
    }
  }
}
```

This file holds your key, so keep it out of version control.

### 3. Check the connection

Ask your assistant to verify your MarginFront connection. It calls `verify`, which shows the organization your key belongs to. If that fails, see [Troubleshooting](#troubleshooting).

## Environment variables

| Name                              | Required? | Purpose                                                                                                                                                                                                                                                  |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MF_API_SECRET_KEY`               | yes       | Your secret API key (`mf_sk_*`). Create one in your MarginFront dashboard under Build, then API keys.                                                                                                                                                      |
| `MARGINFRONT_API_URL`             | yes       | Your MarginFront server's API address, including `/v1`, for example `https://billing.example.com/v1` or `http://localhost:4000/v1`. There is no default: without it the server prints what to set and exits. Must be `https://`, or `http://` to this machine. |
| `MARGINFRONT_ALLOW_INSECURE_HTTP` | no        | Set to `1` to allow plain `http://` to another machine, for a server on a private network you trust. Your key then travels unencrypted. Off by default.                                                                                                   |

How the address is enforced:

- A missing or malformed address, or one carrying a username, password, `?query` or `#fragment`, stops the server at startup with a message that says what to fix. Nothing falls back to another address.
- Every request is checked against that one server before it is sent.
- A redirect from the server is refused, so your key cannot follow one to another address.
- A path in front of `/v1` is kept: `https://example.com/billing/v1` works.

The server doesn't read `MF_API_BASE_URL`. If that one is set and `MARGINFRONT_API_URL` is not, the server exits and tells you to rename it.

## Updating

Nothing checks for updates. To update, pull the MarginFront repository, run the build command again, and restart your MCP client.

## Example: backfilling historical events

The most common reason to fire events through MCP is a one-time backfill. You hand the AI a list of past activity, it records each event for you, and you can move on.

> "I have 47 research reports my agent generated last week that never got recorded. Each one used Claude Opus with around 4000 input tokens and 1500 output tokens. The customer was `acme-001`, the agent was `research-agent`, the signal is `research_reports`, and quantity is 1 per report. Record them all."

The assistant calls `record_usage_batch` and returns a confirmation:

```
Processed 47 event(s): 47 succeeded, 0 failed.
```

If any model isn't in the pricing catalog yet, those events are **still saved** with `cost: null` and flagged `NEEDS_COST_BACKFILL`. The assistant can then call `map_model` to fix it, and every flagged past event with that model gets a real cost retroactively.

For per-event tracking from your production code, use the [SDK](../sdk/README.md) instead. MCP fires events through an LLM, which is fine for ad-hoc batches and terrible for the hot path.

## Example: AI agent recording multi-service usage

When one outcome uses several services (e.g. a research report that searches the web, calls an LLM, and sends an email), MCP records it as ONE event with a `services` array. The customer is billed per signal; MarginFront tracks per-service cost under the hood. Same backfill pattern as above:

> "Record one research report for `acme-001` on `research-agent`, signal `research_reports`, quantity 1. The services were 12 web search calls, Claude Opus 4 with 4200 input plus 1800 output tokens, and 3 emails."

The assistant calls `record_usage` with the multi-service shape and gets one confirmation:

```
Processed 1 event(s): 1 succeeded, 0 failed.

Successful:
  - acme-001 / research_reports: $0.142 across 3 services (event: 5de8fbf1-...)
```

Per-service cost lines live under the parent event for margin reporting. The customer's invoice shows one line: `research_reports x 1`.

## Example: asking about revenue and cost

The canonical analytics tools answer business questions in plain English:

> "What revenue did we get from customer acme-001 in April?"

Calls `get_customer_revenue` (after resolving the UUID via `list_customers`) and returns `{ revenue, cost, margin, marginPercent }` plus a per-strategy-type breakdown.

> "What did we spend on model providers this month?"

Calls `get_cost_metrics` and returns total cost plus breakdowns by agent, customer, signal, day, plan, and model.

> "What's our MRR right now?"

Calls `get_mrr` (defaults to MRR1, contracted monthly recurring revenue of active subscriptions, today). Ask for "all three" to get MRR1 (contracted), MRR2 (run-rate trajectory), and MRR3 (contractual floor) in one response.

## How it relates to the SDK

- Use **`@marginfront/sdk`** to instrument your product. Every time your agent does work for a customer, your code fires a typed function call (`client.usage.record({ ... })`). This is the integration path.
- Use **`@marginfront/mcp`** for human-to-LLM ops on the MarginFront account: backfills, batch fixes, queries, admin actions. This is the operator path.

Both wrap the same REST API. They are not interchangeable: the SDK is built for production hot paths, MCP runs through an LLM and is built for conversational use. Pick the one that matches the job.

### From a test event to your own code

A good first hour uses both:

1. Ask the assistant to record one test event through MCP, with the customer, agent and signal names you plan to use. The reply tells you whether it was saved and priced, or saved under **Needs attention** and why.
2. Fix anything it flagged, such as a model name the catalog doesn't know.
3. Ask the same assistant to write the SDK call (or the REST call) into your codebase, at the spot where your agent finishes the work you bill for, with the same names and fields as the test event.

The test event shows the connection works. The code you keep is the SDK call.

## Troubleshooting

**"Missing MF_API_SECRET_KEY environment variable"**
Your MCP client didn't pass the env var. Check the `env` block in your MCP config.

**"The MarginFront MCP server did not start. No MarginFront server is set..."**
`MARGINFRONT_API_URL` is missing from the `env` block. Add your server's API address, including `/v1`.

**"...which is unencrypted http on another machine..."**
The address is plain `http://` to a host other than this machine. Use `https://`, or set `MARGINFRONT_ALLOW_INSECURE_HTTP=1` if the server is on a private network you trust.

**"Authentication failed. The API key is invalid or missing"**
The key was passed but rejected. Check the key in your MarginFront dashboard under Build, then API keys, and confirm you're using a `mf_sk_*` secret key (not a `mf_pk_*` publishable key) that was created on the same server `MARGINFRONT_API_URL` points at.

**"...answered with a redirect..."**
Your server, or a proxy in front of it, redirected the request. Redirects are refused. Set `MARGINFRONT_API_URL` to the final address, usually the `https://` one.

**"Could not reach the MarginFront API"**
This machine can't connect to the address in `MARGINFRONT_API_URL`. Check that the server is running and that the address and port are right.

## Development

```bash
npm run build       # tsc, writes dist/
npm run typecheck
npm test            # needs the build: several tests start dist/index.js
```

## License

MIT. See `LICENSE`.
