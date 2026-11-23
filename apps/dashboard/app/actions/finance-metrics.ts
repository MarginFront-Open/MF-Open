'use server'

/**
 * Finance Module revenue-aware metrics: margin BY product line, not only COGS
 * classification.
 *
 * Deliberately separate from cost-command-center.ts, which is contractually
 * cost-only (a parity test there asserts no revenue/margin keys leak). This
 * module owns the finance surfaces that intentionally combine cost + revenue:
 * product-line margin.
 *
 * All math delegates to the canonical revenue lib (getRevenueMetrics in
 * @marginfront/db). We aggregate its per-subscription breakdown up to the agent
 * (product line) level — an agent is MarginFront's closest concept to a
 * "product."
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import {
  getRevenueMetrics as canonGetRevenueMetrics,
  getCostMetrics as canonGetCostMetrics,
} from '@marginfront/db'
import { getJournalExport } from './journal-export'
import {
  parseWindowFilter,
  formatWindowLabel,
  type WindowFilter,
} from './_shared/parse-window-filter'
import { findLockedPeriod } from './_shared/period-lock-store'

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

export type ProductLineMargin = {
  agentId: string
  agentName: string
  /**
   * Total Revenue for this product line (canon Revenue, R1+R2): usage
   * (events × rate) PLUS recurring, seat, and one-time fees — "what the
   * customer owes" over the window.
   */
  revenue: number
  /**
   * Agent-Earned for this product line (canon Agent-Earned, R1): the usage
   * slice only — events × rate, no recurring/seat/one-time fees. Always ≤
   * `revenue`. Surfaced so the "earned vs total" chart can
   * show "what activity produced" beside "what the customer owes" without a
   * second server round-trip: it's already in the canon per-subscription
   * breakdown we aggregate below (`usageRevenue`).
   */
  earned: number
  /** AI cost attributed to this product line (billable events tied to its subscriptions). */
  cost: number
  /** revenue − cost. */
  margin: number
  /** margin / revenue, 0-1. Null when revenue === 0 (canon M1). */
  marginPercent: number | null
  /** Distinct customers with a subscription on this product line. */
  customerCount: number
  /** Number of active subscriptions on this product line. */
  subscriptionCount: number
}

export type ProductLineMarginSummary = {
  periodLabel: string
  rows: ProductLineMargin[]
  /** Org-wide blended margin % across all product lines, for the reference line. */
  blendedMarginPercent: number | null
  totalRevenue: number
  /** Org-wide Agent-Earned across all product lines (canon R1) — sum of rows.earned. */
  totalEarned: number
  totalCost: number
}

/**
 * Per-product-line (per-agent) margin for the active org over the last 30
 * days. Aggregates the canonical revenue lib's per-subscription breakdown up
 * to the agent level, then joins agent names. Sorted by revenue descending so
 * the biggest product lines lead.
 *
 * Note: R&D / internal AI usage (events with no subscription) is intentionally
 * excluded — product-line margin is a customer-facing COGS-vs-revenue view.
 * Internal R&D cost shows in the COGS classification panel's R&D bucket, not here.
 *
 * Each row also carries `earned` (canon Agent-Earned, R1) beside
 * `revenue` (canon Total, R1+R2) so the CFO "earned vs total" chart can read
 * both off ONE call. `earned` is the usage-only slice already present in the
 * canon per-subscription breakdown — no extra query, no new server action.
 */
export async function getProductLineMargins(
  filter?: WindowFilter
): Promise<ProductLineMarginSummary | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return null
  const orgId = session.session.activeOrganizationId

  const { windowStart, windowEnd } = parseWindowFilter(filter)

  // PERIOD LOCK: a CLOSED period serves its frozen
  // product-line margins so the locked close is fully consistent with the page
  // banner + Close dialog ("…won't change this period's journal, CSVs, or
  // margin"). Mirrors the guard in getDefensibilityScore.
  const locked = await findLockedPeriod(orgId, windowStart, windowEnd)
  // Cast back from the store's `unknown` (cycle-break) to this fn's return type.
  if (locked)
    return locked.snapshot.productLineMargins as ProductLineMarginSummary

  const rev = await canonGetRevenueMetrics(prisma, orgId, {
    start: windowStart,
    end: windowEnd,
  })

  // Aggregate the per-subscription breakdown up to agent level.
  type Agg = {
    revenue: number
    earned: number
    cost: number
    customers: Set<string>
    subscriptions: number
  }
  const byAgent = new Map<string, Agg>()
  for (const sub of rev.bySubscription) {
    const a = byAgent.get(sub.agentId) ?? {
      revenue: 0,
      earned: 0,
      cost: 0,
      customers: new Set<string>(),
      subscriptions: 0,
    }
    a.revenue += sub.revenue
    // Agent-Earned (canon R1): the usage-only slice of this sub's revenue. The
    // canon lib already split it out per subscription (`usageRevenue`); this
    // rolls it up to the agent alongside total revenue.
    a.earned += sub.usageRevenue
    a.cost += sub.cost
    a.customers.add(sub.customerId)
    a.subscriptions += 1
    byAgent.set(sub.agentId, a)
  }

  // Join agent names.
  const agentIds = Array.from(byAgent.keys())
  const agents =
    agentIds.length > 0
      ? await prisma.agents.findMany({
          where: { id: { in: agentIds }, orgId },
          select: { id: true, name: true },
        })
      : []
  const nameById = new Map(agents.map((a) => [a.id, a.name]))

  const rows: ProductLineMargin[] = agentIds
    .map((agentId) => {
      const a = byAgent.get(agentId)!
      const margin = a.revenue - a.cost
      return {
        agentId,
        agentName: nameById.get(agentId) ?? 'Unknown product',
        revenue: a.revenue,
        earned: a.earned,
        cost: a.cost,
        margin,
        marginPercent: a.revenue > 0 ? margin / a.revenue : null,
        customerCount: a.customers.size,
        subscriptionCount: a.subscriptions,
      }
    })
    .sort((x, y) => y.revenue - x.revenue)

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
  const totalEarned = rows.reduce((s, r) => s + r.earned, 0)
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)

  return {
    periodLabel: formatWindowLabel(filter, windowStart, windowEnd),
    rows,
    blendedMarginPercent:
      totalRevenue > 0 ? (totalRevenue - totalCost) / totalRevenue : null,
    totalRevenue,
    totalEarned,
    totalCost,
  }
}

export type DefensibilityScore = {
  periodLabel: string
  /** 0–1 composite "how defensible is this AI P&L" score. Null when no cost in window. */
  score: number | null
  /** score × 100, rounded — the board-citable headline. Null when score is null. */
  scorePercent: number | null
  /** Share of cost ($) on a classified (non-UNCLASSIFIED) signal, 0–1. */
  classifiedShare: number | null
  /** Share of cost ($) mapped to a GL code, 0–1. */
  glMappedShare: number | null
  /** Share of cost ($) on events that carry a known environment, 0–1. */
  instrumentedShare: number | null
  /** Dollars still UNCLASSIFIED — the headline gap to close. */
  unclassifiedCost: number
  /** Dollars not yet mapped to a GL code. */
  unmappedCost: number
  /** Total AI cost in the window. */
  totalCost: number
}

/**
 * "Defensibility score" — how much of the AI P&L is backed by an explicit
 * classification + GL mapping + instrumentation, vs. guessed. A CFO can cite
 * it as "94% of our AI spend is classified and mapped to a GL code".
 *
 * All inputs come from existing canon outputs (getCostMetrics' byCostCategory
 * + byEnvironment) plus the journal export's GL-mapping coverage — no new
 * per-event SQL. Weighted toward classified-by-dollars (the dominant term);
 * GL mapping and instrumentation are secondary quality signals. The score
 * climbs as the operator classifies signals and maps GL codes. Lives here (not cost-command-center.ts) to stay clear of the
 * cost-only parity test.
 *
 * Returns null only when there is no session; a zero-cost window returns a
 * populated object with null shares (canon M1 null-on-zero).
 */
export async function getDefensibilityScore(
  filter?: WindowFilter
): Promise<DefensibilityScore | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return null
  const orgId = session.session.activeOrganizationId

  const { windowStart, windowEnd } = parseWindowFilter(filter)
  const periodLabel = formatWindowLabel(filter, windowStart, windowEnd)

  // PERIOD LOCK: a CLOSED period serves its frozen
  // defensibility score so the locked close is consistent with its posted
  // journal/breakdown.
  const locked = await findLockedPeriod(orgId, windowStart, windowEnd)
  // Cast back from the store's `unknown` (cycle-break) to this fn's return type.
  if (locked) return locked.snapshot.score as DefensibilityScore

  // Canon cost (category + environment splits) and the journal export
  // (GL-mapping coverage) over the IDENTICAL window — passing full ISO
  // timestamps makes getJournalExport resolve the same bounds as canon.
  const [cost, journal] = await Promise.all([
    canonGetCostMetrics(prisma, orgId, { start: windowStart, end: windowEnd }),
    getJournalExport({
      startDate: windowStart.toISOString(),
      endDate: windowEnd.toISOString(),
    }),
  ])

  const totalCost = cost.cost
  const unclassifiedCost =
    cost.byCostCategory.find((r) => r.costCategory === 'UNCLASSIFIED')?.cost ??
    0
  const unmappedCost = journal?.unmappedAmount ?? 0

  if (totalCost <= 0) {
    return {
      periodLabel,
      score: null,
      scorePercent: null,
      classifiedShare: null,
      glMappedShare: null,
      instrumentedShare: null,
      unclassifiedCost,
      unmappedCost,
      totalCost,
    }
  }

  const classifiedShare = (totalCost - unclassifiedCost) / totalCost

  const instrumentedCost = cost.byEnvironment
    .filter((r) => r.environment !== null)
    .reduce((sum, r) => sum + r.cost, 0)
  const instrumentedShare = instrumentedCost / totalCost

  // GL coverage from the journal export, computed against its own total so the
  // ratio is self-consistent even if the journal window edge differs by a hair.
  const journalTotal = journal?.totalAmount ?? 0
  const glMappedShare =
    journalTotal > 0 ? (journalTotal - unmappedCost) / journalTotal : null

  // Weighted composite over the available terms, renormalized so a missing GL
  // term doesn't deflate the score. Classified-by-dollars dominates.
  const terms: Array<{ weight: number; value: number | null }> = [
    { weight: 0.6, value: classifiedShare },
    { weight: 0.25, value: glMappedShare },
    { weight: 0.15, value: instrumentedShare },
  ]
  const present = terms.filter(
    (t): t is { weight: number; value: number } => t.value !== null
  )
  const weightSum = present.reduce((s, t) => s + t.weight, 0)
  const score =
    weightSum > 0
      ? present.reduce((s, t) => s + t.weight * clamp01(t.value), 0) / weightSum
      : null

  return {
    periodLabel,
    score,
    scorePercent: score === null ? null : Math.round(score * 100),
    classifiedShare,
    glMappedShare,
    instrumentedShare,
    unclassifiedCost,
    unmappedCost,
    totalCost,
  }
}
