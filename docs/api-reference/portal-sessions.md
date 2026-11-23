# Portal sessions

A portal session is a one-time link that signs one of your customers into
their billing portal: their usage, plan and invoices. Your backend creates the
link with a secret API key, you hand the link to the customer, and they never
see your key.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is built from the code and is the final word on every field.

- [How it works](#how-it-works)
- [Who can call these](#who-can-call-these)
- [Create a portal session](#create-a-portal-session)
- [List portal sessions](#list-portal-sessions)
- [Get one portal session](#get-one-portal-session)
- [Revoke a portal session](#revoke-a-portal-session)
- [Security notes](#security-notes)

## How it works

1. Your backend calls `POST /portal-sessions`.
2. The API returns a link like `https://portal.example.com/r/mgl_...`. The
   host comes from `PORTAL_BASE_URL` in the API settings. Without it the API
   uses `BETTER_AUTH_URL`, then `http://localhost:3000`. See
   [configuration.md](../configuration.md#server).
3. You send the link to the customer: an email, a text, or a "View billing"
   button in your app.
4. The customer opens it within one hour. The link is used up on that first
   open.
5. They land on your organization's portal, signed in as that customer.
6. They stay signed in for as long as `PORTAL_SESSION_DURATION_MS` in the
   dashboard settings says, one hour by default. See
   [configuration.md](../configuration.md#customer-portal).
7. Opening the same link again, or opening it after the hour is up, shows an
   error page that says the link was already used or has expired.

The link's one-hour lifetime is fixed in the API. `PORTAL_SESSION_DURATION_MS`
only changes how long the customer stays signed in after opening it.

## Who can call these

All four endpoints need a secret key (`mf_sk_...`), so call them from your
backend, never from a browser.

- No key: `401 Unauthorized`.
- A publishable key (`mf_pk_...`): `403 Forbidden`.
- An ingest-only key or a legal key: `403 Forbidden`. Those keys can't reach
  the portal.

## Create a portal session

```
POST /portal-sessions
```

**Request body:**

```json
{
  "customerExternalId": "acme-001",
  "returnUrl": "https://app.example.com/billing"
}
```

| Field                | Type     | Required         | Notes                                                                                                                                         |
| -------------------- | -------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `customerExternalId` | string   | One of these two | Your own ID for the customer, the same one you send with usage events.                                                                        |
| `customerId`         | string   | One of these two | The customer's MarginFront ID. When you send both, this one is used.                                                                          |
| `returnUrl`          | string   | No               | Must be a valid URL. It's echoed back in the response. The portal doesn't redirect to it.                                                     |
| `features`           | string[] | No               | Any of `invoices`, `subscriptions`, `usage`, `profile`. It's validated and echoed back, but the portal always shows all four sections. |

**Response (`201 Created`):**

```json
{
  "id": "00000000-0000-4000-8000-000000000101",
  "object": "portal_session",
  "url": "https://portal.example.com/r/mgl_exampletoken000000000000000000",
  "token": "mgl_exampletoken000000000000000000",
  "customerId": "00000000-0000-4000-8000-000000000001",
  "customerName": "Acme Corp",
  "customerEmail": "billing@acme.example.com",
  "expiresAt": "2026-05-13T17:30:00.000Z",
  "features": ["invoices", "subscriptions", "usage", "profile"],
  "returnUrl": "https://app.example.com/billing",
  "createdAt": "2026-05-13T16:30:00.000Z"
}
```

Give the `url` to your customer. Keep the `id` if you might want to look the
session up or revoke it. `customerName` and `customerEmail` are left out when
the customer has none.

**curl:**

```bash
curl -X POST https://billing.example.com/v1/portal-sessions \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "customerExternalId": "acme-001",
    "returnUrl": "https://app.example.com/billing"
  }'
```

**SDK:**

```ts
import { MarginFrontClient } from "@marginfront/sdk";

const mf = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});

const session = await mf.portalSessions.create({
  customerExternalId: "acme-001",
});
// send session.url to the customer
```

The SDK builds from this repository. See [packages.md](../packages.md). The
SDK also has `get`, `list` and `revoke`, and MCP has `create_portal_session`,
`get_portal_session`, `list_portal_sessions` and `revoke_portal_session`.

**Errors:**

- `400 Bad Request`: neither `customerId` nor `customerExternalId` was sent,
  or your organization has no slug, so no portal address can be built.
- `401 Unauthorized`: no key, or the key that sent the request was revoked
  while the link was being created.
- `403 Forbidden`: a publishable, ingest-only or legal key.
- `404 Not Found`: no customer in your organization matches the ID.

## List portal sessions

```
GET /portal-sessions
```

Lists the links your organization created, newest first. Handy for a
question like "did Acme open the link I sent yesterday?"

| Query parameter  | Type    | Default | Notes                                                                                   |
| ---------------- | ------- | ------- | --------------------------------------------------------------------------------------- |
| `customerId`     | string  | none    | Only links for this customer, by MarginFront ID.                                        |
| `limit`          | number  | `10`    | How many to return.                                                                     |
| `includeExpired` | boolean | `false` | `true` also returns links past their expiry. Used links that haven't expired are always listed. |

**Response (`200 OK`):** a plain JSON array, with no wrapper object and no
paging fields.

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000101",
    "object": "portal_session",
    "customerId": "00000000-0000-4000-8000-000000000001",
    "customerName": "Acme Corp",
    "customerEmail": "billing@acme.example.com",
    "expiresAt": "2026-05-13T17:30:00.000Z",
    "isExpired": false,
    "isUsed": true,
    "usedAt": "2026-05-13T16:45:12.000Z",
    "createdAt": "2026-05-13T16:30:00.000Z",
    "features": ["invoices", "subscriptions", "usage", "profile"]
  }
]
```

There's no `url` or `token` here. The API stores only a hash of the token, so
the link can't be rebuilt. If a customer lost it, create a new one.

## Get one portal session

```
GET /portal-sessions/{sessionId}
```

Returns `id`, `object`, `customerId`, `customerName`, `customerEmail`,
`expiresAt`, `features` and `createdAt` for one link. Like the list, it never
returns the `url` or `token`. To see whether a link was used, read `isUsed`
from the list.

**Errors:**

- `404 Not Found`: no link with that ID in your organization.

## Revoke a portal session

```
DELETE /portal-sessions/{sessionId}
```

Deletes the link, so it can no longer be opened. Use it when you sent a link
to the wrong person.

Revoking doesn't sign out a customer who already opened the link. They stay
signed in until their portal session ends (see `PORTAL_SESSION_DURATION_MS`
above).

**Response:** `204 No Content`.

**Errors:**

- `404 Not Found`: no link with that ID in your organization.

## Security notes

- **Create links on your backend only.** It takes a secret key. Treat that key
  like a database password.
- **One link, one open.** The first open uses it up.
- **The link is shown once.** Only the create response carries `url` and
  `token`.
- **Revoking a secret key ends all portal access for your organization.** When
  a secret key is revoked, from the dashboard or the API, every unused
  unexpired link and every signed-in portal session in your organization ends
  at once, not only those created with that key. A customer holding a link
  sees the "link expired, request a new one" page, so send them a fresh one.
  Revoking a publishable key changes nothing here, because publishable keys
  can't create links.

Related: [features.md](../features.md#customer-portals) covers the portal
itself, and [alerts-and-notifications.md](../alerts-and-notifications.md#email)
covers the portal emails your team can send from the dashboard.
