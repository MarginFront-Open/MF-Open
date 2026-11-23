/**
 * The trend chart's metric picker (the breakdown chart is
 * metric-customizable like the KPI tiles). PURE and
 * client-safe: no React, no recharts, no Prisma — just the mapping from a
 * picked metric to which already-fetched series to plot. DimensionedSection
 * imports it AND a node test exercises it directly, so the selection logic
 * has one source of truth that can be unit-tested without rendering.
 *
 * Every series here is sliced out of the ONE resolveMetrics response the
 * section already holds (cost + eventCount from `series`, revenue from
 * `earnedSeries`) — the picker never triggers a second query, so chart,
 * donut, and table still cannot disagree.
 */

import type { CostByDayRow, EarnedByDayRow } from './types'

/** The picker's mutually-exclusive views. Cost + Revenue is the default (both
 * series on one money axis). 'tasks' plots the daily task count
 * on a count axis; the others are $-denominated so they share one money axis. */
export type ChartMetric = 'cost+revenue' | 'cost' | 'revenue' | 'tasks'

/** The chart's y-axis unit. Money metrics format via canon-format's formatCost;
 * a count formats via toLocaleString (matching format-metric.ts's 'count'). */
export type ChartValueFormat = 'cost' | 'count'

/** Structurally the TimeseriesChart's TimeseriesSeriesInput, redeclared here so
 * this pure module never imports the recharts-backed tile. Both sides key off
 * the same canonical CostByDayRow, so the shapes can't silently drift. */
export interface ChartSeriesInput {
  label: string
  points: CostByDayRow[]
}

/**
 * Which views the picker offers. Revenue-bearing views appear only when the
 * response actually carries a revenue series (a revenue-computing scope AND a
 * window inside the earned-series cap) — the same honest-null gate the donut's
 * cost/revenue toggle uses. Tasks and Cost are always offered.
 */
export function chartMetricOptions(hasRevenueSeries: boolean): ChartMetric[] {
  return hasRevenueSeries
    ? ['cost+revenue', 'cost', 'revenue', 'tasks']
    : ['cost', 'tasks']
}

/**
 * The picked view, corrected to a still-available one. Mirrors the donut's
 * effectiveDonutMetric: if the user had picked a revenue view and then widened
 * the window past the earned-series cap (revenue series gone), fall back to
 * Cost so the toggle never shows a dead pressed state.
 */
export function effectiveChartMetric(
  metric: ChartMetric,
  hasRevenueSeries: boolean
): ChartMetric {
  if (hasRevenueSeries) return metric
  return metric === 'revenue' || metric === 'cost+revenue' ? 'cost' : metric
}

export function chartMetricLabel(metric: ChartMetric): string {
  switch (metric) {
    case 'cost+revenue':
      return 'Cost + Revenue'
    case 'cost':
      return 'Cost'
    case 'revenue':
      return 'Revenue'
    case 'tasks':
      return 'Usage events'
  }
}

/**
 * The chart title for a view. The Cost + Revenue view keeps the page's own
 * title (Money's 'Cost vs revenue') + its tooltip; the single-metric
 * views get an honest "<Metric> over time" so the heading never claims to show
 * cost/revenue while a Tasks line is on screen.
 */
export function chartTitleFor(
  metric: ChartMetric,
  costRevenueTitle: string
): string {
  switch (metric) {
    case 'cost+revenue':
      return costRevenueTitle
    case 'cost':
      return 'Cost over time'
    case 'revenue':
      return 'Revenue over time'
    case 'tasks':
      return 'Usage events over time'
  }
}

/**
 * The series + y-axis unit to plot for a view, sliced from the one response.
 * Revenue points use the Cost + Revenue mapping (earned dollars into the row's
 * `cost` y-field); Tasks maps each day's eventCount into that same y-field on
 * a count axis. Revenue collapses to Cost when no revenue series exists, so a
 * caller can pass any metric safely.
 */
export function selectChartSeries(
  metric: ChartMetric,
  series: CostByDayRow[],
  earnedSeries: EarnedByDayRow[] | null | undefined,
  hasRevenueSeries: boolean
): { series: ChartSeriesInput[]; valueFormat: ChartValueFormat } {
  const cost: ChartSeriesInput = { label: 'Cost', points: series }
  const revenue: ChartSeriesInput = {
    label: 'Revenue',
    points: (earnedSeries ?? []).map((day) => ({
      date: day.date,
      cost: day.earned,
      eventCount: 0,
    })),
  }
  const tasks: ChartSeriesInput = {
    label: 'Usage events',
    points: series.map((day) => ({
      date: day.date,
      cost: day.eventCount,
      eventCount: 0,
    })),
  }

  switch (metric) {
    case 'cost':
      return { series: [cost], valueFormat: 'cost' }
    case 'revenue':
      return {
        series: hasRevenueSeries ? [revenue] : [cost],
        valueFormat: 'cost',
      }
    case 'cost+revenue':
      return {
        series: hasRevenueSeries ? [cost, revenue] : [cost],
        valueFormat: 'cost',
      }
    case 'tasks':
      return { series: [tasks], valueFormat: 'count' }
  }
}
