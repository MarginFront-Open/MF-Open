/**
 * Pure mapping from one batch of canon window reads to a per-metric value —
 * shared by the ROI actuals composition AND the auto-baseline derivation so
 * a starting value can never be computed by a different rule than the
 * current number it's compared against.
 * No fetching here; the reads arrive from initiative-actuals.ts.
 */

import { costPerTask } from '@marginfront/db'
import type { InitiativeMetric } from '../initiatives'
import { AUTO_BASELINE_SUPPORTED } from '@/features/roi/baseline-derivation'

export interface WindowReads {
  breakdownTotals: { cost: number; eventCount: number } | null
  revenue: {
    revenue: number
    margin: number
    marginPercent: number | null
  } | null
  unmappedSignalCount: number | null
  /** getMrr snapshot (canon MRR1) — as-of-now, NOT window-scoped; see the
   * readMetricsWindow note. null when no mrr/arr target needs it. */
  mrr: { mrr: number; arr: number } | null
  /** Count of customers created within the window; null when no
   * newCustomers target needs it. */
  newCustomers: number | null
  /** Window cost split by customers.isInternal, plus the window's total
   * event count (the baseline no-data check needs it); null when no
   * internal/external target needs it OR the customer bucket set was
   * truncated (canon M2). */
  partitionedCost: {
    internal: number
    external: number
    eventCount: number
  } | null
}

export const NO_READS: WindowReads = {
  breakdownTotals: null,
  revenue: null,
  unmappedSignalCount: null,
  mrr: null,
  newCustomers: null,
  partitionedCost: null,
}

/**
 * The reads for an initiative scoped to ONE matter. Revenue is
 * invoiced per customer and the entity counts have no matter column, so the
 * matter rollup (canon C1) is the only answer that exists: every field but
 * breakdownTotals stays null and actualForMetric renders the honest dash
 * (canon M2), never a zero that would read as "this matter cost nothing".
 */
export function matterScopedReads(
  rollup: { cost: number; eventCount: number } | null
): WindowReads {
  return {
    ...NO_READS,
    breakdownTotals: rollup
      ? { cost: rollup.cost, eventCount: rollup.eventCount }
      : null,
  }
}

export function actualForMetric(
  metric: InitiativeMetric,
  reads: WindowReads
): number | null {
  switch (metric) {
    case 'cost':
      return reads.breakdownTotals ? reads.breakdownTotals.cost : null
    case 'eventCount':
      return reads.breakdownTotals ? reads.breakdownTotals.eventCount : null
    case 'costPerTask':
      return reads.breakdownTotals
        ? costPerTask(
            reads.breakdownTotals.cost,
            reads.breakdownTotals.eventCount
          )
        : null
    case 'revenue':
      return reads.revenue ? reads.revenue.revenue : null
    case 'margin':
      return reads.revenue ? reads.revenue.margin : null
    case 'marginPercent':
      return reads.revenue ? reads.revenue.marginPercent : null
    case 'unmappedCount':
      return reads.unmappedSignalCount
    case 'mrr':
      return reads.mrr ? reads.mrr.mrr : null
    case 'arr':
      return reads.mrr ? reads.mrr.arr : null
    case 'newCustomers':
      return reads.newCustomers
    case 'internalCost':
      return reads.partitionedCost ? reads.partitionedCost.internal : null
    case 'externalCost':
      return reads.partitionedCost ? reads.partitionedCost.external : null
    default: {
      const exhaustive: never = metric
      return exhaustive
    }
  }
}

/**
 * A starting value from one batch of pre-start-window reads: actualForMetric
 * plus one honesty rule — a window with NO recorded activity yields null,
 * never a fabricated zero. Entity counts (unmappedCount, newCustomers) keep a real 0: the
 * tables exist either way, so zero is a measurement, not a gap.
 */
export function autoBaselineFromReads(
  metric: InitiativeMetric,
  reads: WindowReads
): number | null {
  if (!AUTO_BASELINE_SUPPORTED[metric]) return null

  switch (metric) {
    case 'cost':
    case 'eventCount':
    case 'costPerTask':
      return reads.breakdownTotals && reads.breakdownTotals.eventCount > 0
        ? actualForMetric(metric, reads)
        : null
    case 'internalCost':
    case 'externalCost':
      return reads.partitionedCost && reads.partitionedCost.eventCount > 0
        ? actualForMetric(metric, reads)
        : null
    case 'revenue':
    case 'margin':
    case 'marginPercent':
      return reads.revenue &&
        (reads.revenue.revenue !== 0 || reads.revenue.margin !== 0)
        ? actualForMetric(metric, reads)
        : null
    default:
      return actualForMetric(metric, reads)
  }
}
