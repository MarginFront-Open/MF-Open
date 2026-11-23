/**
 * DimensionedSection's showChart prop.
 * Node-only jest, no RTL (jest.config.ts) — conditional-render source-
 * asserts, the same approach dimensioned-section-picker.test.ts uses for
 * showDimensionPicker. The single-resolver-call invariant is guarded
 * separately by shell-safety.test.ts (this prop must never add a second
 * call site — that suite counts them).
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(
  join(__dirname, '..', 'dimensioned-section.tsx'),
  'utf8'
)

describe('DimensionedSection — showChart prop', () => {
  it('declares showChart as an optional boolean prop', () => {
    expect(src).toMatch(/showChart\?:\s*boolean/)
  })

  it('defaults to true (backward-compatible — every existing caller keeps its chart)', () => {
    expect(src).toMatch(/showChart\s*=\s*true/)
  })

  it('the TimeseriesChart block only renders when showChart is true', () => {
    const gateIndex = src.indexOf('{showChart && (')
    expect(gateIndex).toBeGreaterThan(-1)
    // The gated block contains the chart's own JSX so the conditional wraps
    // the right thing, not an unrelated element. The window is wide enough
    // to include the metric-picker markup above the chart inside this gate.
    const afterGate = src.slice(gateIndex, gateIndex + 1600)
    expect(afterGate).toMatch(/<TimeseriesChart/)
  })

  it('donut, table, and picker keep their own independent gates', () => {
    expect(src).toMatch(/\{showDonut\s*&&\s*\(/)
    expect(src).toMatch(/\{showTable\s*&&\s*\(/)
    expect(src).toMatch(/\{showDimensionPicker\s*&&\s*\(/)
  })

  it('renderKpiRow also receives the response series (the add-panel chart feed — no second fetch)', () => {
    expect(src).toMatch(
      /renderKpiRow\(\s*data\?\.tiles \?\? null,\s*stateFor\(data !== null\),\s*data\?\.series \?\? null\s*\)/
    )
  })
})

// ── the chart metric picker ─────────────────
describe('DimensionedSection — chart metric picker', () => {
  it('declares showChartMetricPicker as an optional boolean prop', () => {
    expect(src).toMatch(/showChartMetricPicker\?:\s*boolean/)
  })

  it('defaults to false (overview/build/finops charts keep their default behavior)', () => {
    expect(src).toMatch(/showChartMetricPicker\s*=\s*false/)
  })

  it('the picker toggle only renders when showChartMetricPicker is true', () => {
    const gateIndex = src.indexOf('{showChartMetricPicker && (')
    expect(gateIndex).toBeGreaterThan(-1)
    const afterGate = src.slice(gateIndex, gateIndex + 500)
    expect(afterGate).toMatch(/aria-label='Chart metric'/)
  })

  it('the picker toggle sits inside the showChart gate (it belongs to the chart column)', () => {
    const chartGate = src.indexOf('{showChart && (')
    const pickerGate = src.indexOf('{showChartMetricPicker && (')
    const chartEl = src.indexOf('<TimeseriesChart')
    expect(chartGate).toBeGreaterThan(-1)
    expect(pickerGate).toBeGreaterThan(chartGate)
    expect(chartEl).toBeGreaterThan(pickerGate)
  })

  it('the chart plots the picked view sliced from the SAME response — data.series / data.earnedSeries, no second call', () => {
    // selectChartSeries is fed THIS response's arrays (the ones the table's
    // breakdown also reads), never a fresh fetch. Paired with shell-safety's
    // exactly-one-resolveMetrics-call check, this proves chart and table can't
    // disagree: same window, same dimension, same response.
    expect(src).toMatch(
      /selectChartSeries\(\s*chartMetricInUse,\s*data\?\.series/
    )
    expect(src).toMatch(/data\?\.earnedSeries/)
    expect(src).toMatch(/series=\{chart\.series\}/)
    expect(src).toMatch(/valueFormat=\{chart\.valueFormat\}/)
  })

  it('the table still reads the same response (data.breakdown) — one truth for chart + table', () => {
    expect(src).toMatch(/data\?\.breakdown \?\? EMPTY_BREAKDOWN/)
  })

  it('the picked view drives the chart title, keeping the money explainer tooltip', () => {
    expect(src).toMatch(/title=\{displayChartTitle\}/)
    // The info icon threads through (chart-title-tooltip.test.ts guards
    // this literal too).
    expect(src).toMatch(/titleTooltip=\{chartTitleTooltip\}/)
  })
})
