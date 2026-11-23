/**
 * The ONE list of optional columns the Money "Custom
 * CSV export…" dialog offers. Both the dialog (client, for checkbox
 * rendering) and the export route's CSV builder (server, for the actual CSV
 * text) read this, so adding/removing a column is a single-line change here
 * instead of two lists drifting apart.
 *
 * The row label ("Account") isn't on this list — every export always
 * includes it; it's not a user choice.
 */
import type { RevenueBasis } from '@/lib/revenue-basis'

export const BREAKDOWN_CSV_COLUMNS = [
  'tasks',
  'cost',
  'revenue',
  'margin',
  'marginPercent',
] as const

export type BreakdownCsvColumn = (typeof BREAKDOWN_CSV_COLUMNS)[number]

export function isBreakdownCsvColumn(
  value: string
): value is BreakdownCsvColumn {
  return (BREAKDOWN_CSV_COLUMNS as readonly string[]).includes(value)
}

/** The dialog's checkbox label for every column except `revenue`, whose
 * label depends on the dimension's basis (Earned vs Billed — see
 * revenueColumnLabel). On-screen copy only: the exported file's header row
 * is BREAKDOWN_CSV_HEADERS in app/api/export/breakdown/csv.ts, whose names
 * stay fixed because sheets and scripts read the export by column name. */
export const BREAKDOWN_CSV_COLUMN_LABELS: Record<
  Exclude<BreakdownCsvColumn, 'revenue'>,
  string
> = {
  tasks: 'Usage events',
  cost: 'Cost',
  margin: 'Margin',
  marginPercent: 'Margin %',
}

/**
 * Which of the 5 optional columns are honest to offer for a given revenue
 * basis. null (model/environment, per revenue-basis.ts) drops
 * Revenue/Margin/Margin % entirely rather than exporting a column that would
 * be blank on every row, the same gate the on-screen table uses
 * via breakdown.revenueBasis.
 */
export function columnsAvailableForBasis(
  basis: RevenueBasis | null
): BreakdownCsvColumn[] {
  return basis === null ? ['tasks', 'cost'] : [...BREAKDOWN_CSV_COLUMNS]
}
