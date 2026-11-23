'use client'

/**
 * The shared events table plus the page-level
 * EventStream wrapper. The agent drill-in renders EventsTable for the
 * agent's recent events; EventStream below wraps the SAME component
 * with its own window-bounded fetch, honest count header, and View-all
 * footer. Row click deep-links to /metrics-events/raw-events?eventId= — the
 * protected deep-link contract — which auto-opens the full detail
 * sidebar, so this table never rebuilds one.
 */

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { formatCost } from '@/lib/canon-format'
import {
  TileFrame,
  type TileState,
  type TileStateProps,
} from '@/features/dashboard-shell/tiles/tile-frame'
import { getSignalEvents, type SignalEvent } from '@/app/actions/signal-events'
import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'
import { EVENT_STATUS_CHIPS, eventModelLabel } from './status-maps'

const HEADER_CELL =
  'pb-2 pt-[14px] text-left text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'

export interface EventsTableProps extends TileStateProps {
  events: SignalEvent[]
}

export function EventsTable({ events, state, errorMessage }: EventsTableProps) {
  const router = useRouter()
  const effectiveState =
    state === 'ready' && events.length === 0 ? 'empty' : state

  return (
    <TileFrame
      state={effectiveState}
      errorMessage={errorMessage}
      emptyMessage='No events in this window'
      className='min-h-[120px] overflow-hidden'
      loadingLines={4}
    >
      <table className='w-full border-collapse'>
        <thead>
          <tr>
            <th className={`${HEADER_CELL} px-[17px]`}>Time</th>
            <th className={`${HEADER_CELL} px-[10px]`}>Agent</th>
            <th className={`${HEADER_CELL} px-[10px]`}>Model</th>
            <th className={`${HEADER_CELL} px-[10px]`}>Cost</th>
            <th className={`${HEADER_CELL} px-[17px]`}>Status</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const chip = EVENT_STATUS_CHIPS[event.eventProcessed]
            return (
              <tr
                key={event.id}
                onClick={() =>
                  router.push(`/metrics-events/raw-events?eventId=${event.id}`)
                }
                className='cursor-pointer border-t border-mf-bd2 hover:bg-mf-card2'
              >
                <td className='px-[17px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                  {format(new Date(event.usageDate), 'MMM d · HH:mm')}
                </td>
                <td className='px-[10px] py-[7px] text-[12px] text-mf-tx'>
                  {event.agent?.name ?? '—'}
                </td>
                <td className='px-[10px] py-[7px] text-[12px] text-mf-tx2'>
                  {eventModelLabel(event.services)}
                </td>
                <td className='px-[10px] py-[7px] text-[12px] tabular-nums text-mf-tx2'>
                  {event.usageCost === null ? '—' : formatCost(event.usageCost)}
                </td>
                <td className='px-[17px] py-[7px]'>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${chip.className}`}
                  >
                    {chip.label}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TileFrame>
  )
}

const EVENT_STREAM_LIMIT = 8

const STREAM_ERROR =
  "Couldn't load the event stream. This section failed to load, but the rest of the page is fine. Refresh the page to try again."

export interface EventStreamProps {
  period: { startDate?: string; endDate?: string }
}

/**
 * The page-level event stream: the org's latest events for the
 * page's window, capped at 8 with the honest total in the header — full
 * lists live on /metrics-events/raw-events, one click away in the footer.
 */
export function EventStream({ period }: EventStreamProps) {
  const { startDate, endDate } = period

  const [events, setEvents] = useState<SignalEvent[]>([])
  const [totalResults, setTotalResults] = useState<number | null>(null)
  const [state, setState] = useState<TileState>('loading')
  const [, startEventsFetch] = useTransition()

  useEffect(() => {
    let cancelled = false
    startEventsFetch(async () => {
      setState('loading')
      try {
        // ALWAYS send concrete bounds. Rolling mode's period is {} and
        // getSignalEvents applies its usageDate predicate only when a bound
        // is present, so raw passthrough would make
        // totalResults an ALL-TIME unindexed count under a "this window"
        // header. parseWindowFilter is the resolver's own derivation, and it
        // re-parses full-ISO strings verbatim, so the server-side re-parse
        // of these values is idempotent.
        const { windowStart, windowEnd } = parseWindowFilter({
          startDate,
          endDate,
        })
        const result = await getSignalEvents({
          limit: EVENT_STREAM_LIMIT,
          startDate: windowStart.toISOString(),
          endDate: windowEnd.toISOString(),
          sortBy: 'usageDate',
          sortOrder: 'desc',
        })
        if (cancelled) return
        if (result.success && result.data) {
          setEvents(result.data.results)
          setTotalResults(result.data.totalResults)
          setState('ready')
        } else {
          setState('error')
        }
      } catch {
        if (cancelled) return
        setState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [startDate, endDate])

  return (
    <section>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <h2 className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx'>
          Event stream
        </h2>
        {state === 'ready' && totalResults !== null && (
          <span className='text-[11px] font-medium text-mf-tx3'>
            Last {events.length} of {totalResults.toLocaleString()} this window
          </span>
        )}
      </div>
      <EventsTable events={events} state={state} errorMessage={STREAM_ERROR} />
      <div className='mt-2 text-right'>
        <Link
          href='/metrics-events/raw-events'
          className='text-[11.5px] font-medium text-mf-tx3 hover:text-mf-accent'
        >
          View all →
        </Link>
      </div>
    </section>
  )
}
