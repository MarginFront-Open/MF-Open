'use client'

/**
 * The first-event empty-state nudge.
 * Auto-hides itself for good the moment the org's first event lands, so a
 * live customer never sees it again: fetches getHasIngestedFirstEvent ONCE
 * and renders nothing until that resolves `hasEvents: false`. A local-only
 * dismiss (no persisted state, no new write path) lets a still-zero-event
 * session close it without re-fetching; it comes back on the next page
 * load for as long as the org really has zero events.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { getHasIngestedFirstEvent } from '@/app/actions/getting-started-status'

export function GettingStartedNudge({
  description = 'Nothing has landed yet. Connect the MCP server, SDK, or REST API to see your first usage event show up here.',
  hasEvents: givenHasEvents,
}: {
  // Per-surface copy: Build keeps the default; Unit Economics speaks to the
  // internal-AI-spend persona that lands there by default.
  description?: string
  /** The answer, when the page already asked. Omitted elsewhere, where this
   * component still asks for itself. */
  hasEvents?: boolean | null
}) {
  const asksItself = givenHasEvents === undefined
  const [fetchedHasEvents, setFetchedHasEvents] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!asksItself) return
    let cancelled = false
    getHasIngestedFirstEvent().then((result) => {
      if (cancelled) return
      // Fail-quiet: only an explicit false shows the nudge, never a guess.
      setFetchedHasEvents(result.success ? (result.hasEvents ?? null) : null)
    })
    return () => {
      cancelled = true
    }
  }, [asksItself])

  const hasEvents = asksItself ? fetchedHasEvents : givenHasEvents

  if (hasEvents !== false || dismissed) return null

  return (
    <div
      data-tour='getting-started-nudge'
      className='flex items-center gap-3 rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-3'
    >
      <div className='min-w-0 flex-1'>
        <p className='text-[12.5px] font-semibold text-mf-tx'>
          Get started: send your first event
        </p>
        <p className='mt-1 text-[11.5px] text-mf-tx2'>{description}</p>
      </div>
      <Link
        href='/developer-zone/getting-started'
        className='shrink-0 rounded-mf-seg-item bg-mf-accent px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:opacity-90'
      >
        Get started
      </Link>
      <button
        type='button'
        onClick={() => setDismissed(true)}
        aria-label='Dismiss'
        className='shrink-0 text-mf-tx3 hover:text-mf-tx'
      >
        <X className='h-4 w-4' />
      </button>
    </div>
  )
}
