/**
 * Unit tests for the CFO Charts data-shaping helpers. These run in
 * the dashboard's node-env jest suite — the helpers are pure (no React/recharts),
 * so we can assert the shaping directly without mounting a chart.
 */
import {
  buildRevenueComparison,
  buildCategorySlices,
  buildGlCostBars,
} from '../cfo-charts-utils'

describe('buildRevenueComparison', () => {
  // Rows arrive pre-sorted by revenue desc (getProductLineMargins).
  const rows = [
    { agentName: 'Atlas', earned: 80, revenue: 100 },
    { agentName: 'Bolt', earned: 30, revenue: 30 },
    { agentName: 'Zero', earned: 0, revenue: 0 },
  ]

  it('keeps order, pairs earned vs total, and drops zero-activity lines', () => {
    expect(buildRevenueComparison(rows)).toEqual([
      { name: 'Atlas', earned: 80, total: 100 },
      { name: 'Bolt', earned: 30, total: 30 },
    ])
  })

  it('clamps earned to total — earned (R1) is a slice of total (R1+R2), never bigger', () => {
    const [bar] = buildRevenueComparison([
      { agentName: 'Glitch', earned: 200, revenue: 100 },
    ])
    expect(bar.earned).toBe(100)
    expect(bar.total).toBe(100)
  })

  it('treats a missing earned (older locked snapshot) as 0, not NaN', () => {
    const [bar] = buildRevenueComparison([
      { agentName: 'Legacy', revenue: 50 } as {
        agentName: string
        revenue: number
        earned: number
      },
    ])
    expect(bar.earned).toBe(0)
    expect(bar.total).toBe(50)
  })

  it('caps to the top-N by revenue (order already desc)', () => {
    const out = buildRevenueComparison(rows, 1)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Atlas')
  })
})

describe('buildCategorySlices', () => {
  it('keeps only buckets with real spend and carries the human label', () => {
    const slices = buildCategorySlices([
      { key: 'PRODUCTION_COGS', label: 'Production COGS', cost: 120 },
      { key: 'DEVELOPMENT_RD', label: 'Development / R&D', cost: 0 },
      { key: 'UNCLASSIFIED', label: 'Unclassified', cost: 5 },
    ])
    expect(slices).toEqual([
      { key: 'PRODUCTION_COGS', name: 'Production COGS', value: 120 },
      { key: 'UNCLASSIFIED', name: 'Unclassified', value: 5 },
    ])
  })
})

describe('buildGlCostBars', () => {
  const rows = [
    { glCode: '5100', glName: 'AI Inference', amount: 50 },
    { glCode: null, glName: 'Unmapped — needs GL code', amount: 80 },
    { glCode: '5200', glName: 'Empty', amount: 0 },
  ]

  it('sorts by spend desc, flags the unmapped bucket, drops $0 lines', () => {
    expect(buildGlCostBars(rows)).toEqual([
      { name: 'Unmapped', value: 80, isUnmapped: true },
      { name: '5100 · AI Inference', value: 50, isUnmapped: false },
    ])
  })

  it('caps to the top-N by spend', () => {
    const out = buildGlCostBars(rows, 1)
    expect(out).toHaveLength(1)
    expect(out[0].value).toBe(80)
  })
})
