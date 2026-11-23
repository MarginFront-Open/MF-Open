# Customers

A customer is someone you bill: a person, company or account using your
product. You give each one an `externalId`, the ID your own system already
uses, and usage events name the customer by that ID.

You don't have to create a customer before you send usage. An event with a
`customerExternalId` the API hasn't seen creates the customer, with the
external ID as its name. Create one yourself when you want to set the name,
email and billing details up front.

Paths below are relative to your API address including `/v1`, for example
`https://billing.example.com/v1`. The interactive reference at `/api-docs` on
your running API is the final word on every request and response shape.

- [Who can call these routes](#who-can-call-these-routes)
- [Create a customer](#create-a-customer)
- [Read a customer](#read-a-customer)
- [Read a customer with revenue](#read-a-customer-with-revenue)
- [List customers](#list-customers)
- [Update a customer](#update-a-customer)
- [Delete a customer](#delete-a-customer)
- [Using the SDK](#using-the-sdk)

## Who can call these routes

Send a secret key (`mf_sk_...`) in the `x-api-key` header. See
[authentication.md](authentication.md).

- **Reads** work with any secret key except an ingest-only or legal key.
- **Writes** (create, update, delete) need a key whose role is owner, admin or
  developer. Any other role gets `403`.
- A publishable key (`mf_pk_...`) gets `403` on every route on this page.

## Create a customer

```
POST /customers
```

**Required:**

- `name` (string): the customer's company or full name. It appears on
  invoices.

**Optional:**

- `externalId` (string): your own ID for this customer. Usage events use it
  as `customerExternalId`. It must be unique within your organization.
- `email` (string): the billing email. Invoices are sent here.
- `phone` (string)
- `addressLine1`, `addressLine2`, `city`, `state`, `zipCode`, `country`
  (strings): the mailing address.
- `timezone` (string): defaults to your organization's timezone, or `UTC`
  when it has none.
- `status`: `active`, `inactive` or `suspended`. Defaults to `active`.
- `billingContactName` (string) and `billingContactEmail` (email): a billing
  contact, when it isn't the main contact.
- `netTerms` (number): payment terms in days. Defaults to `30`.
- `invoiceEmailRecipients` (array of emails)
- `metadata` (object): your own key/value pairs. Stored and returned, never
  read by MarginFront.

**Example:**

```bash
curl -X POST https://billing.example.com/v1/customers \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Inc",
    "externalId": "acme-001",
    "email": "billing@acme.example.com"
  }'
```

**Returns `201`** with the customer record (abridged here):

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Acme Inc",
  "externalId": "acme-001",
  "email": "billing@acme.example.com",
  "status": "active",
  "timezone": "UTC",
  "netTerms": 30,
  "createdAt": "2026-04-10T14:30:00.000Z"
}
```

**Errors:**

- `400`: `name` is missing, or a field has the wrong type, such as an email
  that isn't an email. The message names the field.
- `401`: the key is missing or wrong.
- `403`: a publishable key, or a key whose role can't write.
- `409`: another customer in your organization already has that
  `externalId`.

## Read a customer

```
GET /customers/{customerId}
```

`customerId` is the MarginFront `id` from the create response, not your
`externalId`.

```bash
curl https://billing.example.com/v1/customers/00000000-0000-4000-8000-000000000001 \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

**Errors:** `404` when no customer with that ID exists in your organization,
or it was deleted.

## Read a customer with revenue

Revenue, cost and margin for one customer over a date range. Use it for a
customer detail page.

```
GET /customers/{customerId}/revenue
```

**Query parameters (both optional):**

- `startDate`: start of the range, as an ISO date.
- `endDate`: end of the range, as an ISO date. Defaults to now.

With no `startDate`, the range is the 30 days before `endDate`.

```bash
curl "https://billing.example.com/v1/customers/00000000-0000-4000-8000-000000000001/revenue?startDate=2026-04-01&endDate=2026-04-30T23:59:59.999Z" \
  -H "x-api-key: $MF_API_SECRET_KEY"
```

It returns the same revenue object as `GET /analytics/revenue`, worked out the
same way, scoped to this customer. See
[analytics-revenue.md](analytics-revenue.md) for its fields.

## List customers

```
GET /customers
```

**Query parameters (all optional):**

- `name`, `email`: partial, case-insensitive matches.
- `status`: `active`, `inactive` or `suspended`.
- `timezone`
- `search`: matches name, email, external ID, billing contact name and
  timezone.
- `sortBy` (default `createdAt`) and `sortOrder` (`asc` or `desc`, default
  `desc`).
- `page` (default `1`) and `limit` (1 to 100, default `10`).

**Returns:**

```json
{
  "results": [],
  "page": 1,
  "limit": 10,
  "totalPages": 0,
  "totalResults": 0
}
```

In this list, each customer's `status` says whether it has an active
subscription: `active` when it has one, `inactive` when it doesn't. A single
read returns the stored status.

## Update a customer

```
PATCH /customers/{customerId}
```

Send any field from create. Only the fields you send change.

```bash
curl -X PATCH https://billing.example.com/v1/customers/00000000-0000-4000-8000-000000000001 \
  -H "x-api-key: $MF_API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone": "+1-555-0100"}'
```

Sending an empty `timezone` resets it to your organization's timezone.

**Returns `200`** with the updated customer.

**Errors:** `404` when the customer doesn't exist; `403` as for create.

## Delete a customer

```
DELETE /customers/{customerId}
```

A soft delete: the customer is hidden from reads and lists, and its invoices
and subscriptions stay in the database. **Returns `204`** with no body.

A usage event that names the deleted customer's `externalId` brings the
customer back.

**Errors:** `404` when the customer doesn't exist; `403` as for create.

## Using the SDK

Build and install the SDK from this repository first, as in
[packages.md](../packages.md). Then:

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MF_API_SECRET_KEY,
  baseUrl: "https://billing.example.com/v1", // or set MARGINFRONT_API_URL
});

const customer = await client.customers.create({
  name: "Acme Inc",
  externalId: "acme-001",
  email: "billing@acme.example.com",
});

// get, update and delete take the MarginFront id, not the externalId
const same = await client.customers.get(customer.id);
await client.customers.update(customer.id, { phone: "+1-555-0100" });
const all = await client.customers.list();

// The customer and its revenue in one call. Both requests run in parallel.
const { revenue } = await client.customers.getWithRevenue(customer.id, {
  startDate: "2026-04-01",
  endDate: "2026-04-30T23:59:59.999Z",
});

await client.customers.delete(customer.id);
```

The SDK's customer methods call the `/sdk/customers` routes. They behave like
the routes above, with these differences:

- `create` and `update` take no address fields.
- `create` answers a duplicate `externalId` with `400`, not `409`.
- `list` returns every customer, newest first, with no filters.
- `delete` also soft-deletes the customer's subscriptions.
  `DELETE /customers/{customerId}` leaves them in place.

More SDK examples are in the [SDK README](../../packages/sdk/README.md).
Through MCP: `create_customer`, `get_customer`, `list_customers` and
`get_customer_revenue`.
