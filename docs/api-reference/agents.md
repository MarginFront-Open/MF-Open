# Agents

An agent is the thing that does billable work: an AI feature, a product, a
worker, a service. Signals, pricing plans and usage events all hang off an
agent. Each one has an `agentCode` that your app sends with every usage event.

You don't have to create an agent before you send usage. An event with an
`agentCode` the API hasn't seen creates the agent, with the code as its name.
Create one yourself when you want to set its name and description up front.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is the final word on every request and response shape.

- [Why agents exist](#why-agents-exist)
- [Who can call these routes](#who-can-call-these-routes)
- [Create an agent](#create-an-agent)
- [Read an agent](#read-an-agent)
- [List agents](#list-agents)
- [Update an agent](#update-an-agent)
- [Delete an agent](#delete-an-agent)
- [Agents in usage events](#agents-in-usage-events)

## Why agents exist

One customer can use several of your products, and each can cost and bill
differently. Say you run a chatbot, a document analyzer and an image
generator. If you only tracked usage per customer, all three would blur into
one number. With three agents (`chatbot`, `doc-analyzer`, `image-gen`), each
event says which product did the work, so each can have its own prices, its
own margin and its own lines on the invoice.

With one product you need one agent. It's still the anchor everything else
attaches to.

## Who can call these routes

Send a secret key (`mf_sk_...`) in the `x-api-key` header. See
[authentication.md](authentication.md).

- **Reads** work with any secret key except an ingest-only or legal key.
- **Writes** (create, update, delete) need a key whose role is owner, admin or
  developer. Any other role gets `403`.
- A publishable key (`mf_pk_...`) gets `403` on every route on this page.

## Create an agent

```
POST /agents
```

**Required:**

- `name` (string, up to 255 characters): shown in the dashboard, reports and
  invoices.
- `agentCode` (string, up to 255 characters): a short code you pick, such as
  `chatbot` or `doc-analyzer`. Usage events name the agent by this code. It
  must be unique within your organization.

**Optional:**

- `description` (string)
- `isActive` (boolean): defaults to `true`. Set it to `false` to retire the
  agent and keep its history.
- `context` (object): your own key/value pairs, such as
  `{ "department": "support" }`. Stored and returned, never read by
  MarginFront.

**Example:**

```bash
curl -X POST https://billing.example.com/v1/agents \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support Assistant",
    "agentCode": "support-bot",
    "description": "Answers customer support questions"
  }'
```

**Returns `201`** with the agent (abridged here):

```json
{
  "id": "00000000-0000-4000-8000-000000000002",
  "name": "Support Assistant",
  "agentCode": "support-bot",
  "description": "Answers customer support questions",
  "isActive": true,
  "context": null,
  "createdAt": "2026-04-10T14:30:00.000Z"
}
```

**Errors:**

- `400`: `name` or `agentCode` is missing, empty or longer than 255
  characters. The message names the field.
- `401`: the key is missing or wrong.
- `403`: a publishable key, or a key whose role can't write.
- `409`: an agent with that `agentCode` already exists in your organization.

## Read an agent

```
GET /agents/{agentId}
```

`agentId` is the agent's `id`, not its `agentCode`. The response includes the
agent's `signals` and the `pricing_plans` linked to it.

**Errors:** `404` when no agent with that ID exists in your organization, or
it was deleted.

## List agents

```
GET /agents
```

**Query parameters (all optional):**

- `name`, `agentCode`: partial, case-insensitive matches.
- `isActive`: `true` or `false`.
- `search`: matches name, description and agent code.
- `sortBy`: `name`, `agentCode`, `createdAt` or `updatedAt`. `sortOrder`:
  `asc` or `desc` (default `desc`).
- `page` (default `1`) and `limit` (1 to 100, default `10`).

**Returns** `{ results, page, limit, totalPages, totalResults }`. Each agent
in `results` carries `signalsCount` and `activePlansCount`.

## Update an agent

```
PATCH /agents/{agentId}
```

Send any field from create. Only the fields you send change. To retire an
agent and keep its history, set `isActive` to `false`:

```bash
curl -X PATCH https://billing.example.com/v1/agents/00000000-0000-4000-8000-000000000002 \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"isActive": false}'
```

**Errors:** `404` when the agent doesn't exist; `409` when you change
`agentCode` to one another agent already has.

## Delete an agent

```
DELETE /agents/{agentId}
```

A soft delete: the agent is hidden from reads and lists, and its signals,
plans and history stay in the database. **Returns `204`** with no body.

A usage event that sends the deleted agent's `agentCode` brings the agent
back. To stop an agent for good, stop sending its code. To keep it visible but
out of use, set `isActive` to `false` instead.

**Errors:** `404` when the agent doesn't exist.

## Agents in usage events

The SDK has no agents resource. It names the agent by `agentCode` when you
record usage:

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1", // or set MARGINFRONT_API_URL
});

await client.usage.record({
  customerExternalId: "acme-001",
  agentCode: "support-bot",
  signalName: "messages",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});
```

An unknown `agentCode` creates a minimal agent named after the code. That's
handy while you prototype. Set a proper name and description afterwards with
`PATCH /agents/{agentId}`.

Build the SDK from source first, as in [packages.md](../packages.md). Through
MCP: `create_agent` and `list_agents`.
