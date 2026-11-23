# Features

Each section below covers one part of MarginFront: what it is, the problem it
solves, how to use it, and how to build on it. Dashboard locations are the
names in the left menu. API paths are relative to your API address including
`/v1`, and the interactive API reference is at `/api-docs` on a running API.

- [Agents](#agents)
- [Usage metering and the model price catalog](#usage-metering-and-the-model-price-catalog)
- [Pricing plans and simulators](#pricing-plans-and-simulators)
- [Revenue attribution](#revenue-attribution)
- [Billing through Stripe](#billing-through-stripe)
- [Refunds](#refunds)
- [Customer portals](#customer-portals)
- [ROI](#roi)
- [AI Accounting](#ai-accounting)
- [MFiQ](#mfiq)
- [Internal AI spend and the Code Cost Clarity meter](#internal-ai-spend-and-the-code-cost-clarity-meter)
- [Alerts](#alerts)
- [Matters](#matters)
- [The MCP server](#the-mcp-server)
- [The SDK and React components](#the-sdk-and-react-components)
- [The plan quiz and ROI calculator](#the-plan-quiz-and-roi-calculator)
- [Teams and roles](#teams-and-roles)
- [Page layouts](#page-layouts)
- [Onboarding assistant](#onboarding-assistant)

## Agents

**What it is.** An agent is the thing you meter and price. It has a code your
app sends with each event, a set of signals (the units a customer pays for,
such as `report_generated` or `minutes`), and the pricing plans that apply to
it. An agent can be one AI feature inside a bigger product, or a standalone AI
product with its own plans and customers.

**The problem it solves.** Most products run several AI features with very
different costs. Pricing them as one blob hides which ones lose money.

**How to use it.** Open **Build**, then **Agents** to create one, or let the
first usage event create it: an event with an `agentCode` or `signalName` the
API hasn't seen creates that agent and signal, and an unknown
`customerExternalId` creates the customer. Each agent's page lists its
signals, its plans and its revenue simulator.

**Build on it.** Agents live in the `agents` table and signals in `signals`
(`packages/db/prisma/schema.prisma`). The intake that creates them is
`recordUsage` in `apps/api-nest/src/modules/sdk/sdk.service.ts`. Through the
API: `POST /agents`, `POST /signals`. Through MCP: `create_agent`,
`create_signal`, `list_agents`, `list_signals`.

## Usage metering and the model price catalog

**What it is.** Your app sends one event per billable outcome, naming the
customer, agent, signal, model and token counts. The API prices the call
against a built-in catalog of model prices and stores its cost with the event.

**The problem it solves.** Model prices differ by provider, model, input,
output and prompt cache. Without a price list you either type in every rate
or never know what a call cost.

**How to use it.** `npm run db:setup` loads 1,936 prices with no internet
needed: 1,877 from a LiteLLM snapshot that ships with the repository, and 59
built-in rows the product needs. Those are the tools that ship inside Claude
Code and Codex, which the cost meter forwards, and the row that prices
finished work. 1,741 are priced per million tokens (with separate input,
output, cache-read and cache-write rates where the source gives them). The
rest cover speech, images, video and tool calls priced per second, character,
image or request.

To add OpenRouter prices, run `npm run db:sync-pricing`. It fetches today's
prices from OpenRouter and LiteLLM, updates the catalog, and switches off
models the sources no longer list. If OpenRouter doesn't answer, it carries on
with LiteLLM alone. To skip OpenRouter on purpose, run
`npm run db:sync-pricing --workspace=@marginfront/db -- --litellm-only`.
Rebuild the snapshot file itself, from LiteLLM only, with
`npm run db:snapshot-pricing --workspace=@marginfront/db`. Both need internet.

An event whose model isn't in the catalog, or that's missing token counts, is
stored without a cost and listed under **Needs attention**, so nothing is
silently priced at zero. The SDK, the API (`POST /sdk/usage/record`) and MCP
(`record_usage`, `map_model`, `fill_volume`) all record and repair events.

**Build on it.** The math is `calculateEventCost` in
`packages/db/src/lib/model-pricing.ts`. To price your own API or MCP tool, add
a row to `BUILT_IN_ROWS` in `packages/db/scripts/sync-service-pricing.ts`
([how](make-it-yours.md#prices-for-your-own-tools)). The rules the
pricing follows are in [packages/db/CANON.md](../packages/db/CANON.md).
Licences for the price data are in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## Pricing plans and simulators

**What it is.** A plan belongs to an agent and holds one or more pricing
rules. A rule charges per use, per seat, a recurring fee or a one-time fee.
Per-use rules can be flat, volume-tiered, graduated, or a credit pool that
several signals draw down at their own rates. Rules can carry a minimum
commitment.

**The problem it solves.** Pricing AI products is guesswork until you can try
a plan against real usage before a customer sees it.

**How to use it.**

1. Create a plan from an agent's page (**Pricing plans**, then **New**), or
   copy an existing one.
2. Try it before you use it. **Unit Economics**, then **Simulator** projects
   revenue and margin for one plan, or two side by side, against volumes you
   type or a customer's real volume. It writes nothing. Each agent also has a
   **Revenue simulator** that compares up to four plans.
3. Subscribe a customer from their page, or from **Unit Economics**, then
   **Subscriptions**.
4. Move a customer to another plan by editing their subscription there. You
   give a reason, and the change is kept in the subscription's change log.
   The invoice for a period prices it on the plan the subscription has when
   the invoice is issued.
5. Retire a plan by deactivating it under **Unit Economics**, then **Plans**.
   That hides it from new subscriptions and leaves existing ones running.

**Build on it.** The tier math is one file,
`packages/db/src/lib/revenue-calc.ts`, shared by the dashboard, the API and the
invoices. The simulator calls the same functions through
`apps/dashboard/app/actions/simulate-pricing.ts`, so a new pricing model added
there shows up in the simulator and on the invoice together. Through MCP:
`create_pricing_plan`, `create_pricing_strategy`, `link_plan_to_agent`,
`create_subscription`.

## Revenue attribution

**What it is.** Every event is tied to a customer, an agent, a signal, a plan
and a model. Revenue and cost roll up along any of those, so each one has its
own margin.

**The problem it solves.** Total margin can look fine while one customer or
one agent loses money on every call.

**How to use it.** **Unit Economics**, then **Breakdown** groups cost, revenue
and margin by agent, customer, signal, plan, model or environment, with a CSV
export. Four revenue figures are kept apart on purpose: Earned (what usage
earned under each plan), Revenue (earned plus subscription fees), Billed
(issued invoices) and Collected (payments received). Events with no matching
subscription show as Unassigned rather than disappearing.

**Build on it.** An event attributes through its subscription first, then
through the active subscription for its customer, agent and signal on that
date. The definitions are in [packages/db/CANON.md](../packages/db/CANON.md),
and the readers are `getRevenueMetrics` and `getCostBreakdown` in
`@marginfront/db`. The API exposes them under `/analytics/*`; MCP has
`get_customer_revenue`, `get_cost_metrics` and `get_mrr`.

## Billing through Stripe

**What it is.** Subscriptions turn usage into invoices on each billing cycle.
Each invoice gets a payment link that opens Stripe Checkout, and Stripe's
webhook marks it paid and sends a receipt.

**The problem it solves.** Usage billing needs metering, invoicing and payment
collection to agree on the same numbers.

**How to use it.**

1. Connect Stripe under **Settings**, then **Integrations**. See
   [integrations.md](integrations.md#payments).
2. Run the scheduled billing jobs. The dispatch job issues every invoice
   that's due, builds its PDF and emails the customer a **Pay Now** link. See
   [self-hosting.md](self-hosting.md#scheduled-jobs).
3. Generate an invoice from a subscription, or send one, on the full
   invoices list: **Unit Economics**, then **Invoices**, then **View all**.

An invoice's payment link is `<dashboard>/i/<invoice ID>/pay`. It needs no
sign-in and sends the customer straight to Stripe Checkout. Invoices move from
draft to issued, then paid or overdue, or void.

**Build on it.** The payment code sits behind one interface, `PaymentAdapter`.
To add events, store PDFs or add a provider, see
[make-it-yours.md](make-it-yours.md#payments). MCP has `generate_invoice` and
`send_invoice`.

## Refunds

**What it is.** A refund of all or part of a payment. For a Stripe payment the
API asks Stripe to move the money back and records the refund as pending until
Stripe's webhook confirms it. For a payment recorded by hand it records the
refund straight away. An invoice whose payments are all refunded moves to
refunded.

**The problem it solves.** A refund has to change the money in Stripe and the
invoice in the books together, or the two drift apart.

**How to use it.** Send `POST /invoices/<invoice ID>/payments/<payment ID>/refund`
as an owner, admin or finance member, with an optional `amount` in the
payment's currency (the full payment when left out) and an optional `reason`.
A refund made in Stripe directly arrives through the same webhook. The
invoice's page in the dashboard shows each payment's refunds and the total
refunded.

**Build on it.** The refund is `InvoicesService.createRefund` in
`apps/api-nest/src/modules/invoices/invoices.service.ts`, and
`InvoiceRefundFinalizer` in the same folder settles the invoice when the
webhook arrives. To refund from the dashboard, add a button to
`apps/dashboard/src/features/invoices/PaymentHistoryPanel.tsx` that calls
`invoicesApi.createRefund` in `apps/dashboard/src/lib/api/invoices.ts`.

## Customer portals

**What it is.** A signed-in page for each of your customers, showing their
usage, what each agent did, their plan, and their invoices with payment
history. Each invoice links to its PDF once you wire in file storage (see
[make-it-yours.md](make-it-yours.md#your-file-storage-for-invoice-pdfs)).

**The problem it solves.** Customers on usage pricing ask "what am I paying
for?" The portal answers it without a support ticket.

**How to use it.** Each organization's portal is at
`<portal host>/<organization slug>/`. Customers sign in with an emailed link.
Your team can send one from the customer's page, and the API and MCP can mint a
one-hour link (`create_portal_session`). Set `PORTAL_BASE_URL` to the portal's
host. See [configuration.md](configuration.md#customer-portal).

**Build on it.** The pages are under `apps/dashboard/app/(customer-portal)`
and read from `apps/api-nest/src/modules/portal-api`. To put the same views in
your own app instead, use the `CustomerPortal`, `InvoiceList` and
`UsageChart` components from [packages/react](../packages/react/README.md).

## ROI

**What it is.** A page that answers "is AI paying for itself?" for a board or
a budget owner. It has three tabs:

- **Summary:** what AI cost and earned in the dates you pick, next to your own
  estimate of the same work without AI.
- **Finished work:** each thing your team or your product finished, how many,
  the AI cost recorded against it, and the cost for one.
- **Goals:** targets for cost, revenue, margin, margin %, cost per task, event
  count or unmapped events, each with a baseline and progress.

**The problem it solves.** AI spend is easy to count and hard to justify.
Leaders want results per dollar, not token totals.

**How to use it.**

1. Open **ROI**. Under **Summary**, fill in the "Without AI" estimate: a cost
   per item, people's time (hours and a rate), or a total for the period. It's
   saved for your organization.
2. Record finished work. The meter's `done` command records it from a
   developer's machine (see
   [packages/code-cost-clarity](../packages/code-cost-clarity/README.md)), and
   any app can send a usage event with `modelProvider: "outcome"` and
   `model: "work-item"`, which is priced at zero and listed on the tab.
3. Add goals under **Goals**. A baseline can be measured from your data as of
   the goal's start date or typed in.
4. Press **Print report** for a board-ready page that leads with the Without AI
   comparison. The same report is available as JSON at
   `<dashboard>/api/roi/report`.

**Build on it.** Every sentence and number on the page, the print and the JSON
comes from one composer, `apps/dashboard/src/features/roi/report-derivation.ts`.
Goals are the `initiatives` and `initiative_targets` tables. Add a goal metric
by adding it to the metric registry there and to the read in
`apps/dashboard/app/actions/initiatives.ts`.

## AI Accounting

**What it is.** The finance side: AI cost booked the way an accountant books
it. Open **AI Accounting**. It has three tabs:

- **Close:** a month-end checklist (record usage, map costs to GL codes,
  categorize COGS and R&D, fix account-type mismatches, sign off), a journal
  preview and **Close the books**. Closing freezes that month's numbers as a
  posted snapshot; **Reopen** discards it.
- **Cost management:** each signal's cost category (production COGS, R&D,
  sales and marketing, general and admin, internal tool) and GL code.
- **Settings:** the classification rules and the chart of accounts.

**The problem it solves.** AI cost lands in one vendor bill, but finance needs
it split into cost of revenue and operating expense, mapped to the general
ledger, and closed each month.

**How to use it.**

1. Under **Settings**, review the default classification rules. Each rule
   matches a pattern in a signal's name to a category, such as `dev` to R&D.
   Add, edit or restore them.
2. Review the default chart of accounts and add your own GL codes.
3. Under **Cost management**, apply the rules and fix any signal by hand.
4. At month end, work through **Close**, check the journal preview and close
   the period.
5. Export the period from `<dashboard>/api/export/journal` as a summary by GL
   code, balanced double-entry journal lines, or a per-event audit trail
   (`format=summary`, `journal` or `detail`).

**Build on it.** The rules are `apps/dashboard/app/actions/classification-rules.ts`,
the ledger mapping is `chart-of-accounts.ts`, the close is
`finance-period-lock.ts`, and the export is
`apps/dashboard/app/api/export/journal/route.ts`. The CSV is generic. To post
straight into your ledger, add a format in that route.

## MFiQ

**What it is.** A hygiene score from 0 to 10 for your books, with cards that
say what to fix. It's rules-based, so it costs nothing in model tokens. The
page shows:

- **The score and the fixes**, each fix worth the points it would win back.
- **Rules:** every usage event has a cost (2 points), this month's costs are
  mapped to GL codes (2), categorized (2), signals are booked to the right
  account type (1), last month's close is signed off (2), and agents are priced
  above cost (1).
- **Recommendations:** costs on the wrong side of the gross-margin line, and
  cost with no GL code.
- **Needs attention:** events that need a cost or a volume, account-type
  mismatches and low credit pools.
- **Customer alerts:** customer watches that have fired.

A rule with no data shows "No data" and the score stays blank, rather than
passing a rule it couldn't check.

**The problem it solves.** Books drift: new models arrive unpriced, new
signals arrive uncategorized. A score with the fix next to it keeps the drift
small.

**How to use it.** Open **MFiQ** and work down the fixes. Each one links to the
page that fixes it.

**Build on it.** MFiQ has no plug-in system; you extend it in code, in three
places:

1. **Facts.** `getMfiqStatus` in `apps/dashboard/app/actions/mfiq-status.ts`
   gathers what the rules read. Add your own reads here, including a call to
   your own model or service.
2. **Rules and cards.** `deriveIqScore` in
   `apps/dashboard/src/features/mfiq/iq-derivation.ts` turns facts into rules,
   fixes, recommendations and needs-attention items. Add a rule to `IqRuleId`
   and `IQ_RULE_POINTS` (the points add up to 10, and a test checks that), or
   push your own items onto `recommendations`.
3. **Tiles.** `apps/dashboard/src/features/mfiq/index.tsx` lays out the cards.
   Each card is an `AlertList`, so a new card is one more `AlertList` with your
   items.

## Internal AI spend and the Code Cost Clarity meter

**What it is.** A meter that runs on each developer's machine, records what
Claude Code and Codex spend, and files it by developer, repository, branch and
commit. **Internal AI Spend** in the dashboard shows it and sets caps.

**The problem it solves.** AI coding spend grows fast and lands on one bill
with no idea who, which repository or which branch it went to.

**How to use it.**

1. Build the meter and run `init` on each machine. See
   [packages/code-cost-clarity](../packages/code-cost-clarity/README.md).
2. Open **Internal AI Spend**. **Internal Setup** has the install kit, **AI
   spend** groups spend by repository or branch, and developers appear under
   **Unit Economics**, then **Users**.
3. Under **Caps**, set a cap for the whole organization or one developer, per
   day, week or month. A cap in track mode emails at its alert levels (50%,
   80% and 100% by default). In enforce mode, machines set up with
   `init --control` pause Claude Code and Codex tool calls once the cap is
   reached.
4. Keep a repository off the meter with `CCC_IGNORE_REPOS`, and tag spend to a
   piece of work with the meter's `work` command.

**Build on it.** The meter is `packages/code-cost-clarity`. Its records arrive
as ordinary usage events, so every report in the dashboard works on them. The
caps live in `apps/api-nest/src/modules/cost-control`. MCP has
`get_spend_controls`, `get_internal_spend_breakdown` and `create_spend_cap`.

## Alerts

**What it is.** Three kinds of email alert, checked as usage arrives and again
by the daily dispatch job:

- **Spend caps:** spending crosses one of a cap's alert levels.
- **Credit pools:** a customer's pool crosses 50%, 80% or 95% used, or runs
  out.
- **Customer watches:** a customer's cost or revenue crosses a threshold you
  set, such as "email me when this customer's cost passes $500 this month".

**The problem it solves.** You hear about a runaway customer or an empty
credit pool before the invoice does.

**How to use it.** Set caps under **Internal AI Spend**, then **Caps**. Set a
watch on a customer's page. Credit pools are set on a plan's credit-pool rule
and listed under **Unit Economics**, then **Plans**. Operator alerts about
failing customers can also go to Slack. See
[alerts-and-notifications.md](alerts-and-notifications.md).

**Build on it.** To send product alerts somewhere other than email, see
[make-it-yours.md](make-it-yours.md#alerts-to-other-channels).

## Matters

**What it is.** Matter-based billing for law firms and anyone who bills work
against a job: a case, a project or a ticket. Each matter shows its own AI
cost.

**The problem it solves.** A firm has to show which client matter each dollar
of AI work belongs to before it can bill it.

**How to use it.** Open **Matters**. It has three tabs:

- **Matters:** create matters and see each one's AI cost, with an audit
  export.
- **Rules:** routing rules that assign events to a matter automatically.
- **Unassigned:** events with no matter yet, to assign by hand.

An event joins a matter when it carries `metadata.matterId`, when a rule
matches it, or when someone assigns it. On developer machines, the meter's
`work` command tags spend to a matter. The `legal` role can open this page and
nothing else that handles money.

**Build on it.** The API is `apps/api-nest/src/modules/matters` (`/matters`,
`/matter-rules`, `/matters/unassigned`, `/matters/audit`). MCP has twelve
matter tools, from `list_matters` to `export_matter_audit`.

## The MCP server

**What it is.** A server that gives an AI assistant (Claude Desktop, Claude
Code, Cursor or any MCP client) 58 tools over your API.

**The problem it solves.** Finance and support people can ask questions and
fix data in plain language, and a developer can backfill or repair events
without writing a script.

**How to use it.** Build it and point your client at it. See
[packages/mcp](../packages/mcp/README.md).

**What it covers.** Usage recording and repair, customers, agents and signals,
pricing plans and rules, subscriptions (create and list), invoices (list,
generate and send), analytics and MRR, the price catalog, customer portal
links, spend caps and internal spend, credit balances, customer watches and
matters.

**Add a tool.** Each tool calls an API route. To add one, add a
`server.registerTool` call in `packages/mcp/src/index.ts` for a route the API
already has, or add a route and a tool together. Good places to start: ROI,
AI Accounting (classification rules, GL codes, the close and the journal
export), the MFiQ score, team members, API keys, payment provider setup, and
editing or cancelling subscriptions and plans.

## The SDK and React components

**What it is.** A Node.js library for sending usage and reading billing data,
with a small command-line tool, and a set of React components (pricing table,
invoice list and viewer, usage chart, subscription card and a full customer
portal) for your own pages.

**The problem it solves.** Instrumenting a product should take one call per
outcome, and showing customers their bill shouldn't mean building a billing
UI.

**How to use it.** See [packages.md](packages.md),
[packages/sdk](../packages/sdk/README.md) and
[packages/react](../packages/react/README.md). **Build**, then **Simulator**
in the dashboard sends real test events through the same intake, which is
handy while you wire up your app.

**Build on it.** Both packages build from this repository and read one server
address. They're the place to add a client for a new API route.

## The plan quiz and ROI calculator

**What it is.** Two React components for a pricing page. `PlanQuiz` (also
exported as `ChooseBestPlan`) asks a few questions built from your plans'
features and recommends one. `ROICalculator` shows sliders for a visitor's
current costs and works out their yearly saving and return against a plan's
price.

**The problem it solves.** A visitor comparing plans wants to know which one
fits and whether it pays for itself, before they talk to anyone.

**How to use it.** Render either one inside `<MarginFrontProvider>` and pass
your plans as `pricingPlans`, plus your `companyName`, a `brandColor` and a
`businessContext` that describes your product. The calculator picks its
inputs from that description (hiring, calls, API, storage, email, AI, video,
CRM or general software). `onSelectPlan`, `onComplete` and `onGetStarted` hand
the visitor's choice back to your page.

**Build on it.** Both live in `packages/react/src/components`. To load plans
from your API, fetch `GET /public/org/<slug or ID>/pricing` and map each
agent's `plans` to `PricingPlanV2` before you pass them in.

## Teams and roles

**What it is.** Each organization has members with roles: owner, admin,
finance, developer, member and legal. API keys carry a role too, and an
`ingest` key can send usage and make a few status reads, nothing more.

**The problem it solves.** The people who send usage, read money and change
pricing are rarely the same people.

**How to use it.** Invite people under **Settings**, then **Team**. Create
keys under **Build**, then **API keys**.

**Build on it.** The role sets are in `packages/db/src/lib/org-roles.ts`.
Dashboard pages check them with `requireRouteRoles` and server actions with
the `assert-*` helpers in `apps/dashboard/app/actions/_shared`. API routes use
`@OrgRoles` with `OrgRoleGuard`. Use the same checks on anything you add.

## Page layouts

**What it is.** **Unit Economics**, **AI Accounting** and **Build** open on a
grid of tiles: headline numbers on top and charts and tables below. Each person
arranges their own grid for each organization.

**The problem it solves.** An owner, a finance lead and an engineer look for
different numbers first.

**How to use it.** Click **Edit layout**, drag tiles within their group, use
**＋** to add a tile from the catalog, then click **Done** to save. **Reset to
default** goes back to the built-in layout. A grid holds up to 24 tiles.

**Build on it.** The catalog of tiles and metrics is
`apps/dashboard/src/lib/component-catalog.ts`, the built-in layouts are
`apps/dashboard/src/features/dashboard-shell/default-layouts.ts`, and saved
layouts go to the `user_dashboard_layouts` table through
`apps/dashboard/app/actions/dashboard-layouts.ts`. Add a tile by adding it to
the catalog and rendering it in the page's `renderTile`.

## Onboarding assistant

**What it is.** API routes that read a company's website and pricing page and
draft a billing setup from them: agents, signals, pricing plans and sample
customers, each one ready to switch on or off before anything is created.

**The problem it solves.** Turning an existing price list into agents, signals
and plans by hand is slow, and it's the first thing a new organization needs.

**How to use it.** Set `OPENAI_API_KEY` and `FIRECRAWL_API_KEY` on the API (see
[configuration.md](configuration.md#onboarding-assistant)). Send
`POST /onboarding/enhanced-preview` with a `websiteUrl`. It takes one to three
minutes and returns the draft. Send the items you keep to
`POST /onboarding/create-from-preview` with the `organizationId`, as a member
of that organization.

**Build on it.** The reading and drafting are in
`apps/api-nest/src/modules/onboarding/onboarding.service.ts`. The dashboard
calls the routes through `enhancedPreviewProxy` and writes a reviewed draft
with `createFromEnhancedPreview`, both in `apps/dashboard/app/actions/onboarding.ts`.
`WebsiteScanner` and `ReviewBillingModal` in
`apps/dashboard/src/features/quick-onboarding/components` are the scanning and
review screens. Add them as a step in
`apps/dashboard/src/features/quick-onboarding/OnboardingRouter.tsx` to put the
assistant in the setup flow.
