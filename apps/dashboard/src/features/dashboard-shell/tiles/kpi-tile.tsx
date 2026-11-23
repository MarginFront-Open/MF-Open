import {
  TILE_METRIC_REGISTRY,
  type TileMetric,
  type TooltipKey,
} from '@/lib/component-catalog'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { formatPct } from '@/lib/canon-format'
import type { CostByDayRow } from '../types'
import { TileFrame, type TileStateProps } from './tile-frame'
import { TileHeader } from './tile-header'
import { formatMetric } from './format-metric'

export interface KpiTileDelta {
  value: number | null
  // Which direction of change is good for THIS metric — up for revenue,
  // down for cost. The arrow color follows from this, not a hardcoded sign.
  direction: 'up-good' | 'down-good'
  // Required: every delta names its comparison window explicitly
  // (a bare "vs prev" is unrepresentable because the window is never guessed).
  comparisonLabel: string
}

export interface KpiTileProps extends TileStateProps {
  metric: TileMetric
  value: number | null
  delta?: KpiTileDelta
  subtext?: string
  spark?: CostByDayRow[]
  // Optional overrides (same contract as DimensionedSection's
  // showChart): absent = registry defaults. They
  // exist for surfaces where the metric's registry copy is dishonest — an
  // agent row's margin is earned-basis, not the org-wide 'Net margin' whose
  // tooltip claims subscription/seat fees are included.
  tooltipKey?: TooltipKey
  label?: string
}

// Bad-direction deltas render amber (caution), not red — red is reserved for
// alert-list/gauge severity elsewhere in the catalog. A flat (zero) delta is
// neutral. See kpi-tile fixture Cost (▲4.2%, down-good) for the amber case.
function deltaColorClass(value: number, direction: 'up-good' | 'down-good') {
  if (value === 0) return 'text-mf-tx3'
  const isUp = value > 0
  const isGood = direction === 'up-good' ? isUp : !isUp
  return isGood ? 'text-mf-green' : 'text-mf-amber'
}

function sparkPoints(data: CostByDayRow[]): string {
  if (data.length < 2) return ''
  const values = data.map((d) => d.cost)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = 200 / (data.length - 1)
  return values
    .map((v, i) => {
      const x = i * stepX
      const y = 22 - ((v - min) / range) * 18
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

export function KpiTile({
  metric,
  value,
  delta,
  subtext,
  spark,
  state,
  errorMessage,
  tooltipKey,
  label,
}: KpiTileProps) {
  const registryEntry = TILE_METRIC_REGISTRY[metric]
  const tooltip = tooltipDefinitions[tooltipKey ?? registryEntry.tooltipKey]
  const points = spark ? sparkPoints(spark) : ''

  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      // Fixed height, not min-h: the KPI row must stay uniform whether a
      // tile carries a spark, a delta, a subtext, or none.
      className='flex h-[146px] flex-col px-[15px] py-[14px]'
      loadingLines={2}
      header={
        <TileHeader label={label ?? registryEntry.label} tooltip={tooltip} />
      }
    >
      <div className='mt-[9px] text-[23px] font-semibold tracking-[-.02em] text-mf-tx'>
        {formatMetric(metric, value)}
      </div>
      {delta && (
        <div className='mt-[5px] flex items-center gap-[5px]'>
          <span
            className={`text-[11px] font-medium ${
              delta.value === null
                ? 'text-mf-tx3'
                : deltaColorClass(delta.value, delta.direction)
            }`}
          >
            {delta.value === null
              ? '—'
              : `${delta.value > 0 ? '▲' : delta.value < 0 ? '▼' : '·'} ${formatPct(Math.abs(delta.value))}`}
          </span>
          <span className='text-[11px] text-mf-tx3'>
            {delta.comparisonLabel}
          </span>
        </div>
      )}
      {!delta && subtext && (
        <div className='mt-[5px] text-[11px] font-medium text-mf-tx2'>
          {subtext}
        </div>
      )}
      {points && (
        // preserveAspectRatio='none' + fixed h-6: without it the spark's
        // height tracks the column width, so KPI cards would measure
        // differently at every span/breakpoint. mt-auto pins it to the card's bottom
        // edge.
        <svg
          viewBox='0 0 200 24'
          preserveAspectRatio='none'
          className='mt-auto block h-6 w-full overflow-visible'
        >
          <polyline
            points={points}
            fill='none'
            stroke='var(--mf-tx3)'
            strokeWidth={1.5}
            strokeLinecap='round'
            strokeLinejoin='round'
            vectorEffect='non-scaling-stroke'
          />
        </svg>
      )}
    </TileFrame>
  )
}
