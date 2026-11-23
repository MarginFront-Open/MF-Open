import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * A subscription with no usage in the selected window (e.g. brand-new, or a
 * quiet billing period) has chartData === []. An empty Recharts
 * ResponsiveContainer in the "Current Bill & Usage" card's fixed 350px chart
 * area draws only axis lines on a blank background, so the page shows an
 * explicit empty state instead. The chart itself (all four
 * displayType/chartType branches) renders as usual when there is data.
 * Source-assertion, not a render test — this page depends on
 * client-only hooks (useParams/useSubscriptionDetails/etc.) this repo's
 * Node-only jest can't render (same constraint as the sibling
 * usage-chart-tab-tooltips test).
 */
describe('subscription usage chart shows an empty state instead of a blank chart', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('checks chartData.length before rendering the chart', () => {
    expect(src).toMatch(/chartData\.length === 0 \? \(/)
  })

  it('shows an explicit "no usage data" message in the empty branch', () => {
    const emptyCheckIndex = src.indexOf('chartData.length === 0 ? (')
    expect(emptyCheckIndex).toBeGreaterThan(-1)
    const nearby = src.slice(emptyCheckIndex, emptyCheckIndex + 300)
    expect(nearby).toMatch(/No usage data for this period yet\./)
  })

  it('renders the real chart (ResponsiveContainer) in the non-empty branch', () => {
    const emptyCheckIndex = src.indexOf('chartData.length === 0 ? (')
    const chartBranch = src.slice(emptyCheckIndex, emptyCheckIndex + 2000)
    expect(chartBranch).toMatch(
      /<ResponsiveContainer width='100%' height='100%'>/
    )
    expect(chartBranch).toMatch(/chartType === 'area'/)
  })

  it('the fixed-height chart container is exactly one 350px box', () => {
    const matches = [...src.matchAll(/h-\[350px\]/g)]
    expect(matches.length).toBe(1)
  })
})
