/**
 * WHAT THIS FILE DOES: pure data-shaping helpers for the CFO Charts panel. It
 *   turns the three canonical server-action payloads into the exact arrays
 *   recharts wants — nothing more. No React, no recharts, no 'use client', and
 *   only TYPE imports from the action modules (erased at build), so it has zero
 *   runtime dependencies and the node-env jest suite can unit-test the shaping
 *   directly (the same pattern classification-utils.ts already uses).
 *
 * WHY IT EXISTS: the panel is presentation; the interesting logic is
 *   "pair each product line's earned vs total, clamp, sort, cap to top-N." Keeping
 *   that here means it can be tested without mounting a chart in a DOM-less suite.
 *
 * CONNECTS TO:
 *   - ./components/cfo-charts-panel.tsx (the only caller)
 *   - app/actions/finance-metrics.ts (ProductLineMargin)
 *   - app/actions/cost-command-center.ts (CostClassificationCategory)
 *   - app/actions/journal-export.ts (JournalEntryRow)
 */

import type { ProductLineMargin } from '@/app/actions/finance-metrics'
import type { CostClassificationCategory } from '@/app/actions/cost-command-center'
import type { JournalEntryRow } from '@/app/actions/journal-export'
import type { CostCategoryKey } from '@/app/actions/cost-command-center'

/** One product line's earned-vs-total pair for the grouped revenue bar chart. */
export type RevenueComparisonBar = {
  name: string
  /** Agent-Earned (canon R1): usage only. */
  earned: number
  /** Total Revenue (canon R1+R2): usage + recurring + seat + one-time. */
  total: number
}

/** One slice of the cost-by-classification donut. */
export type CategorySlice = {
  key: CostCategoryKey
  name: string
  value: number
}

/** One bar of the cost-by-GL-code chart. */
export type GlCostBar = {
  name: string
  value: number
  /** True for the "needs a GL code" bucket — rendered in a warning color. */
  isUnmapped: boolean
}

/**
 * Top-N product lines as earned-vs-total bars. Input rows arrive already sorted
 * by total revenue descending (getProductLineMargins), so we keep that order and
 * just cap to `limit` so a long agent list stays readable. earned (R1) is the
 * usage slice of total (R1+R2) and can never exceed it — we clamp defensively in
 * case a locked snapshot is served without the `earned` field.
 */
export function buildRevenueComparison(
  rows: Pick<ProductLineMargin, 'agentName' | 'earned' | 'revenue'>[],
  limit = 8
): RevenueComparisonBar[] {
  return rows
    .filter((r) => r.revenue > 0 || (r.earned ?? 0) > 0)
    .slice(0, limit)
    .map((r) => ({
      name: r.agentName,
      earned: Math.min(r.earned ?? 0, r.revenue),
      total: r.revenue,
    }))
}

/**
 * Cost-by-classification slices for the donut — categories with real spend only
 * (a $0 bucket is noise in a pie). Order is preserved from the breakdown, which
 * already lists the buckets in a stable, CFO-friendly order.
 */
export function buildCategorySlices(
  categories: Pick<CostClassificationCategory, 'key' | 'label' | 'cost'>[]
): CategorySlice[] {
  return categories
    .filter((c) => c.cost > 0)
    .map((c) => ({ key: c.key, name: c.label, value: c.cost }))
}

/**
 * Cost-by-GL-code bars, biggest spend first, capped to top-N. The Unmapped
 * bucket (glCode === null) is flagged so the chart can paint it in a warning
 * color — that's the "assign a GL code" nudge, mirroring the journal export's
 * own unmapped warning on the page.
 */
export function buildGlCostBars(
  rows: Pick<JournalEntryRow, 'glCode' | 'glName' | 'amount'>[],
  limit = 10
): GlCostBar[] {
  return rows
    .filter((r) => r.amount > 0)
    .map((r) => ({
      name: r.glCode ? `${r.glCode} · ${r.glName}` : 'Unmapped',
      value: r.amount,
      isUnmapped: r.glCode === null,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}
