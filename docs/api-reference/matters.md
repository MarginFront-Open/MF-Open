# Matters

A matter is the job AI work is billed against: a case for a law firm, a
project or a ticket for anyone else. Matters answer one question for every
dollar of AI cost: which job does this belong to?

Once usage is tied to matters, you can export a per-matter cost record to
hand a client or an auditor. Anything no matter claims stays visible as
**Unassigned**, so nothing gets lost.

You can work with matters on the **Matters** page in the dashboard (see
[features.md](../features.md#matters)), through these endpoints, or through
MCP's twelve matter tools, from `list_matters` to `export_matter_audit`. All
three use the same data.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

- [How usage lands on a matter](#how-usage-lands-on-a-matter)
- [Actual cost, never an estimate](#actual-cost-never-an-estimate)
- [Who can manage matters](#who-can-manage-matters)
- [Matters](#matters-1)
- [Unassigned events](#unassigned-events)
- [Routing rules](#routing-rules)
- [The audit record](#the-audit-record)
- [A quick pattern](#a-quick-pattern)

## How usage lands on a matter

Every usage event lands on at most one matter. There are three ways it gets
there, and the strongest wins:

1. **Manual assignment (strongest).** Someone puts the event on a matter by
   hand, in the dashboard or with `POST /matters/assign`. Tags and rules never
   override it.
2. **A tag on the event.** Send the matter's number as `metadata.matterId`
   when you record the event (see [usage-events.md](usage-events.md)). It's
   matched exactly, after trimming spaces, against `matterNumber`, not against
   the matter's ID.
3. **A routing rule (weakest).** A rule says "events for this agent code,
   customer or signal go to this matter". Rules fill in what you didn't tag.

If none apply, the event stays Unassigned until someone assigns it or a rule
sweeps it up. A tag that matches no matter is never an error and never
creates a matter. The event falls through to the rules, then to Unassigned.

**Tagging spend from developer machines.** The Code Cost Clarity meter puts a
machine's Claude Code and Codex spend on a matter with its `work` command or a
`CCC_WORK_ID` line in `~/.marginfront-ccc/.env` (`CCC_MATTER_ID` still works
as another name for it). The meter sends that value as `metadata.matterId`.
Create the matter first and use the exact same spelling, capital letters
included. A name that matches no matter lands in Unassigned with no error.
See [packages/code-cost-clarity](../../packages/code-cost-clarity/README.md#label-this-machines-spend-with-a-work-item).

## Actual cost, never an estimate

Every cost on a matter is the sum of its usage events' real costs. An event
whose cost isn't known yet (its model has no price) adds `0` to the total and
is counted in `eventsMissingCost`. A non-zero `eventsMissingCost` means the
true cost is higher than the total shows, and how many events to fix first.
See [services.md](services.md) for how prices are found.

## Who can manage matters

Every endpoint on this page needs an owner, admin, finance or legal member, or
a secret key with one of those roles. Anything else gets `403 Forbidden`. A
publishable key is refused.

### Legal keys

A key with the `legal` role is meant for this page, so you can give one to
your own agent without opening up the books. Create keys under **Build**, then
**API keys**.

A legal key can reach:

- every endpoint on this page,
- recording usage, `GET /verify`, `GET /me/key`, and reading spend caps,
  spend and coverage (see [spend-controls.md](spend-controls.md)).

Everything else answers `403 Forbidden`, including customers, invoices,
analytics, pricing and portal sessions. The server enforces this on every
request.

## Matters

### List matters

```
GET /matters
```

Your matters, each with its all-time cost and event count.

| Query parameter | Type   | Default | Notes      |
| --------------- | ------ | ------- | ---------- |
| `page`          | number | `1`     | From 1.    |
| `limit`         | number | `10`    | 1 to 100.  |

**Response (`200 OK`):**

```json
{
  "results": [
    {
      "id": "00000000-0000-4000-8000-000000000801",
      "matterNumber": "2026-0142",
      "name": "Acme v. Example Widgets",
      "clientName": "Acme Corp",
      "status": "open",
      "responsibleUserId": null,
      "createdAt": "2026-09-01T00:00:00.000Z",
      "updatedAt": "2026-09-01T00:00:00.000Z",
      "actualCost": 46.0,
      "eventCount": 14,
      "eventsMissingCost": 0
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "totalResults": 1
}
```

### Create a matter

```
POST /matters
```

```json
{
  "matterNumber": "2026-0142",
  "name": "Acme v. Example Widgets",
  "clientName": "Acme Corp"
}
```

| Field               | Type   | Required | Notes                                                                                          |
| ------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `matterNumber`      | string | Yes      | Your own ID for the job, unique in your organization, up to 255 characters. Events tag with it. |
| `name`              | string | Yes      | What the job is called.                                                                        |
| `clientName`        | string | Yes      | Who the matter is billed to.                                                                   |
| `status`            | string | No       | `open` or `closed`. Defaults to `open`.                                                        |
| `responsibleUserId` | string | No       | The responsible person, as a user UUID.                                                        |

**Response (`201 Created`):** the matter, with the fields shown in the list
minus the cost and count fields.

**Errors:**

- `400 Bad Request`: a required field is blank or too long.
- `409 Conflict`: a matter with that `matterNumber` already exists in your
  organization.

### Get one matter

```
GET /matters/{id}
```

The matter, its all-time cost and event count, and its 100 most recent
events. `eventsCap` states that limit. For every event, use
[the audit record](#the-audit-record).

**Response (`200 OK`):**

```json
{
  "matter": {
    "id": "00000000-0000-4000-8000-000000000801",
    "matterNumber": "2026-0142",
    "name": "Acme v. Example Widgets",
    "clientName": "Acme Corp",
    "status": "open",
    "responsibleUserId": null,
    "createdAt": "2026-09-01T00:00:00.000Z",
    "updatedAt": "2026-09-01T00:00:00.000Z"
  },
  "actualCost": 46.0,
  "eventCount": 14,
  "eventsMissingCost": 0,
  "events": [
    {
      "eventId": "00000000-0000-4000-8000-000000000901",
      "usageDate": "2026-09-05T12:00:00.000Z",
      "agentName": "Research Bot",
      "signalName": "documents_reviewed",
      "quantity": 1,
      "usageCost": 5.0,
      "source": "tag"
    }
  ],
  "eventsCap": 100
}
```

An event's `usageCost` is `null` when its cost isn't known yet. `source` is
`tag`, `rule`, `manual` or `null`.

**Errors:** `404 Not Found` when there's no matter with that ID in your
organization.

### Update a matter

```
PATCH /matters/{id}
```

Only the fields you send change. Send `responsibleUserId: null` to clear it.
Closing a matter (`status: "closed"`) is a label only. Events can still land
on it.

**Response (`200 OK`):** the updated matter.

**Errors:** `404 Not Found` for an unknown matter, `409 Conflict` when the new
`matterNumber` is taken.

### Delete a matter

```
DELETE /matters/{id}
```

The matter's usage events aren't deleted. They go back to Unassigned, where a
rule or a manual assignment can pick them up again. The matter's routing rules
are deleted with it.

**Response (`200 OK`):**

```json
{
  "deleted": true,
  "eventsReturnedToUnassigned": 14,
  "routingRulesDeleted": 2
}
```

**Errors:** `404 Not Found` for an unknown matter.

## Unassigned events

### List unassigned events

```
GET /matters/unassigned
```

Usage events no matter has claimed, with the same `page` and `limit` as
`GET /matters`. `totalResults` counts every unassigned event in your history,
not only this page, and `totalCost` is the cost of all of them.

**Response (`200 OK`):**

```json
{
  "results": [
    {
      "eventId": "00000000-0000-4000-8000-000000000902",
      "usageDate": "2026-09-06T09:30:00.000Z",
      "agentName": "Intake Bot",
      "signalName": "messages",
      "quantity": 3,
      "usageCost": 0.75,
      "source": null
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 3,
  "totalResults": 25,
  "totalCost": 25.0,
  "eventsMissingCost": 0
}
```

### Assign an event to a matter

```
POST /matters/assign
```

Puts one usage event on a matter by hand, or takes it off. Either way the
event is marked `manual`, which outranks tags and rules. An event you take off
by hand is never swept back up by applying rules.

```json
{
  "eventId": "00000000-0000-4000-8000-000000000902",
  "matterId": "00000000-0000-4000-8000-000000000801"
}
```

| Field      | Type           | Required | Notes                                         |
| ---------- | -------------- | -------- | --------------------------------------------- |
| `eventId`  | string         | Yes      | The usage event's UUID.                       |
| `matterId` | string or null | Yes      | The matter's UUID, or `null` to unassign it.  |

**Response (`201 Created`):**

```json
{
  "assigned": true,
  "eventId": "00000000-0000-4000-8000-000000000902",
  "matterId": "00000000-0000-4000-8000-000000000801",
  "source": "manual"
}
```

**Errors:** `404 Not Found` when the event or the matter isn't in your
organization.

## Routing rules

A rule assigns events to a matter automatically. It matches an event when
every matcher it sets matches: `agentCode` exactly, `customerExternalId`
exactly, and `signalPattern` anywhere in the signal name, ignoring case. A
rule needs at least one matcher.

Rules run lowest `priority` first, then oldest first on a tie. The first rule
that matches wins. Rules run as events are recorded, and again when you apply
them.

### List routing rules

```
GET /matter-rules
```

Your rules, in the order they run, with the same `page` and `limit` as
`GET /matters`.

**Response (`200 OK`):**

```json
{
  "results": [
    {
      "id": "00000000-0000-4000-8000-000000001001",
      "matterId": "00000000-0000-4000-8000-000000000801",
      "matterNumber": "2026-0142",
      "matterName": "Acme v. Example Widgets",
      "priority": 100,
      "agentCode": "research-bot",
      "customerExternalId": null,
      "signalPattern": null
    }
  ],
  "page": 1,
  "limit": 10,
  "totalPages": 1,
  "totalResults": 1
}
```

### Create a routing rule

```
POST /matter-rules
```

```json
{
  "matterId": "00000000-0000-4000-8000-000000000801",
  "agentCode": "research-bot"
}
```

| Field                | Type   | Required | Notes                                                 |
| -------------------- | ------ | -------- | ----------------------------------------------------- |
| `matterId`           | string | Yes      | The matter this rule assigns to, by UUID.             |
| `priority`           | number | No       | Zero or more. Lower runs first. Defaults to `100`.    |
| `agentCode`          | string | No       | Match this agent code exactly.                        |
| `customerExternalId` | string | No       | Match this customer ID exactly.                       |
| `signalPattern`      | string | No       | Match this text anywhere in the signal name, ignoring case. |

Send at least one of `agentCode`, `customerExternalId` or `signalPattern`.
Matchers are trimmed, and each can be up to 255 characters.

**Response (`201 Created`):** the rule, with its matter's number and name.

**Errors:** `400 Bad Request` when no matcher is set or one is too long,
`404 Not Found` when the matter isn't in your organization.

### Apply routing rules

```
POST /matter-rules/apply
```

Runs your rules, in order, over events that are still Unassigned. It skips
events someone took off a matter by hand, and never touches an event that
already has a matter, so it never overrides a tag, an earlier rule or a
manual choice. Events returned to Unassigned by deleting their matter are
included.

**Response (`201 Created`):**

```json
{ "assigned": 12 }
```

If the run fails partway, the API answers `500` with an `assigned` count of
the events it placed before stopping. Run it again to finish.

### Update a routing rule

```
PATCH /matter-rules/{id}
```

Only the fields you send change. Send a matcher as `null` to clear it. The
rule must still have at least one matcher afterwards.

**Response (`200 OK`):** the updated rule.

**Errors:** `400 Bad Request` when the result has no matcher, `404 Not Found`
for an unknown rule or matter.

### Delete a routing rule

```
DELETE /matter-rules/{id}
```

Stops future matching only. Events the rule already assigned keep their
matter.

**Response (`200 OK`):**

```json
{ "deleted": true }
```

**Errors:** `404 Not Found` for an unknown rule.

## The audit record

```
GET /matters/audit
```

The record you hand a client or an auditor: actual AI cost per matter over a
window. The default `summary` view has one row per matter, an Unassigned row,
and totals for your organization. It matches the CSV export on the Matters
page for the same window.

| Query parameter | Type   | Notes                                                                                                   |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `start`         | string | `YYYY-MM-DD` (start of that day, UTC) or a full ISO timestamp. Defaults to 30 days ago.                |
| `end`           | string | `YYYY-MM-DD` (end of that day, UTC) or a full ISO timestamp. Capped at now. Defaults to now.           |
| `format`        | string | `summary` (default) or `detail`. `detail` adds one row per event.                                       |
| `matterId`      | string | One matter's UUID. A view for one matter has no Unassigned row and no organization totals.             |

**Response (`200 OK`, `summary`):**

```json
{
  "periodStart": "2026-08-11T00:00:00.000Z",
  "periodEnd": "2026-09-10T23:59:59.999Z",
  "summary": [
    {
      "matterNumber": "2026-0142",
      "matterName": "Acme v. Example Widgets",
      "clientName": "Acme Corp",
      "cost": 21.0,
      "eventCount": 5,
      "eventsMissingCost": 0
    },
    {
      "matterNumber": null,
      "matterName": null,
      "clientName": null,
      "cost": 25.0,
      "eventCount": 9,
      "eventsMissingCost": 0
    }
  ],
  "totalCost": 46.0,
  "totalEvents": 14,
  "eventsMissingCost": 0
}
```

The row with a `null` `matterNumber` is the Unassigned row. It's there
whenever unassigned events fall in the window.

With `format=detail`, the response also has a `rows` array, one entry per
event: `matterNumber`, `clientName`, `usageDate`, `agentName`, `signalName`,
`models` (the event's distinct model names joined with `; `), `usageCost`,
`quantity`, `source` and `eventId`.

Costs that aren't known yet count as `0` in every total and are flagged in
`eventsMissingCost`. They're never invented.

## A quick pattern

1. Create a matter for each open job, with your own number as `matterNumber`.
2. Tag usage events with `metadata.matterId` set to that number.
3. Add a routing rule or two for work that's hard to tag at the source.
4. Check the Unassigned list now and then, and assign what's left by hand.
5. Export the audit for the billing window when it's time to bill.
