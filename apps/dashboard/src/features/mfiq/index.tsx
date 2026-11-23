'use client'

/**
 * MF IQ: the bespoke four-card score page.
 *
 * ONE data path, one failure domain: getMfiqStatus (the composed five-read
 * action) feeds the pure deriveIqScore, which composes EVERYTHING rendered —
 * score, fixes, rule chips, recommendations, needs-attention items, subtitle.
 * Bespoke four-card grid: no tile grid, no date selector (the mfiq
 * date-range config offers no modes), no resolver, no writes, and no
 * URL-coupled state — hence no search-params hook and no prerender-boundary
 * wrapper. (The page-composition greps ban those identifiers anywhere in
 * this file, comments included — hence the roundabout wording.)
 *
 * Honesty: an action failure renders all four cards in state='error' with
 * the action's message — a failed compose is never an empty 10/10. A null
 * score (some rule has no data) renders '— / 10' plus the unknown-count
 * line, never 0/10 or a fake Pass.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PageShell } from '@/features/dashboard-shell/page-shell'
import { PAGE_DATE_RANGE } from '@/features/dashboard-shell/default-layouts'
import { Gauge } from '@/features/dashboard-shell/tiles/gauge'
import { AlertList } from '@/features/dashboard-shell/tiles/alert-list'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import { getMfiqStatus, type MfiqFacts } from '@/app/actions/mfiq-status'
import {
  getCustomerAlertNotifications,
  markCustomerAlertNotificationsRead,
} from '@/app/actions/customer-alert-notifications'
import { UNREAD_CUSTOMER_ALERT_QUERY_KEY } from '@/services/customer-alerts-service'
import type { AlertListItem } from '@/features/dashboard-shell/tiles/alert-list'
import { buildCustomerAlertItems } from './customer-alert-items'
import { deriveIqScore } from './iq-derivation'
import { RulesList } from './components/rules-list'

const PAGE = 'mfiq' as const

const MFIQ_ERROR =
  "Couldn't load the MFiQ score. The request failed before it reached the server. Check your connection and refresh to try again."

const WATCH_ERROR =
  "Couldn't load your customer alerts. The request failed before it reached the server. Refresh to try again."

const CARD_SPAN = 'col-span-12 sm:col-span-6 lg:col-span-4'

export default function Mfiq() {
  const [facts, setFacts] = useState<MfiqFacts | null>(null)
  const [state, setState] = useState<TileState>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  // The customer-alerts card is its OWN failure domain and its own
  // fetch (the page-composition contract keeps getMfiqStatus a single-purpose
  // read). Items arrive pre-composed from customer-alert-items.ts.
  const [watchItems, setWatchItems] = useState<AlertListItem[]>([])
  const [watchState, setWatchState] = useState<TileState>('loading')
  const [watchError, setWatchError] = useState<string | undefined>(undefined)
  const queryClient = useQueryClient()

  useEffect(() => {
    let cancelled = false
    getMfiqStatus()
      .then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          setFacts(result.data)
          setState('ready')
        } else {
          setState('error')
          setError(result.error ?? MFIQ_ERROR)
        }
      })
      .catch(() => {
        if (cancelled) return
        setState('error')
        setError(MFIQ_ERROR)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    getCustomerAlertNotifications()
      .then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          setWatchItems(buildCustomerAlertItems(result.data))
          setWatchState('ready')
          // Opening the page counts as reading: clear unread server-side,
          // then refresh the sidebar badge so it drops without a poll wait.
          if (result.data.some((row) => row.readAt === null)) {
            void markCustomerAlertNotificationsRead().then(() =>
              queryClient.invalidateQueries({
                queryKey: UNREAD_CUSTOMER_ALERT_QUERY_KEY,
              })
            )
          }
        } else {
          setWatchState('error')
          setWatchError(result.error ?? WATCH_ERROR)
        }
      })
      .catch(() => {
        if (cancelled) return
        setWatchState('error')
        setWatchError(WATCH_ERROR)
      })
    return () => {
      cancelled = true
    }
  }, [queryClient])

  const derived = useMemo(
    () => (facts ? deriveIqScore(facts, new Date()) : null),
    [facts]
  )

  // The honesty line rides the label slot so the gauge component itself
  // stays copy-free.
  const gaugeLabel =
    derived && derived.score === null
      ? `Financial hygiene · ${derived.unknownCount} rule${
          derived.unknownCount === 1 ? ' has' : 's have'
        } no data`
      : 'Financial hygiene'

  return (
    <PageShell
      page={PAGE}
      title='MFiQ'
      subtitle={derived?.subtitle}
      dateRange={PAGE_DATE_RANGE[PAGE]}
      editable={false}
    >
      <div className='grid grid-cols-12 gap-3'>
        <div className={CARD_SPAN}>
          <Gauge
            title='MFiQ'
            value={derived ? derived.score : null}
            max={10}
            label={gaugeLabel}
            fixes={derived?.fixes}
            badge='Rules-based. $0 in tokens.'
            state={state}
            errorMessage={error}
          />
        </div>
        <div className={CARD_SPAN}>
          <RulesList
            title='Rules'
            rules={derived?.rules ?? []}
            state={state}
            errorMessage={error}
          />
        </div>
        <div className={CARD_SPAN}>
          <AlertList
            title='Recommendations'
            items={derived?.recommendations ?? []}
            state={
              state === 'ready' && (derived?.recommendations.length ?? 0) === 0
                ? 'empty'
                : state
            }
            errorMessage={error}
            emptyMessage='No recommendations. Your books are clean.'
          />
        </div>
        <div className={CARD_SPAN}>
          <AlertList
            title='Needs attention'
            tooltipKey='needsAttention'
            items={derived?.needsAttention ?? []}
            state={
              state === 'ready' && (derived?.needsAttention.length ?? 0) === 0
                ? 'empty'
                : state
            }
            errorMessage={error}
            emptyMessage='Nothing needs attention'
          />
        </div>
        <div className={CARD_SPAN}>
          <AlertList
            title='Customer alerts'
            items={watchItems}
            state={
              watchState === 'ready' && watchItems.length === 0
                ? 'empty'
                : watchState
            }
            errorMessage={watchError}
            emptyMessage='No customer watches have fired'
          />
        </div>
      </div>
    </PageShell>
  )
}
