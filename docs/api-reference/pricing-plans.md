# Pricing plans

A pricing plan is a named bundle of prices, such as "Starter" or "Pro". The
prices themselves are pricing strategies inside the plan (see
[pricing-strategies.md](pricing-strategies.md)). A subscription puts a
customer on a plan.

Plans belong to your organization and link to one or more agents. One "Pro"
plan can be offered by several agents without building it twice.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is the final word on every request and response shape.

- [Who can call these routes](#who-can-call-these-routes)
- [Create a plan](#create-a-plan)
- [Link a plan to an agent](#link-a-plan-to-an-agent)
- [Unlink a plan from an agent](#unlink-a-plan-from-an-agent)
- [Read a plan](#read-a-plan)
- [List plans](#list-plans)
- [Update a plan](#update-a-plan)
- [Delete a plan](#delete-a-plan)
- [Copy a plan](#copy-a-plan)
- [Using the SDK](#using-the-sdk)
- [How plans fit the billing chain](#how-plans-fit-the-billing-chain)

## Who can call these routes

Send a secret key (`mf_sk_...`) in the `x-api-key` header. See
[authentication.md](authentication.md).

- **Reads** work with any secret key except an ingest-only or legal key.
- **Writes** (create, update, delete, copy, link, unlink) need a key whose
  role is owner, admin or finance. Any other role gets `403`.
- A publishable key (`mf_pk_...`) gets `403` on every route on this page.

## Create a plan

```
POST /pricing-plans
```

**Required:**

- `name` (string, up to 255 characters): such as `"Starter"`, `"Pro"`.

**Optional:**

- `agentId` (UUID): an agent to link the plan to straight away. Link more
  agents later with `POST /pricing-plans/{planId}/agents`.
- `description` (string, up to 255 characters)
- `featuresList` (object): free-form, stored and returned, such as
  `{ "features": ["API access", "Priority support"] }`.
- `isActive` (boolean): defaults to `true`.

**Example:**

```bash
curl -X POST https://billing.example.com/v1/pricing-plans \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pro",
    "description": "For teams that need more volume",
    "agentId": "00000000-0000-4000-8000-000000000002",
    "featuresList": { "features": ["API access", "Priority support"] }
  }'
```

**Returns `201`** with the plan and its agent links (abridged here):

```json
{
  "id": "00000000-0000-4000-8000-000000000004",
  "name": "Pro",
  "description": "For teams that need more volume",
  "isActive": true,
  "agent_pricing_plans": [
    {
      "agentId": "00000000-0000-4000-8000-000000000002",
      "planId": "00000000-0000-4000-8000-000000000004",
      "agents": {
        "id": "00000000-0000-4000-8000-000000000002",
        "name": "Support Assistant",
        "agentCode": "support-bot"
      }
    }
  ],
  "createdAt": "2026-04-10T14:30:00.000Z"
}
```

**Errors:**

- `400`: `name` is missing or too long, or `agentId` isn't a UUID.
- `404`: no agent with that `agentId` exists in your organization.

Create a plan once per price tier, then subscribe many customers to it. You
don't need a plan per customer.

## Link a plan to an agent

```
POST /pricing-plans/{planId}/agents
```

Offers an existing plan through another agent. The plan itself doesn't
change.

```bash
curl -X POST https://billing.example.com/v1/pricing-plans/00000000-0000-4000-8000-000000000004/agents \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "00000000-0000-4000-8000-000000000009"}'
```

**Returns `201`** with `{ "message": "Plan linked to agent successfully" }`.

**Errors:** `404` when the plan or agent isn't in your organization; `409`
when the plan is already linked to that agent.

## Unlink a plan from an agent

```
DELETE /pricing-plans/{planId}/agents/{agentId}
```

Takes the plan off that agent. The plan still exists. **Returns `204`.**

**Errors:** `400` when subscriptions with status `active` or `pending` use
this plan with this agent (end them first); `404` when the plan isn't found.

## Read a plan

```
GET /pricing-plans/{planId}
```

Returns the plan with `agents` (the linked agents) and `pricingStrategies`
(its prices). **Errors:** `404` when the plan doesn't exist or was deleted.

## List plans

```
GET /pricing-plans
```

**Query parameters (all optional):**

- `name`: partial, case-insensitive match.
- `agentId`: only plans linked to this agent.
- `isActive`: `true` or `false`.
- `includeStrategies`: `true` to include each plan's strategies.
- `sortBy`: `name`, `createdAt` or `updatedAt`. `sortOrder`: `asc` or `desc`
  (default `desc`).
- `page` (default `1`) and `limit` (1 to 100, default `10`).

**Returns** `{ results, page, limit, totalPages, totalResults }`. Each plan in
`results` has an `agents` array.

## Update a plan

```
PATCH /pricing-plans/{planId}
```

Send any of `name`, `description`, `featuresList` and `isActive`. Only the
fields you send change. To change which agents offer the plan, use link and
unlink, not this route. To change prices, update the plan's strategies.

An invoice is priced from the plan's active strategies at the time the
invoice is generated.

**Errors:** `404` when the plan doesn't exist.

## Delete a plan

```
DELETE /pricing-plans/{planId}
```

A soft delete: the plan is hidden from reads and lists. **Returns `204`.**

Delete doesn't check for subscriptions first. If customers are on the plan,
set `isActive` to `false` instead: it marks the plan as retired, keeps its
history, and existing subscriptions keep running. Keep delete for cleaning up
mistakes.

## Copy a plan

```
POST /pricing-plans/{planId}/copy
```

Makes a new plan with the same strategies and agent links. Use it to build a
variant, such as a yearly version of a monthly plan, without starting over.

**Body:**

- `newName` (string, required, up to 255 characters)
- `newDescription` (string, optional): defaults to the original's.
- `discount` (number from 0 to 100, optional, default `0`): a percentage taken
  off every rate and tier rate in the copy, rounded to two decimal places.
  Credit-pool burn rates (`creditRates`) are copied unchanged, because they
  count credits, not money.
- `requestedYearly` (boolean, optional, default `false`): switches every
  monthly strategy in the copy to yearly. It changes the billing frequency
  only, not the rates.

```bash
curl -X POST https://billing.example.com/v1/pricing-plans/00000000-0000-4000-8000-000000000004/copy \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"newName": "Pro Yearly", "discount": 20, "requestedYearly": true}'
```

**Returns `201`** with the new plan. The copy is checked against the
credit-pool rules after the discount is applied, so a copy that would break
them is refused with `400`.

**Errors:** `404` when the original plan doesn't exist.

## Using the SDK

Build and install the SDK from this repository first, as in
[packages.md](../packages.md). Then:

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1", // or set MARGINFRONT_API_URL
});

const plan = await client.pricingPlans.create({ name: "Pro" });
await client.pricingPlans.linkAgent(plan.id, "00000000-0000-4000-8000-000000000002");

// Add the prices. See pricing-strategies.md.
await client.pricingStrategies.createBulk(plan.id, [
  {
    name: "Platform fee",
    agentId: "00000000-0000-4000-8000-000000000002",
    chargeType: "recurring",
    rate: 49,
  },
]);

const { results } = await client.pricingPlans.list({ isActive: true });
await client.pricingPlans.update(plan.id, { description: "For larger teams" });
const yearly = await client.pricingPlans.copy(plan.id, {
  newName: "Pro Yearly",
  discount: 20,
  requestedYearly: true,
});
```

The resource also has `get(planId)`, `delete(planId)` and
`unlinkAgent(planId, agentId)`.

Through MCP: `create_pricing_plan`, `list_pricing_plans`, `get_pricing_plan`
and `link_plan_to_agent`.

## How plans fit the billing chain

```
Organization
    |
    +---- Pricing plan ----+---- Agent A
           (the prices)    +---- Agent B   (same plan, another agent)
                |
          Subscription ---- Customer
          (one customer, one plan, one agent)
                |
          Usage events
          (priced by the plan's strategies)
```

1. Create an **agent** ([agents.md](agents.md)).
2. Create one or more **plans** for your organization.
3. **Link** each plan to the agents that offer it.
4. Add **pricing strategies** to each plan
   ([pricing-strategies.md](pricing-strategies.md)).
5. When a customer signs up, create a **subscription** for that customer,
   agent and plan ([subscriptions.md](subscriptions.md)).
6. Send **usage events** as the customer uses the product. Each billing
   period they're priced by the plan and rolled into an invoice
   ([invoices.md](invoices.md)).
