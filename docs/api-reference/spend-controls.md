# Spend controls

A spend cap is a limit on what your own team spends on AI coding tools, for
example "$5,000 across the whole team per month" or "$200 a week for one
developer".

Caps cover your company's internal spend: the Claude Code and Codex usage the
Code Cost Clarity meter records (see
[packages/code-cost-clarity](../../packages/code-cost-clarity/README.md)).
They have nothing to do with your customers. Events you record for customer
billing never count toward a cap, and a cap never changes what a customer
pays.

You can manage caps under **Internal AI Spend**, then **Caps** in the
dashboard. These endpoints are the same controls from your own code. The SDK's
`spendControls` and MCP's `get_spend_controls`, `get_internal_spend_breakdown`,
`create_spend_cap`, `update_spend_cap` and `delete_spend_cap` call them too.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

- [Two ideas first](#two-ideas-first)
- [Who can do what](#who-can-do-what)
- [List caps](#list-caps)
- [Create a cap](#create-a-cap)
- [Update a cap](#update-a-cap)
- [Delete a cap](#delete-a-cap)
- [Read spend](#read-spend)
- [Spend by repository or branch](#spend-by-repository-or-branch)
- [Read coverage](#read-coverage)
- [How enforcement works](#how-enforcement-works)
- [Alert emails](#alert-emails)

## Two ideas first

**Scope: who the cap covers.**

- `org`: one ceiling for the whole team.
- `dev`: one developer, named by their `customerExternalId` (their email).

A developer cap can't be set above the whole-team ceiling. The API refuses
with a message that says why.

**Mode: what happens at the cap.**

- `track`: sends alert emails. Blocks nothing.
- `enforce`: machines set up with `init --control` pause Claude Code and Codex
  tool calls once the cap is reached. The API itself never blocks anything. It
  stores caps and reports spend.

Every cap covers all AI tools. `providerScope` must be `"all"`. Anything else
gets `400` with "Caps cover all AI tools for now."

## Who can do what

| Action                                     | Who                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Read caps, spend and coverage              | Any secret key, including ingest-only and legal keys, and any member.           |
| Read the spend breakdown and its drill-down | Owner, admin or finance.                                                        |
| Create, update or delete a cap             | Owner or finance only. Admins can read caps but not change them.               |

A publishable key is refused everywhere. Anyone else gets `403 Forbidden`.

## List caps

```
GET /control/caps
```

Every cap in your organization. Each one has a `sentence`: the cap written out
as one plain sentence by the server.

**Response (`200 OK`):**

```json
[
  {
    "id": "00000000-0000-4000-8000-000000001101",
    "scope": "org",
    "scopeValue": null,
    "providerScope": "all",
    "amountUsd": 5000,
    "period": "month",
    "mode": "enforce",
    "coolOffHours": null,
    "alertThresholds": [50, 80, 100],
    "createdByUserId": null,
    "createdAt": "2026-07-01T00:00:00.000Z",
    "updatedAt": "2026-07-01T00:00:00.000Z",
    "sentence": "Stop AI spend at $5,000 across the whole team per month"
  }
]
```

## Create a cap

```
POST /control/caps
```

```json
{
  "scope": "dev",
  "scopeValue": "dev@example.com",
  "providerScope": "all",
  "amountUsd": 200,
  "period": "week",
  "mode": "enforce"
}
```

| Field             | Type     | Required | Notes                                                                                                   |
| ----------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `scope`           | string   | Yes      | `org` or `dev`.                                                                                          |
| `scopeValue`      | string   | For `dev` | The developer's `customerExternalId` (their email), up to 255 characters. Leave it out for `org`.     |
| `providerScope`   | string   | Yes      | Must be `"all"`. The SDK fills it in for you.                                                           |
| `amountUsd`       | number   | Yes      | The cap in US dollars, 0 to 50,000,000.                                                                 |
| `period`          | string   | Yes      | `day`, `week` or `month`. Windows roll over at UTC boundaries.                                         |
| `mode`            | string   | Yes      | `track` or `enforce`.                                                                                   |
| `coolOffHours`    | number   | No       | Whole hours, 0 to 8,760, to wait after a cap trips before the machine checks again.                    |
| `alertThresholds` | number[] | No       | Alert levels as whole percents of the cap, 1 to 100, at most five, each higher than the last. Default `[50, 80, 100]`. |

**Response (`201 Created`):** the cap, in the same shape as the list,
including its `sentence`.

```bash
curl -X POST https://billing.example.com/v1/control/caps \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "org",
    "providerScope": "all",
    "amountUsd": 5000,
    "period": "month",
    "mode": "track"
  }'
```

**Errors:**

- `400 Bad Request`: a developer cap above the whole-team ceiling, a
  `scopeValue` sent for `org` or missing for `dev`, or a `providerScope` other
  than `"all"`.
- `403 Forbidden`: the caller isn't an owner or finance member.
- `409 Conflict`: a cap with this scope and target already exists. Update it
  instead.

## Update a cap

```
PATCH /control/caps/{id}
```

You can change `amountUsd`, `period`, `mode`, `coolOffHours` (send `0` to
clear it) and `alertThresholds`. The scope and target can't change. To point a
cap at someone else, delete it and create a new one.

**Response (`200 OK`):** the updated cap, with a fresh `sentence`.

**Errors:**

- `400 Bad Request`: the change would leave a developer cap above the
  whole-team ceiling.
- `403 Forbidden`: the caller isn't an owner or finance member.
- `404 Not Found`: no cap with that ID in your organization.

## Delete a cap

```
DELETE /control/caps/{id}
```

The response repeats the removed cap's sentence, so you can see what went.

**Response (`200 OK`):**

```json
{
  "deleted": true,
  "sentence": "Stop AI spend at $200 for dev@example.com per week"
}
```

**Errors:**

- `400 Bad Request`: deleting this whole-team cap would leave a developer cap
  above the ceiling that applies after it.
- `403 Forbidden`: the caller isn't an owner or finance member.
- `404 Not Found`: no cap with that ID in your organization.

## Read spend

```
GET /control/spend?period=week
```

Your team's internal coding spend for the current window of that period,
worked out in UTC. Add `customerExternalId` to get one developer's number
too:

```
GET /control/spend?period=week&customerExternalId=dev@example.com
```

**Response (`200 OK`):**

```json
{
  "period": "week",
  "window": {
    "start": "2026-07-20T00:00:00.000Z",
    "end": "2026-07-26T23:59:59.999Z"
  },
  "asOf": "2026-07-23T14:05:00.000Z",
  "org": {
    "spentUsd": 42.5,
    "eventCount": 310,
    "unpricedEventCount": 0
  },
  "dev": {
    "customerExternalId": "dev@example.com",
    "spentUsd": 12.75,
    "eventCount": 88,
    "unpricedEventCount": 0
  }
}
```

- `dev` is `null` when you don't send `customerExternalId`.
- `spentUsd` is `null` when there's no priced usage in the window. That means
  "nothing to total yet", never a quiet `$0`.
- `unpricedEventCount` is how many events in the window have no price yet. If
  it's above zero, true spend is higher than `spentUsd`.
- Only events from the `claude-code` and `codex` agents count. Customer
  billing events never do.

Responses may be cached privately for up to 30 seconds. `asOf` says when the
numbers were worked out.

## Spend by repository or branch

```
GET /control/spend/breakdown?period=week&dimension=branch
```

Internal coding spend for the current window, grouped by the git repository
(`dimension=repo`) or branch (`dimension=branch`) each event was recorded on.
The response has `dimension`, `period`, `window`, `asOf`, `totals`, `rows` (each
with a `key` plus `spentUsd`, `eventCount` and `unpricedEventCount`),
`noMetadata` for events with no repository or branch, and `coveragePercent`:
how much of the activity carries a repository or branch, or `null` with no
events.

```
GET /control/spend/breakdown/drill?period=week&branchKey=example%2Fapp%23main
```

One branch row from the breakdown, split by commit and developer. `branchKey`
is the `key` exactly as the breakdown returned it (`<owner/repo>#<branch>`),
URL-encoded so the `#` survives. A `commitSha` of `null`
means no commit was recorded. The totals match that branch's row in the
breakdown.

## Read coverage

```
GET /control/coverage
```

Answers "how many of my developers actually have the cap check running?" over
the last 7 days, for each tool.

**Response (`200 OK`):**

```json
{
  "armed": 3,
  "total": 5,
  "asOf": "2026-07-23T14:05:00.000Z",
  "claudeCode": { "armed": 3, "notArmed": 1, "unknown": 0, "total": 4 },
  "codex": { "armed": 1, "notArmed": 0, "unknown": 2, "total": 3 }
}
```

Read `claudeCode` and `codex`:

- `armed`: developers for whom every machine seen using that tool had the cap
  check running.
- `notArmed`: developers with at least one machine shown not to be running it.
- `unknown`: developers the server can't vouch for, such as a meter build
  that doesn't report for that tool, or a check that didn't answer. Unknown
  never counts as armed.
- `total`: developers who used that tool in the window. Someone who uses both
  tools appears in both.

Don't rely on the top-level `armed` and `total`. They blend both tools and
can't tell you which tool is covered. `asOf` is `null` when there's been no
recent activity.

## How enforcement works

The API stores caps and reports spend. The stopping happens on each
developer's machine, through the meter set up with `init --control`. See the
[Spend Control section of the meter README](../../packages/code-cost-clarity/README.md#spend-control).

- **It fails open.** A missing, broken or stale cap file never blocks anyone.
  When the numbers the check reads are more than an hour old, it lets
  everything through until the meter is sending normally again.
- **Only `enforce` caps covering all providers are applied.** A `track` cap
  never blocks anything.
- **A machine applies the whole-team cap and the cap for its own developer
  email.**
- **It stops tool calls, not tokens.** A prompt that's already running is
  already billed.
- **Codex needs one more step.** Until the developer trusts the cap check in
  Codex with `/hooks`, Codex spend is counted but its tool calls aren't
  paused.

For a hard ceiling, also set a spend limit in your Anthropic Console or OpenAI
account.

## Alert emails

Each cap emails at its alert levels, once per level per window. If several
levels are crossed at once, only the highest is sent. Recipients are the
organization's billing contact email if one is set, and otherwise every
current owner and finance member.

These emails need your email provider turned on. See
[alerts-and-notifications.md](../alerts-and-notifications.md#email).
