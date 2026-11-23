import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import ExcelJS from 'exceljs'
import { auth } from '@/app/lib/auth'
import {
  getFullCommandCenterBreakdown,
  getFullCommandCenterInvoicesTab,
  type BreakdownServiceRow,
  type BreakdownCustomerRow,
  type InvoiceLedgerRow,
} from '@/app/actions/full-command-center'
import { resolveMetrics } from '@/app/actions/metrics-resolver'
import { getFilters } from '@/app/actions/get-filters'
import { GROUP_BY_DIMENSIONS, type Dimension } from '@/lib/component-catalog'
import { ANALYTICS_MAX_ROWS } from '@marginfront/db'
import { toBreakdownCsv, type BreakdownCsvRow } from './csv'
import { safeText } from './xlsx-cell'
import {
  BREAKDOWN_CSV_COLUMNS,
  isBreakdownCsvColumn,
} from '@/features/money/components/csv-columns'

/**
 * GET /api/export/breakdown
 *
 * Generates a single XLSX workbook with every Breakdown tab the user can
 * see in /home — plus a "How to read this" first sheet that explains each
 * column in plain English. One file, seven sheets.
 *
 * Query params (all optional — default window is last 30 days):
 *   start     — yyyy-mm-dd, window start
 *   end       — yyyy-mm-dd, window end
 *   customer  — filter to one customerId
 *   agent     — filter to one agentId
 *
 * Returns the workbook as an XLSX binary stream with a download-ready
 * Content-Disposition header so the browser saves it instead of opening it.
 *
 * Runs server-side so orgs with thousands of events don't freeze the browser
 * doing spreadsheet math on the main thread.
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session?.session?.activeOrganizationId) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 })
  }

  const url = new URL(request.url)

  // Custom CSV export returns early. Without `format=csv` the request gets
  // the one-click XLSX workbook below.
  if (url.searchParams.get('format') === 'csv') {
    return handleCsvExport(url)
  }

  const startParam = url.searchParams.get('start') ?? undefined
  const endParam = url.searchParams.get('end') ?? undefined
  const customerIdParam = url.searchParams.get('customer') ?? undefined
  const agentIdParam = url.searchParams.get('agent') ?? undefined

  const filters = {
    startDate: startParam,
    endDate: endParam,
    customerId: customerIdParam,
    agentId: agentIdParam,
  }

  // Resolve the friendly window label to stamp on each sheet. If the user
  // didn't pass dates we say "Last 30 days"; otherwise we echo what they picked.
  const windowLabel = (() => {
    if (startParam && endParam) return `${startParam} to ${endParam}`
    if (startParam) return `From ${startParam}`
    if (endParam) return `Through ${endParam}`
    return 'Last 30 days'
  })()

  const [breakdown, invoicesLedger] = await Promise.all([
    getFullCommandCenterBreakdown(filters),
    getFullCommandCenterInvoicesTab(filters),
  ])

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'MarginFront'
  workbook.created = new Date()

  buildHowToSheet(workbook, windowLabel)
  buildEarnedSheet(workbook, {
    title: 'Service Cost',
    rows: breakdown.service,
    includeContext: true,
    windowLabel,
  })
  buildEarnedSheet(workbook, {
    title: 'Agent Task',
    rows: breakdown.task,
    includeContext: false,
    windowLabel,
  })
  buildEarnedSheet(workbook, {
    title: 'Agent',
    rows: breakdown.agent,
    includeContext: false,
    windowLabel,
  })
  buildCustomerSheet(workbook, breakdown.customer, windowLabel)
  buildBilledSheet(workbook, 'Pricing Plan', breakdown.plan, windowLabel)
  buildInvoicesSheet(workbook, invoicesLedger, windowLabel)

  const buffer = await workbook.xlsx.writeBuffer()
  const dateStr = new Date().toISOString().slice(0, 10)
  const filename = `marginfront-breakdown-${dateStr}.xlsx`

  return new NextResponse(Buffer.from(buffer), {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Don't let a stale cached export leak across orgs in shared proxies.
      'Cache-Control': 'private, no-store',
    },
  })
}

/**
 * GET /api/export/breakdown?format=csv&dimension=&startDate=&endDate=&columns=
 *
 * The Money "Custom CSV export…" path, next to the XLSX handler above.
 * Calls resolveMetrics, the SAME server action
 * DimensionedSection calls for the on-screen Breakdown table/donut — so
 * this file's numbers can't drift from what Money already shows. getFilters
 * below is a name lookup only (agent/customer/plan/signal UUID -> display
 * name); it never touches cost/revenue/margin.
 *
 * Query params:
 *   dimension  — one of Money's on-screen Group-by options (agent,
 *                customer, signal, plan, model, environment — NOT
 *                day/costCategory; same allow-list as GROUP_BY_DIMENSIONS.money)
 *   startDate/endDate — parseWindowFilter's UI shape (bare YYYY-MM-DD or
 *                full ISO), passed straight through to resolveMetrics;
 *                omit both for the rolling last-30-days default
 *   columns    — comma-separated subset of
 *                tasks,cost,revenue,margin,marginPercent (default: all).
 *                Revenue/Margin/Margin % are dropped entirely for a
 *                dimension with no honest revenue basis (model/environment —
 *                canon M2), never exported as a fabricated or blank column.
 */
async function handleCsvExport(url: URL): Promise<NextResponse> {
  const dimensionParam = url.searchParams.get('dimension')
  const isMoneyDimension = (value: string | null): value is Dimension =>
    value !== null &&
    (GROUP_BY_DIMENSIONS.money as readonly string[]).includes(value)

  if (!isMoneyDimension(dimensionParam)) {
    return NextResponse.json(
      {
        error: `Unknown or unsupported group-by "${dimensionParam ?? ''}". Choose one of: ${GROUP_BY_DIMENSIONS.money.join(', ')}.`,
      },
      { status: 400 }
    )
  }
  const dimension = dimensionParam

  const startDate = url.searchParams.get('startDate') ?? undefined
  const endDate = url.searchParams.get('endDate') ?? undefined

  const columnsParam = url.searchParams.get('columns')
  const requestedColumns = (
    columnsParam ? columnsParam.split(',') : [...BREAKDOWN_CSV_COLUMNS]
  ).filter(isBreakdownCsvColumn)

  const [result, filtersResult] = await Promise.all([
    resolveMetrics({
      scope: 'money',
      period: { startDate, endDate },
      dimension,
      filters: {},
      breakdown: { page: 1, pageSize: ANALYTICS_MAX_ROWS },
    }),
    getFilters(),
  ])

  if (!result.success || !result.data) {
    return NextResponse.json(
      {
        error: result.error ?? 'Could not load the breakdown for this window.',
      },
      { status: 400 }
    )
  }

  // Same UUID -> name fallback Money's own page uses client-side
  // (resolveLabel in src/features/money/index.tsx): a key that isn't a
  // known UUID (a model string, an environment enum value, or a truly
  // orphaned reference) falls back to the raw key instead of a blank cell.
  const labelMap = new Map<string, string>()
  if (filtersResult.success && filtersResult.data) {
    for (const c of filtersResult.data.customers) labelMap.set(c.id, c.name)
    for (const a of filtersResult.data.agents) labelMap.set(a.id, a.name)
    for (const p of filtersResult.data.pricingPlans) labelMap.set(p.id, p.name)
    for (const s of filtersResult.data.signals) labelMap.set(s.id, s.name)
  }
  const resolveLabel = (key: string | null): string =>
    key === null ? 'Unassigned' : (labelMap.get(key) ?? key)

  const { breakdown, window } = result.data
  const toCsvRow = (row: {
    key: string | null
    cost: number
    eventCount: number
    revenue?: number
    marginPercent?: number | null
  }): BreakdownCsvRow => ({
    label: resolveLabel(row.key),
    eventCount: row.eventCount,
    cost: row.cost,
    revenue: row.revenue,
    marginPercent: row.marginPercent,
  })

  const csv = toBreakdownCsv({
    revenueBasis: breakdown.revenueBasis,
    columns: requestedColumns,
    rows: breakdown.rows.map(toCsvRow),
    other: breakdown.other
      ? {
          label: 'Other',
          eventCount: breakdown.other.eventCount,
          cost: breakdown.other.cost,
          revenue: breakdown.other.revenue,
          marginPercent: breakdown.other.marginPercent,
        }
      : null,
  })

  const dateStr = (d: Date) => d.toISOString().slice(0, 10)
  const filename = `marginfront-money-breakdown-${dimension}-${dateStr(window.start)}_to_${dateStr(window.end)}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Don't let a stale cached export leak across orgs in shared proxies.
      'Cache-Control': 'private, no-store',
    },
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Sheet builders
// ────────────────────────────────────────────────────────────────────────────

/**
 * The "How to read this" sheet. Ships first so a non-technical reader can
 * walk up to the file cold and understand what every number means without
 * opening the app. Plain English, one sentence per column, no jargon.
 */
function buildHowToSheet(workbook: ExcelJS.Workbook, windowLabel: string) {
  const sheet = workbook.addWorksheet('How to read this')
  addTitleRow(sheet, 'How to read this export', windowLabel)
  sheet.columns = [
    { header: 'Sheet', key: 'sheet', width: 18 },
    { header: 'Column', key: 'column', width: 18 },
    { header: 'What it means', key: 'meaning', width: 80 },
  ]
  styleHeaderRow(sheet, sheet.getRow(sheet.rowCount))

  const guide: Array<[string, string, string]> = [
    // Service Cost
    [
      'Service Cost',
      'Name',
      'The AI provider or service name, like GPT-4 or Claude.',
    ],
    [
      'Service Cost',
      'Category',
      'What kind of service it is, like LLM or Embeddings.',
    ],
    ['Service Cost', 'Provider', 'The company that runs the service.'],
    [
      'Service Cost',
      'Cost',
      'What you paid the provider for agent work in this window.',
    ],
    [
      'Service Cost',
      'Earned',
      'What you made when agents used this service. Pure per-event earnings.',
    ],
    [
      'Service Cost',
      'Margin',
      'Earned minus Cost. What you kept after paying the provider.',
    ],
    [
      'Service Cost',
      'Margin %',
      'Margin as a share of Earned. Blank if Earned was zero.',
    ],
    ['Service Cost', 'Qty', 'Total units processed, like tokens or seconds.'],
    ['Service Cost', 'Events', 'How many usage events hit this service.'],

    // Agent Task
    [
      'Agent Task',
      'Task',
      'The kind of work the agent did, like "summarize doc" or "send email".',
    ],
    ['Agent Task', 'Category', 'The bigger group the task belongs to.'],
    ['Agent Task', 'Cost', 'What this task type cost you in AI service fees.'],
    [
      'Agent Task',
      'Earned',
      'What you made doing this task. Per-event earnings only.',
    ],
    ['Agent Task', 'Margin', 'Earned minus Cost.'],
    [
      'Agent Task',
      'Margin %',
      'Margin as a share of Earned. Blank if Earned was zero.',
    ],
    ['Agent Task', 'Qty', 'How many units of this task ran.'],
    ['Agent Task', 'Events', 'How many separate task events fired.'],

    // Agent
    ['Agent', 'Agent', "The agent's name."],
    ['Agent', 'Cost', 'Total AI service cost for everything this agent did.'],
    [
      'Agent',
      'Earned',
      'What this agent made from its activity. No subscription or seat fees.',
    ],
    ['Agent', 'Margin', 'Earned minus Cost.'],
    [
      'Agent',
      'Margin %',
      'Margin as a share of Earned. Blank if Earned was zero.',
    ],
    ['Agent', 'Qty', 'Total units this agent processed.'],
    ['Agent', 'Events', 'How many events this agent fired.'],

    // Customer
    ['Customer', 'Customer', "The customer's name."],
    [
      'Customer',
      'Cost',
      "AI service cost for this customer's activity in the window.",
    ],
    [
      'Customer',
      'Billed',
      'What you invoiced this customer. Includes usage, seats, and subscriptions.',
    ],
    ['Customer', 'Margin', 'Billed minus Cost.'],
    [
      'Customer',
      'Margin %',
      'Margin as a share of Billed. Blank if Billed was zero.',
    ],
    ['Customer', 'Inv Sent', 'How many invoices they received in this window.'],
    ['Customer', 'Inv Paid', 'How many of those invoices they paid.'],
    ['Customer', 'Outstanding', 'How many invoices are still unpaid.'],
    ['Customer', 'Last Payment', 'Most recent payment date in this window.'],

    // Pricing Plan
    ['Pricing Plan', 'Plan', 'The pricing plan name.'],
    [
      'Pricing Plan',
      'Cost',
      'AI service cost for work under subscriptions on this plan.',
    ],
    [
      'Pricing Plan',
      'Billed',
      'What you invoiced across every subscriber on this plan.',
    ],
    ['Pricing Plan', 'Margin', 'Billed minus Cost.'],
    [
      'Pricing Plan',
      'Margin %',
      'Margin as a share of Billed. Blank if Billed was zero.',
    ],
    ['Pricing Plan', 'Events', 'Total events that ran under this plan.'],

    // Invoices
    ['Invoices', 'Invoice #', 'The invoice number you send the customer.'],
    ['Invoices', 'Customer', 'Who the invoice was sent to.'],
    ['Invoices', 'Plan', 'The pricing plan the invoice was generated from.'],
    ['Invoices', 'Amount', 'Total on the invoice.'],
    [
      'Invoices',
      'Status',
      'Where the invoice is: draft, sent, paid, or overdue.',
    ],
    ['Invoices', 'Due Date', 'When payment is due.'],
    ['Invoices', 'Paid Date', 'When it was paid, if it has been.'],
    ['Invoices', 'Method', 'How the customer paid.'],
  ]

  for (const [s, c, m] of guide) {
    sheet.addRow({ sheet: s, column: c, meaning: m })
  }

  // Freeze header + title so scrolling keeps context visible.
  sheet.views = [{ state: 'frozen', ySplit: 3 }]
}

// BreakdownServiceRow already carries every field we render below
// (name, category, cost, qty, events, revenue, margin, marginPct,
// plus an optional context the Service tab uses for "Provider").
type EarnedRow = BreakdownServiceRow

/**
 * Shared builder for Service Cost / Agent Task / Agent sheets — the three
 * per-activity tabs that use "Earned" attribution (sum of per-event calcRouted).
 *
 * `includeContext` controls whether the "Provider" column renders; only
 * Service Cost uses it (pricing_strategies row doesn't carry a provider for
 * agents or signals).
 */
function buildEarnedSheet(
  workbook: ExcelJS.Workbook,
  opts: {
    title: string
    rows: EarnedRow[]
    includeContext: boolean
    windowLabel: string
  }
) {
  const sheet = workbook.addWorksheet(opts.title)
  addTitleRow(sheet, opts.title, opts.windowLabel)
  const columns: Partial<ExcelJS.Column>[] = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Category', key: 'category', width: 16 },
  ]
  if (opts.includeContext) {
    columns.push({ header: 'Provider', key: 'context', width: 16 })
  }
  columns.push(
    { header: 'Cost', key: 'cost', width: 12, style: { numFmt: '$#,##0.00' } },
    {
      header: 'Earned',
      key: 'earned',
      width: 12,
      style: { numFmt: '$#,##0.00' },
    },
    {
      header: 'Margin',
      key: 'margin',
      width: 12,
      style: { numFmt: '$#,##0.00' },
    },
    { header: 'Margin %', key: 'marginPct', width: 10 },
    { header: 'Qty', key: 'qty', width: 10, style: { numFmt: '#,##0.##' } },
    { header: 'Events', key: 'events', width: 10, style: { numFmt: '#,##0' } }
  )
  sheet.columns = columns as ExcelJS.Column[]
  styleHeaderRow(sheet, sheet.getRow(sheet.rowCount))

  for (const row of opts.rows) {
    sheet.addRow({
      name: safeText(row.name),
      category: safeText(row.category),
      context: safeText(row.context),
      cost: row.cost,
      earned: row.revenue,
      margin: row.margin,
      marginPct: formatPctCell(row.marginPct),
      qty: row.qty,
      events: row.events,
    })
  }

  sheet.views = [{ state: 'frozen', ySplit: 3 }]
}

/**
 * Pricing Plan sheet — "Billed" column since pricing plans map exactly to
 * invoice records (via invoice.subscription.planId).
 */
function buildBilledSheet(
  workbook: ExcelJS.Workbook,
  title: string,
  rows: EarnedRow[],
  windowLabel: string
) {
  const sheet = workbook.addWorksheet(title)
  addTitleRow(sheet, title, windowLabel)
  sheet.columns = [
    { header: 'Plan', key: 'name', width: 28 },
    { header: 'Cost', key: 'cost', width: 12, style: { numFmt: '$#,##0.00' } },
    {
      header: 'Billed',
      key: 'billed',
      width: 12,
      style: { numFmt: '$#,##0.00' },
    },
    {
      header: 'Margin',
      key: 'margin',
      width: 12,
      style: { numFmt: '$#,##0.00' },
    },
    { header: 'Margin %', key: 'marginPct', width: 10 },
    { header: 'Events', key: 'events', width: 10, style: { numFmt: '#,##0' } },
  ]
  styleHeaderRow(sheet, sheet.getRow(sheet.rowCount))

  for (const row of rows) {
    sheet.addRow({
      name: safeText(row.name),
      cost: row.cost,
      billed: row.revenue,
      margin: row.margin,
      marginPct: formatPctCell(row.marginPct),
      events: row.events,
    })
  }

  sheet.views = [{ state: 'frozen', ySplit: 3 }]
}

type CustomerRow = BreakdownCustomerRow

/**
 * Customer sheet — "Billed" column, plus invoice ledger stats that live
 * only on this tab.
 */
function buildCustomerSheet(
  workbook: ExcelJS.Workbook,
  rows: CustomerRow[],
  windowLabel: string
) {
  const sheet = workbook.addWorksheet('Customer')
  addTitleRow(sheet, 'Customer', windowLabel)
  sheet.columns = [
    { header: 'Customer', key: 'name', width: 28 },
    { header: 'Cost', key: 'cost', width: 12, style: { numFmt: '$#,##0.00' } },
    {
      header: 'Billed',
      key: 'billed',
      width: 12,
      style: { numFmt: '$#,##0.00' },
    },
    {
      header: 'Margin',
      key: 'margin',
      width: 12,
      style: { numFmt: '$#,##0.00' },
    },
    { header: 'Margin %', key: 'marginPct', width: 10 },
    {
      header: 'Inv Sent',
      key: 'invoicesSent',
      width: 10,
      style: { numFmt: '#,##0' },
    },
    {
      header: 'Inv Paid',
      key: 'invoicesPaid',
      width: 10,
      style: { numFmt: '#,##0' },
    },
    {
      header: 'Outstanding',
      key: 'invoicesOutstanding',
      width: 12,
      style: { numFmt: '#,##0' },
    },
    { header: 'Last Payment', key: 'lastPayment', width: 14 },
  ]
  styleHeaderRow(sheet, sheet.getRow(sheet.rowCount))

  for (const row of rows) {
    sheet.addRow({
      name: safeText(row.name),
      cost: row.cost,
      billed: row.revenue,
      margin: row.margin,
      marginPct: formatPctCell(row.marginPct),
      invoicesSent: row.invoicesSent,
      invoicesPaid: row.invoicesPaid,
      invoicesOutstanding: row.invoicesOutstanding,
      lastPayment: row.lastPayment,
    })
  }

  sheet.views = [{ state: 'frozen', ySplit: 3 }]
}

/**
 * Invoices sheet — the ledger view (all-time, newest first). Matches the
 * Invoices tab in /home.
 */
function buildInvoicesSheet(
  workbook: ExcelJS.Workbook,
  rows: InvoiceLedgerRow[],
  windowLabel: string
) {
  const sheet = workbook.addWorksheet('Invoices')
  addTitleRow(sheet, 'Invoices', windowLabel)
  sheet.columns = [
    { header: 'Invoice #', key: 'invoiceNumber', width: 18 },
    { header: 'Customer', key: 'customerName', width: 22 },
    { header: 'Plan', key: 'planName', width: 18 },
    {
      header: 'Amount',
      key: 'amount',
      width: 12,
      style: { numFmt: '$#,##0.00' },
    },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Due Date', key: 'dueDate', width: 14 },
    { header: 'Paid Date', key: 'paidDate', width: 14 },
    { header: 'Method', key: 'method', width: 14 },
  ]
  styleHeaderRow(sheet, sheet.getRow(sheet.rowCount))

  for (const row of rows) {
    sheet.addRow({
      invoiceNumber: safeText(row.invoiceNumber),
      customerName: safeText(row.customerName),
      planName: safeText(row.planName),
      amount: row.amount,
      status: row.status,
      dueDate: row.dueDate,
      paidDate: row.paidDate ?? '—',
      method: safeText(row.method ?? '—'),
    })
  }

  sheet.views = [{ state: 'frozen', ySplit: 3 }]
}

// ────────────────────────────────────────────────────────────────────────────
// Sheet formatting helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Puts the sheet title + window label on the first two rows of every sheet
 * so the file tells the reader what they're looking at without needing to
 * open the How-To tab. Row 3 is left blank for the column header that the
 * sheet.columns setter writes afterward.
 */
function addTitleRow(
  sheet: ExcelJS.Worksheet,
  title: string,
  windowLabel: string
) {
  const titleRow = sheet.addRow([title])
  titleRow.font = { bold: true, size: 14 }
  const windowRow = sheet.addRow([`Window: ${windowLabel}`])
  windowRow.font = { italic: true, color: { argb: 'FF6B7280' } }
}

function styleHeaderRow(_sheet: ExcelJS.Worksheet, row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E293B' },
  }
  row.alignment = { vertical: 'middle', horizontal: 'left' }
  row.height = 20
}

/**
 * Render null marginPct as an em dash, as the UI does (CANON.md rule M1).
 * Numbers become "XX.X%" strings so the column is readable at a glance.
 */
function formatPctCell(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(1)}%`
}
