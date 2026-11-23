# Recipe: services that aren't models

Not everything your agent does is a model call. It might send a text message,
scrape pages, build a PDF, send an email or transcribe audio. MarginFront
records all of it through the same event call, so one dashboard shows the
whole cost of a job, not only the model part.

For the ideas behind `signalName` and `quantity`, see
[concepts.md](../concepts.md#choosing-a-signal-name-and-quantity).

- [How these events differ](#how-these-events-differ)
- [Where the cost comes from](#where-the-cost-comes-from)
- [Before you start](#before-you-start)
- [Text messages](#text-messages)
- [Web scraping](#web-scraping)
- [PDF reports](#pdf-reports)
- [Email](#email)
- [Speech to text](#speech-to-text)
- [Models and services in one job](#models-and-services-in-one-job)
- [Adding a price for your service](#adding-a-price-for-your-service)
- [What you set and what the API works out](#what-you-set-and-what-the-api-works-out)
- [If your MarginFront server is down](#if-your-marginfront-server-is-down)

## How these events differ

Same route (`POST /usage/record`), same SDK call (`usage.record()`). What
changes is the field that says how much:

| Event                     | How much                       | Example                             |
| ------------------------- | ------------------------------ | ----------------------------------- |
| A model priced by tokens  | `inputTokens` + `outputTokens` | 523 input tokens, 117 output tokens |
| Anything priced per unit  | `quantity`                     | 1 text sent, 12 pages scraped       |

`model` and `modelProvider` are still required. For a service that isn't a
model, they're names you choose, and they're also the key the API looks up a
price by. Pick readable ones and keep them stable.

`quantity` can be a fraction, such as `14.5` seconds. Send it as it is.

## Where the cost comes from

The price catalog that ships with the repository covers AI models, plus
speech, image, video and tool-call services priced per second, character,
image or request. It has no prices for third-party APIs such as SMS, maps,
email or scraping services, and none for tools you built yourself. See
[features.md](../features.md#usage-metering-and-the-model-price-catalog).

An event whose `model` and `modelProvider` aren't in the catalog is still
stored and still billed:

- Its cost is stored as empty, never as zero, and it's listed under **Needs
  attention**.
- Its revenue still comes from your plan: quantity times your rate.

To get a cost for it, add your own price row for that service (see
[Adding a price for your service](#adding-a-price-for-your-service)). Until
you do, the cost stays empty. Plenty of teams only need the revenue side for
these services, and that works without a price row.

## Before you start

1. A running MarginFront server and its API address including `/v1`, such as
   `https://billing.example.com/v1`.
2. A secret key (`mf_sk_...`) from the dashboard: **Build**, then **API keys**.
3. The SDK built from this repository and installed into your app. See
   [packages.md](../packages.md):

   ```bash
   npm install /path/to/marginfront/packages/sdk
   ```

4. `MARGINFRONT_API_URL` set to your API address, or `baseUrl` passed in code.

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

// One client for every event, model or not.
const mf = new MarginFrontClient(process.env.MF_API_SECRET_KEY!); // reads MARGINFRONT_API_URL
```

You don't need to create the customer, agent or signal first. The first event
with a new `customerExternalId`, `agentCode` or `signalName` creates it.

## Text messages

Your agent sends a text and you count each one.

```typescript
await sendText(customerPhone, "Your order has shipped.");

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "notification-bot",
  signalName: "sms-sent",
  model: "sms-send", // your name for the service
  modelProvider: "twilio", // who runs it
  quantity: 1, // one text sent
});
```

## Web scraping

Your research agent scrapes a site, and the number of pages changes every job.

```typescript
const pages = await scrapeSite(targetUrl);

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "research-bot",
  signalName: "pages-scraped",
  model: "web-scraper",
  modelProvider: "internal", // any name works for a tool you built
  quantity: pages.length, // 3 on one site, 50 on another
});
```

Send **one** event when the whole job finishes, with `quantity` set to the
page count. Don't send one event per page. The same goes for minutes of audio,
images in a batch or messages in a thread: one event per outcome, and
`quantity` does the counting.

`internal` isn't special to the API. It's a provider name like any other, so
this event lands under **Needs attention** with no cost until you add a row
for `web-scraper` from `internal`. If the tool costs you nothing, a row with a
price of zero says so (see below).

## PDF reports

Your reporting agent builds a PDF and you bill by the page.

```typescript
const pdf = await buildReport(customerData);
res.setHeader("Content-Type", "application/pdf");
res.send(pdf.buffer);

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "report-bot",
  signalName: "report-pages",
  model: "pdf-generator",
  modelProvider: "internal",
  quantity: pdf.pageCount, // a 1-page report and a 20-page report bill differently
});
```

## Email

```typescript
await sendEmail({ to: recipientEmail, subject: "Your weekly report", html });

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "notification-bot",
  signalName: "emails-sent",
  model: "transactional-email",
  modelProvider: "resend",
  quantity: 1,
});
```

## Speech to text

Some services that aren't chat models are in the catalog. OpenAI's
`whisper-1` is priced per second, so `quantity` is the length of the audio in
seconds and the cost is worked out for you:

```typescript
const seconds = audioDurationSeconds; // for example 92.4

await mf.usage.record({
  customerExternalId: customerId,
  agentCode: "transcriber",
  signalName: "minutes-transcribed",
  model: "whisper-1",
  modelProvider: "openai",
  quantity: seconds,
});
```

Here the signal is `minutes-transcribed` but the quantity is seconds, so the
cost comes out right and the invoice line would read in seconds. If your
customer pays per minute, keep the two apart with the
[several-services shape](#models-and-services-in-one-job): `quantity` in
minutes at the top, and the seconds inside the `whisper-1` entry.

To check whether a service is in the catalog before you send events, list it
with `GET /services?provider=openai`,
`mf.services.list({ provider: "openai" })` or the MCP tool
`list_catalog_services`.

## Models and services in one job

A place report might search the web for background, have a model write the
report, and look the place up on a maps service. To the customer that's one
report. To you it's three costs.

Send it as **one** event with a `services` array. Each entry is one service
with its own cost, and the parent event is the report:

```typescript
async function placeReport(customerId: string, placeName: string) {
  const sources = await searchWeb(placeName); // 1 search
  const draft = await writeReport(placeName, sources); // a model call
  const places = await lookUpPlaces(placeName); // several lookups

  await mf.usage.record({
    customerExternalId: customerId,
    agentCode: "place-report-bot",
    signalName: "place-reports",
    quantity: 1, // one report: this is what the customer pays for
    services: [
      { model: "web-search", modelProvider: "search-api", quantity: 1 },
      {
        model: "gemini-2.5-flash",
        modelProvider: "google",
        inputTokens: draft.inputTokens,
        outputTokens: draft.outputTokens,
      },
      {
        model: "maps-place-lookup",
        modelProvider: "google",
        quantity: places.length,
      },
    ],
  });
}
```

One event shows up in your dashboard. The model entry is priced from the
catalog. The search and maps entries have a cost once you add rows for them.
Until then the parent event's cost is empty and it's listed under **Needs
attention**, while its revenue bills as usual.

The rules for this shape:

- Send `model` and `modelProvider` at the top, or `services`, never both and
  never neither. A request that mixes them is refused with a message saying
  which to drop.
- `services` holds 1 to 100 entries.
- The top-level `quantity` is the signal count: one report is `quantity: 1`,
  however many services helped.
- Each entry carries its own volume: tokens for a model, `quantity` for a
  service priced per unit.

Don't send one event per service. Three events for one report would put three
reports in your history and, when they share a signal, bill the customer three
times.

### A model entry can carry a call count too

A model entry may have `inputTokens`, `outputTokens` and `quantity` together,
for example `quantity: 2` when one report took two calls. For a model priced
by tokens, `quantity` doesn't change the cost. Only the tokens do.

### The same model twice in one job

If a report takes two calls to the same model, a draft and a rewrite, record
them either way:

```typescript
// One entry per call, for a cost line per call.
services: [
  { model: "gemini-2.5-flash", modelProvider: "google", inputTokens: 4500, outputTokens: 800 },
  { model: "gemini-2.5-flash", modelProvider: "google", inputTokens: 1200, outputTokens: 400 },
];

// Or one entry with the tokens added up.
services: [
  { model: "gemini-2.5-flash", modelProvider: "google", inputTokens: 5700, outputTokens: 1200, quantity: 2 },
];
```

Both give the same total cost.

## Adding a price for your service

A price row tells the API what one unit of your service costs you. Rows you
add go in `BUILT_IN_ROWS` in `packages/db/scripts/sync-service-pricing.ts`.
The full steps are in
[make-it-yours.md](../make-it-yours.md#prices-for-your-own-tools).

The row has to match what your events send. The part of `externalId` after
the last `/`, in lowercase, must equal the event's `model`, and `provider`
must equal its `modelProvider`. For the text-message example above:

```ts
{
  externalId: "twilio/sms-send", // matches model "sms-send"
  displayName: "Text message",
  provider: "twilio", // matches modelProvider "twilio"
  serviceType: "SMS",
  inputCost: 8, // your real price, in dollars per costUnit
  outputCost: null,
  costUnit: "1K messages",
  contextWindow: null,
  source: "builtin",
  isApi: true,
},
```

With that row, an event with `quantity: 3` costs 3 times $8 divided by 1,000.
`costUnit` must be one of `KNOWN_COST_UNITS` in the same file, such as
`1K requests`, `1K messages`, `1K emails`, `1K pages`, `minute`, `second`,
`request` or `item`.

For a tool that costs you nothing, use `costUnit: "item"` and
`inputCost: 0`. Its events then have a cost of $0 instead of an empty one and
stay off **Needs attention**.

Load the rows with `npm run db:seed-pricing`, or `npm run db:sync-pricing` if
you keep live prices. Events already waiting under **Needs attention** get
their cost when you map them to the new row there with **Map & backfill**.

## What you set and what the API works out

| Field           | You set it                               | The API works it out                                                  |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `model`         | Yes, a stable name for the service       | No                                                                    |
| `modelProvider` | Yes, who runs it                         | No                                                                    |
| `quantity`      | Yes, how many units of work              | No                                                                    |
| `inputTokens`   | Only for models priced by tokens         | No                                                                    |
| `outputTokens`  | Only for models priced by tokens         | No                                                                    |
| Cost            | No                                       | Yes, when a price row matches. Otherwise it's empty.                  |
| Revenue         | No                                       | Yes, from the customer's plan: quantity times your rate.              |

A service priced per unit with no `quantity` is stored with no cost and
flagged `MISSING_VOLUME_DATA`. See
[concepts.md](../concepts.md#events-that-need-attention).

## If your MarginFront server is down

The SDK's default `fireAndForget` mode applies here too. If the server can't
be reached, events wait in an in-memory buffer and are retried in the
background. A validation error logs a warning and drops the event. Your agent
never waits on MarginFront, which matters most here, because the text is
already sent and the PDF already built. The buffer's limits are in
[packages/sdk](../../packages/sdk/README.md#retry-buffer).

To read back revenue and cost, see
[Reading back what you earned](openai.md#reading-back-what-you-earned) in the
OpenAI recipe. It works the same for every event.
