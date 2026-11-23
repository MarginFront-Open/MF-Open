'use server'

/**
 * Metrics resolver: the ONE server action the metrics pages
 * call for their numbers. It COMPOSES canonical functions
 * from @marginfront/db (never re-derives math): tiles come from the canon
 * getters, series + breakdown come from getCostBreakdown. Chart-vs-table
 * equality is by construction — one response, one window, one transaction
 * snapshot. Display formatting is NOT this file's job; components format
 * via @/lib/canon-format.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import {
  getCostBreakdown,
  getRevenueMetrics as canonGetRevenueMetrics,
  getInvoiceTotals as canonGetInvoiceTotals,
  getMrr as canonGetMrr,
  getAgentEarned as canonGetAgentEarned,
  costPerTask,
  safeMarginPercent,
  DimensionSchema,
  RevenueFiltersSchema,
  COST_BREAKDOWN_DEFAULT_PAGE_SIZE,
  ANALYTICS_MAX_ROWS,
} from '@marginfront/db'
import type {
  BreakdownRow,
  CostBreakdownOther,
  CostByDayRow,
  Dimension,
} from '@marginfront/db'
import { z } from 'zod'
import {
  parseWindowFilter,
  formatWindowLabel,
} from './_shared/parse-window-filter'
import { getRevenueByDimension } from './_shared/revenue-by-dimension'
import type { RevenueBasis } from '@/lib/revenue-basis'
import { SCOPE_TILE_SOURCES } from '@/lib/component-catalog'

export type MetricsScope =
  | 'money'
  | 'finops'
  | 'build'
  | 'roi'
  | 'mfiq'

export interface ResolveMetricsInput {
  scope: MetricsScope
  /** parseWindowFilter semantics — bare dates or full ISO timestamps. */
  period: { startDate?: string; endDate?: string }
  dimension: Dimension
  filters: {
    customerId?: string
    agentId?: string
    signalId?: string
    subscriptionId?: string
  }
  breakdown?: { page: number; pageSize: number }
}

/**
 * Tile values are full-precision dollars/counts (canon R4 — the UI rounds
 * once via canon-format). Ratio fields are number | null per canon M1/M2:
 * null means "undefined for this window" (renders as "—"), never 0.
 * Which optional fields are present depends on the scope's tile map below.
 */
export interface ResolvedTiles {
  cost: number
  eventCount: number
  eventCountWithNullCost: number
  costPerTask: number | null
  revenue?: number
  usageRevenue?: number
  recurringRevenue?: number
  seatRevenue?: number
  onetimeRevenue?: number
  margin?: number
  marginPercent?: number | null
  earned?: number
  billed?: number
  collected?: number
  outstanding?: number
  overdueAmount?: number
  overdueCount?: number
  refunded?: number
  mrr?: number
  arr?: number
}

/**
 * A cost breakdown row (canon {key, cost, eventCount}) plus the ADDITIVE
 * per-bucket revenue composed on top. `revenue`/
 * `marginPercent` are present only when the dimension is revenue-definable AND
 * the scope computes revenue — absent (undefined) means "not definable, render
 * '—'" (canon M2). A real $0 bucket carries revenue: 0, never undefined.
 */
export interface ResolvedBreakdownRow extends BreakdownRow {
  revenue?: number
  /** safeMarginPercent(revenue, revenue − cost); null when revenue is 0
   * (canon M1). Never an inline (a−b)/a. */
  marginPercent?: number | null
}

export interface ResolvedBreakdownOther extends CostBreakdownOther {
  revenue?: number
  marginPercent?: number | null
}

export interface ResolvedBreakdown {
  rows: ResolvedBreakdownRow[]
  totalRowCount: number
  other: ResolvedBreakdownOther | null
  page: number
  pageSize: number
  /** 'earned' (agent/signal), 'billed' (customer/plan), or null when revenue
   * is not definable for this dimension OR the scope doesn't compute revenue.
   * The table/donut read this to label the revenue column and gate it. Cost
   * stays 100% from getCostBreakdown regardless — revenue is a separate,
   * parity-tested composition. */
  revenueBasis: RevenueBasis | null
}

/** One UTC day's earned dollars — always a whole-day getRevenueMetrics()
 * output (never per-event math). */
export interface EarnedByDayRow {
  date: Date
  earned: number
}

export interface ResolvedMetrics {
  window: { start: Date; end: Date; label: string }
  tiles: ResolvedTiles
  series: CostByDayRow[]
  /** Per-day earned alongside `series`' per-day cost. Optional so
   * fixtures without it compile; resolveMetrics always sets it, null when
   * the scope doesn't compute revenue or the window exceeds
   * EARNED_SERIES_MAX_DAYS days (chart falls back to cost-only). */
  earnedSeries?: EarnedByDayRow[] | null
  breakdown: ResolvedBreakdown
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Beyond this many days, computeEarnedSeries returns null instead of
 * firing one getRevenueMetrics query per day. */
const EARNED_SERIES_MAX_DAYS = 92

const EARNED_SERIES_CONCURRENCY = 8

function utcDayFloor(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY) * MS_PER_DAY
}

// Bounded-concurrency map: `items.length` promises would fire every day's
// query at once; this keeps at most `limit` in flight against Postgres.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return results
}

async function computeEarnedSeries(
  orgId: string,
  window: { start: Date; end: Date },
  filters: ResolveMetricsInput['filters']
): Promise<EarnedByDayRow[] | null> {
  const firstDay = utcDayFloor(window.start)
  const lastDay = utcDayFloor(window.end)
  const dayCount = Math.round((lastDay - firstDay) / MS_PER_DAY) + 1
  if (dayCount > EARNED_SERIES_MAX_DAYS) return null

  const dayFloors: number[] = []
  for (let day = firstDay; day <= lastDay; day += MS_PER_DAY) {
    dayFloors.push(day)
  }

  return mapWithConcurrency(
    dayFloors,
    EARNED_SERIES_CONCURRENCY,
    async (dayFloor): Promise<EarnedByDayRow> => {
      const dayWindow = {
        start: new Date(Math.max(dayFloor, window.start.getTime())),
        end: new Date(Math.min(dayFloor + MS_PER_DAY - 1, window.end.getTime())),
      }
      const dayMetrics = await canonGetRevenueMetrics(
        prisma,
        orgId,
        dayWindow,
        filters
      )
      return { date: new Date(dayFloor), earned: dayMetrics.revenue }
    }
  )
}

const ResolveMetricsInputSchema = z.object({
  scope: z.enum(['money', 'finops', 'build', 'roi', 'mfiq']),
  period: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }),
  dimension: DimensionSchema,
  filters: RevenueFiltersSchema,
  breakdown: z
    .object({
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
    })
    .optional(),
})

export async function resolveMetrics(input: ResolveMetricsInput): Promise<{
  success: boolean
  data?: ResolvedMetrics
  error?: string
}> {
  try {
    const parsed = ResolveMetricsInputSchema.safeParse(input)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return {
        success: false,
        error: `Invalid metrics request (${issue.path.join('.') || 'input'}: ${issue.message}). This is a bug in the calling page, not your data.`,
      }
    }

    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const { scope, period, dimension, filters, breakdown } = parsed.data

    const { windowStart, windowEnd } = parseWindowFilter(period)
    const window = { start: windowStart, end: windowEnd }
    const label = formatWindowLabel(period, windowStart, windowEnd)

    // Same clamp getCostBreakdown applies internally, computed here too so
    // the echoed page/pageSize match what the query actually used.
    const page = Math.max(1, Math.trunc(breakdown?.page ?? 1))
    const pageSize = Math.min(
      ANALYTICS_MAX_ROWS,
      Math.max(
        1,
        Math.trunc(breakdown?.pageSize ?? COST_BREAKDOWN_DEFAULT_PAGE_SIZE)
      )
    )

    const sources = SCOPE_TILE_SOURCES[scope]
    const [
      costBreakdown,
      revenueMetrics,
      invoiceTotals,
      mrr,
      agentEarned,
      earnedSeries,
      revenueByDim,
    ] = await Promise.all([
        getCostBreakdown(prisma, orgId, window, dimension, filters, {
          page,
          pageSize,
        }),
        sources.revenue
          ? canonGetRevenueMetrics(prisma, orgId, window, filters)
          : null,
        sources.invoices
          ? canonGetInvoiceTotals(prisma, orgId, window, filters)
          : null,
        sources.mrr
          ? canonGetMrr(prisma, orgId, {
              customerId: filters.customerId,
              subscriptionId: filters.subscriptionId,
            })
          : null,
        sources.earned
          ? canonGetAgentEarned(prisma, orgId, window, filters)
          : null,
        sources.revenue
          ? computeEarnedSeries(orgId, window, filters)
          : Promise.resolve(null),
        // Per-bucket revenue over the SAME window/filters, gated on the same
        // sources.revenue flag as the revenue tiles. Cost is untouched — this
        // is an additive composition. null when the
        // scope doesn't compute revenue OR the dimension isn't definable.
        sources.revenue
          ? getRevenueByDimension(prisma, orgId, window, dimension, filters)
          : Promise.resolve(null),
      ])

    // Assembled by assignment, not one big literal: the canon lint rule
    // rejects any object literal whose descendants include earned + billed
    // + collected together, and a spread-based literal trips it even though
    // every value here IS a canonical library return.
    const tiles: ResolvedTiles = {
      cost: costBreakdown.totals.cost,
      eventCount: costBreakdown.totals.eventCount,
      eventCountWithNullCost: costBreakdown.totals.eventCountWithNullCost,
      costPerTask: costPerTask(
        costBreakdown.totals.cost,
        costBreakdown.totals.eventCount
      ),
    }
    if (revenueMetrics) {
      tiles.revenue = revenueMetrics.revenue
      tiles.usageRevenue = revenueMetrics.usageRevenue
      tiles.recurringRevenue = revenueMetrics.recurringRevenue
      tiles.seatRevenue = revenueMetrics.seatRevenue
      tiles.onetimeRevenue = revenueMetrics.onetimeRevenue
      tiles.margin = revenueMetrics.margin
      tiles.marginPercent = revenueMetrics.marginPercent
    }
    if (invoiceTotals) {
      tiles.billed = invoiceTotals.billed
      tiles.collected = invoiceTotals.collected
      tiles.outstanding = invoiceTotals.outstanding
      tiles.overdueAmount = invoiceTotals.overdueAmount
      tiles.overdueCount = invoiceTotals.overdueCount
      tiles.refunded = invoiceTotals.refunded
    }
    if (mrr) {
      tiles.mrr = mrr.mrr
      tiles.arr = mrr.arr
    }
    if (agentEarned) {
      tiles.earned = agentEarned.revenue
    }

    // Compose per-bucket revenue onto the cost rows. A null-key cost row (e.g.
    // events with no signal / no plan) has no entity to attribute revenue to,
    // so it reads $0 on a definable dimension. Margin is safeMarginPercent ONLY
    // — never an inline (revenue−cost)/revenue.
    const revenueForKey = (key: string | null): number =>
      key === null ? 0 : (revenueByDim?.byKey.get(key) ?? 0)

    const rows: ResolvedBreakdownRow[] = revenueByDim
      ? costBreakdown.rows.map((row) => {
          const revenue = revenueForKey(row.key)
          return {
            ...row,
            revenue,
            marginPercent: safeMarginPercent(revenue, revenue - row.cost),
          }
        })
      : costBreakdown.rows

    let other: ResolvedBreakdownOther | null = costBreakdown.other
    if (costBreakdown.other && revenueByDim) {
      // Folded-away "Other" revenue = window total − revenue on the visible
      // page, so Σ(rows.revenue) + other.revenue === total (the revenue-side
      // analogue of the cost invariant). NOTE: on the 'billed' basis this can
      // fold in customers/plans that were invoiced but had NO in-window events
      // (thus absent from the cost breakdown) — honest (they ARE "other"), but
      // it means cost-Other and revenue-Other are not the same entity set.
      const pageRevenue = rows.reduce((sum, row) => sum + (row.revenue ?? 0), 0)
      const otherRevenue = revenueByDim.total - pageRevenue
      other = {
        ...costBreakdown.other,
        revenue: otherRevenue,
        marginPercent: safeMarginPercent(
          otherRevenue,
          otherRevenue - costBreakdown.other.cost
        ),
      }
    }

    return {
      success: true,
      data: {
        window: { start: windowStart, end: windowEnd, label },
        tiles,
        series: costBreakdown.series,
        earnedSeries,
        breakdown: {
          rows,
          totalRowCount: costBreakdown.totalRowCount,
          other,
          page,
          pageSize,
          revenueBasis: revenueByDim?.basis ?? null,
        },
      },
    }
  } catch {
    return {
      success: false,
      error:
        "Couldn't load metrics for this page. The database query failed. Refresh to retry; if it keeps happening, the database may be unreachable.",
    }
  }
}
