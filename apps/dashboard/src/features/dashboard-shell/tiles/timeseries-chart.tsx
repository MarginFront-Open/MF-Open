import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import { formatCost, formatCurrency } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { MF_SERIES } from '../chart-colors'
import type { CostByDayRow } from '../types'
import { TileFrame, type TileStateProps } from './tile-frame'

export interface TimeseriesSeriesInput {
  label: string
  points: CostByDayRow[]
}

export interface TimeseriesChartProps extends TileStateProps {
  title: string
  // 1-2 series (e.g. spend vs revenue). A
  // single series (e.g. a cost-only page) renders as the Area alone.
  series: TimeseriesSeriesInput[]
  // 'count' formats the axis/tooltip as a plain integer
  // for the Tasks view — the metric picker switches this alongside the series.
  valueFormat: 'cost' | 'currency' | 'count'
  now?: Date
  /** Optional info-icon tooltip next to the title; absent renders the title alone. */
  titleTooltip?: { title: string; description: string; details?: string }
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// formatCost and formatCurrency take their precision arg differently
// (positional decimals vs. currency-then-precision) — this gives the chart
// ONE call shape for whichever canon formatter valueFormat selects. The
// exhaustive switch means a new valueFormat member is a compile error until
// it's handled here. `n` is deliberately not a money-named identifier so the
// count branch's toLocaleString doesn't trip the money-.toLocaleString guard
// (money-routing.test.ts) — counts are allowed, money is not.
function makeValueFormatter(valueFormat: 'cost' | 'currency' | 'count') {
  return (n: number, precision?: number) => {
    switch (valueFormat) {
      case 'currency':
        return formatCurrency(n, undefined, precision)
      case 'count':
        return n.toLocaleString()
      case 'cost':
        return formatCost(n, precision)
    }
  }
}

// One row per day bucket across ALL series — never skip a period on the
// axis even if one series has no value that day.
function mergeSeries(series: TimeseriesSeriesInput[]) {
  const byDate = new Map<string, Record<string, number>>()
  series.forEach((s, seriesIndex) => {
    s.points.forEach((point) => {
      const key = dayKey(point.date)
      const row = byDate.get(key) ?? {}
      row[`series${seriesIndex}`] = point.cost
      byDate.set(key, row)
    })
  })
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values }))
}

function TimeseriesTooltip({
  active,
  payload,
  label,
  series,
  formatValue,
}: {
  active?: boolean
  payload?: Array<{ dataKey: string; value: number }>
  label?: string
  series: TimeseriesSeriesInput[]
  formatValue: (n: number) => string
}) {
  if (!active || !payload?.length || !label) return null
  return (
    <div className='rounded-mf-inner border border-mf-bd bg-mf-card px-3 py-2 shadow-lg'>
      <p className='mb-1.5 text-[10.5px] font-medium text-mf-tx3'>
        {formatDisplayDate(label, 'MMM d, yyyy')}
      </p>
      {payload.map((entry) => {
        const seriesIndex = Number(entry.dataKey.replace('series', ''))
        const seriesColor =
          seriesIndex === 0 ? MF_SERIES.primary : MF_SERIES.secondary
        return (
          <div key={entry.dataKey} className='flex items-center gap-2 py-0.5'>
            <span
              className='h-2 w-2 rounded-sm'
              style={{ background: seriesColor }}
            />
            <span className='text-[11px] text-mf-tx2'>
              {series[seriesIndex]?.label}
            </span>
            <span className='ml-auto text-[11px] font-semibold text-mf-tx'>
              {formatValue(entry.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function TimeseriesChart({
  title,
  series,
  valueFormat,
  now,
  state,
  errorMessage,
  titleTooltip,
}: TimeseriesChartProps) {
  const merged = mergeSeries(series)
  const nowKey = now ? dayKey(now) : undefined
  const hasNowMarker =
    nowKey !== undefined && merged.some((row) => row.date === nowKey)
  const formatValue = makeValueFormatter(valueFormat)

  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      className='h-full min-h-[300px] px-[17px] pb-[13px] pt-[15px]'
      loadingLines={6}
      header={
        <div className='mb-[14px] flex items-center gap-3'>
          <div className='flex items-center gap-1.5'>
            <span className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
              {title}
            </span>
            {titleTooltip && (
              <InfoTooltip
                title={titleTooltip.title}
                description={titleTooltip.description}
                details={titleTooltip.details}
                iconSize='h-3 w-3'
              />
            )}
          </div>
          <div className='ml-auto flex items-center gap-[13px]'>
            {series.map((s, i) => (
              <span
                key={s.label}
                className='flex items-center gap-[5px] text-[11px] text-mf-tx2'
              >
                <span
                  className='h-2 w-2 rounded-sm'
                  style={{
                    background:
                      i === 0 ? MF_SERIES.primary : MF_SERIES.secondary,
                  }}
                />
                {s.label}
              </span>
            ))}
          </div>
        </div>
      }
    >
      <div className='h-[220px]'>
        <ResponsiveContainer width='100%' height='100%'>
          <ComposedChart
            data={merged}
            margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
          >
            <defs>
              <linearGradient id='mf-series-0-fill' x1='0' y1='0' x2='0' y2='1'>
                <stop
                  offset='0'
                  stopColor={MF_SERIES.primary}
                  stopOpacity={0.22}
                />
                <stop
                  offset='1'
                  stopColor={MF_SERIES.primary}
                  stopOpacity={0}
                />
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
                <TimeseriesTooltip series={series} formatValue={formatValue} />
              }
            />
            {series[0] && (
              <Area
                dataKey='series0'
                name={series[0].label}
                stroke={MF_SERIES.primary}
                strokeWidth={2}
                fill='url(#mf-series-0-fill)'
                dot={false}
                isAnimationActive={false}
              />
            )}
            {series[1] && (
              <Line
                dataKey='series1'
                name={series[1].label}
                stroke={MF_SERIES.secondary}
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
              />
            )}
            {hasNowMarker && (
              <ReferenceLine
                x={nowKey}
                stroke='var(--mf-tx3)'
                strokeDasharray='3 3'
                label={{
                  value: 'Now',
                  position: 'insideTopRight',
                  fill: 'var(--mf-tx3)',
                  fontSize: 10,
                }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </TileFrame>
  )
}
