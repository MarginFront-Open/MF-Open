import { readFileSync } from 'fs'
import { join } from 'path'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

/**
 * The Money chart is titled 'Cost vs revenue' and carries an info tooltip
 * explaining the two lines in plain English. Source-assertion (dashboard jest is node-only, no RTL — same pattern as
 * no-direct-resolver.test.ts in this directory).
 */
describe('money/index.tsx — chart title + tooltip', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it("titles the chart 'Cost vs revenue'", () => {
    expect(src).toContain("chartTitle='Cost vs revenue'")
  })

  it("has no 'Spend vs. revenue' title anywhere in the page", () => {
    expect(src).not.toMatch(/Spend vs\.? revenue/i)
  })

  it('passes a chartTitleTooltip sourced from the shared tooltip-definitions registry (canon-format-adjacent: no hand-rolled copy)', () => {
    expect(src).toMatch(
      /chartTitleTooltip=\{tooltipDefinitions\.moneyCostVsRevenue\}/
    )
  })
})

// The line is canon Revenue, the accrual from getRevenueMetrics, not Billed
// (invoice totals), which this chart never plots. So the copy states the
// Revenue formula and the entry carries no "bill" language.
describe('tooltip-definitions.ts — moneyCostVsRevenue matches what the chart plots', () => {
  const entry = tooltipDefinitions.moneyCostVsRevenue
  const renderedCopy = [entry.title, entry.description, entry.details].join(
    '\n'
  )

  it('names Cost in plain terms: what you pay AI providers', () => {
    expect(entry.description).toMatch(/pay AI providers/i)
  })

  it('describes the Revenue line as the canon Revenue formula: owed for the window, usage at pricing rates plus subscription, seat, and one-time fees', () => {
    expect(entry.description).toMatch(/owe you for this window/i)
    expect(entry.description).toMatch(/pricing rates/i)
    expect(entry.description).toMatch(/subscription, seat, and one-time fees/i)
  })

  it('is honest that the line accrues before invoicing (the chart never reads invoices)', () => {
    expect(entry.description).toMatch(/whether or not an invoice has gone out/i)
  })

  it('no "bill" language anywhere in the rendered entry — that word belongs to invoice metrics, not this accrual series', () => {
    expect(renderedCopy).not.toMatch(/bill/i)
  })

  it('keeps the per-day framing and points invoice totals at their own surface', () => {
    expect(entry.details).toMatch(/per-day totals/i)
    expect(entry.details).toMatch(/Invoices tab/i)
  })

  it('has no em dash in rendered copy', () => {
    expect(renderedCopy).not.toMatch(/—/)
  })
})

describe('DimensionedSection + TimeseriesChart — thread an optional title tooltip', () => {
  const dimensionedSectionSrc = readFileSync(
    join(__dirname, '..', '..', 'dashboard-shell', 'dimensioned-section.tsx'),
    'utf8'
  )
  const timeseriesChartSrc = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'dashboard-shell',
      'tiles',
      'timeseries-chart.tsx'
    ),
    'utf8'
  )

  it('DimensionedSection declares chartTitleTooltip as optional (absent = unchanged behavior)', () => {
    expect(dimensionedSectionSrc).toMatch(/chartTitleTooltip\?:/)
  })

  it('DimensionedSection forwards chartTitleTooltip to TimeseriesChart as titleTooltip', () => {
    expect(dimensionedSectionSrc).toMatch(/titleTooltip=\{chartTitleTooltip\}/)
  })

  it('TimeseriesChart renders an InfoTooltip next to the title only when titleTooltip is passed', () => {
    expect(timeseriesChartSrc).toMatch(/titleTooltip\?:/)
    expect(timeseriesChartSrc).toMatch(/\{titleTooltip && \(/)
    expect(timeseriesChartSrc).toMatch(/<InfoTooltip/)
  })

  it('the per-day hover tooltip (TimeseriesTooltip) is untouched — still renders one row per series', () => {
    expect(timeseriesChartSrc).toMatch(/function TimeseriesTooltip/)
    expect(timeseriesChartSrc).toMatch(/payload\.map\(\(entry\)/)
  })
})
