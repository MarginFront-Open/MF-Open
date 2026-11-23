# Errors

When a request fails, the API answers with an HTTP status code and a JSON body
that says what went wrong. This page explains each status in plain English and
what to do about it.

- [The shape of an error](#the-shape-of-an-error)
- [400 Bad Request](#400-bad-request)
- [401 Unauthorized](#401-unauthorized)
- [403 Forbidden](#403-forbidden)
- [404 Not Found](#404-not-found)
- [409 Conflict](#409-conflict)
- [413 Payload Too Large](#413-payload-too-large)
- [429 Too Many Requests](#429-too-many-requests)
- [500 Internal Server Error](#500-internal-server-error)
- [503 Service Unavailable](#503-service-unavailable)
- [502 and 504](#502-and-504)
- [A success with no body](#a-success-with-no-body)
- [Failures inside a 200](#failures-inside-a-200)
- [When nothing here matches](#when-nothing-here-matches)

## The shape of an error

Most errors look like this:

```json
{
  "statusCode": 400,
  "message": ["name should not be empty", "agentId must be a UUID"],
  "error": "Bad Request"
}
```

`message` is the useful part. For a validation error it's a list naming each
field that's wrong. For other errors it's one sentence.

Some errors also carry a `code`, a fixed string your code can branch on
without reading the message:

| `code`                      | Status | Meaning                                                      |
| --------------------------- | ------ | ------------------------------------------------------------ |
| `key_revoked`               | 401    | The key was revoked.                                         |
| `use_api_key`               | 401    | A sign-in token was sent to the usage route instead of a key. |
| `publishable_key_forbidden` | 403    | A publishable key on a route that needs a secret key.        |
| `insufficient_key_role`     | 403    | The key's role isn't allowed on this route.                   |
| `too_many_auth_failures`    | 429    | Too many failed key attempts from your address.              |
| `auth_unavailable`          | 503    | The API couldn't check your key because of its own problem.  |

## 400 Bad Request

**What happened:** something in the request is malformed.

**Common causes:**

- A required field is missing.
- A field has the wrong type: text where a number goes, a decimal where a
  whole number goes, a negative count.
- An ID isn't a valid UUID, or a date isn't valid ISO 8601.
- A value isn't one of the allowed choices.
- The body isn't valid JSON.
- On `POST /v1/usage/record`: the batch is empty or has more than 100
  records, a record sends both `model` and `services` or neither, a value is
  past its limit, or a field name isn't one the route knows
  (`property ... should not exist`).

**What to do:** read `message`. It names the field. Fix it and send again.
A `400` on the usage route rejects the whole request, so nothing in it was
saved.

## 401 Unauthorized

**What happened:** the API couldn't tell who you are.

**Common causes:**

- No `x-api-key` header.
- The key is in the wrong header, such as `Authorization: Bearer`.
- A typo when the key was copied.
- On Windows PowerShell, an empty key. See
  [authentication.md](authentication.md#windows-and-powershell).

The message for a missing, unknown or expired key is
`No valid authentication provided`. Two cases get their own message:

- **A revoked key** gets the code `key_revoked` and the date it was revoked.
- **A sign-in token on the usage route** gets the code `use_api_key`. Recording
  usage takes an API key.

**What to do:**

1. Check the header is exactly `x-api-key: mf_sk_...`.
2. Check the key with `GET /v1/verify`
   ([how](authentication.md#checking-that-a-key-works)).
3. If it's revoked, expired or lost, create a new one under **Build**, then
   **API keys**, and update the app that sends the old one.

## 403 Forbidden

**What happened:** the key is valid, but it isn't allowed to do this.

**Common causes:**

- **A publishable key (`mf_pk_...`) on a write.** Any `POST`, `PUT`, `PATCH`
  or `DELETE` with a publishable key is refused, usage recording included. Use
  a secret key.
- **A publishable key on a read.** A publishable key reaches only
  `GET /v1/verify` and `GET /v1/me/key`. Everything else (customers, invoices,
  analytics, credit balances, spend controls) answers `403` with the code
  `publishable_key_forbidden`. Use a secret key.
- **The key's role isn't allowed.** The body has the code
  `insufficient_key_role`, the key's role in `key_role` and the allowed roles
  in `required_roles`. For example, spend-cap writes need owner or finance,
  and credit top-ups need owner, admin or finance.
- **An `ingest` or `legal` key outside its scope.** Same code, with an empty
  `required_roles` and a message saying what that kind of key can reach. An
  `ingest` key can send usage, call `/v1/verify` and `/v1/me/key`, and read
  spend controls. Use a key with a higher role for anything else.
- **A route that only takes a signed-in person.** Some routes, such as
  `GET /v1/users/me` and team management, refuse every API key. Use the
  dashboard.

**What to do:** read `message`, then use a key with the right type or role.
[authentication.md](authentication.md#key-roles) lists the roles. To see a
key's role, call `GET /v1/me/key`.

## 404 Not Found

**What happened:** the thing you asked for doesn't exist in your
organization.

**Common causes:**

- A wrong or mistyped ID in the address.
- The ID of a record that was deleted.
- An ID in the body that points at nothing, such as a pricing row on
  `POST /v1/events/map-model`.
- A typo in the route itself.

**What to do:** list the resource to find the right ID, check the key belongs
to the organization you expect (`GET /v1/verify`), and check the route against
`/api-docs`.

## 409 Conflict

**What happened:** what you're creating already exists.

**Common causes:**

- A customer with an `externalId` that's already used in your organization.
- An agent with an `agentCode` that's already used.
- A signal with a name that already exists on that agent.
- Linking a pricing plan to an agent it's already linked to.
- A matter with a number that's already used.
- A spend cap with the same scope, target and provider as an existing one.
- A customer watch identical to an existing one.
- A credit top-up `idempotencyKey` reused with a different number of units,
  or on a different subscription. Reuse a key only to retry the exact same
  top-up. See [credit-balances.md](credit-balances.md).

**What to do:** update the existing record instead of creating a second one,
or pick a different ID or name.

## 413 Payload Too Large

**What happened:** a request to `POST /v1/usage/record` is over 2 MB.

**What to do:** send fewer records per request (100 at most), and keep each
record's `metadata` under 16 KB.

## 429 Too Many Requests

There are two kinds. The body tells them apart.

### Too many requests

**What happened:** you're calling faster than the rate limit. The default
limits are 1,200 requests a minute per organization, 60,000 a minute for the
usage route, and 60 a minute per address for routes that need no key. They're
set in `apps/api-nest/src/common/throttler/throttler.config.ts`
([how to change them](../make-it-yours.md#api-keys-and-rate-limits)).

The body is `{"statusCode": 429, "message": "ThrottlerException: Too Many Requests"}`.
The response says how long to wait in a `Retry-After` header. On the usage
route the header is named `Retry-After-sdk`, after the limit that applies
there.

**What to do:**

- Wait as long as the header says, then retry.
- Batch usage events, up to 100 per request, instead of one per request.

### Too many failed key attempts

**What happened:** the body has the code `too_many_auth_failures`. Too many
requests with a bad key came from your address in a short window. By default
that's 50 failures in 15 minutes, and it's only counted when the API runs with
Redis ([settings](../configuration.md#failed-key-throttle)). It's a sign the
key is wrong, not that you're calling too fast.

**What to do:** stop retrying and check the key you're sending. A request with
a valid key always goes through, block or not.

## 500 Internal Server Error

**What happened:** something failed inside the API. It's not your request.

The body is usually `{"statusCode": 500, "message": "Internal server error"}`,
with no details, so nothing internal leaks out.

**What to do:**

- Retry once after a few seconds.
- If it keeps happening, look in the API's logs for the request's time and
  route. The full error is there.

## 503 Service Unavailable

**`auth_unavailable`.** The API couldn't check your key because of a problem
on its side, such as the database not answering. Your key is probably fine.
Wait the few seconds in the `Retry-After` header and try again.

**The rate limiter isn't working.** The message says the rate limiter's store,
usually Redis, isn't responding. Depending on `RATE_LIMIT_STORE_FAILURE_MODE`,
the API refuses requests until it's back. Retry in a minute, and check
`REDIS_URL` on the API. See
[configuration.md](../configuration.md#rate-limiting-and-redis).

## 502 and 504

These come from whatever sits in front of the API, such as a reverse proxy or
load balancer, when the API doesn't answer in time or isn't running. Wait a
moment and retry. If it lasts, check that the API process is up and look at
the proxy's logs.

## A success with no body

Some routes answer `204 No Content` with an empty body, for example
`DELETE /v1/events`. The status code is the answer.

## Failures inside a 200

`POST /v1/usage/record` answers `200 OK` even when some records weren't
priced. Those records are listed in `results.failed`, each with a `code` and a
`stored` flag.

**`stored: true`:** the event is saved, without a cost. Don't send it again,
or it's stored twice. Fix the cause and the saved event is priced in place.

**`stored: false`:** the event wasn't saved. It's safe to retry.

| Code                  | Stored? | What happened                                                                                                                                                 | What to do                                                                                                                                       |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEEDS_COST_BACKFILL` | Yes     | The model and provider aren't in the price catalog, or they are but the price row has no rate for the cache tokens the event sent. The `error` says which.       | Map the model to a known price, or add the missing price or cache rate. See [usage-events.md](usage-events.md#fixing-unpriced-events).          |
| `MISSING_VOLUME_DATA` | Yes     | An LLM event without both token counts, or a per-unit event without `quantity`.                                                                                | Send the volume on future events, and fill in the saved ones with `POST /v1/events/fill-volume`.                                                 |
| `INTERNAL_ERROR`      | No      | Something failed inside the API while saving the event.                                                                                                       | Retry. If it keeps happening, check the API's logs.                                                                                              |

Example: one priced event and one unknown model in the same batch.

```json
{
  "processed": 2,
  "successful": 1,
  "failed": 1,
  "results": {
    "success": [
      {
        "customerExternalId": "acme-001",
        "agentCode": "support_bot",
        "signalName": "messages",
        "totalCostUsd": "0.0024775000",
        "eventId": "00000000-0000-4000-8000-000000000011"
      }
    ],
    "failed": [
      {
        "record": {
          "customerExternalId": "acme-001",
          "agentCode": "support_bot",
          "signalName": "messages",
          "model": "my-custom-llm",
          "modelProvider": "custom"
        },
        "code": "NEEDS_COST_BACKFILL",
        "stored": true,
        "eventId": "00000000-0000-4000-8000-000000000013",
        "error": "Model \"my-custom-llm\" (provider \"custom\") not found in service_pricing. Event stored with usageCost: null. Map this model in the MarginFront dashboard under \"Needs attention\" to calculate cost and backfill this event."
      }
    ]
  }
}
```

The entries are shortened here. [usage-events.md](usage-events.md#the-response)
has every field.

## When nothing here matches

1. Open `/api-docs` on your running API. It's built from the code, so it's the
   final word on each route's fields and status codes.
2. Look in the API's logs at the time of the request. Server errors and
   rejected keys are logged there with their cause.
3. If it's a bug, open an issue on the repository with the route, the request
   body (key removed) and the response.
