# Customer alerts

A customer alert, called a watch in the dashboard, keeps an eye on one
customer's money: "email me when this customer's cost passes $500 this month",
or "email me when their revenue passes $10,000". When the number goes over the
line, the API emails the person you named and adds an in-app notification
that links to the customer's page.

You can watch two numbers:

- `cost`: what the customer costs you to serve, the same figure
  [`/analytics/cost`](analytics-cost.md) returns for that customer.
- `revenue`: what the customer earns you, the same figure
  [`/analytics/revenue`](analytics-revenue.md) returns for that customer.

Watches can also be managed on a customer's page in the dashboard, and through
MCP with `get_customer_alerts`, `create_customer_alert`,
`update_customer_alert` and `delete_customer_alert`. They all use these
endpoints.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

- [Alert emails need your email provider](#alert-emails-need-your-email-provider)
- [Who can manage watches](#who-can-manage-watches)
- [The window](#the-window)
- [List watches](#list-watches)
- [Create a watch](#create-a-watch)
- [Update a watch](#update-a-watch)
- [Delete a watch](#delete-a-watch)
- [Good to know](#good-to-know)

## Alert emails need your email provider

Watches send email through Resend. Without `RESEND_API_KEY` on the API, a
tripped watch sends nothing, records nothing and shows no in-app
notification. It's tried again on the next check, so turning email on later
still delivers it. Creating a watch works either way. See
[alerts-and-notifications.md](../alerts-and-notifications.md#email) to turn
email on, and
[spend, credit and customer alerts](../alerts-and-notifications.md#spend-credit-and-customer-alerts)
for when checks run. Revenue watches depend on the daily dispatch job, so
without a scheduler they're checked only when usage arrives.

## Who can manage watches

Every endpoint, reads included, needs an owner, admin or finance member, or a
secret key with one of those roles. Anything else gets `403 Forbidden`. A
publishable key is refused.

## The window

Each watch measures its number over a window you pick:

- `month`: the current UTC calendar month. Fires at most once a month and
  re-arms when the next month starts.
- `rolling`: the last 30 days. Fires when the number goes over the line, stays
  quiet while it stays over, and re-arms once it drops back under. It fires at
  most once per UTC day.
- `custom`: a fixed range you set with `customStartDate` and `customEndDate`.
  Fires at most once, and stops checking after the range ends.

## List watches

```
GET /customer-alerts
```

**Response (`200 OK`):**

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000701",
    "customerId": "00000000-0000-4000-8000-000000000001",
    "customerName": "Acme Corp",
    "customerExternalId": "acme-001",
    "metric": "cost",
    "thresholdUsd": 500,
    "windowMode": "month",
    "customStartDate": null,
    "customEndDate": null,
    "recipientEmail": "finance@example.com",
    "createdByUserId": null,
    "createdAt": "2026-08-01T00:00:00.000Z",
    "updatedAt": "2026-08-01T00:00:00.000Z"
  }
]
```

## Create a watch

```
POST /customer-alerts
```

**Request body:**

```json
{
  "customerId": "00000000-0000-4000-8000-000000000001",
  "metric": "cost",
  "thresholdUsd": 500,
  "windowMode": "month",
  "notifyEmail": "finance@example.com"
}
```

| Field             | Type   | Required            | Notes                                                                                                                                                                  |
| ----------------- | ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customerId`      | string | Yes                 | The customer's MarginFront ID, not your own ID for them.                                                                                                              |
| `metric`          | string | Yes                 | `cost` or `revenue`.                                                                                                                                                   |
| `thresholdUsd`    | number | Yes                 | The line, in US dollars. Above zero, up to 50,000,000. The watch trips when the number goes over it.                                                                  |
| `windowMode`      | string | Yes                 | `month`, `rolling` or `custom`.                                                                                                                                        |
| `customStartDate` | string | For `custom`        | ISO 8601 date. Only allowed with `custom`, and must be before `customEndDate`.                                                                                         |
| `customEndDate`   | string | For `custom`        | ISO 8601 date. Only allowed with `custom`.                                                                                                                             |
| `notifyEmail`     | string | Yes, with a key     | Who gets the emails. It must be the email of a current member of your organization with the owner, admin or finance role. A key has no person behind it, so it's required. |

The recipient gets a confirmation email when the watch is created (if email
is on), then an alert email and an in-app notification each time it trips.

**Response (`201 Created`):** the watch, in the same shape as the list.

```bash
curl -X POST https://billing.example.com/v1/customer-alerts \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "00000000-0000-4000-8000-000000000001",
    "metric": "cost",
    "thresholdUsd": 500,
    "windowMode": "month",
    "notifyEmail": "finance@example.com"
  }'
```

**Errors:**

- `400 Bad Request`: the customer is an internal spend account from the Code
  Cost Clarity meter (use [spend-controls.md](spend-controls.md) for that), the
  customer was deleted, the custom dates are missing, misplaced or out of
  order, `notifyEmail` is missing or doesn't belong to a member with a money
  role, or your organization already has 100 watches.
- `403 Forbidden`: the caller isn't an owner, admin or finance member.
- `404 Not Found`: no customer with that ID in your organization.
- `409 Conflict`: an identical watch already exists (same customer, metric,
  window, threshold and recipient). Edit that one instead.

## Update a watch

```
PATCH /customer-alerts/{id}
```

You can change `metric`, `thresholdUsd`, `windowMode`, `customStartDate` and
`customEndDate`. The rules are checked against the watch as it will be after
the change, so you can switch to `custom` and send its dates in one call. The
customer and the recipient are fixed. To change either, delete the watch and
create a new one.

Changing `windowMode` resets the rolling latch, so the first crossing under
the new window can fire.

**Response (`200 OK`):** the updated watch.

**Errors:**

- `400 Bad Request`: custom dates that don't fit the resulting watch.
- `403 Forbidden`: the caller isn't an owner, admin or finance member.
- `404 Not Found`: no watch with that ID in your organization.
- `409 Conflict`: the change would make the watch identical to another one.

## Delete a watch

```
DELETE /customer-alerts/{id}
```

Deleting a watch also deletes its history and its in-app notifications.

**Response (`200 OK`):**

```json
{
  "deleted": true,
  "id": "00000000-0000-4000-8000-000000000701"
}
```

**Errors:**

- `403 Forbidden`: the caller isn't an owner, admin or finance member.
- `404 Not Found`: no watch with that ID in your organization.

## Good to know

- **Each window alerts once.** A `month` watch alerts at most once a month and
  a `custom` watch at most once. A record of every alert sent is kept in the
  database, so running a check twice never sends the same alert twice.
- **Internal spend accounts can't be watched.** For your own team's Claude
  Code and Codex spend, use spend caps instead: [spend-controls.md](spend-controls.md).
- **A deleted customer stops alerting.** If the watched customer is deleted
  after the watch was created, the watch is skipped.

Related: [features.md](../features.md#alerts) for the three kinds of alert.
