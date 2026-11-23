'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

interface PortalActivityChartProps {
  data: { label: string; tasks: number }[]
  mode: 'billing' | 'all'
}

export function PortalActivityChart({ data, mode }: PortalActivityChartProps) {
  const hasData = data.some((d) => d.tasks > 0)

  if (!hasData) {
    return (
      <div className='flex h-48 items-center justify-center rounded-lg border border-dashed border-border bg-muted/10 text-sm text-muted-foreground'>
        No activity in this{' '}
        {mode === 'billing' ? 'billing period' : 'time range'} yet.
      </div>
    )
  }

  return (
    <div className='h-64 w-full'>
      <ResponsiveContainer width='100%' height='100%'>
        <BarChart
          data={data}
          margin={{ top: 10, right: 12, left: 0, bottom: 24 }}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='#f0f0f0' />
          <XAxis
            dataKey='label'
            tick={{ fontSize: 11 }}
            interval='preserveStartEnd'
            height={32}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={40} />
          <Tooltip
            formatter={(value: number) => [value, 'Usage events']}
            contentStyle={{ borderRadius: 6, border: '1px solid #e5e7eb' }}
          />
          <Bar dataKey='tasks' fill='#003024' radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
