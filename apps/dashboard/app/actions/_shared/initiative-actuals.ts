/**
 * The ONE window-read composition behind every initiative
 * number. getRoiOverview, the auto baselines in initiatives.ts and the
 * /roi/[initiativeId] detail action all read through here, so a card, a detail page, and a stored starting value
 * can never disagree about the same window. Canon getters only, no new
 * SQL, never the metrics resolver, no re-derived sums.
 *
 * Lives in _shared (a plain module, the parse-window-filter pattern) because
 * both 'use server' files need it and initiatives.ts <- roi-overview.ts is
 * already an import edge — importing the other way would be a cycle.
 */

import { db as prisma } from '@/app/lib/db'
import {
  getCostBreakdown,
  getRevenueMetrics,
  getMrr,
  getMatterCostRollups,
  ANALYTICS_MAX_ROWS,
} from '@marginfront/db'
import type { Initiative, InitiativeMetric } from '../initiatives'
import type { RoiInitiativeView, RoiTargetView } from '../roi-overview'
import { getJournalExport } from '../journal-export'
import { parseWindowFilter } from './parse-window-filter'
import {
  targetProgress,
  deriveInitiativeHealth,
  windowElapsedPct,
} from '@/features/roi/progress-derivation'
import {
  AUTO_BASELINE_SUPPORTED,
  baselineWindowFor,
} from '@/features/roi/baseline-derivation'
import {
  actualForMetric,
  autoBaselineFromReads,
  matterScopedReads,
  NO_READS,
  type WindowReads,
} from './initiative-metric-values'
import {
  buildInternalCustomerMeta,
  sumCostByInternalPartition,
} from '@/features/money/internal-partition'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** getJournalExport's window findMany is unbounded — past
 * this many days the unmappedCount read is null (renders '—', canon M2),
 * the EARNED_SERIES_MAX_DAYS precedent. */
export const ROI_UNMAPPED_WINDOW_MAX_DAYS = 92

/**
 * Every canon read a set of initiative metrics needs, over one bare-date
 * window. `includeMrrSnapshot` exists because getMrr is a point-in-time
 * snapshot (canon MRR1, as-of new Date() inside the getter): fine as a
 * "today" actual, dishonest as a historical baseline — so the baseline path
 * always passes false.
 *
 * `matterId` narrows the batch to one matter via
 * getMatterCostRollups. Every other read is SKIPPED rather than run org-wide:
 * a revenue number measured across the whole org under a matter-scoped goal
 * would be a wrong answer, not a partial one.
 */
export async function readMetricsWindow(
  orgId: string,
  metrics: ReadonlySet<InitiativeMetric>,
  period: { startDate: string; endDate?: string },
  opts: { includeMrrSnapshot: boolean; matterId?: string | null }
): Promise<WindowReads> {
  const needCost =
    metrics.has('cost') ||
    metrics.has('eventCount') ||
    metrics.has('costPerTask')
  const needRevenue =
    metrics.has('revenue') ||
    metrics.has('margin') ||
    metrics.has('marginPercent')
  const needJournal = metrics.has('unmappedCount')
  const needMrr =
    opts.includeMrrSnapshot && (metrics.has('mrr') || metrics.has('arr'))
  const needNewCustomers = metrics.has('newCustomers')
  const needPartitionedCost =
    metrics.has('internalCost') || metrics.has('externalCost')

  const { windowStart, windowEnd } = parseWindowFilter(period)
  const window = { start: windowStart, end: windowEnd }

  if (opts.matterId) {
    if (!needCost) return NO_READS
    const [rollup] = await getMatterCostRollups(prisma, orgId, {
      matterIds: [opts.matterId],
      window,
    })
    // The rollup zero-fills a requested bucket, so 0 here means the matter
    // spent nothing in this window — a measurement, not a gap.
    return matterScopedReads(
      rollup ? { cost: rollup.cost, eventCount: rollup.eventCount } : null
    )
  }

  // Inclusive UTC day count, the computeEarnedSeries shape — windowEnd is
  // already capped at now, so an ongoing year-old initiative overflows here.
  const journalWindowDays =
    Math.floor(windowEnd.getTime() / MS_PER_DAY) -
    Math.floor(windowStart.getTime() / MS_PER_DAY) +
    1

  const [
    breakdown,
    revenueMetrics,
    journal,
    mrr,
    newCustomersCount,
    customerBreakdown,
    customerMetaRows,
  ] = await Promise.all([
    needCost
      ? getCostBreakdown(prisma, orgId, window, 'day', {}, {
          page: 1,
          pageSize: 1,
          includeOtherRollup: false,
        })
      : null,
    needRevenue ? getRevenueMetrics(prisma, orgId, window, {}) : null,
    needJournal && journalWindowDays <= ROI_UNMAPPED_WINDOW_MAX_DAYS
      ? getJournalExport(period)
      : null,
    needMrr ? getMrr(prisma, orgId, {}) : null,
    // A plain entity count (customers created in-window), not money math — so
    // a raw prisma count is canon-clean here where money getters are the rule.
    needNewCustomers
      ? prisma.customers.count({
          where: {
            organizationId: orgId,
            deletedAt: null,
            createdAt: { gte: windowStart, lte: windowEnd },
          },
        })
      : null,
    // Internal/external cost = the isInternal partition of the window's
    // per-customer cost. includeOtherRollup:false + the full page so every
    // bucket is present; the partition below folds none into "Other".
    needPartitionedCost
      ? getCostBreakdown(prisma, orgId, window, 'customer', {}, {
          page: 1,
          pageSize: ANALYTICS_MAX_ROWS,
          includeOtherRollup: false,
        })
      : null,
    needPartitionedCost
      ? prisma.customers.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { id: true, isInternal: true, defaultGlCodeId: true },
        })
      : null,
  ])

  // Only partition a COMPLETE customer-bucket set. Past ANALYTICS_MAX_ROWS the
  // breakdown page is truncated and one side would silently understate — the
  // honest answer is null (renders '—', canon M2), never a wrong split.
  let partitionedCost: WindowReads['partitionedCost'] = null
  if (
    customerBreakdown &&
    customerMetaRows &&
    customerBreakdown.totalRowCount <= customerBreakdown.rows.length
  ) {
    const partition = sumCostByInternalPartition(
      customerBreakdown.rows,
      buildInternalCustomerMeta(customerMetaRows)
    )
    partitionedCost = {
      internal: partition.internal,
      external: partition.external,
      eventCount: customerBreakdown.totals.eventCount,
    }
  }

  return {
    breakdownTotals: breakdown
      ? {
          cost: breakdown.totals.cost,
          eventCount: breakdown.totals.eventCount,
        }
      : null,
    revenue: revenueMetrics
      ? {
          revenue: revenueMetrics.revenue,
          margin: revenueMetrics.margin,
          marginPercent: revenueMetrics.marginPercent,
        }
      : null,
    unmappedSignalCount: journal ? (journal.unmappedSignalCount ?? null) : null,
    mrr: mrr ? { mrr: mrr.mrr, arr: mrr.arr } : null,
    newCustomers: newCustomersCount,
    partitionedCost,
  }
}

/**
 * One initiative's full card/detail view: canon actuals over its own window
 * plus the pure progress/health derivation. Archived and not-yet-started
 * initiatives skip all reads (no actuals spend on dead or future goals).
 */
export async function buildInitiativeView(
  initiative: Initiative,
  orgId: string,
  now: Date
): Promise<RoiInitiativeView> {
  // The not-started guard — the ONE place an initiative date meets new Date()
  // in this composition; every windowed read derives bounds via
  // parseWindowFilter.
  const startsInFuture =
    new Date(initiative.startDate).getTime() > now.getTime()
  const skipReads = initiative.status === 'archived' || startsInFuture

  // Slice stored full-ISO timestamps to bare dates so parseWindowFilter's
  // bare-date branch fires: a stored midnight endDate passed verbatim makes
  // windowEnd the START of the final day, silently excluding that whole
  // day's money. Bare dates expand the end
  // to 23:59:59.999Z; startDate midnight is identical either way.
  const period = {
    startDate: initiative.startDate.slice(0, 10),
    endDate: initiative.endDate ? initiative.endDate.slice(0, 10) : undefined,
  }

  const reads =
    skipReads || initiative.targets.length === 0
      ? NO_READS
      : await readMetricsWindow(
          orgId,
          new Set(initiative.targets.map((t) => t.metric)),
          period,
          { includeMrrSnapshot: true, matterId: initiative.matterId }
        )

  // When a matter is deleted (the FK is SET NULL) these actuals widen back to
  // org-wide, so an AUTO starting value still holding that one matter's
  // numbers would score progress nobody made. Manual ones are a person's own.
  const scopeGone =
    initiative.matterId === null && initiative.scopedMatterNumber !== null

  const elapsedPct = windowElapsedPct(
    initiative.startDate,
    initiative.endDate,
    now
  )

  const targets: RoiTargetView[] = initiative.targets.map((t) => {
    const actual = actualForMetric(t.metric, reads)
    const baseline =
      scopeGone && t.baselineSource === 'auto' ? null : t.baselineValue
    const { progressPct, met } = targetProgress(
      { metric: t.metric, direction: t.direction, targetValue: t.targetValue },
      actual,
      baseline,
      elapsedPct
    )
    return {
      id: t.id,
      metric: t.metric,
      direction: t.direction,
      targetValue: t.targetValue,
      actual,
      baseline,
      baselineSource: t.baselineSource,
      progressPct,
      met,
    }
  })

  return {
    id: initiative.id,
    name: initiative.name,
    description: initiative.description,
    status: initiative.status,
    startDate: initiative.startDate,
    endDate: initiative.endDate,
    matterId: initiative.matterId,
    matterNumber: initiative.matterNumber,
    scopedMatterNumber: initiative.scopedMatterNumber,
    elapsedPct,
    health: deriveInitiativeHealth(initiative, targets, now),
    targets,
  }
}

/**
 * The measured starting value per metric, as of an initiative's start date:
 * one batch of canon reads over the mirrored pre-start
 * window, mapped through the SAME per-metric rule the actuals use.
 * Unsupported metrics (mrr/arr — no historical snapshot exists) and
 * no-data windows come back null, the honest fallback.
 *
 * A matter-scoped initiative measures through the same scope: an
 * org-wide starting value compared against a matter-scoped actual would show
 * progress that never happened.
 */
export async function computeAutoBaselines(
  orgId: string,
  initiativeWindow: { startDate: string; endDate: string | null },
  metrics: InitiativeMetric[],
  matterId: string | null = null
): Promise<Map<InitiativeMetric, number | null>> {
  const values = new Map<InitiativeMetric, number | null>()
  for (const metric of metrics) values.set(metric, null)

  const supported = [...new Set(metrics)].filter(
    (metric) => AUTO_BASELINE_SUPPORTED[metric]
  )
  if (supported.length === 0) return values

  const baselinePeriod = baselineWindowFor(
    initiativeWindow.startDate,
    initiativeWindow.endDate
  )
  const reads = await readMetricsWindow(
    orgId,
    new Set(supported),
    baselinePeriod,
    {
      includeMrrSnapshot: false,
      matterId,
    }
  )

  for (const metric of supported) {
    values.set(metric, autoBaselineFromReads(metric, reads))
  }
  return values
}
