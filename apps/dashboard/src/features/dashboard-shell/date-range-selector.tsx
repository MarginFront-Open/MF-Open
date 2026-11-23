'use client'

/**
 * The ONE page-scoped date-range control.
 * State lives in the URL (?startDate=&endDate=, plus an explicit
 * ?range=rolling marker for Rolling — date-range.ts's header explains why)
 * so views are shareable and saved-views round-trip unchanged. All mapping
 * logic is in date-range.ts (pure, unit-tested); this file is only chrome.
 */

import { Suspense, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { MONTH_OPTIONS } from '@/features/_shared/billing-period'
import { SegmentedControl } from './segmented-control'
import {
  nextUrlParams,
  selectionFromParams,
  selectionToPeriod,
  type DateRangeUrlParams,
} from './date-range'
import type {
  DateRangeConfig,
  DateRangeMode,
  DateRangeSelection,
} from './types'

const MODE_LABELS: Record<DateRangeMode, string> = {
  month: 'Month',
  rolling: 'Last 30 days',
  custom: 'Custom',
}

// py-1 leading-none override @tailwindcss/forms' 8px vertical padding and
// the global `select { line-height: 1.5 }` base rule (src/index.css) — both
// clip the 12px label inside this h-7 control otherwise.
const CONTROL_CLASS =
  'h-7 rounded-mf-seg-item border border-mf-bd bg-mf-card px-2 py-1 text-[12px] font-medium leading-none text-mf-tx'

export function DateRangeSelector({ config }: { config: DateRangeConfig }) {
  if (config.modes.length === 0) return null
  return (
    // useSearchParams needs a Suspense boundary during prerender; contain it
    // here so consuming pages don't each have to remember one.
    <Suspense fallback={null}>
      <DateRangeSelectorInner config={config} />
    </Suspense>
  )
}

function DateRangeSelectorInner({ config }: { config: DateRangeConfig }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const params: DateRangeUrlParams = {
    startDate: searchParams.get('startDate') ?? undefined,
    endDate: searchParams.get('endDate') ?? undefined,
    range: searchParams.get('range') ?? undefined,
  }
  const selection = selectionFromParams(params, config)
  // Which mode's controls to show while the user is mid-edit (e.g. Custom
  // picked but only one date filled in — nothing committed to the URL yet).
  const [draftMode, setDraftMode] = useState<DateRangeMode | null>(null)
  const activeMode = draftMode ?? selection?.mode ?? config.modes[0]
  const [draftStart, setDraftStart] = useState('')
  const [draftEnd, setDraftEnd] = useState('')

  const commit = (next: DateRangeSelection) => {
    const params = nextUrlParams(searchParams, next, config)
    setDraftMode(null)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const pickMode = (mode: DateRangeMode) => {
    if (mode === 'rolling') {
      commit({ mode: 'rolling' })
    } else if (mode === 'month') {
      commit({
        mode: 'month',
        monthsAgo: selection?.mode === 'month' ? selection.monthsAgo : 0,
      })
    } else {
      const current = selectionToPeriod(selection ?? { mode: 'rolling' })
      setDraftStart(current.startDate ?? '')
      setDraftEnd(current.endDate ?? '')
      setDraftMode('custom')
    }
  }

  const commitCustom = (startDate: string, endDate: string) => {
    setDraftStart(startDate)
    setDraftEnd(endDate)
    if (startDate && endDate) commit({ mode: 'custom', startDate, endDate })
  }

  return (
    <div className='flex items-center gap-1.5'>
      {config.modes.length > 1 && (
        <SegmentedControl
          ariaLabel='Date range'
          dataTour='date-range'
          options={config.modes.map((mode) => ({
            id: mode,
            label: MODE_LABELS[mode],
          }))}
          value={activeMode}
          onChange={pickMode}
        />
      )}

      {activeMode === 'month' && (
        <select
          aria-label='Billing period'
          className={CONTROL_CLASS}
          value={selection?.mode === 'month' ? selection.monthsAgo : 0}
          onChange={(e) =>
            commit({ mode: 'month', monthsAgo: Number(e.target.value) })
          }
        >
          {MONTH_OPTIONS.map((option) => (
            <option key={option.monthsAgo} value={option.monthsAgo}>
              {option.label}
              {option.monthsAgo === 0 ? ' (current)' : ''}
            </option>
          ))}
        </select>
      )}

      {activeMode === 'custom' && (
        <>
          <input
            type='date'
            aria-label='Start date'
            className={CONTROL_CLASS}
            value={
              draftMode === 'custom'
                ? draftStart
                : selection?.mode === 'custom'
                  ? selection.startDate
                  : draftStart
            }
            onChange={(e) =>
              commitCustom(
                e.target.value,
                draftMode === 'custom' || selection?.mode !== 'custom'
                  ? draftEnd
                  : selection.endDate
              )
            }
          />
          <span className='text-[11px] text-mf-tx3'>→</span>
          <input
            type='date'
            aria-label='End date'
            className={CONTROL_CLASS}
            value={
              draftMode === 'custom'
                ? draftEnd
                : selection?.mode === 'custom'
                  ? selection.endDate
                  : draftEnd
            }
            onChange={(e) =>
              commitCustom(
                draftMode === 'custom' || selection?.mode !== 'custom'
                  ? draftStart
                  : selection.startDate,
                e.target.value
              )
            }
          />
        </>
      )}
    </div>
  )
}
