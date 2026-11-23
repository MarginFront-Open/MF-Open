/**
 * WHAT THIS FILE DOES: turns ONE Money breakdown dimension (rows shaped like
 * resolveMetrics' ResolvedBreakdownRow) into downloadable CSV text for the
 * "Custom CSV export…" dialog. Pure string-building
 * only — no database, no request handling.
 *
 * WHY IT'S A SEPARATE FILE: same reason as journal export's csv.ts: the route
 * handler pulls in Prisma via resolveMetrics/getFilters, and this module
 * needs to stay importable from a plain Node test without dragging that in.
 *
 * CONNECTS TO: route.ts (the `?format=csv` branch), ../journal/csv.ts
 * (reuses csvCell — the app's one CSV escaper + formula-injection guard,
 * never a second hand-rolled one), src/features/money/components/csv-columns.ts
 * (the column list this file and the dialog both read; the dialog's labels
 * live there, the exported header names live here — see
 * BREAKDOWN_CSV_HEADERS below for why they differ).
 */
import { csvCell } from '../journal/csv'
import { formatPct } from '@/lib/canon-format'
import { revenueColumnLabel, type RevenueBasis } from '@/lib/revenue-basis'
import {
  columnsAvailableForBasis,
  type BreakdownCsvColumn,
} from '@/features/money/components/csv-columns'

/**
 * The CSV header text, which is NOT the dialog's checkbox label. A header
 * name is a wire contract: a customer's sheet, Zapier step or script reads
 * the exported file by column name, and renaming one breaks those silently
 * at merge. The on-screen label for the same number reads "Usage events"
 * (BREAKDOWN_CSV_COLUMN_LABELS); this header stays as it is. Typed against
 * BreakdownCsvColumn so a new column can't ship
 * without a header.
 */
const BREAKDOWN_CSV_HEADERS: Record<
  Exclude<BreakdownCsvColumn, 'revenue'>,
  string
> = {
  tasks: 'Tasks',
  cost: 'Cost',
  margin: 'Margin',
  marginPercent: 'Margin %',
}

export interface BreakdownCsvRow {
  label: string
  eventCount: number
  cost: number
  /** undefined = not canon-definable for this dimension (canon M2). When
   * undefined, the WHOLE Revenue/Margin/Margin % column set is dropped by
   * toBreakdownCsv below — never a blank cell sitting beside filled ones. */
  revenue?: number
  marginPercent?: number | null
}

export interface BreakdownCsvInput {
  revenueBasis: RevenueBasis | null
  /** Columns the caller asked for. Filtered again here against
   * columnsAvailableForBasis so a stale or hand-built request can't smuggle
   * in a column this dimension can't honestly fill. */
  columns: BreakdownCsvColumn[]
  rows: BreakdownCsvRow[]
  /** The resolver's rolled-up overflow bucket beyond its row cap — rendered
   * as a single "Other" row, same as the on-screen table. */
  other?: BreakdownCsvRow | null
}

function cellFor(row: BreakdownCsvRow, column: BreakdownCsvColumn): string {
  switch (column) {
    case 'tasks':
      return String(row.eventCount)
    case 'cost':
      return row.cost.toFixed(2)
    case 'revenue':
      return row.revenue === undefined ? '' : row.revenue.toFixed(2)
    case 'margin':
      return row.revenue === undefined
        ? ''
        : (row.revenue - row.cost).toFixed(2)
    case 'marginPercent':
      return formatPct(row.marginPercent ?? null)
  }
}

/** One breakdown dimension → CSV text: header row + one row per bucket +
 * an "Other" row when the resolver folded overflow past its row cap. */
export function toBreakdownCsv(input: BreakdownCsvInput): string {
  const activeColumns = input.columns.filter((column) =>
    columnsAvailableForBasis(input.revenueBasis).includes(column)
  )
  const header = [
    'Account',
    ...activeColumns.map((column) =>
      column === 'revenue' && input.revenueBasis
        ? revenueColumnLabel(input.revenueBasis)
        : BREAKDOWN_CSV_HEADERS[
            column as Exclude<BreakdownCsvColumn, 'revenue'>
          ]
    ),
  ]
  const lines = [header.map(csvCell).join(',')]

  const rowLine = (row: BreakdownCsvRow) =>
    [
      csvCell(row.label),
      ...activeColumns.map((column) => csvCell(cellFor(row, column))),
    ].join(',')

  for (const row of input.rows) lines.push(rowLine(row))
  if (input.other) lines.push(rowLine(input.other))

  return lines.join('\n')
}
