'use server'

/**
 * Answers exactly one question: has this org EVER
 * ingested a usage event? Deliberately NOT windowed (unlike the resolver's
 * per-page eventCount, which only covers the page's selected date range) —
 * a brand-new org and a churned one-year-old org can both show 0 events in
 * "this month," but only the former should see the Getting Started nudge.
 *
 * Cheapest possible read: an indexed existence check (findFirst + select id,
 * take 1 implied) on raw_ingest_events.organizationId — no aggregation, no
 * heavy new query. raw_ingest_events is checked (not signal_events) because
 * it records every ingest attempt, including ones that failed enrichment;
 * an org that has tried and failed still needs the "you're set up, wrong
 * problem now" signal from Needs-attention, not the "you haven't started"
 * nudge.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'

export async function getHasIngestedFirstEvent(): Promise<{
  success: boolean
  hasEvents?: boolean
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'Not authenticated' }
    }
    const orgId = session.session.activeOrganizationId

    const firstEvent = await db.raw_ingest_events.findFirst({
      where: { organizationId: orgId },
      select: { id: true },
    })

    return { success: true, hasEvents: firstEvent !== null }
  } catch (error) {
    console.error('[getHasIngestedFirstEvent] Error:', error)
    return { success: false, error: 'Failed to check event status' }
  }
}
