'use client'

/**
 * One initiative's detail
 * view at /roi/[initiativeId]. Same doctrine as the ROI page: ONE data path
 * (getInitiativeDetail, which composes the same buildInitiativeView the
 * cards read), every rendered number comes from the progress-derivation
 * copy builders, nothing re-derived here. Read-only: edits, archive, and
 * delete stay on the ROI page's cards.
 */

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { PageShell } from '@/features/dashboard-shell/page-shell'
import { ROI_DETAIL_DATE_RANGE } from '@/features/dashboard-shell/default-layouts'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import {
  getInitiativeDetail,
  type RoiInitiativeDetail,
} from '@/app/actions/roi-initiative-detail'
import type { RoiTargetView } from '@/app/actions/roi-overview'
import { formatDisplayDate } from '@/lib/canon-date'
import { cn } from '@/lib/utils'
import {
  INITIATIVE_METRIC_META,
  baselineLabel,
  displayProgressPct,
  formatMetricValue,
  goalProgressSentence,
  goalSentence,
  matterScopeLabel,
  progressLabel,
} from './progress-derivation'
import { AUTO_BASELINE_SUPPORTED } from './baseline-derivation'
import { HEALTH_PILLS, progressFillClass } from './components/status-maps'
import { TargetTrendChart } from './components/target-trend-chart'

const PAGE = 'roi' as const

const DETAIL_ERROR =
  "Couldn't load this goal. The request failed before it reached the server. Check your connection and refresh to try again."

function windowLabel(startDate: string, endDate: string | null): string {
  const start = formatDisplayDate(startDate)
  if (!endDate) return `Started ${start} · ongoing`
  return `${start} – ${formatDisplayDate(endDate)}`
}

function startedAtNote(target: RoiTargetView): string {
  if (!AUTO_BASELINE_SUPPORTED[target.metric]) {
    return 'No history exists to measure this one. Add a starting value on the edit screen if you know it.'
  }
  return "Not measured yet. Re-save this goal on the ROI page and we'll measure it from your data."
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-[10.5px] font-medium uppercase tracking-[.02em] text-mf-tx3'>
        {label}
      </span>
      <span className='text-[13px] font-semibold tabular-nums text-mf-tx'>
        {value}
      </span>
    </div>
  )
}

export default function InitiativeDetail({
  initiativeId,
}: {
  initiativeId: string
}) {
  const [detail, setDetail] = useState<RoiInitiativeDetail | null>(null)
  const [state, setState] = useState<TileState>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  const [, startFetch] = useTransition()

  useEffect(() => {
    let cancelled = false
    startFetch(async () => {
      setState('loading')
      try {
        const result = await getInitiativeDetail(initiativeId)
        if (cancelled) return
        if (result.success && result.data) {
          setDetail(result.data)
          setState('ready')
          setError(undefined)
        } else {
          setState('error')
          setError(result.error ?? DETAIL_ERROR)
        }
      } catch {
        if (cancelled) return
        setState('error')
        setError(DETAIL_ERROR)
      }
    })
    return () => {
      cancelled = true
    }
  }, [initiativeId])

  const view = detail?.view ?? null
  const pill = view ? HEALTH_PILLS[view.health] : null
  const matterScope = view ? matterScopeLabel(view) : null

  return (
    <PageShell
      page={PAGE}
      title={view ? view.name : 'Goal'}
      subtitle={view ? windowLabel(view.startDate, view.endDate) : undefined}
      dateRange={ROI_DETAIL_DATE_RANGE}
      editable={false}
      headerExtras={
        <Link
          href='/roi'
          className='inline-flex h-7 items-center rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
        >
          Back to ROI
        </Link>
      }
    >
      {state === 'error' ? (
        <TileFrame
          state='error'
          errorMessage={error}
          className='min-h-[120px] px-[17px] py-[14px]'
        >
          <div />
        </TileFrame>
      ) : state === 'loading' || !view ? (
        <div className='flex flex-col gap-3'>
          {[0, 1].map((i) => (
            <TileFrame
              key={i}
              state='loading'
              loadingLines={4}
              className='min-h-[140px] px-[17px] py-[14px]'
            >
              <div />
            </TileFrame>
          ))}
        </div>
      ) : (
        <div className='flex flex-col gap-3'>
          <section className='flex flex-col gap-2.5 rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-[14px]'>
            <div className='flex items-start justify-between gap-2'>
              <h2 className='text-[12.5px] font-semibold tracking-[-.01em] text-mf-tx'>
                About this goal
              </h2>
              {pill && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${pill.className}`}
                >
                  {pill.label}
                </span>
              )}
            </div>
            <p className='text-[11.5px] text-mf-tx2'>
              {view.description ??
                'No description yet. Edit this goal on the ROI page to add one for the board.'}
            </p>
            {matterScope && (
              <p className='text-[11px] text-mf-tx3'>{matterScope}</p>
            )}
            <div className='flex flex-wrap gap-6'>
              <Stat
                label='Start date'
                value={formatDisplayDate(view.startDate)}
              />
              <Stat
                label='End date'
                value={
                  view.endDate ? formatDisplayDate(view.endDate) : 'Ongoing'
                }
              />
              <Stat
                label='Status'
                value={view.status === 'archived' ? 'Archived' : 'Active'}
              />
            </div>
          </section>

          {view.targets.length === 0 && (
            <TileFrame
              state='ready'
              className='min-h-[80px] px-[17px] py-[14px]'
            >
              <p className='text-[11.5px] text-mf-tx3'>
                No target set yet. Edit this goal on the ROI page to add one,
                and progress tracks from your real numbers.
              </p>
            </TileFrame>
          )}

          {view.targets.map((target) => {
            const series = detail?.seriesByTargetId[target.id] ?? null
            const meta = INITIATIVE_METRIC_META[target.metric]
            const shownPct = displayProgressPct(target)
            return (
              <section
                key={target.id}
                className='flex flex-col gap-2.5 rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-[14px]'
              >
                <div className='flex items-baseline justify-between gap-2'>
                  <h2 className='text-[12.5px] font-semibold tracking-[-.01em] text-mf-tx'>
                    {goalSentence(target)}
                  </h2>
                  <span className='text-[12.5px] font-semibold tabular-nums text-mf-tx'>
                    {progressLabel(shownPct)}
                  </span>
                </div>
                <div className='h-1.5 overflow-hidden rounded-full bg-mf-card2'>
                  <div
                    className={cn(
                      'h-full rounded-full',
                      progressFillClass(view.health)
                    )}
                    style={{ width: `${shownPct ?? 0}%` }}
                  />
                </div>
                <div className='flex flex-wrap gap-6'>
                  <Stat
                    label={baselineLabel(target.metric, view.endDate)}
                    value={formatMetricValue(target.metric, target.baseline)}
                  />
                  <Stat
                    label='Current'
                    value={formatMetricValue(target.metric, target.actual)}
                  />
                  <Stat
                    label='Target'
                    value={formatMetricValue(target.metric, target.targetValue)}
                  />
                </div>
                {target.baseline === null && (
                  <p className='text-[11px] text-mf-tx3'>
                    {startedAtNote(target)}
                  </p>
                )}
                <p className='text-[11px] text-mf-tx3'>
                  {goalProgressSentence(target, view.elapsedPct)}
                </p>
                {series && series.length > 0 ? (
                  <TargetTrendChart
                    points={series}
                    format={meta.format}
                    label={meta.label}
                  />
                ) : (
                  <p className='text-[11px] text-mf-tx3'>
                    {series === null
                      ? 'No day-by-day history exists for this metric, so there is no trend to chart. These numbers still track from your real data.'
                      : 'Nothing recorded in this window yet. The trend chart draws itself as events land.'}
                  </p>
                )}
              </section>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}
