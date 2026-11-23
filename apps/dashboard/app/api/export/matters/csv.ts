/**
 * WHAT THIS FILE DOES: Turns a matter export (per-matter AI cost)
 * into downloadable CSV text — the per-matter "summary" and the one-row-per-
 * event "detail" audit trail. Pure string-building, no database.
 *
 * WHY IT EXISTS: same split as the journal export's csv.ts: the route
 * imports the server action (which drags in Prisma), so the formatting lives
 * here where a plain Node test can reach it.
 *
 * CONNECTS TO: route.ts (the GET handler), matter-export-utils.ts (the data
 * shape), ../journal/csv.ts (csvCell, the formula-injection
 * + RFC-4180 escaping, reused not re-implemented).
 *
 * SECURITY: every cell — including the org-controlled matterNumber, client
 * and signal names — routes through csvCell() so a malicious value like
 * `=HYPERLINK("http://evil","x")` exports as inert text (CWE-1236).
 */

import { csvCell } from '../journal/csv'
import type { MatterExport } from '@/features/law/matter-export-utils'

/**
 * Per-matter summary CSV: one row per matter, an Unassigned row when
 * unassigned events exist, and a TOTAL row. Costs stay at the schema's full
 * 6-decimal precision (canon R4: per-token events are sub-cent; rounding per
 * row to cents would break the matters+Unassigned=total reconciliation this
 * export exists to prove).
 */
export function toMatterSummaryCsv(data: MatterExport): string {
  const header = [
    'Matter Number',
    'Matter Name',
    'Client',
    'Actual Cost (USD)',
    'Event Count',
    'Events Missing Cost',
    'Period Start',
    'Period End',
  ]
  const periodStart = data.periodStart.slice(0, 10)
  const periodEnd = data.periodEnd.slice(0, 10)

  const lines = [header.map(csvCell).join(',')]
  for (const row of data.summary) {
    lines.push(
      [
        csvCell(row.matterNumber ?? 'UNASSIGNED'),
        csvCell(row.matterName ?? 'Unassigned'),
        csvCell(row.clientName ?? ''),
        csvCell(row.cost.toFixed(6)),
        csvCell(row.eventCount),
        csvCell(row.eventsMissingCost),
        csvCell(periodStart),
        csvCell(periodEnd),
      ].join(',')
    )
  }
  lines.push(
    [
      csvCell('TOTAL'),
      csvCell('All AI cost for period'),
      csvCell(''),
      csvCell(data.totalCost.toFixed(6)),
      csvCell(data.totalEvents),
      csvCell(data.eventsMissingCost),
      csvCell(periodStart),
      csvCell(periodEnd),
    ].join(',')
  )

  return lines.join('\n')
}

/**
 * Detail audit-trail CSV: ONE row per usage event, in a fixed column
 * order. The Attribution Source cell is never empty — assigned rows say how
 * they were assigned (tag / rule / manual), rows with no matter say
 * 'unassigned' (or 'manual' when an operator explicitly unassigned them), so
 * every row of the record states its provenance.
 */
export function toMatterDetailCsv(data: MatterExport): string {
  const header = [
    'Matter Number',
    'Client',
    'Usage Date',
    'Agent',
    'Signal',
    'Service/Model',
    'Quantity',
    'Actual Cost (USD)',
    'Attribution Source',
    'Event ID',
  ]
  const lines = [header.map(csvCell).join(',')]

  for (const row of data.rows) {
    lines.push(
      [
        csvCell(row.matterNumber ?? 'UNASSIGNED'),
        csvCell(row.clientName ?? ''),
        csvCell(row.usageDate.slice(0, 10)),
        csvCell(row.agentName),
        csvCell(row.signalName),
        csvCell(row.models),
        csvCell(row.quantity ?? ''),
        // Null cost exports BLANK, not 0.00 — unknown is not zero (canon C1);
        // the summary's Events Missing Cost column carries the flag.
        csvCell(row.usageCost === null ? '' : row.usageCost.toFixed(6)),
        csvCell(row.source ?? 'unassigned'),
        csvCell(row.eventId),
      ].join(',')
    )
  }

  return lines.join('\n')
}
