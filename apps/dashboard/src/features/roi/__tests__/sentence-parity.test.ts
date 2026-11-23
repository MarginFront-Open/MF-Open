/**
 * The screen, the printed page and the JSON
 * read carry the SAME words.
 *
 * Why this file exists: the "Without AI" paragraph is the one string we tell
 * a customer to paste into a board slide. If the print or the JSON rebuilt it
 * from the same numbers rather than reusing the same builder, the three could
 * drift a word apart and nobody would notice until a reader held the PDF
 * next to the screen.
 *
 * Node-only, no DB, no mocks — pure functions in, exact strings out.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'
import { formatPct, safeMarginPercent } from '@/lib/canon-format'
import {
  REPORT_COPY,
  REVENUE_BASIS_OPTIONS,
  WITHOUT_AI_COPY,
  buildPrintReport,
  buildRoiReportJson,
  buildWithoutAi,
  marginHeaderForBasis,
  reportAgentRowCells,
  reportAgentRowKey,
  reportLeadSentence,
  reportMetricTile,
  type ReportAgentRowValues,
  type ReportMetricValue,
  type ReportSurfaceInput,
} from '../report-derivation'

const WINDOW = { startDate: '2026-08-19', endDate: '2026-09-18' }

const ROWS: ReportAgentRowValues[] = [
  {
    agentId: 'a1',
    name: 'Contract Summary',
    usageEvents: 900,
    cost: 3000,
    earned: 4000,
    revenue: 5200,
    marginPercent: 25,
  },
  {
    agentId: 'a2',
    name: 'Drafting',
    usageEvents: 300,
    cost: 1200,
    earned: 1500,
    revenue: 1800,
    marginPercent: 20,
  },
]

const TOTALS = { usageEvents: 1200, cost: 4200, earned: 5500, revenue: 7000 }

const METRICS: ReportMetricValue[] = [
  { metric: 'cost', value: 4200, unavailable: null },
  { metric: 'revenue', value: 7000, unavailable: null },
  { metric: 'margin', value: 2800, unavailable: null },
  { metric: 'marginPercent', value: 40, unavailable: null },
  { metric: 'eventCount', value: 1200, unavailable: null },
  { metric: 'costPerTask', value: 3.5, unavailable: null },
]

/** The instants the reads ran on: a rolling window resolves to
 * now-minus-30-days at this hour, not to the midnight the display date names. */
const RESOLVED = {
  startDate: '2026-08-19T14:22:10.114Z',
  endDate: '2026-09-18T14:22:10.114Z',
}

const SURFACE: ReportSurfaceInput = {
  window: WINDOW,
  resolvedPeriod: RESOLVED,
  agents: { rows: ROWS, totals: TOTALS },
  metrics: METRICS,
  finishedWork: null,
  assumptions: {
    method: 'perItem',
    unitPlural: 'reviews',
    unitSingular: 'review',
    costPerItem: 140,
  },
  inputs: {
    unitsCompleted: 57,
    measuredCount: null,
    windowIsAnchored: true,
    selectedAgentKeys: null,
  },
}

const jsonBody = (input: ReportSurfaceInput) => buildRoiReportJson(input)

const pageWithoutAi = (input: ReportSurfaceInput = SURFACE) =>
  buildWithoutAi({
    window: input.window,
    resolvedPeriod: input.resolvedPeriod,
    assumptions: input.assumptions,
    inputs: input.inputs,
    rows: input.agents.rows,
    totals: input.agents.totals,
    // This fixture reads no finished work, which is what surfaceWithoutAi
    // passes in that case.
    measuredThings: [],
  })

describe('the paragraph is one string on all three surfaces', () => {
  it("the print and the JSON carry the builder's paragraph, character for character", () => {
    const page = pageWithoutAi()
    expect(page.kind).toBe('comparison')
    if (page.kind !== 'comparison') return

    expect(buildPrintReport(SURFACE).withoutAi?.paragraph).toBe(page.paragraph)
    expect(jsonBody(SURFACE).withoutAi?.paragraph).toBe(page.paragraph)
  })

  it('the heading is the same word on all three, so none of them says "Without us"', () => {
    expect(buildPrintReport(SURFACE).withoutAi?.heading).toBe(
      WITHOUT_AI_COPY.heading
    )
    expect(WITHOUT_AI_COPY.heading).toBe('Without AI')
  })

  it('the estimate stamp travels with it, so dropping it is a deliberate act', () => {
    const page = pageWithoutAi()
    if (page.kind !== 'comparison') throw new Error('expected a comparison')
    expect(buildPrintReport(SURFACE).withoutAi?.estimateLabel).toBe(
      page.estimateLabel
    )
    expect(jsonBody(SURFACE).withoutAi?.estimateLabel).toBe(page.estimateLabel)
  })

  it('the rows and the method ride into the JSON, so a consumer can rebuild the table', () => {
    const page = pageWithoutAi()
    if (page.kind !== 'comparison') throw new Error('expected a comparison')
    const body = jsonBody(SURFACE)
    expect(body.withoutAi?.method).toBe('perItem')
    expect(body.withoutAi?.cost).toEqual(page.cost)
    expect(body.withoutAi?.revenue).toEqual(page.revenue)
    expect(body.withoutAi?.netLine).toBe(page.netLine)
    expect(body.withoutAi?.intro).toBe(page.intro)
  })

  it('narrowing the agents changes the paragraph on every surface at once', () => {
    const narrowed: ReportSurfaceInput = {
      ...SURFACE,
      inputs: { ...SURFACE.inputs, selectedAgentKeys: ['a1'] },
    }
    const page = pageWithoutAi(narrowed)
    if (page.kind !== 'comparison') throw new Error('expected a comparison')

    expect(page.paragraph).not.toBe(
      (pageWithoutAi() as { paragraph: string }).paragraph
    )
    expect(buildPrintReport(narrowed).withoutAi?.paragraph).toBe(page.paragraph)
    expect(jsonBody(narrowed).withoutAi?.paragraph).toBe(page.paragraph)
  })

  it('with nothing supplied, all three refuse together rather than one showing an empty shell', () => {
    const bare: ReportSurfaceInput = { ...SURFACE, assumptions: {} }
    expect(pageWithoutAi(bare).kind).toBe('empty')
    expect(buildPrintReport(bare).withoutAi).toBeNull()
    expect(jsonBody(bare).withoutAi).toBeNull()
  })
})

describe('the print leads with the report, in full', () => {
  const print = buildPrintReport(SURFACE)

  it('names the dates it covers', () => {
    expect(print.datesLine).toBe(
      REPORT_COPY.printDatesLine(WINDOW.startDate, WINDOW.endDate)
    )
  })

  // The print is the one surface that leaves the building, so it carries this
  // too. The screen renders REPORT_COPY.noHours and the JSON carries
  // honesty.hoursNote.
  it('carries the "we do not show hours saved" sentence the screen and the JSON both carry', () => {
    expect(print.hoursNote).toBe(REPORT_COPY.noHours)
  })

  it('carries the What you used AI for table with the same lead sentence the screen shows', () => {
    expect(print.agentsHeading).toBe(REPORT_COPY.agentsHeading)
    expect(print.leadSentence).toBe(
      reportLeadSentence({
        ...WINDOW,
        agentsThatRecorded: 2,
        usageEvents: TOTALS.usageEvents,
        cost: TOTALS.cost,
        includesDeletedAgents: false,
      })
    )
    expect(print.rows.map((row) => row.name)).toEqual([
      'Contract Summary',
      'Drafting',
    ])
    expect(print.totals?.cost).toBe('$4,200.00')
  })

  it('shows which agents the comparison counted, the way the checkboxes read on screen', () => {
    expect(print.rows.map((row) => row.counted)).toEqual([
      REPORT_COPY.agentCounted,
      REPORT_COPY.agentCounted,
    ])
    const narrowed = buildPrintReport({
      ...SURFACE,
      inputs: { ...SURFACE.inputs, selectedAgentKeys: ['a1'] },
    })
    expect(narrowed.rows.map((row) => row.counted)).toEqual([
      REPORT_COPY.agentCounted,
      REPORT_COPY.agentLeftOut,
    ])
  })

  it('carries the six headline metrics with their definitions, from the same tile builder', () => {
    expect(print.metrics).toHaveLength(6)
    expect(print.metrics.map((tile) => tile.key)).toEqual(
      METRICS.map((entry) => entry.metric)
    )
    for (const tile of print.metrics) {
      expect(tile.definition.length).toBeGreaterThan(10)
    }
    expect(print.metrics[0]).toEqual(
      reportMetricTile(METRICS[0], { window: WINDOW })
    )
  })

  it('carries the usage-event definition and the proxy-gap sentence in full, not a trimmed version', () => {
    expect(print.usageEventDefinition).toBe(REPORT_COPY.usageEventDefinition)
    expect(print.proxyGap).toBe(REPORT_COPY.proxyGap)
  })

  it('an empty window prints the honest empty sentence rather than a table of nothing', () => {
    const quiet = buildPrintReport({
      ...SURFACE,
      agents: {
        rows: [],
        totals: { usageEvents: 0, cost: 0, earned: 0, revenue: 0 },
      },
    })
    expect(quiet.rows).toEqual([])
    expect(quiet.totals).toBeNull()
    expect(quiet.leadSentence).toContain('Nothing recorded')
  })
})

describe('every number in the JSON says where it came from', () => {
  const body = jsonBody(SURFACE)

  /** Walks the body and returns the path of every bare number that is not the
   * `value` of an object carrying a `source`. */
  function unstamped(node: unknown, path = ''): string[] {
    if (typeof node === 'number') return [path]
    if (Array.isArray(node)) {
      return node.flatMap((item, i) => unstamped(item, `${path}[${i}]`))
    }
    if (node === null || typeof node !== 'object') return []
    const record = node as Record<string, unknown>
    if (typeof record.source === 'string' && 'value' in record) {
      return typeof record.value === 'number' ? [] : [`${path}.value`]
    }
    return Object.entries(record).flatMap(([key, item]) =>
      unstamped(item, path === '' ? key : `${path}.${key}`)
    )
  }

  it('walks the whole body and finds no number without a source beside it', () => {
    expect(unstamped(body)).toEqual([])
  })

  it('the walker is real — a body with a bare number fails it', () => {
    expect(unstamped({ metrics: [{ key: 'cost', value: 12 }] })).toEqual([
      'metrics[0].value',
    ])
  })

  it('measured, customer-entered and derived are the only three stamps in the body', () => {
    const stamps = new Set<string>()
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(collect)
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (typeof record.source === 'string') stamps.add(record.source)
      Object.values(record).forEach(collect)
    }
    collect(body)
    expect([...stamps].sort()).toEqual(
      [
        'assumed_same_as_with_ai',
        'customer_entered',
        'derived_from_customer_input',
        'measured',
      ].sort()
    )
  })

  it('what the customer typed is never stamped as something we measured', () => {
    expect(body.withoutAi?.numbers.unitsCompleted?.source).toBe(
      'customer_entered'
    )
    expect(body.withoutAi?.numbers.costPerItem?.source).toBe('customer_entered')
    expect(body.withoutAi?.numbers.cost.withoutAi.source).toBe(
      'derived_from_customer_input'
    )
    expect(body.withoutAi?.numbers.cost.withAi.source).toBe('measured')
  })

  it('the window and the agent rows are measured, and the agent selection is the customer speaking', () => {
    expect(body.window).toEqual({
      start: WINDOW.startDate,
      end: WINDOW.endDate,
      resolvedStart: RESOLVED.startDate,
      resolvedEnd: RESOLVED.endDate,
      source: 'measured',
    })
    expect(body.whatYouUsedAiFor.agents[0].cost.source).toBe('measured')
    expect(body.whatYouUsedAiFor.totals.usageEvents.source).toBe('measured')
    expect(body.scope.source).toBe('customer_entered')
    expect(body.scope.allSelected).toBe(true)
    expect(body.scope.agentKeys).toEqual(ROWS.map(reportAgentRowKey))
  })

  it('a metric with no number for the window is null, never a zero', () => {
    const body = jsonBody({
      ...SURFACE,
      metrics: [{ metric: 'mrr', value: null, unavailable: null }],
    })
    expect(body.metrics[0].value).toBeNull()
    expect(body.metrics[0].formatted).toBe('—')
  })

  it('every metric carries its label and its definition, so a figure quoted alone still explains itself', () => {
    for (const metric of body.metrics) {
      expect(metric.label.length).toBeGreaterThan(0)
      expect(metric.definition.length).toBeGreaterThan(10)
    }
  })

  it('the honesty paragraphs ship in full, so a consumer cannot quote the number without them', () => {
    expect(body.honesty).toEqual({
      proxyGap: REPORT_COPY.proxyGap,
      usageEventDefinition: REPORT_COPY.usageEventDefinition,
      hoursNote: REPORT_COPY.noHours,
    })
  })
})

/**
 * The route is sold on one promise: any figure in it can be checked. A body
 * whose own dates re-query to a different window breaks that promise on the
 * one field every other number hangs off.
 */
describe('the published window reproduces the numbers it was read with', () => {
  const body = jsonBody(SURFACE)

  it('publishes the instants the reads ran on, beside the dates a person reads', () => {
    expect(body.window.start).toBe(WINDOW.startDate)
    expect(body.window.end).toBe(WINDOW.endDate)
    expect(body.window.resolvedStart).toBe(RESOLVED.startDate)
    expect(body.window.resolvedEnd).toBe(RESOLVED.endDate)
  })

  it('re-sending the published instants lands on the same bounds, to the millisecond', () => {
    const again = parseWindowFilter({
      startDate: body.window.resolvedStart,
      endDate: body.window.resolvedEnd,
    })
    expect(again.windowStart.toISOString()).toBe(RESOLVED.startDate)
    expect(again.windowEnd.toISOString()).toBe(RESOLVED.endDate)
  })

  it('re-sending the display dates would have widened the window, which is why both pairs ship', () => {
    const widened = parseWindowFilter({
      startDate: body.window.start,
      endDate: body.window.end,
    })
    expect(widened.windowStart.toISOString()).not.toBe(RESOLVED.startDate)
    expect(widened.windowStart.getTime()).toBeLessThan(
      new Date(RESOLVED.startDate).getTime()
    )
  })

  it('the day the dates name is the day the instants fall on, so the two pairs describe one window', () => {
    expect(body.window.resolvedStart.slice(0, 10)).toBe(body.window.start)
    expect(body.window.resolvedEnd.slice(0, 10)).toBe(body.window.end)
  })

  it('the day count the estimate pro-rates by comes from those instants', () => {
    const page = pageWithoutAi()
    if (page.kind !== 'comparison') throw new Error('expected a comparison')
    expect(page.numbers.windowDays.value).toBe(30)
    expect(page.numbers.windowDays.source).toBe('measured')
  })

  it('the action publishes the instants it read with rather than resolving a second time', () => {
    const actionSrc = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'app',
        'actions',
        'roi-report.ts'
      ),
      'utf8'
    )
    const start = actionSrc.indexOf('buildRoiReportJson({')
    const call = actionSrc.slice(start, actionSrc.indexOf('}),', start))
    expect(start).toBeGreaterThan(-1)
    expect(call).toMatch(/window: resolved\.displayWindow/)
    expect(call).toMatch(/resolvedPeriod: resolved\.resolvedPeriod/)
  })
})

/**
 * The print LEADS with the comparison, in the same rows the
 * screen shows, not only the paragraph. Page one is what a director reads, and
 * a director who reads "Without AI" first reads the point of the page first.
 */
describe('the print carries the comparison the screen carries', () => {
  const WITH_REVENUE: ReportSurfaceInput = {
    ...SURFACE,
    assumptions: { ...SURFACE.assumptions, revenuePerMonth: 4000 },
  }

  it('carries both rows as built, not a second rendering of the same numbers', () => {
    const page = pageWithoutAi(WITH_REVENUE)
    if (page.kind !== 'comparison') throw new Error('expected a comparison')
    const print = buildPrintReport(WITH_REVENUE).withoutAi
    expect(print?.cost).toEqual(page.cost)
    expect(print?.revenue).toEqual(page.revenue)
    expect(print?.netLine).toBe(page.netLine)
  })

  // The row stays when the reader unchecks an agent. It follows the check
  // marks, on paper exactly as on screen.
  it('narrows the Revenue row with the check marks, on paper as on screen', () => {
    const narrowed: ReportSurfaceInput = {
      ...WITH_REVENUE,
      inputs: { ...WITH_REVENUE.inputs, selectedAgentKeys: ['a1'] },
    }
    const page = pageWithoutAi(narrowed)
    if (page.kind !== 'comparison') throw new Error('expected a comparison')
    expect(page.numbers.revenue.withAi.value).toBe(ROWS[0].revenue)
    expect(buildPrintReport(narrowed).withoutAi?.revenue).toEqual(page.revenue)
  })

  it('carries none of the on-screen help, which asks the reader to click things paper has none of', () => {
    const print = buildPrintReport(WITH_REVENUE)
    const onPaper = JSON.stringify(print)
    for (const helper of [
      WITHOUT_AI_COPY.intro(WINDOW.startDate, WINDOW.endDate),
      WITHOUT_AI_COPY.whatSaves,
      WITHOUT_AI_COPY.agentScopeHelper,
      WITHOUT_AI_COPY.countNeedsDatesHelper,
      WITHOUT_AI_COPY.hourlyRateHelper,
      WITHOUT_AI_COPY.revenuePerMonthHelper,
      WITHOUT_AI_COPY.emptyButton,
      REPORT_COPY.printReportLabel,
      REPORT_COPY.printReportHover,
      REPORT_COPY.howThisPageWorksLabel,
      REPORT_COPY.dateHelper,
      REPORT_COPY.meterNamesHelper,
      REPORT_COPY.showEveryMetric,
    ]) {
      expect(onPaper).not.toContain(helper)
    }
  })

  it('still carries the hours sentence, which is the one thing paper cannot ask a tooltip for', () => {
    expect(buildPrintReport(WITH_REVENUE).hoursNote).toBe(REPORT_COPY.noHours)
  })
})

/**
 * Both revenue columns, one read. The screen shows the column
 * the reader picked; the paper and the JSON carry both, so nobody downstream
 * has to know which one was on screen when the link was sent.
 */
describe('Earned and Total revenue on all three surfaces', () => {
  it('the print carries both columns and the totals for both', () => {
    const print = buildPrintReport(SURFACE)
    expect(print.tableHeaders).toEqual([
      'Agent',
      'Usage events',
      'Cost',
      'Earned',
      'Total revenue',
      marginHeaderForBasis('total'),
      WITHOUT_AI_COPY.agentScopeColumnLabel,
    ])
    expect(print.rows.map((row) => row.earned)).toEqual([
      '$4,000.00',
      '$1,500.00',
    ])
    expect(print.rows.map((row) => row.revenue)).toEqual([
      '$5,200.00',
      '$1,800.00',
    ])
    expect(print.totals?.revenue).toBe('$7,000.00')
  })

  it('the print margin follows the same column the screen is showing', () => {
    const earned = buildPrintReport({ ...SURFACE, revenueBasis: 'earned' })
    const total = buildPrintReport({ ...SURFACE, revenueBasis: 'total' })
    expect(earned.rows[0].margin).not.toBe(total.rows[0].margin)
  })

  it('the printed Margin header names its denominator, because paper has no hover', () => {
    const earned = buildPrintReport({ ...SURFACE, revenueBasis: 'earned' })
    const total = buildPrintReport({ ...SURFACE, revenueBasis: 'total' })
    expect(earned.tableHeaders).toContain('Margin (on Earned)')
    expect(total.tableHeaders).toContain('Margin (on Total revenue)')
    expect(earned.tableHeaders).not.toContain('Margin')
    expect(total.tableHeaders).not.toContain('Margin')
    expect(marginHeaderForBasis('total')).toBe('Margin (on Total revenue)')
  })

  it('the basis in the header is the label the control uses, not a second spelling', () => {
    for (const option of REVENUE_BASIS_OPTIONS) {
      expect(marginHeaderForBasis(option.id)).toBe(
        `Margin (on ${option.label})`
      )
    }
  })

  it('the JSON names the basis of every margin, so it cannot disagree with the screen', () => {
    const body = jsonBody(SURFACE)
    const row = body.whatYouUsedAiFor.agents[0]
    expect(row).not.toHaveProperty('marginPercent')
    expect(row.marginPercentEarned?.value).toBe(safeMarginPercent(4000, 1000))
    expect(row.marginPercentTotal?.value).toBe(safeMarginPercent(5200, 2200))
    expect(formatPct(row.marginPercentEarned?.value ?? null)).toBe(
      reportAgentRowCells(ROWS[0], 'earned').margin
    )
    expect(formatPct(row.marginPercentTotal?.value ?? null)).toBe(
      reportAgentRowCells(ROWS[0], 'total').margin
    )
  })

  it('a margin with no revenue under it stays null in the document, never a zero', () => {
    const noMoney: ReportAgentRowValues = {
      agentId: 'a3',
      name: 'Quiet',
      usageEvents: 4,
      cost: 12,
      earned: 0,
      revenue: 0,
      marginPercent: null,
    }
    const body = jsonBody({
      ...SURFACE,
      agents: { rows: [noMoney], totals: TOTALS },
    })
    expect(body.whatYouUsedAiFor.agents[0].marginPercentEarned).toBeNull()
    expect(body.whatYouUsedAiFor.agents[0].marginPercentTotal).toBeNull()
  })

  it('the JSON carries both on every row and on the totals', () => {
    const body = jsonBody(SURFACE)
    expect(body.whatYouUsedAiFor.agents.map((row) => row.earned.value)).toEqual(
      [4000, 1500]
    )
    expect(
      body.whatYouUsedAiFor.agents.map((row) => row.revenue.value)
    ).toEqual([5200, 1800])
    expect(body.whatYouUsedAiFor.totals.revenue.value).toBe(TOTALS.revenue)
    expect(body.whatYouUsedAiFor.totals.earned.value).toBe(TOTALS.earned)
  })

  it('the table total IS the Revenue tile, so the two cannot disagree on one screen', () => {
    const body = jsonBody(SURFACE)
    const tile = body.metrics.find((metric) => metric.key === 'revenue')
    expect(tile?.value?.value).toBe(body.whatYouUsedAiFor.totals.revenue.value)

    // Both numbers above come from this file's own fixture, so the pair proves
    // the echo, not the guarantee. The guarantee is in the action: the tile's
    // read and the table's total are one variable off ONE getRevenueMetrics.
    const actionSrc = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'app',
        'actions',
        'roi-report.ts'
      ),
      'utf8'
    )
    const from = actionSrc.indexOf('async function readHeadlineReport(')
    const to = actionSrc.indexOf('async function readSecondaryMetrics(')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const headline = actionSrc.slice(from, to)
    expect(headline.match(/getRevenueMetrics\(/g)).toHaveLength(1)

    const tileAt = headline.indexOf('const headlineReads: WindowReads = {')
    const totalsAt = headline.indexOf('totals: {')
    expect(tileAt).toBeGreaterThan(-1)
    expect(totalsAt).toBeGreaterThan(tileAt)
    expect(headline.slice(tileAt, totalsAt)).toMatch(
      /revenue: revenueMetrics\.revenue,/
    )
    expect(headline.slice(totalsAt)).toMatch(
      /revenue: revenueMetrics\.revenue,/
    )
  })

  it('the JSON always carries a Revenue row in a comparison, with its own source word', () => {
    const body = jsonBody(SURFACE)
    expect(body.withoutAi?.revenue).not.toBeNull()
    expect(body.withoutAi?.numbers.revenue.withoutAi.source).toBe(
      'assumed_same_as_with_ai'
    )
    const told = jsonBody({
      ...SURFACE,
      assumptions: { ...SURFACE.assumptions, revenuePerMonth: 4000 },
    })
    expect(told.withoutAi?.numbers.revenue.withoutAi.source).toBe(
      'derived_from_customer_input'
    )
  })
})
