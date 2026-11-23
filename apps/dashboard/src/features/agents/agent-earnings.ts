/**
 * Pure view logic for the agent "Usage Cost & Revenue" chart, shared by the
 * Build agent detail. "Revenue" in this chart is event-based only (quantity × usage-strategy rate, stored on
 * row.earned by getAgentEarningsBreakdown) and does NOT include recurring,
 * seat, or one-time fees. The tooltipDefinitions.usageRevenue entry states
 * this, so keep that tooltip wherever the chart renders.
 */

import { formatCurrency } from '@/lib/canon-format'
import type { AgentEarningsBreakdown } from '@/app/actions/get-agent-earnings-breakdown'

export type EarningsDisplayType = 'metrics' | 'cost' | 'revenue'
export type EarningsChartShape = 'area' | 'bar'

/** One Recharts row: a date plus a column per signal name. */
export type EarningsChartDatum = Record<string, number | string>

/**
 * Pivots the server's per-(day, signal) rows into the flat shape Recharts
 * needs for stacked series: one entry per date with a column per signal
 * name. Recomputes when the user toggles between metrics / cost / revenue.
 */
export function pivotEarningsChartData(
  breakdown: Pick<AgentEarningsBreakdown, 'dailyBreakdown'> | null | undefined,
  displayType: EarningsDisplayType
): EarningsChartDatum[] {
  if (!breakdown) return []
  const byDate = new Map<string, EarningsChartDatum>()
  for (const row of breakdown.dailyBreakdown) {
    const entry = byDate.get(row.date) ?? { date: row.date }
    const value =
      displayType === 'metrics'
        ? row.quantity
        : displayType === 'cost'
          ? row.cost
          : row.earned
    // Sum into the signal name slot (same signal on the same day can
    // produce multiple event rows — unlikely with our aggregation, but
    // keep the math defensive).
    entry[row.signalName] = Number(entry[row.signalName] ?? 0) + Number(value)
    byDate.set(row.date, entry)
  }
  return Array.from(byDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  )
}

export function formatEarningsValue(
  displayType: EarningsDisplayType,
  value: number | string
): string {
  const numericValue = Number(value)
  return displayType === 'metrics'
    ? numericValue.toLocaleString()
    : formatCurrency(numericValue, 'USD')
}
