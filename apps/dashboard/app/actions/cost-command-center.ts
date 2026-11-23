'use server'

/**
 * Cost Mode Server Actions. Cost mode is strictly cost-only,
 * so it gets its own action module with zero revenue surfaces.
 *
 * Every function in this file delegates cost math to the canonical
 * library (`canonGetCostMetrics` in `@marginfront/db`) per canon C1.
 * No `invoice_line_items` queries, no pricing-strategy joins, no
 * `earnedForEvent` calls, no mixed-status totalAmount sums. The
 * response shapes contain only cost-scoped fields; a parity test
 * asserts zero revenue/margin/collections keys leak into any payload.
 *
 * Mirrors the structural pattern of `full-command-center.ts` (same
 * auth + windowing) so Cost mode and Full mode
 * swap at the import boundary without the consuming UI needing
 * awareness.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import {
  getCostMetrics as canonGetCostMetrics,
  getRevenueMetrics as canonGetRevenueMetrics,
  costPerTask as canonCostPerTask,
  growthPercent,
} from '@marginfront/db'
import {
  parseWindowFilter,
  formatWindowLabel,
  type WindowFilter,
} from './_shared/parse-window-filter'
import { findLockedPeriod } from './_shared/period-lock-store'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Agent color palette matches Full mode so the same agent renders the
// same color across modes. Cycles after 5 agents (most orgs have fewer).
const AGENT_COLOR_PALETTE = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]

function deriveShortName(name: string): string {
  const firstWord = name.split(/\s+/)[0] ?? name
  return firstWord.slice(0, 12)
}

// ─── Top Metrics ──────────────────────────────────────────────────

export type CostCommandCenterTopMetrics = {
  periodLabel: string
  cost: number
  eventCount: number
  // Events with `signal_events.usageCost IS NULL` contribute 0 to cost
  // but still count here (canon C1). Powers the "needs attention" badge.
  eventCountWithNullCost: number
  activeSubscriptionCount: number
  // Current-state count of overdue invoices in the window. Kept because
  // overdue pressure is an operational metric even in cost-only mode.
  overdueCount: number
}

export async function getCostCommandCenterTopMetrics(): Promise<CostCommandCenterTopMetrics> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return emptyTopMetrics()
  const orgId = session.session.activeOrganizationId

  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)

  const [costMetrics, activeSubscriptionCount, overdueCount] =
    await Promise.all([
      canonGetCostMetrics(prisma, orgId, {
        start: windowStart,
        end: windowEnd,
      }),
      prisma.subscriptions.count({
        where: { organizationId: orgId, status: 'active', deletedAt: null },
      }),
      prisma.invoices.count({
        where: {
          organizationId: orgId,
          status: 'overdue',
          invoiceDate: { gte: windowStart, lte: windowEnd },
        },
      }),
    ])

  return {
    periodLabel: 'Last 30 days',
    cost: costMetrics.cost,
    eventCount: costMetrics.eventCount,
    eventCountWithNullCost: costMetrics.eventCountWithNullCost,
    activeSubscriptionCount,
    overdueCount,
  }
}

function emptyTopMetrics(): CostCommandCenterTopMetrics {
  return {
    periodLabel: 'Last 30 days',
    cost: 0,
    eventCount: 0,
    eventCountWithNullCost: 0,
    activeSubscriptionCount: 0,
    overdueCount: 0,
  }
}

// ─── Agent Strip ──────────────────────────────────────────────────

export type CostAgentStripRow = {
  id: string
  name: string
  shortName: string
  color: string
  cost: number
  qty: number
  costPerTask: number
  eventCount: number
  // Null when prior-window cost was 0 (including agents that didn't
  // exist yet). UI renders em-dash for null, "NEW" badge when
  // `isNewAgent` is true.
  costTrend: number | null
  // Literal so the TrendBadge inverts color polarity (down = green,
  // up = red). Cost mode's trend semantics: lower cost is better.
  trendDirection: 'lower-is-better'
  // True when the agent has current-window activity but no prior-
  // window activity. Takes precedence over the numeric trend arrow.
  isNewAgent: boolean
}

export async function getCostCommandCenterAgentStrip(): Promise<
  CostAgentStripRow[]
> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return []
  const orgId = session.session.activeOrganizationId

  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)
  // Prior window is the 30 days immediately preceding the current
  // window, used for costTrend. Overlap-free; no cross-contamination.
  const priorEnd = windowStart
  const priorStart = new Date(priorEnd.getTime() - 30 * MS_PER_DAY)

  const [agents, costMetrics, qtyByAgent] = await Promise.all([
    // agents.orgId, not organizationId: the schema names the org column
    // differently on some models.
    prisma.agents.findMany({
      where: { orgId: orgId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    canonGetCostMetrics(
      prisma,
      orgId,
      { start: windowStart, end: windowEnd },
      {},
      { priorWindow: { start: priorStart, end: priorEnd } }
    ),
    // Canon doesn't expose qty per dimension; this one groupBy is the
    // only non-canon read we need for the strip.
    prisma.signal_events.groupBy({
      by: ['agentId'],
      where: {
        organizationId: orgId,
        usageDate: { gte: windowStart, lte: windowEnd },
      },
      _sum: { quantity: true },
    }),
  ])

  const currentByAgent = new Map(costMetrics.byAgent.map((r) => [r.agentId, r]))
  const priorByAgent = new Map(
    (costMetrics.prior?.byAgent ?? []).map((r) => [r.agentId, r])
  )
  const qtyMap = new Map(
    qtyByAgent.map((r) => [r.agentId, Number(r._sum.quantity ?? 0)])
  )

  const rows: CostAgentStripRow[] = agents.map((agent, idx) => {
    const current = currentByAgent.get(agent.id)
    const prior = priorByAgent.get(agent.id)
    const cost = current?.cost ?? 0
    const eventCount = current?.eventCount ?? 0
    const priorCost = prior?.cost ?? 0
    const priorEvents = prior?.eventCount ?? 0
    const qty = qtyMap.get(agent.id) ?? 0
    const costPerTask = canonCostPerTask(cost, qty) ?? 0
    // costTrend null when prior cost is 0 (includes brand-new agents
    // and agents that had zero cost in the prior window). isNewAgent
    // distinguishes the "no prior activity at all" case visually.
    const costTrend = growthPercent(cost, priorCost)
    const isNewAgent = eventCount > 0 && priorEvents === 0
    return {
      id: agent.id,
      name: agent.name,
      shortName: deriveShortName(agent.name),
      color: AGENT_COLOR_PALETTE[idx % AGENT_COLOR_PALETTE.length],
      cost,
      qty,
      costPerTask,
      eventCount,
      costTrend,
      trendDirection: 'lower-is-better',
      isNewAgent,
    }
  })

  // Sort by cost DESC so rows[0] is the most expensive agent (anchor
  // card in the UI). Cost mode's anchor is "Top Cost Agent."
  rows.sort((a, b) => b.cost - a.cost)
  return rows
}

// ─── Time Series ──────────────────────────────────────────────────

export type CostTimeSeriesDay = {
  date: string
  // Per-agent cost keyed by agent UUID. Recharts consumes this shape
  // directly for the stacked-bar time series.
  [agentId: string]: number | string
}

export type CostCommandCenterTimeSeries = {
  days: CostTimeSeriesDay[]
  agents: Array<{ id: string; shortName: string; color: string }>
}

export async function getCostCommandCenterTimeSeries(): Promise<CostCommandCenterTimeSeries> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return { days: [], agents: [] }
  const orgId = session.session.activeOrganizationId

  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY)

  const agents = await prisma.agents.findMany({
    where: { orgId: orgId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  // One canon call per agent, so this is linear in agent count. Canon
  // doesn't emit a byAgent × byDay cross-product.
  const perAgentCost = await Promise.all(
    agents.map((agent) =>
      canonGetCostMetrics(
        prisma,
        orgId,
        { start: windowStart, end: windowEnd },
        { agentId: agent.id }
      ).then((metrics) => ({ agentId: agent.id, byDay: metrics.byDay }))
    )
  )

  const agentMeta = agents.map((agent, idx) => ({
    id: agent.id,
    shortName: deriveShortName(agent.name),
    color: AGENT_COLOR_PALETTE[idx % AGENT_COLOR_PALETTE.length],
  }))

  // UTC-indexed day math avoids timezone drift. One ms of drift would
  // move an event between adjacent day buckets.
  const startDayIdx = Math.floor(windowStart.getTime() / MS_PER_DAY)
  const endDayIdx = Math.floor(windowEnd.getTime() / MS_PER_DAY)
  const numDays = endDayIdx - startDayIdx + 1

  const days: CostTimeSeriesDay[] = []
  for (let i = 0; i < numDays; i++) {
    const dayStart = new Date((startDayIdx + i) * MS_PER_DAY)
    const row: CostTimeSeriesDay = {
      date: dayStart.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    }
    // Initialize every agent's bucket to 0 so Recharts renders
    // continuous bars (gaps appear if the key is absent).
    for (const agent of agentMeta) {
      row[agent.id] = 0
    }
    days.push(row)
  }

  for (const { agentId, byDay } of perAgentCost) {
    for (const dayRow of byDay) {
      const dayIdx =
        Math.floor(dayRow.date.getTime() / MS_PER_DAY) - startDayIdx
      if (dayIdx < 0 || dayIdx >= numDays) continue
      const row = days[dayIdx]
      const prev = Number(row[agentId] ?? 0)
      row[agentId] = prev + dayRow.cost
    }
  }

  return { days, agents: agentMeta }
}

// ─── Breakdown ────────────────────────────────────────────────────

export type CostBreakdownRow = {
  name: string
  category: string
  context: string
  cost: number
  qty: number
  events: number
  avgCost: number
  // Prior-window cost trend per row. Not computed; always 0, which the UI
  // renders as a neutral dash.
  trend: number
}

export type CostBreakdownFilterOptions = {
  customers: { id: string; name: string }[]
  agents: { id: string; name: string }[]
  subscriptions: { customerId: string; agentId: string }[]
}

export type CostCommandCenterBreakdown = {
  service: CostBreakdownRow[]
  task: CostBreakdownRow[]
  agent: CostBreakdownRow[]
  customer: CostBreakdownRow[]
  plan: CostBreakdownRow[]
  filterOptions: CostBreakdownFilterOptions
}

export type CostBreakdownFilterParams = {
  startDate?: string
  endDate?: string
  customerId?: string
  agentId?: string
}

// Cap for Service tab rows. An org can hit 300+ distinct model strings;
// rendering all bars explodes the chart height. Top N by cost + "Other"
// tail preserves totals without blowing up the UI. Matches Full mode.
const SERVICE_TAB_MAX_ROWS = 19

function buildCostRow(input: {
  name: string
  category: string
  context: string
  cost: number
  qty: number
  events: number
}): CostBreakdownRow {
  const avgCost = canonCostPerTask(input.cost, input.qty) ?? 0
  return {
    name: input.name,
    category: input.category,
    context: input.context,
    cost: input.cost,
    qty: input.qty,
    events: input.events,
    avgCost,
    trend: 0,
  }
}

export async function getCostCommandCenterBreakdown(
  filters?: CostBreakdownFilterParams
): Promise<CostCommandCenterBreakdown> {
  const session = await auth.api.getSession({ headers: await headers() })
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma where clause built up conditionally
  const eventsWhere: any = {
    organizationId: orgId,
    usageDate: { gte: windowStart, lte: windowEnd },
  }
  if (filters?.customerId) eventsWhere.customerId = filters.customerId
  if (filters?.agentId) eventsWhere.agentId = filters.agentId

  const canonFilters: { customerId?: string; agentId?: string } = {}
  if (filters?.customerId) canonFilters.customerId = filters.customerId
  if (filters?.agentId) canonFilters.agentId = filters.agentId

  const [
    events,
    serviceChildren,
    costMetrics,
    allAgents,
    allCustomers,
    allSignals,
    allPlans,
    subscriptionPairs,
  ] = await Promise.all([
    // Raw events for qty + per-customer agent context. Canon carries
    // cost and eventCount; qty is the only per-dimension field canon
    // doesn't emit, so we compute it in one pass below.
    prisma.signal_events.findMany({
      where: eventsWhere,
      select: {
        id: true,
        agentId: true,
        customerId: true,
        signalId: true,
        quantity: true,
        usageCost: true,
        subscriptions: { select: { planId: true } },
        // Childless events carry their model on raw_ingest_events.payload; the
        // Service tab groups by it so cost mode reconciles to canon C1.
        raw_ingest_events: { select: { payload: true } },
      },
    }),
    // Service tab reads from signal_event_services children (multi-service
    // canon). Single-service events have one child whose model + cost
    // mirror the parent, so single-service totals are unchanged. Multi-service
    // events fan into multiple children, one row per (model, modelProvider).
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
    // Subscription pairs for cascading filter dropdowns (customer ↔ agent).
    prisma.subscriptions.findMany({
      where: { organizationId: orgId, status: 'active' },
      select: { customerId: true, agentId: true },
    }),
  ])

  const agentsById = new Map(allAgents.map((a) => [a.id, a]))
  const customersById = new Map(allCustomers.map((c) => [c.id, c]))
  const signalsById = new Map(allSignals.map((s) => [s.id, s]))
  const plansById = new Map(allPlans.map((p) => [p.id, p]))

  const costByAgent = new Map(
    costMetrics.byAgent.map((r) => [r.agentId, r.cost])
  )
  const costByCustomer = new Map(
    costMetrics.byCustomer.map((r) => [r.customerId, r.cost])
  )
  const costBySignal = new Map(
    costMetrics.bySignal
      .filter((r): r is typeof r & { signalId: string } => r.signalId !== null)
      .map((r) => [r.signalId, r.cost])
  )
  const costByPlan = new Map(
    costMetrics.byPlan
      .filter((r): r is typeof r & { planId: string } => r.planId !== null)
      .map((r) => [r.planId, r.cost])
  )
  // Per-dimension qty + event counts built from one raw pass. Canon
  // emits eventCount per dimension but not qty, and we need the
  // per-customer/plan top-agent context which canon doesn't carry.
  type Agg = {
    cost: number
    qty: number
    events: number
    topAgentId?: string
    topAgentQty?: number
  }
  const bySignalAgg = new Map<string, Agg>()
  const byAgentAgg = new Map<string, Agg>()
  const byCustomerAgg = new Map<string, Agg>()
  const byPlanAgg = new Map<string, Agg>()

  // Sub-aggregate qty per (customerId, agentId) so we can pick the
  // top agent per customer below.
  const qtyByCustomerAgent = new Map<string, Map<string, number>>()
  // Same for per-plan top agent.
  const qtyByPlanAgent = new Map<string, Map<string, number>>()

  for (const ev of events) {
    const qty = Number(ev.quantity ?? 0)

    if (ev.agentId) {
      const prev = byAgentAgg.get(ev.agentId) ?? {
        cost: costByAgent.get(ev.agentId) ?? 0,
        qty: 0,
        events: 0,
      }
      prev.qty += qty
      prev.events += 1
      byAgentAgg.set(ev.agentId, prev)
    }

    if (ev.customerId) {
      const prev = byCustomerAgg.get(ev.customerId) ?? {
        cost: costByCustomer.get(ev.customerId) ?? 0,
        qty: 0,
        events: 0,
      }
      prev.qty += qty
      prev.events += 1
      byCustomerAgg.set(ev.customerId, prev)

      if (ev.agentId) {
        const inner =
          qtyByCustomerAgent.get(ev.customerId) ?? new Map<string, number>()
        inner.set(ev.agentId, (inner.get(ev.agentId) ?? 0) + qty)
        qtyByCustomerAgent.set(ev.customerId, inner)
      }
    }

    if (ev.signalId) {
      const prev = bySignalAgg.get(ev.signalId) ?? {
        cost: costBySignal.get(ev.signalId) ?? 0,
        qty: 0,
        events: 0,
      }
      prev.qty += qty
      prev.events += 1
      bySignalAgg.set(ev.signalId, prev)
    }

    const planId = ev.subscriptions?.planId
    if (planId) {
      const prev = byPlanAgg.get(planId) ?? {
        cost: costByPlan.get(planId) ?? 0,
        qty: 0,
        events: 0,
      }
      prev.qty += qty
      prev.events += 1
      byPlanAgg.set(planId, prev)

      if (ev.agentId) {
        const inner = qtyByPlanAgent.get(planId) ?? new Map<string, number>()
        inner.set(ev.agentId, (inner.get(ev.agentId) ?? 0) + qty)
        qtyByPlanAgent.set(planId, inner)
      }
    }
  }

  // Pick top-agent-name per customer / per plan for the `context`
  // column on the UI. Falls back to empty string when unavailable.
  function topAgentName(inner: Map<string, number> | undefined): string {
    if (!inner || inner.size === 0) return ''
    let topId: string | null = null
    let topQty = -1
    for (const [agentId, qty] of inner) {
      if (qty > topQty) {
        topQty = qty
        topId = agentId
      }
    }
    return (topId && agentsById.get(topId)?.name) || ''
  }

  // ─── Service tab (resolved model) ──────────────────────────────
  // Childed events carry the (model, provider) split on their
  // signal_event_services rows (single-service: one child mirrors the parent,
  // unchanged; multi-service: one row per service, catalog fields via
  // the FK). Childless events (cost-only meter events) carry their model on
  // raw_ingest_events.payload and are grouped by it so the tab reconciles to canon
  // C1 instead of the childed-only subtotal. Cost is model-derived, so
  // a model-less event has no cost (needs-cost-backfill) and is absent here — no
  // "No model" bucket.
  type ServiceAgg = {
    cost: number
    qty: number
    events: Set<string>
    displayName?: string
    serviceType?: string
    provider?: string
  }
  const byServiceAgg = new Map<string, ServiceAgg>()
  const childedEventIds = new Set<string>()
  for (const child of serviceChildren) {
    childedEventIds.add(child.signalEventId)
    const key = `${child.modelProvider}|${child.model}`
    const prev = byServiceAgg.get(key) ?? {
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
    byServiceAgg.set(key, prev)
  }

  // Childless-WITH-model groups, keyed by the resolved payload model alone (no
  // catalog join, so no provider/displayName). Mirrors full-command-center.
  const childlessModelGroups = new Map<
    string,
    { cost: number; qty: number; events: Set<string> }
  >()
  for (const ev of events) {
    if (childedEventIds.has(ev.id)) continue
    const payload = ev.raw_ingest_events?.payload as
      | { model?: unknown }
      | null
      | undefined
    const rawModel = payload?.model
    const model =
      typeof rawModel === 'string' && rawModel.length > 0 ? rawModel : null
    // model-less = needs-cost-backfill (no cost) → dropped, no "No model" row.
    if (!model) continue
    const prev = childlessModelGroups.get(model) ?? {
      cost: 0,
      qty: 0,
      events: new Set<string>(),
    }
    prev.cost += Number(ev.usageCost ?? 0)
    prev.qty += Number(ev.quantity ?? 0)
    prev.events.add(ev.id)
    childlessModelGroups.set(model, prev)
  }

  // Flatten childed (model, provider) rows + childless resolved-model rows into
  // one list, then apply the shared top-N + "Other" cap so Σ(rows) === canon C1.
  type ModelRowAgg = {
    name: string
    category: string
    context: string
    cost: number
    qty: number
    eventIds: Set<string>
  }
  const serviceAggs: ModelRowAgg[] = [
    ...Array.from(byServiceAgg.entries()).map(([key, agg]) => {
      const [provider, model] = key.split('|')
      return {
        name: agg.displayName ?? model,
        category: agg.serviceType ?? 'Other',
        context: agg.provider ?? provider,
        cost: agg.cost,
        qty: agg.qty,
        eventIds: agg.events,
      }
    }),
    ...Array.from(childlessModelGroups.entries()).map(([model, agg]) => ({
      name: model,
      category: 'Other',
      context: '',
      cost: agg.cost,
      qty: agg.qty,
      eventIds: agg.events,
    })),
  ]

  const sortedServices = serviceAggs.sort((a, b) => b.cost - a.cost)
  const topServices = sortedServices.slice(0, SERVICE_TAB_MAX_ROWS)
  const tailServices = sortedServices.slice(SERVICE_TAB_MAX_ROWS)

  const serviceRows: CostBreakdownRow[] = topServices.map((agg) =>
    buildCostRow({
      name: agg.name,
      category: agg.category,
      context: agg.context,
      cost: agg.cost,
      qty: agg.qty,
      events: agg.eventIds.size,
    })
  )

  if (tailServices.length > 0) {
    const tailCost = tailServices.reduce((s, a) => s + a.cost, 0)
    const tailQty = tailServices.reduce((s, a) => s + a.qty, 0)
    const tailEventIds = new Set<string>()
    for (const a of tailServices) {
      for (const id of a.eventIds) tailEventIds.add(id)
    }
    serviceRows.push(
      buildCostRow({
        name: `Other (${tailServices.length} services)`,
        category: 'Mixed',
        context: '',
        cost: tailCost,
        qty: tailQty,
        events: tailEventIds.size,
      })
    )
  }

  // ─── Task tab (by signalId) ────────────────────────────────────
  const taskRows: CostBreakdownRow[] = Array.from(bySignalAgg.entries()).map(
    ([signalId, agg]) => {
      const signal = signalsById.get(signalId)
      return buildCostRow({
        name: signal?.name ?? 'Unknown signal',
        category: signal?.type ?? '',
        context: '',
        cost: agg.cost,
        qty: agg.qty,
        events: agg.events,
      })
    }
  )

  // ─── Agent tab ─────────────────────────────────────────────────
  const agentRows: CostBreakdownRow[] = Array.from(byAgentAgg.entries()).map(
    ([agentId, agg]) =>
      buildCostRow({
        name: agentsById.get(agentId)?.name ?? 'Unknown agent',
        category: '',
        context: '',
        cost: agg.cost,
        qty: agg.qty,
        events: agg.events,
      })
  )

  // ─── Customer tab (context = top agent name for that customer) ─
  const customerRows: CostBreakdownRow[] = Array.from(
    byCustomerAgg.entries()
  ).map(([customerId, agg]) =>
    buildCostRow({
      name: customersById.get(customerId)?.name ?? 'Unknown customer',
      category: '',
      context: topAgentName(qtyByCustomerAgent.get(customerId)),
      cost: agg.cost,
      qty: agg.qty,
      events: agg.events,
    })
  )

  // ─── Plan tab (context = top agent name for that plan) ─────────
  const planRows: CostBreakdownRow[] = Array.from(byPlanAgg.entries()).map(
    ([planId, agg]) =>
      buildCostRow({
        name: plansById.get(planId)?.name ?? 'Unknown plan',
        category: '',
        context: topAgentName(qtyByPlanAgent.get(planId)),
        cost: agg.cost,
        qty: agg.qty,
        events: agg.events,
      })
  )

  // Every tab sorted by cost DESC so the heaviest contributor sits on top.
  const sortByCost = (a: CostBreakdownRow, b: CostBreakdownRow) =>
    b.cost - a.cost
  serviceRows.sort(sortByCost)
  taskRows.sort(sortByCost)
  agentRows.sort(sortByCost)
  customerRows.sort(sortByCost)
  planRows.sort(sortByCost)

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

// ─── Cost Classification (COGS vs R&D) ────────────────────────────
//
// Surfaces the canonical `byCostCategory` and `byEnvironment` breakdowns
// from getCostMetrics. The dashboard presents these as the COGS vs R&D
// donut and an environment-scoped filter, plus a "needs classification"
// number that drives the onboarding nudge.
//
// All math comes from the canonical lib — this is presentation reshape
// only, no per-event SQL here. Window matches the rest of Cost mode
// (last 30 days) so cards on the same page move together.

export type CostCategoryKey =
  | 'PRODUCTION_COGS'
  | 'DEVELOPMENT_RD'
  | 'SALES_SM'
  | 'GENERAL_GA'
  | 'INTERNAL_TOOL'
  | 'UNCLASSIFIED'

export type CostClassificationCategory = {
  key: CostCategoryKey
  label: string
  cost: number
  eventCount: number
  /** Share of all classified cost (UNCLASSIFIED excluded), 0-1. Null when total is 0. */
  shareOfClassified: number | null
}

export type CostEnvironmentKey =
  | 'production'
  | 'staging'
  | 'development'
  | 'testing'
  | 'unspecified'

export type CostClassificationEnvironment = {
  key: CostEnvironmentKey
  label: string
  cost: number
  eventCount: number
}

/** Industry benchmark band, used by the dashboard to draw a reference range
 *  next to the headline metric cards. `min` and `max` are both 0-1
 *  ratios (e.g. 0.7 means 70%). Source attribution is for the tooltip. */
export type BenchmarkBand = {
  label: string
  min: number
  max: number
  source: string
}

export type CostClassificationBreakdown = {
  periodLabel: string
  /** SUM of all events in window; matches top-card cost. */
  totalCost: number
  /** Cost belonging to PRODUCTION_COGS. The COGS half of the donut. */
  cogsCost: number
  /** Cost belonging to DEVELOPMENT_RD. The R&D half of the donut. */
  rdCost: number
  /** Cost belonging to SALES_SM. Sales & Marketing OpEx, below gross margin. */
  salesCost: number
  /** Cost belonging to GENERAL_GA. General & Administrative OpEx, below gross margin. */
  gaCost: number
  /** Cost belonging to INTERNAL_TOOL. Hybrid bucket; rendered separately. */
  internalCost: number
  /** Cost stuck on UNCLASSIFIED signals — the "needs attention" number. */
  unclassifiedCost: number
  /** Event count on UNCLASSIFIED signals — drives the onboarding nudge. */
  unclassifiedEventCount: number
  /** All four categories, ordered consistently for the chart. */
  categories: CostClassificationCategory[]
  /** Per-environment breakdown for the filter dropdown + secondary chart. */
  environments: CostClassificationEnvironment[]

  // ── AI Gross Margin (the headline output) ──
  // All math: dashboard-layer aggregation over the canonical cost + revenue
  // metrics for the same window. Kept here (not in the canonical lib) so the
  // shared package stays focused on raw aggregates; AI-margin framing is a
  // dashboard-side product concern.

  /** Total revenue in the same window. Pulled from getRevenueMetrics. */
  revenue: number
  /** revenue − cogsCost. The "true AI gross margin" headline (classified
   *  COGS only). UNCLASSIFIED is its OWN visible bucket and is NEVER folded into
   *  COGS — the uncategorized dollars surface on their own line and the UI flags
   *  them via hasUnclassifiedCost so a high margin is never mistaken for final
   *  while spend is still uncategorized. */
  aiGrossMargin: number
  /** aiGrossMargin / revenue, 0-1. Null when revenue === 0 (canon M1). */
  aiGrossMarginPercent: number | null
  /** cogsCost / revenue, 0-1. Null when revenue === 0. Classified COGS only
   *  — unclassified cost is excluded, not folded in. */
  aiCogsAsPercentOfRevenue: number | null
  /** Margin including all costs (COGS + R&D + Internal + Unclassified). Null when revenue === 0. */
  blendedGrossMarginPercent: number | null
  /** aiGrossMarginPercent − blendedGrossMarginPercent. Null when either component is null.
   *  Positive number = AI gross margin LOOKS BETTER than blended (R&D + internal drag).
   *  Negative number = AI gross margin is WORSE than blended (unusual; check classifications). */
  blendedVsAiMarginDelta: number | null
  /** True when unclassifiedCost > 0 — drives the "classify to refine this number"
   *  inline notice on the headline card. The margin is computed on
   *  classified COGS only, so it can read OPTIMISTICALLY while spend is still
   *  uncategorized — this flag is what makes the UI surface the loud notice so a
   *  high number is never mistaken for final. */
  hasUnclassifiedCost: boolean

  /** SaaS-industry benchmark band for traditional software gross margin (70-80%). */
  saasMarginBenchmark: BenchmarkBand
  /** AI-mature benchmark band for AI-native products at maturity (50-65%). */
  aiMarginBenchmark: BenchmarkBand
}

const SAAS_MARGIN_BENCHMARK: BenchmarkBand = {
  label: 'SaaS benchmark',
  min: 0.7,
  max: 0.8,
  source: 'SaaS industry — typical mature subscription business',
}

const AI_MARGIN_BENCHMARK: BenchmarkBand = {
  label: 'AI-mature benchmark',
  min: 0.5,
  max: 0.65,
  source: "Ben Murray, The SaaS CFO — AI-native products at maturity",
}

const COST_CATEGORY_LABELS: Record<CostCategoryKey, string> = {
  PRODUCTION_COGS: 'Production COGS',
  DEVELOPMENT_RD: 'Development / R&D',
  SALES_SM: 'Sales & Marketing',
  GENERAL_GA: 'General & Admin',
  INTERNAL_TOOL: 'Internal tooling',
  UNCLASSIFIED: 'Unclassified',
}

const COST_ENVIRONMENT_LABELS: Record<CostEnvironmentKey, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  testing: 'Testing',
  unspecified: 'Unspecified',
}

function emptyClassificationBreakdown(): CostClassificationBreakdown {
  const categories = (
    Object.keys(COST_CATEGORY_LABELS) as CostCategoryKey[]
  ).map((key) => ({
    key,
    label: COST_CATEGORY_LABELS[key],
    cost: 0,
    eventCount: 0,
    shareOfClassified: null,
  }))
  return {
    periodLabel: 'Last 30 days',
    totalCost: 0,
    cogsCost: 0,
    rdCost: 0,
    salesCost: 0,
    gaCost: 0,
    internalCost: 0,
    unclassifiedCost: 0,
    unclassifiedEventCount: 0,
    categories,
    environments: [],
    revenue: 0,
    aiGrossMargin: 0,
    aiGrossMarginPercent: null,
    aiCogsAsPercentOfRevenue: null,
    blendedGrossMarginPercent: null,
    blendedVsAiMarginDelta: null,
    hasUnclassifiedCost: false,
    saasMarginBenchmark: SAAS_MARGIN_BENCHMARK,
    aiMarginBenchmark: AI_MARGIN_BENCHMARK,
  }
}

export async function getCostClassificationBreakdown(
  filter?: WindowFilter,
): Promise<CostClassificationBreakdown> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return emptyClassificationBreakdown()
  }
  const orgId = session.session.activeOrganizationId

  const { windowStart, windowEnd } = parseWindowFilter(filter)

  // PERIOD LOCK: a CLOSED period serves its frozen P&L
  // breakdown so the locked Month-End Close stays internally consistent — the
  // category table + AI-gross-margin card can't drift from the journal CSV that
  // was posted at close. Canon-neutral: the snapshot is the unchanged
  // output of this same canon-C1/M1 computation, frozen at close time.
  // Cost Management is calendar-month-scoped, so it passes the SAME month
  // bounds as Month-End Close. Selecting a closed month on EITHER page matches
  // this exact-window lock and serves the identical frozen snapshot, which keeps
  // the two pages reconciled.
  const locked = await findLockedPeriod(orgId, windowStart, windowEnd)
  // Cast back from the store's `unknown` (cycle-break) to this fn's return type.
  if (locked) return locked.snapshot.breakdown as CostClassificationBreakdown

  // Pull cost + revenue for the same window in parallel. Revenue is needed
  // for AI gross margin math; cost provides the byCostCategory split.
  // getRevenueMetrics also returns a `cost` value (whole-org total) but
  // we trust getCostMetrics for the per-category breakdown.
  const [cost, revenueMetrics] = await Promise.all([
    canonGetCostMetrics(prisma, orgId, {
      start: windowStart,
      end: windowEnd,
    }),
    canonGetRevenueMetrics(prisma, orgId, {
      start: windowStart,
      end: windowEnd,
    }),
  ])

  // Build per-category lookups, defaulting unseen categories to zero so
  // the donut renders all four slices even when some are empty.
  const byCategoryMap = new Map(
    cost.byCostCategory.map((row) => [row.costCategory, row]),
  )
  const cogsCost = byCategoryMap.get('PRODUCTION_COGS')?.cost ?? 0
  const rdCost = byCategoryMap.get('DEVELOPMENT_RD')?.cost ?? 0
  const salesCost = byCategoryMap.get('SALES_SM')?.cost ?? 0
  const gaCost = byCategoryMap.get('GENERAL_GA')?.cost ?? 0
  const internalCost = byCategoryMap.get('INTERNAL_TOOL')?.cost ?? 0
  const unclassified = byCategoryMap.get('UNCLASSIFIED')
  const unclassifiedCost = unclassified?.cost ?? 0
  const unclassifiedEventCount = unclassified?.eventCount ?? 0

  // shareOfClassified excludes UNCLASSIFIED so the percentages reflect
  // "of what we know how to classify, what's the COGS / R&D / Internal split"
  // — exactly the question a CFO asks. UNCLASSIFIED gets share=null so the
  // chart can render it as a hatched / muted slice.
  const classifiedTotal =
    cogsCost + rdCost + salesCost + gaCost + internalCost
  const categories: CostClassificationCategory[] = (
    [
      'PRODUCTION_COGS',
      'DEVELOPMENT_RD',
      'SALES_SM',
      'GENERAL_GA',
      'INTERNAL_TOOL',
      'UNCLASSIFIED',
    ] as const
  ).map((key) => {
    const row = byCategoryMap.get(key)
    return {
      key,
      label: COST_CATEGORY_LABELS[key],
      cost: row?.cost ?? 0,
      eventCount: row?.eventCount ?? 0,
      shareOfClassified:
        key === 'UNCLASSIFIED'
          ? null
          : classifiedTotal > 0
            ? (row?.cost ?? 0) / classifiedTotal
            : null,
    }
  })

  const environments: CostClassificationEnvironment[] = cost.byEnvironment.map(
    (row) => {
      const key: CostEnvironmentKey = row.environment ?? 'unspecified'
      return {
        key,
        label: COST_ENVIRONMENT_LABELS[key],
        cost: row.cost,
        eventCount: row.eventCount,
      }
    },
  )

  // ── AI Gross Margin math (canon M1 for null-on-zero-revenue handling) ──
  // cost.cost (canonical total cost, canon C1) feeds the blended margin
  // so the numbers reconcile with the rest of cost-command-center.
  //
  // UNCLASSIFIED is its own visible bucket
  // and is NEVER folded into COGS: adding it would inflate COGS and make the
  // margin look worse than the classified facts support. AI gross margin is
  // computed on CLASSIFIED COGS only. The uncategorized dollars
  // live on their own line (unclassifiedCost / unclassifiedEventCount) and the UI
  // calls them out loudly via `hasUnclassifiedCost`, so a high-looking margin is
  // never mistaken for final while spend is still uncategorized. Canon M1 governs
  // the null-on-zero-revenue handling (never 0% / NaN% / Infinity%). Canon C1
  // owns where cost comes from; only the margin composition is local.
  const revenue = revenueMetrics.revenue
  const aiGrossMargin = revenue - cogsCost
  const aiGrossMarginPercent = revenue > 0 ? aiGrossMargin / revenue : null
  const aiCogsAsPercentOfRevenue = revenue > 0 ? cogsCost / revenue : null
  const blendedGrossMarginPercent =
    revenue > 0 ? (revenue - cost.cost) / revenue : null
  const blendedVsAiMarginDelta =
    aiGrossMarginPercent !== null && blendedGrossMarginPercent !== null
      ? aiGrossMarginPercent - blendedGrossMarginPercent
      : null
  const hasUnclassifiedCost = unclassifiedCost > 0

  return {
    periodLabel: formatWindowLabel(filter, windowStart, windowEnd),
    totalCost: cost.cost,
    cogsCost,
    rdCost,
    salesCost,
    gaCost,
    internalCost,
    unclassifiedCost,
    unclassifiedEventCount,
    categories,
    environments,
    revenue,
    aiGrossMargin,
    aiGrossMarginPercent,
    aiCogsAsPercentOfRevenue,
    blendedGrossMarginPercent,
    blendedVsAiMarginDelta,
    hasUnclassifiedCost,
    saasMarginBenchmark: SAAS_MARGIN_BENCHMARK,
    aiMarginBenchmark: AI_MARGIN_BENCHMARK,
  }
}
