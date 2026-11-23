/**
 * The trend chart's metric picker. This is a
 * REAL logic test (not a source-assert): chart-metric.ts is a pure module with
 * no React/recharts, so a node-only jest can exercise the selection directly.
 * It proves (a) the picker offers the right views, (b) each view plots the
 * right series sliced from the ONE response, (c) the count view switches the
 * axis unit, and (d) revenue views degrade honestly when no revenue series
 * exists — the same honest-null gate the donut toggle uses.
 */

import type { CostByDayRow, EarnedByDayRow } from '../types'
import {
  chartMetricLabel,
  chartMetricOptions,
  chartTitleFor,
  effectiveChartMetric,
  selectChartSeries,
  type ChartMetric,
} from '../chart-metric'

const SERIES: CostByDayRow[] = [
  { date: new Date('2026-06-01T00:00:00.000Z'), cost: 100, eventCount: 4000 },
  { date: new Date('2026-06-02T00:00:00.000Z'), cost: 250, eventCount: 9000 },
]

const EARNED: EarnedByDayRow[] = [
  { date: new Date('2026-06-01T00:00:00.000Z'), earned: 400 },
  { date: new Date('2026-06-02T00:00:00.000Z'), earned: 900 },
]

describe('chartMetricOptions — revenue-bearing views gated on the revenue series', () => {
  it('offers all four views when a revenue series exists', () => {
    expect(chartMetricOptions(true)).toEqual([
      'cost+revenue',
      'cost',
      'revenue',
      'tasks',
    ])
  })

  it('drops Revenue and Cost + Revenue when there is no revenue series (honest-null)', () => {
    expect(chartMetricOptions(false)).toEqual(['cost', 'tasks'])
  })
})

describe('effectiveChartMetric — corrects a dead revenue selection', () => {
  it('keeps the picked view when the revenue series is present', () => {
    for (const m of [
      'cost+revenue',
      'cost',
      'revenue',
      'tasks',
    ] as ChartMetric[]) {
      expect(effectiveChartMetric(m, true)).toBe(m)
    }
  })

  it('falls back to Cost when a revenue view is picked but no revenue series exists', () => {
    expect(effectiveChartMetric('revenue', false)).toBe('cost')
    expect(effectiveChartMetric('cost+revenue', false)).toBe('cost')
  })

  it('leaves non-revenue views untouched without a revenue series', () => {
    expect(effectiveChartMetric('cost', false)).toBe('cost')
    expect(effectiveChartMetric('tasks', false)).toBe('tasks')
  })
})

describe('selectChartSeries — every view is sliced from the one response', () => {
  it('Cost + Revenue plots two money series when revenue exists', () => {
    const { series, valueFormat } = selectChartSeries(
      'cost+revenue',
      SERIES,
      EARNED,
      true
    )
    expect(valueFormat).toBe('cost')
    expect(series.map((s) => s.label)).toEqual(['Cost', 'Revenue'])
    expect(series[0].points).toBe(SERIES)
    // Revenue's y-value is the earned dollars mapped into the row's `cost`
    // field (one axis, both money).
    expect(series[1].points.map((p) => p.cost)).toEqual([400, 900])
  })

  it('Cost + Revenue collapses to Cost-only when no revenue series exists', () => {
    const { series } = selectChartSeries('cost+revenue', SERIES, null, false)
    expect(series.map((s) => s.label)).toEqual(['Cost'])
  })

  it('Cost plots a single money series', () => {
    const { series, valueFormat } = selectChartSeries(
      'cost',
      SERIES,
      EARNED,
      true
    )
    expect(valueFormat).toBe('cost')
    expect(series.map((s) => s.label)).toEqual(['Cost'])
  })

  it('Revenue plots the earned series when present, else Cost', () => {
    expect(
      selectChartSeries('revenue', SERIES, EARNED, true).series.map(
        (s) => s.label
      )
    ).toEqual(['Revenue'])
    expect(
      selectChartSeries('revenue', SERIES, null, false).series.map(
        (s) => s.label
      )
    ).toEqual(['Cost'])
  })

  it('Usage events plots the daily eventCount on a count axis', () => {
    const { series, valueFormat } = selectChartSeries(
      'tasks',
      SERIES,
      EARNED,
      true
    )
    expect(valueFormat).toBe('count')
    expect(series.map((s) => s.label)).toEqual(['Usage events'])
    // The event count rides in the row's `cost` y-field (same shape trick as
    // Revenue) — proves the picker never needs a second, count-shaped query.
    expect(series[0].points.map((p) => p.cost)).toEqual([4000, 9000])
  })
})

describe('labels + titles', () => {
  it('labels each view for the segmented control', () => {
    expect(chartMetricLabel('cost+revenue')).toBe('Cost + Revenue')
    expect(chartMetricLabel('cost')).toBe('Cost')
    expect(chartMetricLabel('revenue')).toBe('Revenue')
    expect(chartMetricLabel('tasks')).toBe('Usage events')
  })

  it('keeps the page title for Cost + Revenue and gives an honest heading otherwise', () => {
    expect(chartTitleFor('cost+revenue', 'Cost vs revenue')).toBe(
      'Cost vs revenue'
    )
    expect(chartTitleFor('cost', 'Cost vs revenue')).toBe('Cost over time')
    expect(chartTitleFor('revenue', 'Cost vs revenue')).toBe(
      'Revenue over time'
    )
    expect(chartTitleFor('tasks', 'Cost vs revenue')).toBe(
      'Usage events over time'
    )
  })
})
