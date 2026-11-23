# Authentication

Every call to the API carries an API key. This page covers where keys come
from, the two key types, the role every key carries, and how to send a key
from Bash or Windows PowerShell.

- [Sending a key](#sending-a-key)
- [Two key types](#two-key-types)
- [Key roles](#key-roles)
- [Creating a key](#creating-a-key)
- [Checking that a key works](#checking-that-a-key-works)
- [Your first event](#your-first-event)
- [Windows and PowerShell](#windows-and-powershell)
- [The key identifies your organization](#the-key-identifies-your-organization)
- [Every keyed call is logged](#every-keyed-call-is-logged)
- [Keeping keys safe](#keeping-keys-safe)

## Sending a key

Put the key in the `x-api-key` header on every request:

```
x-api-key: mf_sk_...
```

There's no token exchange and no refresh. One header, one key, every request.

Bash:

```bash
curl https://billing.example.com/v1/verify \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

Windows PowerShell:

```powershell
curl.exe https://billing.example.com/v1/verify `
  -H "x-api-key: $env:MF_API_SECRET_KEY"
```

On Windows the two aren't interchangeable. See
[Windows and PowerShell](#windows-and-powershell).

With the SDK, pass the key and your API address to the client and it sends the
header for you:

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1",
});
```

Leave out `baseUrl` and the SDK reads `MARGINFRONT_API_URL` instead. Build the
SDK from this repository first: see [packages.md](../packages.md).

## Two key types

| Key type    | Starts with | Where it belongs            | What it can do                                                    |
| ----------- | ----------- | --------------------------- | ----------------------------------------------------------------- |
| Secret      | `mf_sk_`    | Your servers only           | Whatever its [role](#key-roles) allows.                           |
| Publishable | `mf_pk_`    | Browser code, if you need it | `GET /v1/verify` and `GET /v1/me/key`. Nothing else, and no writes. |

What happens with the wrong one:

- A publishable key on any `POST`, `PUT`, `PATCH` or `DELETE` gets `403` with
  a message telling you to use a secret key. That includes
  `POST /v1/usage/record`.
- A publishable key on any other read (customers, invoices, analytics, credit
  balances, spend controls) gets `403` with the code
  `publishable_key_forbidden`.
- A secret key in browser code works, and anyone who opens the page can copy
  it. Don't.

For a customer-facing billing page, use neither. Use
[portal sessions](portal-sessions.md), which hand out short-lived links scoped
to one customer.

## Key roles

Every secret key carries a role, and the API always checks it. The roles are
the same as the team roles: owner, admin, developer, finance, member and
legal, plus `ingest`, which exists only for keys.

| Role                                 | What the key can reach                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest`                             | Send usage (`POST /v1/usage/record`), confirm its organization (`GET /v1/verify`, `GET /v1/me/key`), and read spend controls (`GET /v1/control/caps`, `/control/spend`, `/control/coverage`). Nothing else. |
| `legal`                              | Everything `ingest` can, plus matters, matter rules, assigning events to matters and the matter audit export.                                                                |
| `member`                             | Read routes that any member can read.                                                                                                                                        |
| `developer`, `finance`, `admin`, `owner` | The same routes a person with that team role can use.                                                                                                                    |

A few examples of how the roles split:

- Creating customers, agents and signals, mapping unknown models and deleting
  usage events need owner, admin or developer.
- Moving money (credit top-ups, for example) needs owner, admin or finance.
- Spend-cap writes need owner or finance.
- A few routes take only a signed-in person and refuse every key, for example
  `GET /v1/users/me` and team management.

When a key's role isn't allowed, the API answers `403` with the code
`insufficient_key_role`, the key's role in `key_role`, and the allowed roles
in `required_roles`. An `ingest` or `legal` key that reaches past its scope
gets the same code with an empty `required_roles` and a message that says what
that kind of key can reach. See [errors.md](errors.md#403-forbidden).

The role sets live in `packages/db/src/lib/org-roles.ts`. API routes check
them with `@OrgRoles` and `OrgRoleGuard`, and the ingest limit is
`IngestKeyScopeGuard` in `apps/api-nest/src/common/guards/ingest-key-scope.guard.ts`.

To ask the API which role and type a key has, call `GET /v1/me/key`. It works
for every key, including publishable and `ingest` keys:

```json
{ "role": "developer", "keyType": "secret" }
```

## Creating a key

1. In the dashboard, open **Build**, then **API keys**.
2. Create a key pair and pick the role for its secret half. It defaults to
   `ingest`, the least a key can do. You can only pick roles up to your own:
   a developer can make `ingest`, `member` and `developer` keys, finance can
   make `ingest`, `member` and `finance` keys, admins can make everything but
   `owner`, owners can make any role, and members can't make keys.
3. Copy the secret key (`mf_sk_...`) when it's shown. The dashboard shows it
   once and never again. Lose it and you make a new pair.

The publishable half (`mf_pk_...`) stays visible in the list.

Keys made in the dashboard don't expire. They work until you revoke them. To
issue keys that expire, see
[make-it-yours.md](../make-it-yours.md#api-keys-and-rate-limits).

## Checking that a key works

`GET /v1/verify` takes no parameters. It works for every key and returns the
organization the key belongs to.

Bash:

```bash
curl https://billing.example.com/v1/verify \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

Windows PowerShell:

```powershell
curl.exe https://billing.example.com/v1/verify `
  -H "x-api-key: $env:MF_API_SECRET_KEY"
```

A working key gets `200`:

```json
{
  "organization": {
    "id": "00000000-0000-4000-8000-000000000001",
    "name": "Acme"
  },
  "verified": true,
  "createdAt": "2026-04-11T16:45:27.012Z",
  "updatedAt": "2026-04-11T16:47:29.475Z"
}
```

**`401`.** The key is missing, mistyped or not one this API knows. Check the
header name is `x-api-key`, not `Authorization: Bearer`. A revoked key gets
`401` with the code `key_revoked` and the date it was revoked.

**`401` on Windows with a key you know is good.** You almost certainly sent an
empty key. See [Windows and PowerShell](#windows-and-powershell).

**`403`.** The key is valid but can't reach this route: a publishable key on
anything but `/verify` and `/me/key`, or a role that isn't allowed. The body
says which.

**Connection refused or a timeout.** The API isn't running at that address. On
your own machine, start it with
`npm run dev -- --filter=@marginfront/api-nest` from the repository root.

## Your first event

You don't create anything before your first event. Three of the fields are
names you make up:

- `customerExternalId`: your own ID for the user or company. In real code,
  the ID your database already uses.
- `agentCode`: a stable name for the agent doing the work.
- `signalName`: what the customer pays for.

Send whatever strings you like, and reuse the same ones for the same customer,
agent and signal. The first event that names each one creates it.

Bash:

```bash
curl -X POST https://billing.example.com/v1/usage/record \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "customerExternalId": "test_user_001",
        "agentCode": "report_writer",
        "signalName": "report_generated",
        "model": "gpt-4o",
        "modelProvider": "openai",
        "inputTokens": 523,
        "outputTokens": 117
      }
    ]
  }'
```

Windows PowerShell:

```powershell
$body = @'
{
  "records": [
    {
      "customerExternalId": "test_user_001",
      "agentCode": "report_writer",
      "signalName": "report_generated",
      "model": "gpt-4o",
      "modelProvider": "openai",
      "inputTokens": 523,
      "outputTokens": 117
    }
  ]
}
'@

$body | curl.exe -X POST https://billing.example.com/v1/usage/record `
  -H "x-api-key: $env:MF_API_SECRET_KEY" `
  -H "Content-Type: application/json" `
  -d '@-'
```

A response with `"successful": 1` means the event landed and the customer,
agent and signal now exist. The full field list and response are in
[usage-events.md](usage-events.md).

## Windows and PowerShell

The examples in these pages are written for Bash. In Windows PowerShell, three
things change. Miss any of them and you get a `401` that looks like a bad key
but is really an empty one.

| What you want   | Bash (macOS, Linux, WSL, Git Bash) | Windows PowerShell               |
| --------------- | ---------------------------------- | -------------------------------- |
| Set the key     | `export MF_API_SECRET_KEY="..."`   | `$env:MF_API_SECRET_KEY = "..."` |
| Read the key    | `$MF_API_SECRET_KEY`               | `$env:MF_API_SECRET_KEY`         |
| Run curl        | `curl`                             | `curl.exe`                       |
| Continue a line | `\`                                | `` ` `` (backtick)               |

**Why `$env:` matters.** PowerShell keeps its own variables apart from
environment variables. `$MF_API_SECRET_KEY` names a PowerShell variable that
was never set, so it turns into an empty string. The request goes out with an
empty `x-api-key` header and comes back `401`, with no warning first.

**Why `curl.exe` and not `curl`.** In Windows PowerShell 5.1, the version on
every Windows machine, `curl` is a built-in alias for `Invoke-WebRequest`, a
different command whose parameters don't match curl's. It fails with a
parameter error. PowerShell 7 dropped the alias, but `curl.exe` works in both.
Windows 10 and later ship real curl.

**Sending a JSON body.** Put the JSON in a literal here-string and pipe it to
curl. The `@'` and `'@` markers stop PowerShell from touching what's inside,
and the closing `'@` has to start at the beginning of its own line.

```powershell
$body = @'
{
  "name": "Acme",
  "externalId": "acme-001"
}
'@

$body | curl.exe -X POST https://billing.example.com/v1/customers `
  -H "x-api-key: $env:MF_API_SECRET_KEY" `
  -H "Content-Type: application/json" `
  -d '@-'
```

**Pipe the body, don't pass it as an argument.** `-d '@-'` tells curl to read
the body from standard input, which the pipe feeds. The obvious `-d $body`
breaks on Windows PowerShell 5.1 and PowerShell 7.0 to 7.2: when those pass an
argument with spaces to a program, they strip its double quotes, so the JSON
arrives as `{name: Acme, externalId: acme-001}` and the API rejects it.
PowerShell 7.3 changed that, but piping works on every version. Check yours
with `$PSVersionTable.PSVersion`.

Only arguments with double quotes inside are affected. Headers like
`-H "x-api-key: ..."` and quoted addresses pass through unchanged.

**Quote any address with a query string.** `&` is reserved in PowerShell. With
an unquoted `...?startDate=X&endDate=Y`, Windows PowerShell 5.1 refuses the
line ("The ampersand (&) character is not allowed"), and PowerShell 7 cuts the
command at the `&`, runs the first half as a background job and errors on the
rest. Quote the address and neither happens:

```powershell
curl.exe "https://billing.example.com/v1/events?startDate=2026-04-01&endDate=2026-04-30" `
  -H "x-api-key: $env:MF_API_SECRET_KEY"
```

**Check the variable is set.** Run `$env:MF_API_SECRET_KEY.Length`. A number
means it's set in this window. A blank line or an error means it isn't. This
checks without printing the key.

**A `401` with a key you know is good.** Check these in order. Each one sends
an empty or broken key:

1. You wrote `$MF_API_SECRET_KEY` instead of `$env:MF_API_SECRET_KEY`.
2. You ran `curl` instead of `curl.exe`.
3. You set the variable in a different window from the one you're calling
   from.

A variable set with `$env:` lasts only in the window that set it. To keep it,
run `setx MF_API_SECRET_KEY "mf_sk_..."` once and open a new window, or use
**System Properties**, then **Environment Variables**.

**Rather use Bash?** WSL and Git Bash run the Bash examples as written,
including `export`, `$VAR`, plain `curl` and `\` line endings.

## The key identifies your organization

You never pass an organization ID. The API looks up the key, finds the
organization it belongs to and uses that for the request. To see your
organization's ID, call `GET /v1/verify` and read `organization.id`.

## Every keyed call is logged

Each request that authenticates with an API key writes one row to the
`api_key_usage_logs` table in your database:

- the key's ID (never the key itself)
- your organization's ID
- the method and path
- the response status
- the caller's IP address
- the time of the request

There's no dashboard page for it. Query the table directly when you need to
answer "which key did what, and when". The writer is
`AuditLoggingInterceptor` in
`apps/api-nest/src/common/interceptors/audit-logging.interceptor.ts`.

## Keeping keys safe

- Never commit a key to git, in code, config or comments. Load it from an
  environment variable or your platform's secret store.
- Never put a secret key in browser code.
- Use separate keys for development, staging and production.
- Give each key the lowest role that does its job. A service that only sends
  usage needs an `ingest` key.

For local development, keep the key in a file your framework reads, such as
`.env.local`, and make sure git ignores it.

**If a key leaks:**

1. Create a replacement under **Build**, then **API keys**.
2. Switch your app or deployment to the new key.
3. Revoke the leaked key on the same page.
4. Check `api_key_usage_logs` for calls from that key you don't recognize.

After you revoke it, the old key gets `401` with the code `key_revoked`.
