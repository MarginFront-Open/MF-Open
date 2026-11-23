import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { formatCost } from '@/lib/canon-format'
import { MF_CHART_COLORS } from '../chart-colors'
import type { ResolvedBreakdownOther, ResolvedBreakdownRow } from '../types'
import {
  CONTENT_TILE_CLASS,
  TileFrame,
  type TileStateProps,
} from './tile-frame'
import { TileHeader } from './tile-header'

export interface CategoryDonutProps extends TileStateProps {
  title: string
  rows: ResolvedBreakdownRow[]
  other: ResolvedBreakdownOther | null
  // Which per-bucket value the slices show. 'revenue' is only ever passed for
  // revenue-definable dimensions (the caller gates on revenueBasis), where
  // every row carries a numeric revenue; a missing/undefined revenue reads $0.
  valueMode?: 'cost' | 'revenue'
  // How many buckets `other` folds in — optional because getCostBreakdown's
  // CostBreakdownOther carries only {cost, eventCount}, not a bucket count.
  // When the caller has it (totalRowCount - rows.length), pass it through
  // for an "Other · N more" label; otherwise this renders "Other".
  otherCount?: number
  // Default: an unlabeled bucket (null key — orphan agent/customer/etc.)
  // reads as "Unassigned", never dropped or blank.
  resolveLabel?: (key: string | null) => string
}

const defaultResolveLabel = (key: string | null) => key ?? 'Unassigned'

function DonutTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ name: string; value: number }>
}) {
  if (!active || !payload?.length) return null
  const entry = payload[0]
  return (
    <div className='rounded-mf-inner border border-mf-bd bg-mf-card px-3 py-2 shadow-lg'>
      <p className='text-[11px] text-mf-tx2'>{entry.name}</p>
      <p className='text-[12px] font-semibold text-mf-tx'>
        {formatCost(entry.value)}
      </p>
    </div>
  )
}

export function CategoryDonut({
  title,
  rows,
  other,
  otherCount,
  resolveLabel = defaultResolveLabel,
  valueMode = 'cost',
  state,
  errorMessage,
}: CategoryDonutProps) {
  const valueOf = (bucket: { cost: number; revenue?: number }): number =>
    valueMode === 'revenue' ? (bucket.revenue ?? 0) : bucket.cost
  const slices = [
    ...rows.map((row) => ({
      name: resolveLabel(row.key),
      value: valueOf(row),
    })),
    ...(other
      ? [
          {
            name: otherCount ? `Other · ${otherCount} more` : 'Other',
            value: valueOf(other),
          },
        ]
      : []),
  ]

  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      className={CONTENT_TILE_CLASS}
      loadingLines={4}
      header={<TileHeader label={title} />}
    >
      <div className='mt-3 flex flex-wrap items-center gap-[14px]'>
        <div className='h-[108px] w-[108px] shrink-0'>
          <ResponsiveContainer width='100%' height='100%'>
            <PieChart>
              <Pie
                data={slices}
                dataKey='value'
                nameKey='name'
                cx='50%'
                cy='50%'
                innerRadius={38}
                outerRadius={52}
                strokeWidth={0}
                isAnimationActive={false}
              >
                {slices.map((slice, i) => (
                  <Cell
                    key={slice.name}
                    fill={MF_CHART_COLORS[i % MF_CHART_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip content={<DonutTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className='flex flex-1 flex-col gap-[9px]'>
          {slices.map((slice, i) => (
            <div key={slice.name} className='flex items-center gap-[7px]'>
              <span
                className='h-2 w-2 shrink-0 rounded-sm'
                style={{
                  background: MF_CHART_COLORS[i % MF_CHART_COLORS.length],
                }}
              />
              <span className='flex-1 text-[12px] text-mf-tx2'>
                {slice.name}
              </span>
              <span className='text-[12px] font-medium text-mf-tx'>
                {formatCost(slice.value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </TileFrame>
  )
}
