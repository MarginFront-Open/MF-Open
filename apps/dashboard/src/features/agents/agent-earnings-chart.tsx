'use client'

/**
 * The data hook + Recharts body for the agent "Usage Cost & Revenue" chart,
 * shared by the Build agent detail. Each host keeps its own chrome (Card vs
 * mf-tokens) and its
 * own display/shape controls; the query, the pivot, and the chart markup
 * live here once so the two surfaces cannot drift.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  getAgentEarningsBreakdown,
  type AgentEarningsBreakdown,
} from '@/app/actions/get-agent-earnings-breakdown'
import {
  formatEarningsValue,
  pivotEarningsChartData,
  type EarningsChartShape,
  type EarningsDisplayType,
} from './agent-earnings'

// Chart palette pulled from the theme's --chart-* CSS variables so colors
// match the rest of the dashboard automatically.
const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]

/** Rolling 30 days, same window on every host — the summary line and the
 * usageRevenue tooltip both say "last 30 days", so the query must too. */
export function useAgentEarningsBreakdown(agentId: string) {
  return useQuery({
    queryKey: ['agent-earnings-breakdown', agentId],
    queryFn: async () => {
      const result = await getAgentEarningsBreakdown({ agentId })
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to load earnings breakdown')
      }
      return result.data!
    },
    enabled: !!agentId,
    staleTime: 30_000,
  })
}

export interface AgentEarningsChartBodyProps {
  breakdown: AgentEarningsBreakdown
  displayType: EarningsDisplayType
  chartShape: EarningsChartShape
}

export function AgentEarningsChartBody({
  breakdown,
  displayType,
  chartShape,
}: AgentEarningsChartBodyProps) {
  const chartData = useMemo(
    () => pivotEarningsChartData(breakdown, displayType),
    [breakdown, displayType]
  )

  const yAxisFormatter = (value: number) =>
    formatEarningsValue(displayType, value)
  const tooltipFormatter = (value: number | string) =>
    formatEarningsValue(displayType, value)

  return (
    <ResponsiveContainer width='100%' height='100%'>
      {chartShape === 'area' ? (
        <AreaChart
          data={chartData}
          margin={{ top: 20, right: 30, left: 0, bottom: 30 }}
        >
          <CartesianGrid strokeDasharray='3 3' />
          <XAxis
            dataKey='date'
            angle={-45}
            textAnchor='end'
            height={60}
            tick={{ fontSize: 12 }}
          />
          <YAxis tickFormatter={yAxisFormatter} />
          <Tooltip formatter={tooltipFormatter} />
          <Legend wrapperStyle={{ paddingTop: '10px' }} />
          {breakdown.signals.map((signal, index) => (
            <Area
              key={signal.id}
              type='monotone'
              dataKey={signal.name}
              name={signal.name}
              stackId='1'
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              stroke={CHART_COLORS[index % CHART_COLORS.length]}
              fillOpacity={0.6}
            />
          ))}
        </AreaChart>
      ) : (
        <BarChart
          data={chartData}
          margin={{ top: 20, right: 30, left: 0, bottom: 30 }}
        >
          <CartesianGrid strokeDasharray='3 3' />
          <XAxis
            dataKey='date'
            angle={-45}
            textAnchor='end'
            height={60}
            tick={{ fontSize: 12 }}
          />
          <YAxis tickFormatter={yAxisFormatter} />
          <Tooltip formatter={tooltipFormatter} />
          <Legend wrapperStyle={{ paddingTop: '10px' }} />
          {breakdown.signals.map((signal, index) => (
            <Bar
              key={signal.id}
              dataKey={signal.name}
              name={signal.name}
              stackId='1'
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              fillOpacity={0.8}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      )}
    </ResponsiveContainer>
  )
}
