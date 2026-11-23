'use client'

/**
 * One target's day-by-day
 * trend on the initiative detail page. Modeled on the dashboard-shell
 * timeseries-chart tile (same recharts marks, same mf tokens, same
 * formatDisplayDate axis) but ROI-local: single series, and it formats by
 * the INITIATIVE_METRIC_META format ('pct' included, which the shared tile
 * doesn't speak). Values arrive server-derived from the detail action —
 * this component computes nothing.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatCost, formatPct } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { MF_SERIES } from '@/features/dashboard-shell/chart-colors'
import type { RoiTargetSeriesPoint } from '@/app/actions/roi-initiative-detail'
import type { InitiativeMetricFormat } from '../progress-derivation'

export interface TargetTrendChartProps {
  points: RoiTargetSeriesPoint[]
  format: InitiativeMetricFormat
  /** Names the series in the tooltip, e.g. 'Cost' — the metric label. */
  label: string
}

function makeValueFormatter(format: InitiativeMetricFormat) {
  return (value: number, decimals?: number) => {
    switch (format) {
      case 'cost':
        return formatCost(value, decimals)
      case 'pct':
        return formatPct(value)
      case 'count':
        return value.toLocaleString()
    }
  }
}

function TrendTooltip({
  active,
  payload,
  label,
  seriesLabel,
  formatValue,
}: {
  active?: boolean
  payload?: Array<{ value: number }>
  label?: string
  seriesLabel: string
  formatValue: (value: number) => string
}) {
  if (!active || !payload?.length || !label) return null
  return (
    <div className='rounded-mf-inner border border-mf-bd bg-mf-card px-3 py-2 shadow-lg'>
      <p className='mb-1.5 text-[10.5px] font-medium text-mf-tx3'>
        {formatDisplayDate(label, 'MMM d, yyyy')}
      </p>
      <div className='flex items-center gap-2 py-0.5'>
        <span
          className='h-2 w-2 rounded-sm'
          style={{ background: MF_SERIES.primary }}
        />
        <span className='text-[11px] text-mf-tx2'>{seriesLabel}</span>
        <span className='ml-auto text-[11px] font-semibold text-mf-tx'>
          {formatValue(payload[0].value)}
        </span>
      </div>
    </div>
  )
}

export function TargetTrendChart({
  points,
  format,
  label,
}: TargetTrendChartProps) {
  const formatValue = makeValueFormatter(format)

  return (
    <div className='h-[180px]'>
      <ResponsiveContainer width='100%' height='100%'>
        <ComposedChart
          data={points}
          margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
        >
          <defs>
            <linearGradient id='mf-roi-trend-fill' x1='0' y1='0' x2='0' y2='1'>
              <stop
                offset='0'
                stopColor={MF_SERIES.primary}
                stopOpacity={0.22}
              />
              <stop offset='1' stopColor={MF_SERIES.primary} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke='var(--mf-bd2)' vertical={false} />
          <XAxis
            dataKey='date'
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10.5, fill: 'var(--mf-tx3)' }}
            tickFormatter={(d: string) => formatDisplayDate(d, 'MMM d')}
            interval='preserveStartEnd'
            minTickGap={40}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10.5, fill: 'var(--mf-tx3)' }}
            tickFormatter={(v: number) => formatValue(v, 0)}
            width={56}
          />
          <Tooltip
            content={
              <TrendTooltip seriesLabel={label} formatValue={formatValue} />
            }
          />
          <Area
            dataKey='value'
            name={label}
            stroke={MF_SERIES.primary}
            strokeWidth={2}
            fill='url(#mf-roi-trend-fill)'
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
