import Link from 'next/link'
import {
  CONTENT_TILE_CLASS,
  TileFrame,
  type TileStateProps,
} from './tile-frame'
import { TileHeader } from './tile-header'

export interface GaugeFix {
  label: string
  points: number
  href?: string
}

export interface GaugeProps extends TileStateProps {
  title: string
  // null = honestly unknowable — renders '— / max', NEVER 0/max.
  value: number | null
  max: number
  label: string
  fixes?: GaugeFix[]
  badge?: string
}

const RADIUS = 36
const STROKE_WIDTH = 9
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function Gauge({
  title,
  value,
  max,
  label,
  fixes,
  badge,
  state,
  errorMessage,
}: GaugeProps) {
  const fraction =
    value !== null && max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const dashArray = `${(fraction * CIRCUMFERENCE).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`

  return (
    <TileFrame
      state={state}
      errorMessage={errorMessage}
      className={CONTENT_TILE_CLASS}
      loadingLines={4}
      header={<TileHeader label={title} />}
    >
      <div className='mt-3 flex items-center gap-[13px]'>
        <svg
          viewBox='0 0 88 88'
          width={66}
          height={66}
          className='shrink-0 -rotate-90'
        >
          <circle
            cx={44}
            cy={44}
            r={RADIUS}
            fill='none'
            stroke='var(--mf-barbg)'
            strokeWidth={STROKE_WIDTH}
          />
          <circle
            cx={44}
            cy={44}
            r={RADIUS}
            fill='none'
            stroke='var(--mf-accent)'
            strokeWidth={STROKE_WIDTH}
            strokeLinecap='round'
            strokeDasharray={dashArray}
          />
        </svg>
        <div>
          <div className='text-[18px] font-semibold text-mf-tx'>
            {value ?? '—'}{' '}
            <span className='text-[12px] font-normal text-mf-tx3'>/ {max}</span>
          </div>
          <div className='mt-[2px] text-[11px] text-mf-tx3'>{label}</div>
        </div>
      </div>
      {fixes && fixes.length > 0 && (
        <div className='flex flex-col'>
          <div className='mb-2 mt-[15px] text-[9px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
            {fixes.length} {fixes.length === 1 ? 'fix' : 'fixes'}
            {/* A null score has no honest "reach" target — count only. */}
            {value !== null &&
              ` to reach ${Math.min(max, value + fixes.reduce((sum, f) => sum + f.points, 0))}`}
          </div>
          {fixes.map((fix) => (
            <div
              key={fix.label}
              className='flex items-center gap-[9px] py-[5px]'
            >
              {fix.href ? (
                <Link
                  href={fix.href}
                  className='flex-1 text-[12px] text-mf-tx2 hover:text-mf-accent'
                >
                  {fix.label}
                </Link>
              ) : (
                <span className='flex-1 text-[12px] text-mf-tx2'>
                  {fix.label}
                </span>
              )}
              <span className='text-[11px] font-semibold text-mf-accent'>
                +{fix.points}
              </span>
            </div>
          ))}
        </div>
      )}
      {badge && (
        <span className='mt-[15px] inline-block rounded-full border border-mf-bd bg-mf-card2 px-2 py-0.5 text-[10.5px] font-medium text-mf-tx3'>
          {badge}
        </span>
      )}
    </TileFrame>
  )
}
