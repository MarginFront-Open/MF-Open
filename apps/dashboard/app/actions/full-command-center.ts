'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import {
  getRevenueMetrics as canonGetRevenueMetrics,
  getInvoiceTotals as canonGetInvoiceTotals,
  getMrr as canonGetMrr,
  getAgentEarned as canonGetAgentEarned,
  getCostMetrics as canonGetCostMetrics,
  safeMarginPercent,
  shareOfTotal,
} from '@marginfront/db'
import {
  activeSubscriptionsWithStrategiesSelect,
  buildStrategyBySubSignal,
  earnedBucketsFromAgentEarned,
  earnedForEvent,
} from './_shared/per-event-earned'
import { parseWindowFilter } from './_shared/parse-window-filter'

/**
 * Shape of the "top metrics" section at the top of Full Platform Suite mode.
 *
 * Feeds the thin status bar (margin, collection, overdue, period label) and
 * the 6-card KPI grid right below it (Gross Margin, MRR, Invoices Sent,
 * Collection Rate, Outstanding, Overdue). Status bar and KPI row share the
 * same data sources so they wire as one unit.
 *
 * All money values are plain numbers (dollars), not Prisma Decimals, so they
 * serialize cleanly across the Server Action boundary to the client.
 */
export type FullCommandCenterTopMetrics = {
  periodLabel: string
  // Null when revenue is zero for the window (canon M1). UI renders "—".
  grossMarginPct: number | null
  // Total cost for the window from canonGetCostMetrics (canon C1).
  // Powers the Revenue mode Total Cost tile and any margin display
  // that would otherwise reverse-calculate cost from revenue and
  // marginPercent (fragile because it couples to canon M1).
  cost: number
  mrr: number
  activeSubscriptionCount: number
  // Agent-Earned = events × pricing-strategy-rate for the window. Pure
  // activity — no platform fees, no seat fees, no proration. Moves in real
  // time as agents do work, before any invoice exists. Sourced from the
  // canonical library (metrics.usageRevenue). Funnel tile leading indicator.
  earnedRevenue: number
  // Total Revenue (canon R/L2) = events × rate + recurring + seat + onetime.
  // Everything that COULD become invoice revenue once the cycle closes.
  // Powers the "Total Revenue" hero tile so the label matches what's
  // displayed (canon Agent-Earned excludes recurring/seat/onetime, which
  // would have been confusing under a "Total" label).
  totalRevenue: number
  // Billed = what got invoiced in the window (issued + overdue, per canon I2).
  // Sourced from canonGetInvoiceTotals. Includes recurring + seat fees.
  invoicesSentCount: number
  invoicesSentTotal: number
  collectedAmount: number
  collectionRate: number
  outstanding: number
  outstandingCount: number
  overdueCount: number
  overdueAmount: number
}

/**
 * Server Action: compute the top metrics row for Full command center.
 *
 * Windowing rules (picked to match what a billing ops person would expect):
 *   - Invoices counted as "in the window" when their INVOICE DATE falls
 *     inside the 30-day window (canon I3). Each invoice counts once, on
 *     the day it was actually sent. Billing-period overlap would
 *     double-count any invoice whose period spans a window boundary.
 *   - Cost from signal_events filtered by usageDate in the same 30-day
 *     window (events are spread through time so date-based filter works).
 *   - Overdue count and amount → current-state, no date filter. Overdue is
 *     a status, not a period — you want to see what's overdue right now.
 *   - MRR → sum of non-draft invoice totals for the MOST RECENT COMPLETE
 *     calendar month. On April 11, 2026 that returns March 1–31. That avoids
 *     the "partial April" underwhelming mid-month number.
 *
 * All date windows are constructed in UTC. Invoice dates in Postgres are
 * stored as timestamptz and the seed writes them at `T00:00:00Z`. Using
 * local-time constructors like `new Date(year, month, 1)` produces dates
 * 5 hours off (EST) and silently excludes the intended invoices.
 */
export async function getFullCommandCenterTopMetrics(): Promise<FullCommandCenterTopMetrics> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return emptyMetrics()
  }

  const orgId = session.session.activeOrganizationId

  // Rolling 30-day window ending now. W1: computed ONCE in UTC, threaded to
  // every canonical call below — no surface re-derives a window mid-render.
  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  // All revenue/cost/margin numbers come from the canonical library
  // (packages/db/src/lib/revenue-metrics.ts). All invoice totals come from
  // getInvoiceTotals. MRR comes from getMrr. This function only composes
  // them, with no local formula.
  //
  // Canon rule citations:
  //   C1 — cost from signal_events.usageCost by usageDate
  //   R1+R2 — revenue = events × plan + prorated sub-level fees
  //   I2 — billed = issued + overdue (accrual); collected = cash (succeeded
  //        payments net of refunds); no rule counts pending
  //   I3 — billed on invoiceDate; collected on payment paymentDate (cash-basis)
  //   M1: marginPercent null when revenue=0
  //   MRR1 — contracted recurring value of active subs (recurring + seat, monthly-normalized)
  //
  // Agent-Earned revenue (the "Earned" stage of the Earned → Billed → Collected
  // funnel) = pure activity: events × pricing-strategy rate. NO platform fees,
  // NO seat fees, NO prorations. Recurring + seat fees show up in Billed
  // (they're invoiced), not Earned.
  //
  // Called by name via canonGetAgentEarned even though the number equals
  // metrics.usageRevenue — labeling clarity at the call site is worth one
  // extra Promise.all slot (both functions share the same subs query
  // internally and Prisma pools the connections).
  const [
    metrics,
    costMetrics,
    agentEarned,
    invoiceTotals,
    mrrResult,
    activeSubCount,
    outstandingCount,
  ] = await Promise.all([
    canonGetRevenueMetrics(prisma, orgId, {
      start: windowStart,
      end: windowEnd,
    }),
    // Canonical total cost (canon C1): SUM(signal_events.usageCost) with NO
    // subscription filter. metrics.cost (getRevenueMetrics) is sub-scoped and
    // drops events with subscriptionId IS NULL, so using it would under-report
    // total cost. The cost tile must reconcile to this number.
    canonGetCostMetrics(prisma, orgId, { start: windowStart, end: windowEnd }),
    canonGetAgentEarned(prisma, orgId, { start: windowStart, end: windowEnd }),
    canonGetInvoiceTotals(prisma, orgId, {
      start: windowStart,
      end: windowEnd,
    }),
    canonGetMrr(prisma, orgId),
    prisma.subscriptions.count({
      where: {
        customers: { organizationId: orgId },
        status: 'active',
        deletedAt: null,
      },
    }),
    prisma.invoices.count({
      where: {
        organizationId: orgId,
        invoiceDate: { gte: windowStart, lte: windowEnd },
        status: { in: ['issued', 'overdue'] },
      },
    }),
  ])

  const earnedRevenue = agentEarned.revenue
  const totalRevenue = metrics.revenue

  // "Invoices Sent" = billed only (canon I2). Collected already left the
  // sent pipeline, so including it would double-count the pipeline's dollar value.
  const invoicesSentTotal = invoiceTotals.billed
  // Collection rate. NOTE: `collected` is CASH-BASIS (cash that
  // landed in the window) while `billed` stays ACCRUAL (invoiced in the window)
  // — different bases. We keep the `collected / (billed + collected)` shape on
  // purpose: it stays bounded to [0, 100] and never divides by zero, so the
  // tile can't render NaN, a negative, or an alarming >100% figure (e.g. $254
  // of old cash collected against ~$1 newly billed reads 99.6% here, where
  // `collected / billed` would show 25,400%). The trade-off is that the ratio
  // blends cash-in against (newly-billed + cash-in) rather than being a clean
  // single-basis rate.
  const collectionRate =
    shareOfTotal(
      invoiceTotals.collected,
      invoiceTotals.billed + invoiceTotals.collected
    ) ?? 0

  return {
    periodLabel: 'Last 30 days',
    // Margin recomputed on canonical total cost (not metrics.marginPercent,
    // which uses the sub-scoped getRevenueMetrics().cost). safeMarginPercent
    // returns null when revenue is 0 (canon M1) — never NaN.
    grossMarginPct: safeMarginPercent(
      metrics.revenue,
      metrics.revenue - costMetrics.cost
    ),
    cost: costMetrics.cost,
    mrr: mrrResult.mrr,
    activeSubscriptionCount: activeSubCount,
    earnedRevenue,
    totalRevenue,
    invoicesSentCount: invoiceTotals.invoicesSentCount,
    invoicesSentTotal,
    collectedAmount: invoiceTotals.collected,
    collectionRate,
    outstanding: invoiceTotals.outstanding,
    outstandingCount,
    overdueCount: invoiceTotals.overdueCount,
    overdueAmount: invoiceTotals.overdueAmount,
  }
}

/**
 * Fallback when no org is in session — all zeros, never throws.
 * Used when a user is signed in but hasn't picked an org yet, or in
 * any edge case where the session lookup fails. The dashboard renders
 * a valid empty state rather than a 500.
 */
function emptyMetrics(): FullCommandCenterTopMetrics {
  return {
    periodLabel: 'Last 30 days',
    grossMarginPct: 0,
    cost: 0,
    mrr: 0,
    activeSubscriptionCount: 0,
    earnedRevenue: 0,
    totalRevenue: 0,
    invoicesSentCount: 0,
    invoicesSentTotal: 0,
    collectedAmount: 0,
    collectionRate: 0,
    outstanding: 0,
    outstandingCount: 0,
    overdueCount: 0,
    overdueAmount: 0,
  }
}

/**
 * Shape of a single agent card in the Agent Strip row.
 *
 * One row per agent in the org, sorted by revenue DESC so the first
 * element is the "Top Agent" for the anchor card. All money values are
 * plain numbers in dollars for clean Server Action serialization.
 */
export type AgentStripRow = {
  id: string
  name: string
  shortName: string
  cost: number
  revenue: number
  margin: number
  // Null when revenue is zero (canon M1). UI renders "—".
  marginPct: number | null
  // Null when prior-window margin was zero (brand-new agents,
  // break-even agents, or agents that didn't exist yet). UI renders
  // em-dash for null. isNewAgent takes precedence visually.
  marginTrend: number | null
  // True when the agent has current-window activity but no prior-
  // window activity. UI renders "NEW" badge instead of a percent.
  isNewAgent: boolean
  color: string
  qty: number
  costPerTask: number
  revenuePerTask: number
}

// Colors assigned to agents by index. Uses the theme's chart palette so
// dark/light mode work cleanly without us shipping hex codes that would
// clash. Cycles after 5 agents — most orgs have fewer than 5.
const AGENT_COLOR_PALETTE = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]

/**
 * Pick a short display name from an agent's full name. First word,
 * capped at 12 chars. "Outreach Writer" becomes "Outreach", "Voice
 * Receptionist" becomes "Voice", etc.
 */
function deriveShortName(name: string): string {
  const firstWord = name.split(/\s+/)[0] ?? name
  return firstWord.slice(0, 12)
}

/**
 * Server Action: compute the Agent Strip row for Full command
 * center. One card per agent in the org, sorted by revenue DESC.
 *
 * Revenue per agent is canon getAgentEarned bucketed by agentId (canon R1) —
 * the SAME source the Breakdown Agent tab uses, so strip and breakdown
 * stay identical. Canon aggregates each (subscription, signal)'s window
 * quantity and prices it ONCE (graduated tiers cross, minimum-commitment
 * floors apply) and resolves subs by date-overlap (cancelled subs included).
 * NO recurring/seat/onetime/proration. The prior-window strip (for trend)
 * calls getAgentEarned again on the prior window. Qty + event counts still
 * come from the raw event walk — canon doesn't expose per-agent quantity.
 *
 * Summing each event alone under-/over-counts tiers, floors, and cancelled
 * subs, and an invoice line-item shape would include recurring/seat fees and
 * violate canon L1. Strip, Breakdown Agent tab, and getAgentEarned agree
 * within rounding.
 *
 * Cost is attributed via canonGetCostMetrics.byAgent (canon C1).
 *
 * Trend (marginTrend) compares current-window margin to the prior 30-day
 * window. Null when prior margin is zero (canon M1 convention extended
 * to trend). isNewAgent flag distinguishes brand-new agents (current
 * activity, no prior activity) for the UI's "NEW" badge.
 *
 * Same 30-day usageDate window as getFullCommandCenterTopMetrics. All
 * UTC dates.
 */
export async function getFullCommandCenterAgentStrip(): Promise<
  AgentStripRow[]
> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return []
  }

  const orgId = session.session.activeOrganizationId

  const now = new Date()
  const windowEnd = now
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)
  // Prior window for trend comparison. Same shape as Cost mode strip.
  const priorEnd = windowStart
  const priorStart = new Date(priorEnd.getTime() - 30 * MS_PER_DAY)

  // Fetch in parallel:
  //   1. Agents in the org (row set)
  //   2. Current-window signal events (qty + event count per agent — canon
  //      doesn't expose per-agent quantity)
  //   3. Prior-window signal events (for trend)
  //   4. Canon cost breakdown per agent for current window (canon C1)
  //   5. Canon cost breakdown per agent for prior window (for trend)
  //   6. Canon Agent-Earned for current window (revenue per agent)
  //   7. Canon Agent-Earned for prior window (revenue per agent, for trend)
  const [
    agents,
    currentEvents,
    priorEvents,
    currentCost,
    priorCost,
    currentEarned,
    priorEarned,
  ] = await Promise.all([
    prisma.agents.findMany({
      // IMPORTANT: agents.orgId, NOT organizationId. The schema is
      // inconsistent across models — signal_events and invoices use
      // organizationId, agents and signals use orgId.
      where: { orgId: orgId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: windowStart, lte: windowEnd },
      },
      select: {
        agentId: true,
        quantity: true,
      },
    }),
    prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: priorStart, lte: priorEnd },
      },
      select: {
        agentId: true,
        quantity: true,
      },
    }),
    canonGetCostMetrics(prisma, orgId, { start: windowStart, end: windowEnd }),
    canonGetCostMetrics(prisma, orgId, { start: priorStart, end: priorEnd }),
    canonGetAgentEarned(prisma, orgId, { start: windowStart, end: windowEnd }),
    canonGetAgentEarned(prisma, orgId, { start: priorStart, end: priorEnd }),
  ])

  // Revenue per agent = canon getAgentEarned bucketed by agentId — identical
  // to the Breakdown Agent tab. Qty + event count still from the raw walk.
  const currentEarnedByAgent = earnedBucketsFromAgentEarned(currentEarned).byAgentId
  const priorEarnedByAgent = earnedBucketsFromAgentEarned(priorEarned).byAgentId

  type PerAgentAgg = { eventCount: number; qty: number }
  const aggregatePerAgent = (
    events: typeof currentEvents
  ): Map<string, PerAgentAgg> => {
    const map = new Map<string, PerAgentAgg>()
    for (const ev of events) {
      const existing = map.get(ev.agentId) ?? { eventCount: 0, qty: 0 }
      existing.eventCount += 1
      existing.qty += Number(ev.quantity ?? 0)
      map.set(ev.agentId, existing)
    }
    return map
  }
  const currentByAgent = aggregatePerAgent(currentEvents)
  const priorByAgent = aggregatePerAgent(priorEvents)
  const currentCostByAgent = new Map(
    currentCost.byAgent.map((r) => [r.agentId, r])
  )
  const priorCostByAgent = new Map(priorCost.byAgent.map((r) => [r.agentId, r]))

  // Assemble one row per agent.
  const rows: AgentStripRow[] = agents.map((agent, index) => {
    const current = currentByAgent.get(agent.id)
    const prior = priorByAgent.get(agent.id)
    const currentCostRow = currentCostByAgent.get(agent.id)
    const priorCostRow = priorCostByAgent.get(agent.id)

    const revenue = currentEarnedByAgent.get(agent.id) ?? 0
    const cost = currentCostRow?.cost ?? 0
    const margin = revenue - cost
    // Null when revenue is zero (canon M1). UI renders "—" instead of "0%"
    // so brand-new agents with no revenue don't look like 0% margin earners.
    const marginPct = safeMarginPercent(revenue, margin)
    const qty = current?.qty ?? 0
    const costPerTask = qty > 0 ? cost / qty : 0
    const revenuePerTask = qty > 0 ? revenue / qty : 0

    // Trend: percent change in margin vs prior window. Null when prior
    // margin is zero (brand-new agents, break-even prior, or zero prior
    // activity). isNewAgent distinguishes the no-prior-activity case for
    // the UI's "NEW" badge.
    const priorRevenue = priorEarnedByAgent.get(agent.id) ?? 0
    const priorCostValue = priorCostRow?.cost ?? 0
    const priorMargin = priorRevenue - priorCostValue
    const marginTrend =
      priorMargin !== 0
        ? // eslint-disable-next-line no-restricted-syntax -- abs(priorMargin) denominator handles a negative prior margin; growthPercent's previous<=0-is-null rule would wrongly null out a loss-shrinking trend
          ((margin - priorMargin) / Math.abs(priorMargin)) * 100
        : null
    const currentEventCount = current?.eventCount ?? 0
    const priorEventCount = prior?.eventCount ?? 0
    const isNewAgent = currentEventCount > 0 && priorEventCount === 0

    return {
      id: agent.id,
      name: agent.name,
      shortName: deriveShortName(agent.name),
      cost,
      revenue,
      margin,
      marginPct,
      marginTrend,
      isNewAgent,
      color: AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
      qty,
      costPerTask,
      revenuePerTask,
    }
  })

  // Sort by revenue DESC so the client's top-agent logic reads rows[0].
  rows.sort((a, b) => b.revenue - a.revenue)

  return rows
}

/**
 * Shape for the Time Series Chart.
 *
 * Feeds a Recharts ComposedChart with 30 days of stacked per-agent cost
 * bars plus Revenue and Collections lines. The `days` array is the exact
 * shape Recharts consumes — each row has:
 *   - `date`: short human label like "Mar 12"
 *   - `Revenue`: proportionally-allocated daily revenue in dollars
 *   - `Collections`: proportionally-allocated daily collections in dollars
 *   - one numeric key per agent, keyed by the agent's UUID, value = that
 *     agent's usageCost for that day in dollars
 *
 * The `agents` array carries the stable metadata the chart needs to
 * render the bars dynamically (dataKey, color, legend label) without
 * the client having to hardcode agent names.
 */
export type TimeSeriesDay = {
  date: string
  // Earned = per-event calcRouted summed by UTC day (canon R1). Jagged
  // daily activity curve: rises and falls with events fired that day.
  // Collected deliberately NOT on this chart: one big payment day
  // auto-scales the y-axis and flattens everything else. The Revenue
  // Funnel tile + Invoice Pipeline carry Collected elsewhere.
  Earned: number
  // Agent-keyed numeric entries live here via string-indexer. The
  // type widening to `number` keeps Recharts happy at render time.
  [agentId: string]: number | string
}

export type FullCommandCenterTimeSeries = {
  days: TimeSeriesDay[]
  agents: Array<{
    id: string
    shortName: string
    color: string
  }>
}

/**
 * Server Action: compute the 30-day time series chart.
 *
 * Two data streams, same 30-day window, both UTC-day bucketed:
 *   1. Per-agent daily cost → sum of `signal_events.usageCost` via
 *      canonical getCostMetrics byDay + byAgent narrowing (canon C1).
 *   2. Earned → per-event calcRouted summed by UTC day (canon R1). Real
 *      daily activity: rises and falls with events fired that day. Uses
 *      earnedForEvent against the active subscriptions' pricing
 *      strategies. Events whose (subscription, signal) pair has no
 *      pricing strategy (cost-only signals) contribute
 *      an explicit 0 — no null pollution.
 *
 * Collected is deliberately NOT on this chart. Payments are lumpy — one
 * big payment day auto-scales the y-axis and flattens the cost bars +
 * Earned line. The Revenue Funnel tile carries Collected as an
 * aggregate; the Invoice Pipeline shows per-invoice payment state.
 *
 * UTC-indexed day bucketing avoids timezone drift. One millisecond of
 * drift would move an event between adjacent day buckets, so the entire
 * chart is computed in UTC day space.
 */
export async function getFullCommandCenterTimeSeries(): Promise<FullCommandCenterTimeSeries> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return { days: [], agents: [] }
  }

  const orgId = session.session.activeOrganizationId

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)

  // Agents first (we need the id list before we can fire the
  // per-agent canon calls below).
  const agents = await prisma.agents.findMany({
    // agents.orgId, NOT organizationId: the schema names the org column
    // differently on some models.
    where: { orgId: orgId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  // Fire per-agent canonical cost calls + the event read + subscription
  // read in parallel.
  const [perAgentCost, events, subscriptions] = await Promise.all([
    Promise.all(
      agents.map((agent) =>
        canonGetCostMetrics(
          prisma,
          orgId,
          { start: windowStart, end: windowEnd },
          { agentId: agent.id }
        ).then((metrics) => ({ agentId: agent.id, byDay: metrics.byDay }))
      )
    ),
    prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: windowStart, lte: windowEnd },
      },
      select: {
        subscriptionId: true,
        signalId: true,
        quantity: true,
        usageDate: true,
      },
    }),
    prisma.subscriptions.findMany({
      where: {
        organizationId: orgId,
        status: { in: ['active', 'pending'] },
      },
      select: activeSubscriptionsWithStrategiesSelect,
    }),
  ])

  // Short names + colors indexed by agent.id for later lookups.
  const agentMeta = agents.map((agent, index) => ({
    id: agent.id,
    shortName: deriveShortName(agent.name),
    color: AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
  }))

  // Day index math — floor UTC-ms-since-epoch by MS_PER_DAY to get
  // stable UTC day numbers. `startDayIdx` is day 0 in our window.
  const startDayIdx = Math.floor(windowStart.getTime() / MS_PER_DAY)
  const endDayIdx = Math.floor(windowEnd.getTime() / MS_PER_DAY)
  const numDays = endDayIdx - startDayIdx + 1

  // Seed one row per day with zero values for every agent + earned.
  // The row is the exact shape Recharts consumes.
  const days: TimeSeriesDay[] = []
  for (let i = 0; i < numDays; i++) {
    const dayStart = new Date((startDayIdx + i) * MS_PER_DAY)
    const row: TimeSeriesDay = {
      date: dayStart.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      Earned: 0,
    }
    // Initialize every agent's cost bucket to 0 so Recharts renders
    // continuous bars (gaps appear if the key is missing entirely).
    for (const agent of agentMeta) {
      row[agent.id] = 0
    }
    days.push(row)
  }

  // Bucket per-agent canonical day cost into the matching row.
  for (const { agentId, byDay } of perAgentCost) {
    for (const dayRow of byDay) {
      const eventDayIdx =
        Math.floor(dayRow.date.getTime() / MS_PER_DAY) - startDayIdx
      if (eventDayIdx < 0 || eventDayIdx >= numDays) continue
      const row = days[eventDayIdx]
      const prev = Number(row[agentId] ?? 0)
      row[agentId] = prev + dayRow.cost
    }
  }

  // Earned: per-event calcRouted summed by UTC day (canon R1). Events
  // on cost-only signals (no pricing strategy) contribute 0 via
  // earnedForEvent's explicit zero fallback.
  const strategyMap = buildStrategyBySubSignal(subscriptions)
  for (const event of events) {
    const dayIdx =
      Math.floor(event.usageDate.getTime() / MS_PER_DAY) - startDayIdx
    if (dayIdx < 0 || dayIdx >= numDays) continue
    const earned = earnedForEvent(strategyMap, {
      subscriptionId: event.subscriptionId,
      signalId: event.signalId,
      quantity: event.quantity,
    })
    if (earned === 0) continue
    const row = days[dayIdx]
    row.Earned = Number(row.Earned) + earned
  }

  return {
    days,
    agents: agentMeta,
  }
}

/**
 * Shape for the Invoice Pipeline + Revenue by Type side-by-side row.
 * Two cards, one data fetch — they share the invoices table
 * so we compute them together to avoid a second round-trip.
 *
 * `invoicePipeline` is a CURRENT-STATE snapshot (no date window): "here
 * is the state of every invoice in the system right now." Counts the
 * stages Draft → Sent → Paid → Overdue. Excludes `void`. The `pending`
 * enum value gets lumped into `Sent` because it's conceptually "pre-
 * send, actively queued" — not distinct enough for a dashboard stage.
 *
 * `revenueByType` is WINDOW-SCOPED to match the top metrics' 30-day view:
 * "how was the revenue I billed in the last 30 days split by billing
 * type?" Sums `invoice_line_items.amount` grouped by the line item's
 * `type` enum, filtering to invoices whose invoiceDate is in the
 * window and excluding `tax`/`discount` line items which aren't
 * "revenue" in the customer-facing sense.
 */
export type InvoicePipelineStage = {
  name: 'Draft' | 'Sent' | 'Paid' | 'Overdue'
  // Keys match the client-side STATUS_COLORS dict in command-center-
  // shared.tsx, so the component can do STATUS_COLORS[stage.colorKey]
  // without the server having to ship raw CSS values.
  colorKey: 'draft' | 'sent' | 'paid' | 'overdue'
  count: number
  amount: number
}

export type RevenueTypeRow = {
  name: 'Recurring' | 'Usage-Based' | 'One-Time' | 'Seat-Based'
  value: number
  pct: number
  color: string // plain `hsl(var(--chart-N))` string, no client lookup
}

export type FullCommandCenterPipelineAndTypes = {
  invoicePipeline: InvoicePipelineStage[]
  // Denominator the pipeline bars normalize against: the sum of non-draft
  // invoice amounts.
  invoicesSentTotal: number
  revenueByType: RevenueTypeRow[]
}

/**
 * Server Action: compute the Invoice Pipeline funnel + Revenue by Type
 * donut. Two cards in one call since they share invoice data.
 */
export async function getFullCommandCenterPipelineAndTypes(): Promise<FullCommandCenterPipelineAndTypes> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return {
      invoicePipeline: [],
      invoicesSentTotal: 0,
      revenueByType: [],
    }
  }

  const orgId = session.session.activeOrganizationId

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)

  // Two queries: the pipeline (all-time, by status) stays on invoices since
  // it's a lifecycle view, not a revenue formula. Revenue-by-type comes from
  // the canonical library — reads events × plan (R1+R2), not invoice line
  // items, so a seat fee tagged `type='recurring'` on a line item still
  // lands in the seat slice. Both paths reconcile (canon I1).
  const [allInvoices, metrics] = await Promise.all([
    prisma.invoices.findMany({
      where: {
        organizationId: orgId,
        // `pending` excluded per canon I2: no rule counts it.
        // `void` excluded because it's not part of an active pipeline view.
        status: { in: ['draft', 'issued', 'paid', 'overdue'] },
        // A draft carries no date anyone can be held to, so it stays.
        OR: [{ status: 'draft' }, { invoiceDate: { lte: now } }],
      },
      select: { id: true, status: true, totalAmount: true },
    }),
    canonGetRevenueMetrics(prisma, orgId, {
      start: windowStart,
      end: windowEnd,
    }),
  ])

  // --- Invoice Pipeline (all-time, grouped by current status) ---
  const stageBuckets = {
    Draft: { count: 0, amount: 0 },
    Sent: { count: 0, amount: 0 },
    Paid: { count: 0, amount: 0 },
    Overdue: { count: 0, amount: 0 },
  }
  const paidInvoiceIds: string[] = []
  for (const inv of allInvoices) {
    const amount = Number(inv.totalAmount)
    switch (inv.status) {
      case 'draft':
        stageBuckets.Draft.count++
        stageBuckets.Draft.amount += amount
        break
      case 'issued':
        stageBuckets.Sent.count++
        stageBuckets.Sent.amount += amount
        break
      case 'paid':
        stageBuckets.Paid.count++
        stageBuckets.Paid.amount += amount
        paidInvoiceIds.push(inv.id)
        break
      case 'overdue':
        stageBuckets.Overdue.count++
        stageBuckets.Overdue.amount += amount
        break
    }
  }

  // Subtract refunds from the Paid stage so the pipeline donut matches canon
  // Collected (net of refunds). Issued/Overdue stay gross; refunds only ever
  // apply to paid invoices, and only the donut's Paid slice is supposed to
  // mean "money kept" for the merchant.
  if (paidInvoiceIds.length > 0) {
    const refundSums = await prisma.invoice_payments.groupBy({
      by: ['invoiceId'],
      where: { invoiceId: { in: paidInvoiceIds } },
      _sum: { refunded_amount: true },
    })
    const totalRefunded = refundSums.reduce(
      (s, row) => s + Number(row._sum.refunded_amount ?? 0),
      0
    )
    stageBuckets.Paid.amount -= totalRefunded
  }

  const invoicePipeline: InvoicePipelineStage[] = [
    {
      name: 'Draft',
      colorKey: 'draft',
      count: stageBuckets.Draft.count,
      amount: stageBuckets.Draft.amount,
    },
    {
      name: 'Sent',
      colorKey: 'sent',
      count: stageBuckets.Sent.count,
      amount: stageBuckets.Sent.amount,
    },
    {
      name: 'Paid',
      colorKey: 'paid',
      count: stageBuckets.Paid.count,
      amount: stageBuckets.Paid.amount,
    },
    {
      name: 'Overdue',
      colorKey: 'overdue',
      count: stageBuckets.Overdue.count,
      amount: stageBuckets.Overdue.amount,
    },
  ]

  // "Invoices Sent" = Sent (issued) + Overdue, matching canon I2.
  // Paid invoices already left the pipeline into collections.
  const invoicesSentTotal =
    stageBuckets.Sent.amount + stageBuckets.Overdue.amount

  // --- Revenue by Type (windowed, canonical) ---
  // Slices from getRevenueMetrics' breakdown fields. Each is already the
  // result of (events × strategies) + (sub-level fee × proration) per canon
  // R1+R2, with all tier math routed through @marginfront/db canon primitives (R3),
  // full precision preserved (R4), and marginPercent=null handled at M1.
  const typeTotal =
    metrics.recurringRevenue +
    metrics.usageRevenue +
    metrics.onetimeRevenue +
    metrics.seatRevenue

  const typeRowsRaw: Array<{
    name: RevenueTypeRow['name']
    value: number
    color: string
  }> = [
    {
      name: 'Recurring',
      value: metrics.recurringRevenue,
      color: 'hsl(var(--chart-1))',
    },
    {
      name: 'Usage-Based',
      value: metrics.usageRevenue,
      color: 'hsl(var(--chart-2))',
    },
    {
      name: 'One-Time',
      value: metrics.onetimeRevenue,
      color: 'hsl(var(--chart-3))',
    },
    {
      name: 'Seat-Based',
      value: metrics.seatRevenue,
      color: 'hsl(var(--chart-4))',
    },
  ]
  const revenueByType: RevenueTypeRow[] = typeRowsRaw
    .filter((row) => row.value > 0)
    .map((row) => ({
      ...row,
      pct: shareOfTotal(row.value, typeTotal) ?? 0,
    }))

  return {
    invoicePipeline,
    invoicesSentTotal,
    revenueByType,
  }
}

/**
 * Row shape used by the 5 aggregated breakdown tabs and the
 * BreakdownChart + BreakdownTable helpers.
 */
export type BreakdownServiceRow = {
  name: string
  category: string
  cost: number
  qty: number
  events: number
  avgCost: number
  trend: number
  context: string
  // `revenue` is per-event Earned (calcRouted) for service / task / agent
  // tabs (per-activity attribution) and per-invoice Billed for customer /
  // plan tabs (invoice-keyed attribution). Platform mode renders this
  // directly with per-tab labels.
  revenue: number
  // `earned` is always per-event Earned (calcRouted) regardless of
  // dimension. Cost+Rev mode renders this for every tab as "Revenue" —
  // invoicing is not part of that mode, so the value is invoice-
  // independent and the label drops the Earned/Billed distinction.
  earned: number
  collections: number
  margin: number
  // Null when revenue is zero (canon M1). UI renders "—".
  marginPct: number | null
  marginTrend: number
}

/**
 * Customer tab rows extend the base row with invoice-count fields.
 * Same pattern as the component's inline `CustomerRow` type.
 */
export type BreakdownCustomerRow = BreakdownServiceRow & {
  invoicesSent: number
  invoicesPaid: number
  invoicesOutstanding: number
  lastPayment: string
}

export type BreakdownFilterParams = {
  startDate?: string // yyyy-MM-dd, defaults to 30 days ago
  endDate?: string // yyyy-MM-dd, defaults to now
  customerId?: string
  agentId?: string
}

export type BreakdownFilterOptions = {
  customers: { id: string; name: string }[]
  agents: { id: string; name: string }[]
  subscriptions: { customerId: string; agentId: string }[]
}

export type FullCommandCenterBreakdown = {
  service: BreakdownServiceRow[]
  task: BreakdownServiceRow[]
  agent: BreakdownServiceRow[]
  customer: BreakdownCustomerRow[]
  plan: BreakdownServiceRow[]
  filterOptions: BreakdownFilterOptions
}

/**
 * Build a single-row helper — zero-safe margin/pct math + avgCost.
 * All 5 tabs use the same final derived-field calculation, so we
 * factor it out instead of repeating it 5 times below.
 */
function buildRow(input: {
  name: string
  category: string
  context: string
  cost: number
  qty: number
  events: number
  revenue: number
  earned: number
  collections: number
}): BreakdownServiceRow {
  const margin = input.revenue - input.cost
  // Null when revenue is zero (canon M1). UI renders "—".
  const marginPct = safeMarginPercent(input.revenue, margin)
  const avgCost = input.qty > 0 ? input.cost / input.qty : 0
  return {
    name: input.name,
    category: input.category,
    context: input.context,
    cost: input.cost,
    qty: input.qty,
    events: input.events,
    avgCost,
    // trend + marginTrend are not computed (no prior-period comparison);
    // zero renders the trend badge in its neutral state.
    trend: 0,
    revenue: input.revenue,
    earned: input.earned,
    collections: input.collections,
    margin,
    marginPct,
    marginTrend: 0,
  }
}

/**
 * Server Action: compute the 5 aggregated breakdown tabs.
 *
 * One big parallel fetch + in-memory grouping into 5 row sets.
 *
 * Revenue attribution:
 *   - Agent: exact via line item → pricing strategy → agentId
 *   - Customer: invoice.customerId (exact)
 *   - Plan: invoice.subscription.planId (exact)
 *   - Service: proportional to cost share (services don't tie to
 *     invoices directly — no defensible exact metric)
 *   - Task: proportional to cost share (same reason)
 *
 * Windowed to the same 30-day invoiceDate window as the top metrics,
 * time series and revenue-by-type panels so the breakdown totals line up.
 */
export async function getFullCommandCenterBreakdown(
  filters?: BreakdownFilterParams
): Promise<FullCommandCenterBreakdown> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return {
      service: [],
      task: [],
      agent: [],
      customer: [],
      plan: [],
      filterOptions: { customers: [], agents: [], subscriptions: [] },
    }
  }

  const orgId = session.session.activeOrganizationId

  const { windowStart, windowEnd } = parseWindowFilter(filters)

  // Build conditional WHERE clauses for entity filters
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma where clause built up conditionally
  const eventsWhere: any = {
    organizationId: orgId,
    usageDate: { gte: windowStart, lte: windowEnd },
  }
  if (filters?.customerId) eventsWhere.customerId = filters.customerId
  if (filters?.agentId) eventsWhere.agentId = filters.agentId

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma where clause built up conditionally
  const invoicesWhere: any = {
    organizationId: orgId,
    // Canon I3: filter by invoiceDate so each invoice counts once on its
    // send date. A billing-period-overlap filter would double-count
    // cycle-spanning invoices.
    invoiceDate: { gte: windowStart, lte: windowEnd },
    status: { in: ['issued', 'paid', 'overdue'] },
  }
  if (filters?.customerId) invoicesWhere.customerId = filters.customerId
  if (filters?.agentId) {
    invoicesWhere.subscriptions = { agentId: filters.agentId }
  }

  // Fetch everything in parallel. Cost numbers come from the canonical
  // cost library (single source per canon C1). The raw signal_events
  // read stays in place for quantity + event metadata (model payload,
  // signalId, planId) which canon doesn't expose in its breakdowns.
  const canonFilters: {
    customerId?: string
    agentId?: string
  } = {}
  if (filters?.customerId) canonFilters.customerId = filters.customerId
  if (filters?.agentId) canonFilters.agentId = filters.agentId

  const [
    events,
    serviceChildren,
    costMetrics,
    agentEarned,
    invoices,
    allAgents,
    allCustomers,
    allSignals,
    allPlans,
    subscriptionPairs,
    activeSubStrategies,
  ] = await Promise.all([
    prisma.signal_events.findMany({
      where: eventsWhere,
      select: {
        id: true,
        agentId: true,
        customerId: true,
        signalId: true,
        subscriptionId: true,
        quantity: true,
        usageCost: true,
        subscriptions: { select: { planId: true } },
        // Childless events (no signal_event_services row) carry their model on
        // raw_ingest_events.payload->>'model'. The Model tab reads it so a
        // cost-only meter event with a model lands under that model, not "No model".
        raw_ingest_events: { select: { payload: true } },
      },
    }),
    // Service tab reads from children (multi-service canon). Single-service
    // events have one child mirroring parent, so their totals are unchanged.
    // Multi-service events fan into multiple children.
    prisma.signal_event_services.findMany({
      where: { signal_events: eventsWhere },
      select: {
        model: true,
        modelProvider: true,
        quantity: true,
        usageCost: true,
        signalEventId: true,
        service_pricing: {
          select: {
            displayName: true,
            serviceType: true,
            provider: true,
          },
        },
      },
    }),
    canonGetCostMetrics(
      prisma,
      orgId,
      { start: windowStart, end: windowEnd },
      canonFilters
    ),
    // Canon Agent-Earned for the Agent/Task/Customer/Plan Earned columns.
    // Bucketed below (earnedBucketsFromAgentEarned) so each dimension's Earned
    // is the window-aggregated, floor-applied, cancelled-inclusive canon number
    // — NOT the per-event sum, which under-/over-counts tiers, floors, and
    // cancelled subs. Same window + filters as the cost side.
    canonGetAgentEarned(
      prisma,
      orgId,
      { start: windowStart, end: windowEnd },
      canonFilters
    ),
    prisma.invoices.findMany({
      where: invoicesWhere,
      select: {
        id: true,
        customerId: true,
        totalAmount: true,
        status: true,
        invoiceDate: true,
        subscriptions: {
          select: { agentId: true, planId: true },
        },
      },
    }),
    // Reference tables — small, read fully so we can resolve names
    // without N+1 queries. All use .orgId (not organizationId): the schema
    // names the org column differently on some models.
    prisma.agents.findMany({
      where: { orgId: orgId },
      select: { id: true, name: true },
    }),
    prisma.customers.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    }),
    prisma.signals.findMany({
      where: { orgId: orgId },
      select: { id: true, name: true, type: true },
    }),
    prisma.pricing_plans.findMany({
      where: { orgId: orgId },
      select: { id: true, name: true },
    }),
    // Subscription pairs for cascading filter dropdowns (customer ↔ agent)
    prisma.subscriptions.findMany({
      where: { organizationId: orgId, status: 'active' },
      select: { customerId: true, agentId: true },
    }),
    // Active subscriptions with their pricing strategies — used to
    // compute per-event Agent-Earned revenue via calcRouted for the
    // Agent, Task, and Service tabs (canon R1/R3 per-event attribution).
    prisma.subscriptions.findMany({
      where: {
        organizationId: orgId,
        status: 'active',
        deletedAt: null,
      },
      select: activeSubscriptionsWithStrategiesSelect,
    }),
  ])

  // O(1) name/label lookups from the reference tables.
  const agentsById = new Map(allAgents.map((a) => [a.id, a]))
  const customersById = new Map(allCustomers.map((c) => [c.id, c]))
  const signalsById = new Map(allSignals.map((s) => [s.id, s]))
  const plansById = new Map(allPlans.map((p) => [p.id, p]))

  // Per-invoice refund lookup so Collections columns reflect canon I2
  // (paid net of refunds). Refunds attribute back to whichever invoice
  // they hit, so the same map serves Customer + Plan attribution.
  const paidInvoiceIdsInWindow = invoices
    .filter((inv) => inv.status === 'paid')
    .map((inv) => inv.id)
  const refundsByInvoiceId = new Map<string, number>()
  if (paidInvoiceIdsInWindow.length > 0) {
    const refundSums = await prisma.invoice_payments.groupBy({
      by: ['invoiceId'],
      where: { invoiceId: { in: paidInvoiceIdsInWindow } },
      _sum: { refunded_amount: true },
    })
    for (const row of refundSums) {
      refundsByInvoiceId.set(
        row.invoiceId,
        Number(row._sum.refunded_amount ?? 0)
      )
    }
  }

  // Revenue + Collections totals per dimension. Customer and Plan tabs
  // map exactly to invoice records (Billed basis). Agent / Task / Service
  // use per-event Earned instead — see the earnedBy* maps below.
  const revenueByCustomerId = new Map<string, number>()
  const revenueByPlanId = new Map<string, number>()
  const collectionsByCustomerId = new Map<string, number>()
  const collectionsByPlanId = new Map<string, number>()
  for (const inv of invoices) {
    const amount = Number(inv.totalAmount)
    const isPaid = inv.status === 'paid'
    const refunded = refundsByInvoiceId.get(inv.id) ?? 0
    const netCollected = amount - refunded

    // Customer revenue: exact via invoice.customerId
    revenueByCustomerId.set(
      inv.customerId,
      (revenueByCustomerId.get(inv.customerId) ?? 0) + amount
    )
    if (isPaid) {
      collectionsByCustomerId.set(
        inv.customerId,
        (collectionsByCustomerId.get(inv.customerId) ?? 0) + netCollected
      )
    }

    // Plan revenue: exact via invoice.subscription.planId
    if (inv.subscriptions?.planId) {
      revenueByPlanId.set(
        inv.subscriptions.planId,
        (revenueByPlanId.get(inv.subscriptions.planId) ?? 0) + amount
      )
      if (isPaid) {
        collectionsByPlanId.set(
          inv.subscriptions.planId,
          (collectionsByPlanId.get(inv.subscriptions.planId) ?? 0) +
            netCollected
        )
      }
    }
  }

  // Agent / Task / Customer / Plan Earned columns come from canon
  // getAgentEarned, bucketed by dimension. Canon prices each (sub, signal)'s
  // window-aggregated quantity ONCE (graduated tiers cross the window's events,
  // minimum-commitment floors apply) and resolves subs by date-overlap so
  // cancelled subs keep their history, none of which a per-event sum can do.
  // Customer/Plan render Billed (revenueByCustomerId /
  // revenueByPlanId); these Earned maps feed the Cost+Rev "Revenue" column.
  const {
    byAgentId: earnedByAgentId,
    bySignalId: earnedBySignalId,
    byCustomerId: earnedByCustomerId,
    byPlanId: earnedByPlanId,
  } = earnedBucketsFromAgentEarned(agentEarned)

  // Still per-event, and correctly so: the Service/Model tabs allocate a
  // signal's earned across ONE event's children by cost share, and the
  // "No task"/"No plan" complements price null-signal / plan-less events —
  // per-event granularity canon exposes no primitive for. calcRouted-per-event
  // matches canon on flat pricing; it diverges only on tiers/floors, which
  // never key to a service/model or the null-signal bucket here.
  const strategyBySubSignal = buildStrategyBySubSignal(activeSubStrategies)

  // Service tab earnings = signal-level earned, allocated proportionally
  // across the event's children by cost share so the per-service sum
  // never exceeds the event's earned (no double-count). Single-service
  // events allocate 100% to their one service.
  const earnedByService = new Map<string, number>()
  const childrenByEvent = new Map<
    string,
    Array<(typeof serviceChildren)[number]>
  >()
  for (const child of serviceChildren) {
    const arr = childrenByEvent.get(child.signalEventId) ?? []
    arr.push(child)
    childrenByEvent.set(child.signalEventId, arr)
  }

  // Model tab, childless half: events with no signal_event_services row never
  // reach the per-service rows above. Group the ones that carry
  // a model on raw_ingest_events.payload->>'model' (cost-only meter events)
  // by that resolved model so the tab totals back to canon C1. Cost is
  // model-derived, so a model-less childless event has no cost
  // (needs-cost-backfill) and is dropped here — no "No model" bucket.
  // Built inside the events loop below to reuse `earned`.
  type ChildlessModelAgg = {
    name: string
    cost: number
    qty: number
    events: number
    earned: number
  }
  const childlessModelGroups = new Map<string, ChildlessModelAgg>()

  for (const ev of events) {
    // Per-event earned — used ONLY for Service/Model cost-share allocation
    // below (canon exposes no per-service earned). The dimension Earned totals
    // come from canon buckets above, not this sum.
    const earned = earnedForEvent(strategyBySubSignal, ev)
    const children = childrenByEvent.get(ev.id) ?? []
    if (children.length === 0) {
      // No service children → attribute to the Model tab by resolved payload
      // model. A model-less childless event carries no cost
      // (needs-cost-backfill), so dropping it from this tab leaves canon C1
      // intact; it simply never shows a "No model" row. Its earned/
      // cost still land in the agent/customer/plan/task tabs above.
      const payload = ev.raw_ingest_events?.payload as
        | { model?: unknown }
        | null
        | undefined
      const rawModel = payload?.model
      const model =
        typeof rawModel === 'string' && rawModel.length > 0 ? rawModel : null
      if (!model) continue
      const prev = childlessModelGroups.get(model) ?? {
        name: model,
        cost: 0,
        qty: 0,
        events: 0,
        earned: 0,
      }
      prev.cost += Number(ev.usageCost ?? 0)
      prev.qty += Number(ev.quantity ?? 0)
      prev.events += 1
      prev.earned += earned
      childlessModelGroups.set(model, prev)
      continue
    }
    const totalChildCost = children.reduce(
      (s, c) => s + Number(c.usageCost ?? 0),
      0
    )
    for (const child of children) {
      const key = `${child.modelProvider}|${child.model}`
      const childCost = Number(child.usageCost ?? 0)
      // Cost-share allocation when the event has any cost; otherwise
      // even split so unresolved-cost events still attribute earnings
      // (cost null = NEEDS_COST_BACKFILL but earned can still be > 0).
      const share =
        totalChildCost > 0
          ? (childCost / totalChildCost) * earned
          : earned / children.length
      earnedByService.set(key, (earnedByService.get(key) ?? 0) + share)
    }
  }

  // Canon cost lookups, keyed by entity id — the authoritative cost
  // number for every per-entity row below. Qty + event counts still
  // come from the raw events loop since canon doesn't expose qty.
  const costByAgentCanon = new Map(
    costMetrics.byAgent.map((r) => [r.agentId, r.cost])
  )
  const costByCustomerCanon = new Map(
    costMetrics.byCustomer.map((r) => [r.customerId, r.cost])
  )
  const costBySignalCanon = new Map(
    costMetrics.bySignal
      .filter((r): r is typeof r & { signalId: string } => r.signalId !== null)
      .map((r) => [r.signalId, r.cost])
  )
  const costByPlanCanon = new Map(
    costMetrics.byPlan
      .filter((r): r is typeof r & { planId: string } => r.planId !== null)
      .map((r) => [r.planId, r.cost])
  )
  // --- Agent grouping ---
  // Cost from canon; qty/event-count from raw events (canon doesn't
  // expose qty). Union of canon + events keys so agents showing up in
  // one but not the other still render.
  const agentGroups = new Map<
    string,
    { cost: number; qty: number; events: number }
  >()
  for (const agentId of costByAgentCanon.keys()) {
    agentGroups.set(agentId, {
      cost: costByAgentCanon.get(agentId) ?? 0,
      qty: 0,
      events: 0,
    })
  }
  for (const ev of events) {
    const key = ev.agentId
    const prev = agentGroups.get(key) ?? {
      cost: costByAgentCanon.get(key) ?? 0,
      qty: 0,
      events: 0,
    }
    prev.qty += Number(ev.quantity ?? 0)
    prev.events += 1
    agentGroups.set(key, prev)
  }

  const agentRows: BreakdownServiceRow[] = Array.from(
    agentGroups.entries()
  ).map(([agentId, agg]) => {
    const rowEarned = earnedByAgentId.get(agentId) ?? 0
    return buildRow({
      name: agentsById.get(agentId)?.name ?? 'Unknown agent',
      category: '',
      context: '',
      cost: agg.cost,
      qty: agg.qty,
      events: agg.events,
      // Agent tab is per-activity (Earned, not Billed): canon getAgentEarned's
      // per-subscription usage revenue, summed by agentId. Window-aggregated
      // and floor-applied (no sub-level fees) — canon R1.
      revenue: rowEarned,
      earned: rowEarned,
      // Collections is an invoice-level concept; doesn't map to
      // activity earnings. Set to 0 for Earned tabs.
      collections: 0,
    })
  })

  // --- Task grouping (by signal name) ---
  // Cost from canon (bySignal); qty/events from raw loop.
  // Revenue = canon getAgentEarned bucketed by signalId (Earned basis), since
  // signals don't attribute to invoices directly.
  const taskGroups = new Map<
    string,
    { cost: number; qty: number; events: number }
  >()
  for (const [signalId, cost] of costBySignalCanon) {
    taskGroups.set(signalId, { cost, qty: 0, events: 0 })
  }
  // "No task" complement: events with no signalId. costBySignalCanon drops
  // canon's null bucket, so without this the Task tab under-totals by exactly
  // these events. Cost from canon's null bucket so Σ(taskRows.cost) === canon
  // C1 for any org.
  const noTaskCost =
    costMetrics.bySignal.find((r) => r.signalId === null)?.cost ?? 0
  const noTask = { cost: noTaskCost, qty: 0, events: 0, earned: 0 }
  for (const ev of events) {
    if (!ev.signalId) {
      noTask.qty += Number(ev.quantity ?? 0)
      noTask.events += 1
      noTask.earned += earnedForEvent(strategyBySubSignal, ev)
      continue
    }
    const prev = taskGroups.get(ev.signalId) ?? {
      cost: costBySignalCanon.get(ev.signalId) ?? 0,
      qty: 0,
      events: 0,
    }
    prev.qty += Number(ev.quantity ?? 0)
    prev.events += 1
    taskGroups.set(ev.signalId, prev)
  }
  const taskRows: BreakdownServiceRow[] = Array.from(taskGroups.entries()).map(
    ([signalId, agg]) => {
      const signal = signalsById.get(signalId)
      const taskEarned = earnedBySignalId.get(signalId) ?? 0
      return buildRow({
        name: signal?.name ?? 'Unknown signal',
        category: signal?.type ?? '',
        context: '',
        cost: agg.cost,
        qty: agg.qty,
        events: agg.events,
        // Task tab is per-activity (Earned, not Billed): canon getAgentEarned
        // bucketed to this signal (byStrategy → signalId), window-aggregated.
        revenue: taskEarned,
        earned: taskEarned,
        collections: 0,
      })
    }
  )
  // Append "No task" only when such events exist — no phantom $0 row. No
  // signal → no invoice mapping, so revenue mirrors per-event Earned.
  if (noTask.events > 0) {
    taskRows.push(
      buildRow({
        name: 'No task',
        category: '',
        context: '',
        cost: noTask.cost,
        qty: noTask.qty,
        events: noTask.events,
        revenue: noTask.earned,
        earned: noTask.earned,
        collections: 0,
      })
    )
  }

  // --- Service grouping (by signal_event_services.model + modelProvider) ---
  // Children carry the canonical (model, modelProvider) split. For a
  // single-service event, the one child mirrors the parent's model
  // and cost, so its totals are unchanged. Multi-service events
  // fan into multiple children, one row per distinct (model, provider).
  // Revenue per service = signal-level earned allocated by cost share
  // (computed in earnedByService above) so per-service sums never
  // exceed the event's earned.
  //
  // An org can hit hundreds of distinct model strings; the bar-chart
  // sizes its height at Math.max(200, rows * 36), so unbounded rows
  // would explode the chart. Cap at top 19 by cost, collapse the
  // long tail into one "Other" bucket so totals stay accurate.
  const SERVICE_TAB_MAX_ROWS = 19
  type ServiceAgg = {
    cost: number
    qty: number
    events: Set<string>
    displayName?: string
    serviceType?: string
    provider?: string
  }
  const serviceGroups = new Map<string, ServiceAgg>()
  for (const child of serviceChildren) {
    const key = `${child.modelProvider}|${child.model}`
    const prev = serviceGroups.get(key) ?? {
      cost: 0,
      qty: 0,
      events: new Set<string>(),
      displayName: child.service_pricing?.displayName,
      serviceType: child.service_pricing?.serviceType,
      provider: child.service_pricing?.provider ?? child.modelProvider,
    }
    prev.cost += Number(child.usageCost ?? 0)
    prev.qty += Number(child.quantity ?? 0)
    prev.events.add(child.signalEventId)
    serviceGroups.set(key, prev)
  }

  // Flatten the childed per-(model, provider) rows and the childless
  // per-resolved-model rows into one Model-tab list, then apply the existing
  // top-N + "Other" cap. Both halves contribute real cost, so
  // Σ(serviceRows.cost) === canon C1 regardless of where the cap falls.
  type ModelTabAgg = {
    name: string
    category: string
    context: string
    cost: number
    qty: number
    events: number
    earned: number
  }
  const modelTabAggs: ModelTabAgg[] = [
    ...Array.from(serviceGroups.entries()).map(([key, agg]) => {
      const [provider, model] = key.split('|')
      return {
        name: agg.displayName ?? model,
        category: agg.serviceType ?? 'Other',
        context: agg.provider ?? provider,
        cost: agg.cost,
        qty: agg.qty,
        events: agg.events.size,
        earned: earnedByService.get(key) ?? 0,
      }
    }),
    ...Array.from(childlessModelGroups.values()).map((agg) => ({
      name: agg.name,
      category: '',
      context: '',
      cost: agg.cost,
      qty: agg.qty,
      events: agg.events,
      earned: agg.earned,
    })),
  ]

  const sortedServices = modelTabAggs.sort((a, b) => b.cost - a.cost)
  const topServices = sortedServices.slice(0, SERVICE_TAB_MAX_ROWS)
  const tailServices = sortedServices.slice(SERVICE_TAB_MAX_ROWS)

  const serviceRows: BreakdownServiceRow[] = topServices.map((agg) =>
    buildRow({
      name: agg.name,
      category: agg.category,
      context: agg.context,
      cost: agg.cost,
      qty: agg.qty,
      events: agg.events,
      revenue: agg.earned,
      earned: agg.earned,
      collections: 0,
    })
  )

  if (tailServices.length > 0) {
    const tailCost = tailServices.reduce((s, agg) => s + agg.cost, 0)
    const tailQty = tailServices.reduce((s, agg) => s + agg.qty, 0)
    const tailEvents = tailServices.reduce((s, agg) => s + agg.events, 0)
    const tailEarned = tailServices.reduce((s, agg) => s + agg.earned, 0)
    serviceRows.push(
      buildRow({
        name: `Other (${tailServices.length} services)`,
        category: 'Mixed',
        context: '',
        cost: tailCost,
        qty: tailQty,
        events: tailEvents,
        revenue: tailEarned,
        earned: tailEarned,
        collections: 0,
      })
    )
  }

  // --- Customer grouping + invoice stats ---
  // Cost from canon (byCustomer); qty/events from raw loop.
  const customerEventGroups = new Map<
    string,
    { cost: number; qty: number; events: number }
  >()
  for (const [customerId, cost] of costByCustomerCanon) {
    customerEventGroups.set(customerId, { cost, qty: 0, events: 0 })
  }
  for (const ev of events) {
    const prev = customerEventGroups.get(ev.customerId) ?? {
      cost: costByCustomerCanon.get(ev.customerId) ?? 0,
      qty: 0,
      events: 0,
    }
    prev.qty += Number(ev.quantity ?? 0)
    prev.events += 1
    customerEventGroups.set(ev.customerId, prev)
  }
  // Invoice stats per customer (windowed invoices only for consistency).
  const customerInvoiceStats = new Map<
    string,
    {
      sent: number
      paid: number
      outstanding: number
      lastPayment: string
    }
  >()
  for (const inv of invoices) {
    const prev = customerInvoiceStats.get(inv.customerId) ?? {
      sent: 0,
      paid: 0,
      outstanding: 0,
      lastPayment: '',
    }
    prev.sent += 1
    if (inv.status === 'paid') {
      prev.paid += 1
      const dateStr = new Date(inv.invoiceDate).toISOString().slice(0, 10)
      if (dateStr > prev.lastPayment) prev.lastPayment = dateStr
    } else if (inv.status === 'issued' || inv.status === 'overdue') {
      prev.outstanding += 1
    }
    customerInvoiceStats.set(inv.customerId, prev)
  }
  const customerRows: BreakdownCustomerRow[] = Array.from(
    customerEventGroups.entries()
  ).map(([customerId, agg]) => {
    const customer = customersById.get(customerId)
    const stats = customerInvoiceStats.get(customerId) ?? {
      sent: 0,
      paid: 0,
      outstanding: 0,
      lastPayment: '',
    }
    const base = buildRow({
      name: customer?.name ?? 'Unknown customer',
      category: '',
      context: '',
      cost: agg.cost,
      qty: agg.qty,
      events: agg.events,
      revenue: revenueByCustomerId.get(customerId) ?? 0,
      earned: earnedByCustomerId.get(customerId) ?? 0,
      collections: collectionsByCustomerId.get(customerId) ?? 0,
    })
    return {
      ...base,
      invoicesSent: stats.sent,
      invoicesPaid: stats.paid,
      invoicesOutstanding: stats.outstanding,
      lastPayment: stats.lastPayment || '—',
    }
  })

  // --- Plan grouping ---
  // Cost from canon (byPlan); qty/events from raw loop.
  // Revenue via invoice.subscription.planId directly.
  const planGroups = new Map<
    string,
    { cost: number; qty: number; events: number }
  >()
  for (const [planId, cost] of costByPlanCanon) {
    planGroups.set(planId, { cost, qty: 0, events: 0 })
  }
  // "No plan" complement: events whose subscription carries no planId (or no
  // subscription at all — the subscriptionId-IS-NULL slice). costByPlanCanon
  // drops canon's null bucket, so without this the Plan tab under-totals by
  // exactly these events. Cost from canon's null bucket so Σ(planRows.cost)
  // === canon C1.
  const noPlanCost =
    costMetrics.byPlan.find((r) => r.planId === null)?.cost ?? 0
  const noPlan = { cost: noPlanCost, qty: 0, events: 0, earned: 0 }
  for (const ev of events) {
    const planId = ev.subscriptions?.planId
    if (!planId) {
      noPlan.qty += Number(ev.quantity ?? 0)
      noPlan.events += 1
      noPlan.earned += earnedForEvent(strategyBySubSignal, ev)
      continue
    }
    const prev = planGroups.get(planId) ?? {
      cost: costByPlanCanon.get(planId) ?? 0,
      qty: 0,
      events: 0,
    }
    prev.qty += Number(ev.quantity ?? 0)
    prev.events += 1
    planGroups.set(planId, prev)
  }
  // Also include plans that have invoice revenue but no events (edge
  // case — a plan subscribed to but never used in the window).
  for (const [planId] of revenueByPlanId) {
    if (!planGroups.has(planId)) {
      planGroups.set(planId, { cost: 0, qty: 0, events: 0 })
    }
  }
  const planRows: BreakdownServiceRow[] = Array.from(planGroups.entries()).map(
    ([planId, agg]) =>
      buildRow({
        name: plansById.get(planId)?.name ?? 'Unknown plan',
        category: '',
        context: '',
        cost: agg.cost,
        qty: agg.qty,
        events: agg.events,
        revenue: revenueByPlanId.get(planId) ?? 0,
        earned: earnedByPlanId.get(planId) ?? 0,
        collections: collectionsByPlanId.get(planId) ?? 0,
      })
  )
  // Append "No plan" only when such events exist — no phantom $0 row. No plan
  // → no plan-keyed invoice, so revenue mirrors per-event Earned.
  if (noPlan.events > 0) {
    planRows.push(
      buildRow({
        name: 'No plan',
        category: '',
        context: '',
        cost: noPlan.cost,
        qty: noPlan.qty,
        events: noPlan.events,
        revenue: noPlan.earned,
        earned: noPlan.earned,
        collections: 0,
      })
    )
  }

  return {
    service: serviceRows,
    task: taskRows,
    agent: agentRows,
    customer: customerRows,
    plan: planRows,
    filterOptions: {
      customers: allCustomers,
      agents: allAgents,
      subscriptions: subscriptionPairs,
    },
  }
}

/**
 * Shape for the Invoices tab master list.
 *
 * Unlike the 5 aggregated breakdown tabs, the Invoices tab is a
 * ledger view — users want to see every invoice in the org, not
 * just the 30-day-window slice. So this list is ALL-TIME, no
 * window filter, and the shape is specific to the invoice columns
 * shown in the table (Invoice # / Customer / Plan / Amount /
 * Status / Due Date / Paid Date / Method).
 */
export type InvoiceLedgerRow = {
  id: string
  invoiceNumber: string
  customerName: string
  planName: string
  amount: number
  // Subset of the schema enum — `void` is filtered out in the
  // Server Action's where clause, so the client never sees it.
  // Excluding it here lets the component's StatusPill (which only
  // accepts draft/pending/paid/overdue/sent/partial) map cleanly
  // without a cast.
  status: 'draft' | 'pending' | 'issued' | 'paid' | 'overdue'
  dueDate: string // ISO date string (yyyy-mm-dd), formatted client-side
  paidDate: string | null // yyyy-mm-dd or null when no payment recorded
  method: string | null // "ACH", "Credit Card", etc. — null when no payment recorded
}

/**
 * Server Action: compute the full invoice ledger for the Invoices tab.
 *
 * All-time, ordered by invoiceDate DESC so the newest invoices appear
 * at the top. Joins customers for the name and subscriptions ->
 * pricing_plans for the plan name. Both are left joins (handled via
 * Prisma's `select` which nullifies missing relations) so one-off
 * invoices without a subscription still render — their plan column
 * just shows "—".
 *
 * paidDate and method come from invoice_payments. When an invoice has no
 * payment row the Server Action returns null for both and the component
 * renders "—".
 */
export async function getFullCommandCenterInvoicesTab(
  filters?: BreakdownFilterParams
): Promise<InvoiceLedgerRow[]> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return []
  }

  const orgId = session.session.activeOrganizationId

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma where clause built up conditionally
  const where: any = {
    organizationId: orgId,
    // Exclude void since they're not part of an active ledger view.
    status: { in: ['draft', 'issued', 'paid', 'overdue'] },
  }
  // Apply invoiceDate filter via canonical parseWindowFilter so this
  // surface uses the same window semantics as the breakdown action.
  // Without that, an invoice timestamped 9:25 PM EDT on Apr 26 (= 01:25
  // UTC Apr 27) shows up here but not in the Customer / Plan breakdown
  // tab — same view, contradictory numbers.
  if (filters?.startDate || filters?.endDate) {
    const { windowStart, windowEnd } = parseWindowFilter(filters)
    where.invoiceDate = { gte: windowStart, lte: windowEnd }
  } else {
    where.OR = [{ status: 'draft' }, { invoiceDate: { lte: new Date() } }]
  }
  if (filters?.customerId) where.customerId = filters.customerId
  if (filters?.agentId) {
    where.subscriptions = { agentId: filters.agentId }
  }

  const invoices = await prisma.invoices.findMany({
    where,
    select: {
      id: true,
      invoiceNumber: true,
      totalAmount: true,
      status: true,
      dueDate: true,
      customers: { select: { name: true } },
      subscriptions: {
        select: {
          pricing_plans: { select: { name: true } },
        },
      },
      invoice_payments: {
        select: { paymentDate: true, paymentMethod: true },
        orderBy: { paymentDate: 'desc' },
        take: 1,
      },
    },
    orderBy: { invoiceDate: 'desc' },
  })

  return invoices.map((inv) => {
    const firstPayment = inv.invoice_payments[0]
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerName: inv.customers?.name ?? 'Unknown customer',
      planName: inv.subscriptions?.pricing_plans?.name ?? '—',
      amount: Number(inv.totalAmount),
      // Prisma returns this enum as a string that matches our union.
      // Cast is safe because the where-clause excludes `void`.
      status: inv.status as InvoiceLedgerRow['status'],
      dueDate: inv.dueDate.toISOString().slice(0, 10),
      paidDate: firstPayment
        ? new Date(firstPayment.paymentDate).toISOString().slice(0, 10)
        : null,
      method: firstPayment?.paymentMethod ?? null,
    }
  })
}

/**
 * Shape for the Cash Flow area chart.
 *
 * 30-day window of daily money-in / money-out / running balance.
 * - moneyIn:  proportional allocation of paid invoices (same math as
 *             the time series Collections line), not real payment dates.
 * - moneyOut: sum of signal_events.usageCost bucketed by UTC day.
 *             Represents AI service cost only; real operational
 *             overhead (vendor bills, infra) isn't captured in the
 *             schema so it's not in this chart.
 * - net:      moneyIn − moneyOut for the day
 * - balance:  running cumulative sum of net, starting at $0.
 */
export type CashFlowDay = {
  date: string
  moneyIn: number
  moneyOut: number
  net: number
  balance: number
}

export type FullCommandCenterCashFlow = {
  days: CashFlowDay[]
  netCashFlow: number // sum of all days' net
  endingBalance: number // balance on the final day of the window
}

/**
 * Server Action: compute the Cash Flow chart data.
 *
 * Reuses the same 30-day window + UTC day-index bucketing as the time series.
 * Structurally similar to getFullCommandCenterTimeSeries but produces
 * a simpler shape (no per-agent split) and flips Revenue → moneyIn
 * (collections-only subset) and aggregated cost → moneyOut.
 */
export async function getFullCommandCenterCashFlow(): Promise<FullCommandCenterCashFlow> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return { days: [], netCashFlow: 0, endingBalance: 0 }
  }

  const orgId = session.session.activeOrganizationId

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)

  const [costMetrics, invoicesInWindow] = await Promise.all([
    canonGetCostMetrics(prisma, orgId, {
      start: windowStart,
      end: windowEnd,
    }),
    prisma.invoices.findMany({
      where: {
        organizationId: orgId,
        // Canon I3: invoiceDate window. Invoices are still spread across
        // their billing-period days below for the daily Money In curve.
        invoiceDate: { gte: windowStart, lte: windowEnd },
        // Only paid invoices contribute to Money In — the rest are
        // billed-but-uncollected revenue, not cash.
        status: 'paid',
      },
      select: {
        id: true,
        totalAmount: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
      },
    }),
  ])

  // Subtract refunds from each paid invoice before spreading across days,
  // so Money In matches canon Collected (net of refunds). Refunds are
  // applied at the invoice level rather than on the refund's actual date
  // because the Money In curve already smears each invoice across its
  // billing period — keeping the net-out at the invoice level preserves
  // that aggregation while still reflecting the merchant's true cash kept.
  const refundsByInvoiceId = new Map<string, number>()
  if (invoicesInWindow.length > 0) {
    const refundSums = await prisma.invoice_payments.groupBy({
      by: ['invoiceId'],
      where: { invoiceId: { in: invoicesInWindow.map((inv) => inv.id) } },
      _sum: { refunded_amount: true },
    })
    for (const row of refundSums) {
      refundsByInvoiceId.set(
        row.invoiceId,
        Number(row._sum.refunded_amount ?? 0)
      )
    }
  }

  const startDayIdx = Math.floor(windowStart.getTime() / MS_PER_DAY)
  const endDayIdx = Math.floor(windowEnd.getTime() / MS_PER_DAY)
  const numDays = endDayIdx - startDayIdx + 1

  // Seed zero rows for every day so Recharts renders a continuous
  // curve even when days have no activity.
  const days: CashFlowDay[] = []
  for (let i = 0; i < numDays; i++) {
    const dayStart = new Date((startDayIdx + i) * MS_PER_DAY)
    days.push({
      date: dayStart.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      moneyIn: 0,
      moneyOut: 0,
      net: 0,
      balance: 0,
    })
  }

  // Money Out: pull canonical per-day cost rows into the chart's daily slots.
  for (const dayRow of costMetrics.byDay) {
    const idx = Math.floor(dayRow.date.getTime() / MS_PER_DAY) - startDayIdx
    if (idx < 0 || idx >= numDays) continue
    days[idx].moneyOut += dayRow.cost
  }

  // Money In: proportionally allocate each paid invoice (net of refunds)
  // across the days of its billing period that fall inside the window.
  for (const inv of invoicesInWindow) {
    const periodStartIdx = Math.floor(
      new Date(inv.billingPeriodStart).getTime() / MS_PER_DAY
    )
    const periodEndIdx = Math.floor(
      new Date(inv.billingPeriodEnd).getTime() / MS_PER_DAY
    )
    const periodDays = periodEndIdx - periodStartIdx + 1
    if (periodDays <= 0) continue
    const refunded = refundsByInvoiceId.get(inv.id) ?? 0
    const netAmount = Number(inv.totalAmount) - refunded
    const dailyAmount = netAmount / periodDays
    const clipStart = Math.max(periodStartIdx, startDayIdx)
    const clipEnd = Math.min(periodEndIdx, endDayIdx)
    for (let d = clipStart; d <= clipEnd; d++) {
      days[d - startDayIdx].moneyIn += dailyAmount
    }
  }

  // Compute net + running balance in a single pass starting at $0.
  let runningBalance = 0
  for (const day of days) {
    day.net = day.moneyIn - day.moneyOut
    runningBalance += day.net
    day.balance = runningBalance
  }

  const netCashFlow = days.reduce((s, d) => s + d.net, 0)
  const endingBalance = days[days.length - 1]?.balance ?? 0

  return { days, netCashFlow, endingBalance }
}

/**
 * Per-service row inside an EventFeedRow. Field names + shape mirror
 * exactly what `mf.usage.record()` returns in `services[]` so the
 * expandable feed row shows the same payload the SDK caller submitted —
 * no UI-side translation, no renaming.
 */
export type EventFeedService = {
  model: string
  modelProvider: string
  inputTokens: number | null
  outputTokens: number | null
  quantity: number | null
  usageCost: number | null
  eventStatus: string
}

/**
 * Shape for the Events tab in the Live Event Feed.
 * One row per recent signal_event, with all the detail fields the
 * expandable row shows when you click it.
 *
 * `services[]` is always populated. Length 1 for single-service events
 * (the row's own model/cost in service form), length N for multi-service
 * events. UI uses `services.length > 1` to render the multi-service
 * badge + expand-to-services panel.
 *
 * `agentCode` is the slug the SDK caller submits (e.g. "sourcing-bot");
 * `agent` is the display name. Both kept so the dropdown JSON can mirror
 * the SDK input shape exactly while the row UI shows the readable name.
 */
export type EventFeedRow = {
  id: string
  time: string
  agent: string
  agentCode: string
  customer: string
  customerId: string
  task: string
  qty: number
  cost: number
  revenue: number
  tokens: number
  inputTokens: number
  outputTokens: number
  model: string
  service: string
  latencyMs: number
  status: string
  plan: string
  metadata: Record<string, unknown>
  services: EventFeedService[]
  serviceCount: number
}

/**
 * Shape for the Activity tab in the Live Event Feed.
 *
 * Invoice-focused lifecycle feed: invoice status changes (drafted /
 * sent / paid / marked overdue) and payments (when invoice_payments
 * rows exist). Cost events are intentionally EXCLUDED — the Events
 * tab is already the per-event cost feed, and mixing them in here
 * would duplicate that tab.
 */
export type ActivityFeedRow = {
  id: string
  time: string
  type: 'invoice' | 'payment'
  customer: string
  description: string
  amount: number // always positive for invoice + payment
  detail: string
}

export type FullCommandCenterEventFeed = {
  events: EventFeedRow[]
  activity: ActivityFeedRow[]
  // Tab counts used by the header. Reflects the rendered rows so the
  // user sees numbers that match what they can scroll through.
  activityCounts: {
    invoice: number
    payment: number
  }
}

/**
 * Format a Date as "MMM DD HH:MM" in UTC. Events span many days, so the
 * month + day keep timestamps unambiguous. UTC
 * because toLocaleDateString without a timezone drifts by local
 * offset and produces off-by-one-day errors near midnight.
 */
function formatEventTime(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })
}

/**
 * Map a signal_events.eventProcessed enum to a short display string
 * for the status badge. Values are PENDING / SUCCESS / FAILED /
 * REJECTED etc. from the enum.
 */
function formatEventStatus(processed: string | null | undefined): string {
  if (!processed) return 'pending'
  return processed.toLowerCase()
}

/**
 * Map an invoice's current status to a past-tense Activity verb.
 * "Invoice X drafted" / "sent" / "paid" / "marked overdue".
 */
function invoiceVerbFromStatus(status: string): string {
  switch (status) {
    case 'draft':
      return 'drafted'
    case 'issued':
      return 'sent'
    case 'paid':
      return 'paid'
    case 'overdue':
      return 'marked overdue'
    default:
      return status
  }
}

/**
 * Server Action: compute the Events + Activity feed.
 *
 * Events tab: top 20 most recent signal_events with joins, formatted
 * into the row shape the existing expandable table renders.
 *
 * Activity tab: merged feed of invoice + payment events. Cost events are
 * excluded; the Events tab already carries them.
 * - Invoice events: top 20 recent invoices. Positive amount, status-
 *   dependent verb + color.
 * - Payment events: top 20 recent invoice_payments.
 * Merged list sorted by timestamp DESC, trimmed to 20 total.
 *
 * Revenue per individual event = Agent-Earned via calcRouted: look up
 * the event's (subscription, signal) pricing strategy and route through
 * the canonical primitive. Events on subs with no usage strategy earn
 * $0 (seat/recurring fees don't attribute to a specific event).
 */
export async function getFullCommandCenterEventFeed(): Promise<FullCommandCenterEventFeed> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return {
      events: [],
      activity: [],
      activityCounts: { invoice: 0, payment: 0 },
    }
  }

  const orgId = session.session.activeOrganizationId

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const now = new Date()
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)

  const [recentEvents, recentInvoices, recentPayments, activeSubs] =
    await Promise.all([
      // 20 most recent signal_events with every join the Events tab needs.
      // subscriptionId + signalId fuel the per-event Agent-Earned lookup
      // via the strategyBySubSignal map built below.
      prisma.signal_events.findMany({
        where: {
          organizationId: orgId,
          usageDate: { gte: windowStart, lte: now },
        },
        orderBy: { usageDate: 'desc' },
        take: 20,
        select: {
          id: true,
          usageDate: true,
          quantity: true,
          usageCost: true,
          subscriptionId: true,
          signalId: true,
          eventProcessed: true,
          agents: { select: { name: true, agentCode: true } },
          customers: { select: { name: true, externalId: true } },
          signals: { select: { name: true } },
          raw_ingest_events: { select: { payload: true } },
          // Children carry the canonical (model, modelProvider) split.
          // Single-service events have one child mirroring the parent;
          // multi-service events fan into multiple. Order is insertion
          // order (createdAt asc) so the feed shows services in the
          // same order the SDK caller sent them.
          signal_event_services: {
            orderBy: { createdAt: 'asc' },
            select: {
              model: true,
              modelProvider: true,
              inputTokens: true,
              outputTokens: true,
              quantity: true,
              usageCost: true,
              eventStatus: true,
            },
          },
          subscriptions: {
            select: {
              pricing_plans: { select: { name: true } },
            },
          },
        },
      }),
      // 20 most recent invoices for the Activity tab.
      prisma.invoices.findMany({
        where: {
          organizationId: orgId,
          status: {
            in: ['draft', 'issued', 'paid', 'overdue'],
          },
        },
        orderBy: { invoiceDate: 'desc' },
        take: 20,
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          dueDate: true,
          status: true,
          totalAmount: true,
          customers: { select: { name: true } },
          subscriptions: {
            select: {
              pricing_plans: { select: { name: true } },
            },
          },
        },
      }),
      prisma.invoice_payments.findMany({
        where: { invoices: { organizationId: orgId } },
        orderBy: { paymentDate: 'desc' },
        take: 20,
        select: {
          id: true,
          paymentDate: true,
          amount: true,
          paymentMethod: true,
          invoices: {
            select: {
              invoiceNumber: true,
              customers: { select: { name: true } },
              subscriptions: {
                select: {
                  pricing_plans: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
      // Active subscriptions with their pricing strategies — bulk-loaded
      // once so the event-row loop below avoids N+1 queries.
      prisma.subscriptions.findMany({
        where: {
          organizationId: orgId,
          status: 'active',
          deletedAt: null,
        },
        select: activeSubscriptionsWithStrategiesSelect,
      }),
    ])

  const strategyBySubSignal = buildStrategyBySubSignal(activeSubs)

  // --- Events tab ---
  const events: EventFeedRow[] = recentEvents.map((ev) => {
    const payload = (ev.raw_ingest_events?.payload ?? {}) as Record<
      string,
      unknown
    >
    const cost = Number(ev.usageCost ?? 0)
    const qty = Number(ev.quantity ?? 0)
    // Per-event Agent-Earned revenue (canon R1/R3). Events on subs
    // with no usage strategy for this signal earn $0 — seat and
    // recurring fees live on the invoice, not the event.
    const revenue = earnedForEvent(strategyBySubSignal, ev)
    const metadata = (payload.metadata as Record<string, unknown>) ?? {}

    // Build services[] from children (canonical multi-service shape).
    // Mirrors the SDK response field names exactly so the expandable
    // panel shows the same payload the caller submitted.
    const services: EventFeedService[] = ev.signal_event_services.map(
      (child) => ({
        model: child.model,
        modelProvider: child.modelProvider,
        inputTokens: child.inputTokens ?? null,
        outputTokens: child.outputTokens ?? null,
        quantity: child.quantity !== null ? Number(child.quantity) : null,
        usageCost: child.usageCost !== null ? Number(child.usageCost) : null,
        eventStatus: child.eventStatus,
      })
    )

    // Top-level model + tokens fields are summed from children for
    // the single-value UI columns. For single-service events these match
    // the payload values; for multi-service
    // events they're the rolled-up totals (and the UI shows the badge
    // + per-service breakdown via services[]).
    const inputTokens = services.reduce((s, c) => s + (c.inputTokens ?? 0), 0)
    const outputTokens = services.reduce((s, c) => s + (c.outputTokens ?? 0), 0)
    const model =
      services.length === 1
        ? services[0].model
        : services.length > 1
          ? `multi-service (${services.length})`
          : '—'

    return {
      id: ev.id,
      time: formatEventTime(new Date(ev.usageDate)),
      agent: ev.agents?.name ?? 'Unknown agent',
      agentCode: ev.agents?.agentCode ?? '',
      customer: ev.customers?.name ?? 'Unknown customer',
      customerId: ev.customers?.externalId ?? '',
      task: ev.signals?.name ?? '—',
      qty,
      cost,
      revenue,
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      model,
      service: model,
      latencyMs: 0,
      status: formatEventStatus(ev.eventProcessed),
      plan: ev.subscriptions?.pricing_plans?.name ?? '—',
      metadata,
      services,
      serviceCount: services.length,
    }
  })

  // --- Activity tab ---
  // Invoice-focused: lifecycle events + payments. Cost events are
  // deliberately NOT included — the Events tab already covers per-
  // event cost, and merging them in here would duplicate it.
  type TimedActivityRow = ActivityFeedRow & { sortTime: number }

  const invoiceActivity: TimedActivityRow[] = recentInvoices.map((inv) => {
    const verb = invoiceVerbFromStatus(inv.status ?? 'draft')
    const dueDateStr = new Date(inv.dueDate).toISOString().slice(0, 10)
    return {
      id: `inv-${inv.id}`,
      time: formatEventTime(new Date(inv.invoiceDate)),
      type: 'invoice',
      customer: inv.customers?.name ?? 'Unknown customer',
      description: `Invoice ${inv.invoiceNumber} ${verb}`,
      amount: Number(inv.totalAmount),
      detail: `${inv.subscriptions?.pricing_plans?.name ?? 'Plan'} · Due ${dueDateStr}`,
      sortTime: new Date(inv.invoiceDate).getTime(),
    }
  })

  const paymentActivity: TimedActivityRow[] = recentPayments.map((pay) => {
    const inv = pay.invoices
    return {
      id: `pay-${pay.id}`,
      time: formatEventTime(new Date(pay.paymentDate)),
      type: 'payment',
      customer: inv?.customers?.name ?? 'Unknown customer',
      description: `Payment received — ${inv?.invoiceNumber ?? 'unknown'}`,
      amount: Number(pay.amount),
      detail: `${pay.paymentMethod ?? 'Unknown method'}${inv?.subscriptions?.pricing_plans?.name ? ` · ${inv.subscriptions.pricing_plans.name}` : ''}`,
      sortTime: new Date(pay.paymentDate).getTime(),
    }
  })

  const merged: TimedActivityRow[] = [...invoiceActivity, ...paymentActivity]
  merged.sort((a, b) => b.sortTime - a.sortTime)
  const trimmed = merged.slice(0, 20)
  const activity: ActivityFeedRow[] = trimmed.map((row) => {
    // Strip the sort key so the client gets a clean row shape.
    const { sortTime: _sortTime, ...rest } = row
    return rest
  })

  // Counts reflect what's ACTUALLY in the rendered top-20 feed so the
  // header's "invoice N / payment N" matches the rows the user can
  // scroll through.
  const activityCounts = {
    invoice: trimmed.filter((r) => r.type === 'invoice').length,
    payment: trimmed.filter((r) => r.type === 'payment').length,
  }

  return { events, activity, activityCounts }
}

/**
 * Shape for a single card in the Pricing Plans Strip.
 *
 * Plans are heterogeneous: pure usage, recurring + usage,
 * seat-based + usage, outcome-based. The display has to handle all
 * shapes without a weird "Free" fallback for seat-based plans. We
 * return the headline price as a nullable number + a unit string,
 * and let the component decide how to render it.
 */
export type PricingPlanCard = {
  id: string
  name: string
  color: string
  // Headline recurring price. null when the plan has no fixed fees
  // (pure usage / outcome-based), in which case the component
  // renders "Usage-based" instead of "$0".
  price: number | null
  priceUnit: string // "/mo" or "/seat/mo" — empty when price is null
  // True when the plan has both a base recurring/seat price AND
  // additional usage strategies. Drives the "+ usage" suffix.
  hasUsage: boolean
  subscribers: number
  // MRR = recurring baseline only. Flat recurring rate × subscribers
  // plus seat rate × subscribers (assumes 1 seat per sub, simplest
  // defensible default). Usage overages and one-time fees are
  // excluded — they show up in `revenue` instead.
  mrr: number
  // Revenue = total 30-day billed for this plan's subscriptions
  // (includes usage overages + one-time fees + seat fees). Matches
  // the Plan breakdown tab number for internal consistency.
  revenue: number
  cost: number
  margin: number
  // Null when revenue is zero (canon M1). UI renders "—".
  marginPct: number | null
  pctOfTotalRevenue: number
}

export type FullCommandCenterPricingPlans = {
  // Sorted by revenue DESC, so the client's Top Plan anchor reads
  // `plans[0]` without re-sorting.
  plans: PricingPlanCard[]
  totalRevenue: number
  totalSubscribers: number
}

/**
 * Server Action: compute the Pricing Plans Strip data.
 *
 * Fetches pricing_plans with their strategies + subscriptions, plus
 * in-window invoices (for revenue) and signal_events (for cost) for
 * each plan's subscriptions. Builds one PricingPlanCard per plan.
 *
 * Headline price is derived from the plan's strategy mix in priority
 * order: recurring > seat_based > null (pure usage). Usage strategies
 * set the `hasUsage` flag but don't contribute to the headline price.
 * One-time strategies (setup fees) are excluded from both the
 * headline price and MRR — they're one-time, not recurring.
 */
export async function getFullCommandCenterPricingPlans(): Promise<FullCommandCenterPricingPlans> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return { plans: [], totalRevenue: 0, totalSubscribers: 0 }
  }

  const orgId = session.session.activeOrganizationId

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)

  const [plans, costMetrics, invoices] = await Promise.all([
    // Every plan in the org with its strategies + subscription count.
    // pricing_plans.orgId (not organizationId): the schema names the org
    // column differently on some models.
    prisma.pricing_plans.findMany({
      where: { orgId: orgId },
      select: {
        id: true,
        name: true,
        pricing_strategies: {
          select: {
            chargeType: true,
            rate: true,
          },
        },
        _count: { select: { subscriptions: true } },
      },
    }),
    // Canonical cost breakdown — byPlan is the single source for plan
    // cost in this card (canon C1).
    canonGetCostMetrics(prisma, orgId, {
      start: windowStart,
      end: windowEnd,
    }),
    // Invoices in the 30-day invoiceDate window, with the
    // subscription's planId joined for revenue attribution.
    prisma.invoices.findMany({
      where: {
        organizationId: orgId,
        // Canon I3: invoiceDate window, not billing-period-overlap.
        invoiceDate: { gte: windowStart, lte: windowEnd },
        status: { in: ['issued', 'paid', 'overdue'] },
      },
      select: {
        totalAmount: true,
        subscriptions: { select: { planId: true } },
      },
    }),
  ])

  // Plan cost map from canon.byPlan. Null-keyed rows (cost not tied to
  // any subscription) are dropped — that share shows up in the dashboard's
  // top-line cost but doesn't attribute to any plan card.
  const costByPlan = new Map<string, number>()
  for (const row of costMetrics.byPlan) {
    if (row.planId === null) continue
    costByPlan.set(row.planId, row.cost)
  }
  const revenueByPlan = new Map<string, number>()
  for (const inv of invoices) {
    const planId = inv.subscriptions?.planId
    if (!planId) continue
    revenueByPlan.set(
      planId,
      (revenueByPlan.get(planId) ?? 0) + Number(inv.totalAmount)
    )
  }

  // Build the card list.
  const cards: PricingPlanCard[] = plans.map((plan, index) => {
    // Partition strategies by charge type. For each plan we expect
    // most to be `flat` pricingModel; `graduated` / `tiered` are
    // approximated by their base `rate` for display purposes.
    const recurring = plan.pricing_strategies.filter(
      (s) => s.chargeType === 'recurring'
    )
    const seatBased = plan.pricing_strategies.filter(
      (s) => s.chargeType === 'seat_based'
    )
    const usage = plan.pricing_strategies.filter(
      (s) => s.chargeType === 'usage'
    )

    // Headline price priority: recurring > seat_based > null.
    // Pick the highest-rate strategy within the winning category
    // so the card shows the most prominent number (e.g. Enterprise
    // picks the $1,499 platform fee, not a $50 seat fee).
    let price: number | null = null
    let priceUnit = ''
    if (recurring.length > 0) {
      price = Math.max(...recurring.map((s) => Number(s.rate ?? 0)))
      priceUnit = '/mo'
    } else if (seatBased.length > 0) {
      price = Math.max(...seatBased.map((s) => Number(s.rate ?? 0)))
      priceUnit = '/seat/mo'
    }

    // MRR baseline = recurring rate × subs + seat rate × subs.
    // Assumes 1 seat per subscription: subscriptions.seatsCount/seatsInfo
    // isn't reliably populated.
    const subscribers = plan._count.subscriptions
    const recurringRate = recurring.reduce(
      (sum, s) => sum + Number(s.rate ?? 0),
      0
    )
    const seatRate = seatBased.reduce((sum, s) => sum + Number(s.rate ?? 0), 0)
    const mrr = (recurringRate + seatRate) * subscribers

    // Cost + revenue from the 30-day window aggregates.
    const cost = costByPlan.get(plan.id) ?? 0
    const revenue = revenueByPlan.get(plan.id) ?? 0
    const margin = revenue - cost
    // Null when revenue is zero (canon M1). UI renders "—".
    const marginPct = safeMarginPercent(revenue, margin)

    return {
      id: plan.id,
      name: plan.name,
      color: AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
      price,
      priceUnit,
      hasUsage: usage.length > 0 && price !== null,
      subscribers,
      mrr,
      revenue,
      cost,
      margin,
      marginPct,
      // pctOfTotalRevenue filled in after the total is known (pass 2).
      pctOfTotalRevenue: 0,
    }
  })

  const totalRevenue = cards.reduce((sum, c) => sum + c.revenue, 0)
  const totalSubscribers = cards.reduce((sum, c) => sum + c.subscribers, 0)

  // Pass 2: fill in pctOfTotalRevenue and sort by revenue DESC so
  // the client's Top Plan anchor reads plans[0].
  for (const card of cards) {
    card.pctOfTotalRevenue = shareOfTotal(card.revenue, totalRevenue) ?? 0
  }
  cards.sort((a, b) => b.revenue - a.revenue)

  return { plans: cards, totalRevenue, totalSubscribers }
}
