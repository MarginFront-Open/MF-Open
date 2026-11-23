'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { safeMarginPercent } from '@marginfront/db'
import { parseWindowFilter } from './_shared/parse-window-filter'
import {
  activeSubscriptionsWithStrategiesSelect,
  buildStrategyBySubSignal,
  earnedForEvent,
} from './_shared/per-event-earned'

/**
 * Server Action: per-day × per-metric breakdown for a single agent.
 *
 * Powers the "Current Usage Cost & Earned Revenue" chart card on the
 * agent overview page. Mirrors the shape of the subscription detail
 * page's `dailyBreakdown` so the chart-rendering patterns port directly.
 *
 * Returns one row per (day, signal) pair with three values: quantity,
 * cost, and earned revenue. The UI pivots this into a stacked time-series
 * chart, letting the user toggle between the three views.
 *
 * Earned math uses the flat-vs-tiered split:
 *   - Flat: quantity × strategy.rate
 *   - Graduated / Volume: tiers applied to the quantity
 *
 * Cost is read directly from signal_events.usageCost (authoritative per
 * event). Earned is attributed to each event via its subscription's
 * pricing_strategies chain, so events without a subscription contribute
 * 0 earned (they still show cost + quantity).
 *
 * Window defaults to the trailing 30 days so it lines up with the
 * command-center funnel. Override with explicit start/end if needed.
 */

export interface AgentDailyBreakdownRow {
  date: string // YYYY-MM-DD
  signalId: string
  signalName: string
  quantity: number
  cost: number
  earned: number
}

export interface AgentEarningsBreakdown {
  periodStart: string
  periodEnd: string
  signals: Array<{ id: string; name: string }>
  dailyBreakdown: AgentDailyBreakdownRow[]
  totals: {
    quantity: number
    cost: number
    earned: number
    margin: number
    marginPct: number
  }
}

export async function getAgentEarningsBreakdown(input: {
  agentId: string
  startDate?: string
  endDate?: string
}): Promise<{
  success: boolean
  data?: AgentEarningsBreakdown
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    // Default to rolling 30 days. Normalize both ends to UTC midnight so the
    // day-bucket keys (YYYY-MM-DD) stay consistent with how signal_events
    // are stored (timestamptz).
    const { windowStart, windowEnd } = parseWindowFilter(input)

    // Cross-org guard — don't let a session for one org load another
    // org's agent breakdown by guessing an agentId.
    const agent = await db.agents.findFirst({
      where: { id: input.agentId, orgId, deletedAt: null },
      select: { id: true },
    })
    if (!agent) {
      return { success: false, error: 'Agent not found' }
    }

    // One parallel fetch: signals (for labels), events (for quantity + cost),
    // subscriptions with strategies (for earned attribution).
    const [signals, events, subscriptions] = await Promise.all([
      db.signals.findMany({
        where: { agentId: input.agentId, orgId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.signal_events.findMany({
        where: {
          agentId: input.agentId,
          organizationId: orgId,
          usageDate: { gte: windowStart, lte: windowEnd },
        },
        select: {
          signalId: true,
          subscriptionId: true,
          quantity: true,
          usageCost: true,
          usageDate: true,
        },
        orderBy: { usageDate: 'asc' },
      }),
      db.subscriptions.findMany({
        where: {
          agentId: input.agentId,
          organizationId: orgId,
          status: 'active',
          deletedAt: null,
        },
        select: activeSubscriptionsWithStrategiesSelect,
      }),
    ])

    // Signal name lookup by id — fills in names for event rows that
    // don't carry the signal relation in-line.
    const signalNameById = new Map<string, string>()
    for (const s of signals) signalNameById.set(s.id, s.name)

    // (subscriptionId, signalId) → CalcStrategy. The shared helper handles
    // tier-shape normalization, the usage-only filter, and null-rate
    // preservation (canon R3) — same path full-command-center uses, so the
    // breakdown chart and the command-center cards stay in lockstep.
    const strategyBySubSignal = buildStrategyBySubSignal(subscriptions)

    // Aggregate per (day, signalId) — one row per combination so the chart
    // can render stacked series with date on the X axis.
    const bucket = new Map<
      string, // `${dateKey}:${signalId}`
      {
        date: string
        signalId: string
        quantity: number
        cost: number
        earned: number
      }
    >()

    for (const ev of events) {
      const sid = ev.signalId
      if (!sid) continue
      const dateKey = toDateKey(ev.usageDate)
      const mapKey = `${dateKey}:${sid}`
      const qty = Number(ev.quantity ?? 0)
      const cost = Number(ev.usageCost ?? 0)

      // Earned per event: route through the canonical helper. Same code
      // path the invoice calculator uses, so flat/graduated/volume/credit_pool
      // all get matching math. Per-event attribution is still an approximation
      // for tiered/pooled models (each event's quantity is routed in isolation,
      // not against cumulative usage).
      const earned = earnedForEvent(strategyBySubSignal, ev)

      const existing = bucket.get(mapKey) ?? {
        date: dateKey,
        signalId: sid,
        quantity: 0,
        cost: 0,
        earned: 0,
      }
      existing.quantity += qty
      existing.cost += cost
      existing.earned += earned
      bucket.set(mapKey, existing)
    }

    const dailyBreakdown: AgentDailyBreakdownRow[] = Array.from(bucket.values())
      .map((row) => ({
        date: row.date,
        signalId: row.signalId,
        signalName: signalNameById.get(row.signalId) ?? 'Unknown',
        quantity: Math.round(row.quantity * 1000) / 1000,
        cost: Math.round(row.cost * 10000) / 10000,
        earned: Math.round(row.earned * 100) / 100,
      }))
      .sort((a, b) =>
        a.date === b.date
          ? a.signalName.localeCompare(b.signalName)
          : a.date.localeCompare(b.date)
      )

    // Summary totals for the card footer / subheader.
    const totals = dailyBreakdown.reduce(
      (acc, row) => ({
        quantity: acc.quantity + row.quantity,
        cost: acc.cost + row.cost,
        earned: acc.earned + row.earned,
        margin: 0,
        marginPct: 0,
      }),
      { quantity: 0, cost: 0, earned: 0, margin: 0, marginPct: 0 }
    )
    totals.margin = Math.round((totals.earned - totals.cost) * 100) / 100
    totals.marginPct =
      Math.round(
        (safeMarginPercent(totals.earned, totals.margin) ?? 0) * 10
      ) / 10
    totals.quantity = Math.round(totals.quantity * 1000) / 1000
    totals.cost = Math.round(totals.cost * 10000) / 10000
    totals.earned = Math.round(totals.earned * 100) / 100

    return {
      success: true,
      data: {
        periodStart: windowStart.toISOString(),
        periodEnd: windowEnd.toISOString(),
        signals: signals.map((s) => ({ id: s.id, name: s.name })),
        dailyBreakdown,
        totals,
      },
    }
  } catch (error) {
    console.error('[getAgentEarningsBreakdown] Error:', error)
    return { success: false, error: 'Failed to compute earnings breakdown' }
  }
}

// Format a Date as YYYY-MM-DD in UTC so every event that happened on the
// same calendar day lands in the same bucket regardless of tz offset.
function toDateKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
