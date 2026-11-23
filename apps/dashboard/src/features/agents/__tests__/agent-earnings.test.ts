/**
 * The shared agent-earnings view logic. The
 * pivot/format halves are pure and tested for real; the one-source-of-truth
 * contract (the Build detail renders through the shared module, no forked
 * chart markup) is source-asserted because this repo's jest is node-only
 * (no RTL) and the chart component imports recharts.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { formatEarningsValue, pivotEarningsChartData } from '../agent-earnings'

const dailyBreakdown = [
  {
    date: '2026-07-02',
    signalId: 's2',
    signalName: 'email_delivery',
    quantity: 4,
    cost: 0.4,
    earned: 2,
  },
  {
    date: '2026-07-01',
    signalId: 's1',
    signalName: 'voice_llm',
    quantity: 10,
    cost: 1.5,
    earned: 5,
  },
  {
    date: '2026-07-01',
    signalId: 's2',
    signalName: 'email_delivery',
    quantity: 3,
    cost: 0.3,
    earned: 1.5,
  },
  // Same signal, same day, second row — the pivot must SUM, not overwrite.
  {
    date: '2026-07-01',
    signalId: 's1',
    signalName: 'voice_llm',
    quantity: 2,
    cost: 0.5,
    earned: 1,
  },
]

describe('pivotEarningsChartData', () => {
  it('returns one entry per date, sorted ascending, with a column per signal name', () => {
    const data = pivotEarningsChartData({ dailyBreakdown }, 'revenue')
    expect(data.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-02'])
    expect(data[0]).toEqual({
      date: '2026-07-01',
      voice_llm: 6,
      email_delivery: 1.5,
    })
    expect(data[1]).toEqual({ date: '2026-07-02', email_delivery: 2 })
  })

  it('selects quantity for metrics and cost for cost', () => {
    const metrics = pivotEarningsChartData({ dailyBreakdown }, 'metrics')
    expect(metrics[0].voice_llm).toBe(12)
    const cost = pivotEarningsChartData({ dailyBreakdown }, 'cost')
    expect(cost[0].voice_llm).toBe(2)
  })

  it('returns [] for a null/undefined response (loading and error states)', () => {
    expect(pivotEarningsChartData(null, 'revenue')).toEqual([])
    expect(pivotEarningsChartData(undefined, 'cost')).toEqual([])
  })
})

describe('formatEarningsValue', () => {
  it('renders metrics as plain counts and cost/revenue as USD', () => {
    expect(formatEarningsValue('metrics', 1234)).toBe('1,234')
    expect(formatEarningsValue('cost', 2)).toMatch(/^\$2/)
    expect(formatEarningsValue('revenue', '2.5')).toMatch(/^\$2\.50/)
  })
})

describe('one source of truth: the Build detail renders the shared module', () => {
  const detailSrc = readFileSync(
    join(__dirname, '..', '..', 'build', 'components', 'agent-detail.tsx'),
    'utf8'
  )

  it('there is no separate Overview.tsx', () => {
    expect(existsSync(join(__dirname, '..', 'Overview.tsx'))).toBe(false)
  })

  it('consumes useAgentEarningsBreakdown + AgentEarningsChartBody', () => {
    expect(detailSrc).toMatch(/useAgentEarningsBreakdown/)
    expect(detailSrc).toMatch(/<AgentEarningsChartBody/)
  })

  it('no forked chart markup: recharts stays out, the raw action stays out', () => {
    expect(detailSrc).not.toMatch(/from 'recharts'/)
    expect(detailSrc).not.toMatch(/import[^\n]*getAgentEarningsBreakdown/)
  })

  it("the chart's Revenue uses the usageRevenue tooltip", () => {
    expect(detailSrc).toMatch(/tooltipDefinitions\.usageRevenue/)
  })
})
