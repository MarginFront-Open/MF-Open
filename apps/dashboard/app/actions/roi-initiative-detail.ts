'use server'

/**
 * The ONE read action behind
 * /roi/[initiativeId]. The headline view comes from the SAME
 * buildInitiativeView composition the ROI cards use, so the detail page can
 * never disagree with the card it was clicked from. On top of that it adds
 * the day-by-day series for each target's metric over the initiative
 * window: cost-family days from getCostBreakdown's canon series,
 * revenue-family days from whole-day getRevenueMetrics reads (the
 * metrics-resolver earned-series pattern, same 92-day bound), newCustomers
 * from a plain created-per-day count. Metrics with no honest history
 * (mrr/arr snapshots, unmappedCount, the internal/external split) return
 * null and the page says so instead of inventing a line.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import { getCostBreakdown, getRevenueMetrics, costPerTask } from '@marginfront/db'
import { getInitiatives } from './initiatives'
import type { InitiativeMetric } from './initiatives'
import type { RoiInitiativeView } from './roi-overview'
import { parseWindowFilter } from './_shared/parse-window-filter'
import { buildInitiativeView } from './_shared/initiative-actuals'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Beyond this many days the revenue day-series would fire one
 * getRevenueMetrics query per day — return null instead (the
 * EARNED_SERIES_MAX_DAYS precedent; the chart shows an honest note). */
const DETAIL_SERIES_MAX_DAYS = 92

const REVENUE_SERIES_CONCURRENCY = 8

export interface RoiTargetSeriesPoint {
  /** Bare UTC date, YYYY-MM-DD. */
  date: string
  value: number
}

export interface RoiInitiativeDetail {
  view: RoiInitiativeView
  /** Keyed by target id; null = no honest day-by-day series exists for
   * that metric (canon M2 posture — the page renders a note, never an
   * invented chart). */
  seriesByTargetId: Record<string, RoiTargetSeriesPoint[] | null>
}

function utcDayFloor(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY) * MS_PER_DAY
}

function bareDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Bounded-concurrency map (the metrics-resolver shape): `items.length`
// promises would fire every day's query at once; this keeps at most `limit`
// in flight against Postgres.
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

interface RevenueDay {
  date: string
  revenue: number
  margin: number
  marginPercent: number | null
}

async function computeRevenueDaySeries(
  orgId: string,
  window: { start: Date; end: Date }
): Promise<RevenueDay[] | null> {
  const firstDay = utcDayFloor(window.start)
  const lastDay = utcDayFloor(window.end)
  const dayCount = Math.round((lastDay - firstDay) / MS_PER_DAY) + 1
  if (dayCount > DETAIL_SERIES_MAX_DAYS) return null

  const dayFloors: number[] = []
  for (let day = firstDay; day <= lastDay; day += MS_PER_DAY) {
    dayFloors.push(day)
  }

  return mapWithConcurrency(
    dayFloors,
    REVENUE_SERIES_CONCURRENCY,
    async (dayFloor): Promise<RevenueDay> => {
      const dayWindow = {
        start: new Date(Math.max(dayFloor, window.start.getTime())),
        end: new Date(Math.min(dayFloor + MS_PER_DAY - 1, window.end.getTime())),
      }
      const dayMetrics = await getRevenueMetrics(prisma, orgId, dayWindow, {})
      return {
        date: bareDate(new Date(dayFloor)),
        revenue: dayMetrics.revenue,
        margin: dayMetrics.margin,
        marginPercent: dayMetrics.marginPercent,
      }
    }
  )
}

function seriesForMetric(
  metric: InitiativeMetric,
  costDays: Array<{ date: Date; cost: number; eventCount: number }> | null,
  revenueDays: RevenueDay[] | null,
  customerDays: RoiTargetSeriesPoint[] | null
): RoiTargetSeriesPoint[] | null {
  switch (metric) {
    case 'cost':
      return costDays
        ? costDays.map((d) => ({ date: bareDate(d.date), value: d.cost }))
        : null
    case 'eventCount':
      return costDays
        ? costDays.map((d) => ({ date: bareDate(d.date), value: d.eventCount }))
        : null
    case 'costPerTask':
      // costPerTask is null on a zero-event day (canon M2) — those days
      // simply have no point, never a fabricated 0.
      return costDays
        ? costDays.flatMap((d) => {
            const value = costPerTask(d.cost, d.eventCount)
            return value === null
              ? []
              : [{ date: bareDate(d.date), value }]
          })
        : null
    case 'revenue':
      return revenueDays
        ? revenueDays.map((d) => ({ date: d.date, value: d.revenue }))
        : null
    case 'margin':
      return revenueDays
        ? revenueDays.map((d) => ({ date: d.date, value: d.margin }))
        : null
    case 'marginPercent':
      return revenueDays
        ? revenueDays.flatMap((d) =>
            d.marginPercent === null
              ? []
              : [{ date: d.date, value: d.marginPercent }]
          )
        : null
    case 'newCustomers':
      return customerDays
    case 'unmappedCount':
    case 'mrr':
    case 'arr':
    case 'internalCost':
    case 'externalCost':
      return null
    default: {
      const exhaustive: never = metric
      return exhaustive
    }
  }
}

/**
 * One initiative's detail view: the card-identical headline numbers plus a
 * per-target day-by-day series over the initiative's window.
 */
export async function getInitiativeDetail(initiativeId: string): Promise<{
  success: boolean
  data?: RoiInitiativeDetail
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    const initiativesResult = await getInitiatives()
    if (!initiativesResult.success || !initiativesResult.data) {
      return {
        success: false,
        error: initiativesResult.error ?? 'Failed to load initiatives',
      }
    }

    const initiative = initiativesResult.data.find(
      (i) => i.id === initiativeId
    )
    if (!initiative) {
      return {
        success: false,
        error:
          "This initiative doesn't exist or was deleted. Head back to the ROI page to see what's tracked.",
      }
    }

    const view = await buildInitiativeView(initiative, orgId, new Date())

    const metrics = new Set(initiative.targets.map((t) => t.metric))
    // A matter-scoped initiative gets NO series: the matter
    // rollup has no day grain, and the org-wide series below would chart a
    // line that has nothing to do with this matter. The page already renders
    // an honest "no day-by-day history" note for a null series.
    const matterScoped = initiative.matterId !== null
    const needCostSeries =
      !matterScoped &&
      (metrics.has('cost') ||
        metrics.has('eventCount') ||
        metrics.has('costPerTask'))
    const needRevenueSeries =
      !matterScoped &&
      (metrics.has('revenue') ||
        metrics.has('margin') ||
        metrics.has('marginPercent'))
    const needCustomerSeries = !matterScoped && metrics.has('newCustomers')

    // Bare dates so parseWindowFilter's end-of-day branch fires and the
    // final day counts, the same slicing the actuals composition applies.
    const period = {
      startDate: initiative.startDate.slice(0, 10),
      endDate: initiative.endDate ? initiative.endDate.slice(0, 10) : undefined,
    }
    const { windowStart, windowEnd } = parseWindowFilter(period)
    const window = { start: windowStart, end: windowEnd }

    const [costBreakdown, revenueDays, createdRows] = await Promise.all([
      needCostSeries
        ? getCostBreakdown(
            prisma,
            orgId,
            window,
            'day',
            {},
            {
              page: 1,
              pageSize: 1,
              includeOtherRollup: false,
            }
          )
        : null,
      needRevenueSeries ? computeRevenueDaySeries(orgId, window) : null,
      needCustomerSeries
        ? prisma.customers.findMany({
            where: {
              organizationId: orgId,
              deletedAt: null,
              createdAt: { gte: windowStart, lte: windowEnd },
            },
            select: { createdAt: true },
          })
        : null,
    ])

    let customerDays: RoiTargetSeriesPoint[] | null = null
    if (createdRows) {
      const countsByDay = new Map<string, number>()
      for (const row of createdRows) {
        const day = bareDate(row.createdAt)
        countsByDay.set(day, (countsByDay.get(day) ?? 0) + 1)
      }
      customerDays = [...countsByDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value }))
    }

    const seriesByTargetId: Record<string, RoiTargetSeriesPoint[] | null> = {}
    for (const target of view.targets) {
      seriesByTargetId[target.id] = seriesForMetric(
        target.metric,
        costBreakdown ? costBreakdown.series : null,
        revenueDays,
        customerDays
      )
    }

    return { success: true, data: { view, seriesByTargetId } }
  } catch {
    return {
      success: false,
      error:
        "Couldn't load this initiative's detail. A database query failed. Refresh to retry; if it keeps happening, the database may be unreachable.",
    }
  }
}
