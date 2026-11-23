'use server'

/**
 * FinOps close status — the ONE read action the
 * FinOps page calls for everything close-related. It COMPOSES the four
 * existing close-engine reads (getPeriodLockStatus, getDefensibilityScore,
 * getJournalExport, getMismatchedSignalCount) — no new SQL, never the metrics
 * resolver, no re-derived sums. Period-lock correctness is inherited: for a closed
 * window, getDefensibilityScore and getJournalExport serve their frozen
 * snapshots, so a closed month's facts are the posted numbers automatically.
 *
 * The checklist/tile DERIVATION from these facts is pure and lives in
 * src/features/finops/close-derivation.ts (importable, unit-testable) — a
 * 'use server' file may only export async functions.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import {
  getPeriodLockStatus,
  type PeriodLockStatus,
} from './finance-period-lock'
import { getDefensibilityScore } from './finance-metrics'
import { getJournalExport, type JournalExport } from './journal-export'
import { getMismatchedSignalCount } from './chart-of-accounts'
import {
  parseWindowFilter,
  formatWindowLabel,
} from './_shared/parse-window-filter'
import {
  monthPeriod,
  monthsAgoFromDates,
} from '@/features/_shared/billing-period'

// Direct type DECLARATIONS in a 'use server' file are safe (they erase at
// build — metrics-resolver.ts does the same); only type RE-exports crash the
// action bundle at runtime.
export interface CloseStatusFacts {
  /** monthPeriod label ("June 2026") when the window is a clean calendar month; formatWindowLabel otherwise. */
  monthLabel: string
  /** DefensibilityScore.totalCost. */
  totalCost: number
  /** Sum of the journal rows' eventCount — every event in the window books to exactly one row. */
  eventCount: number
  /** DefensibilityScore.unclassifiedCost — dollars still UNCLASSIFIED. */
  unclassifiedCost: number
  /** JournalExport.unmappedAmount — dollars in the __unmapped bucket. */
  unmappedAmount: number
  /** JournalExport.unmappedSignalCount, or null when the window's frozen snapshot doesn't carry the field. */
  unmappedSignalCount: number | null
  /** DefensibilityScore.classifiedShare, 0–1. Null on a zero-cost window (canon M1). */
  classifiedShare: number | null
  /** getMismatchedSignalCount().count — CURRENT-STATE, not windowed (like Overdue). */
  mismatchedSignalCount: number
  /** Lock state for this exact window — drives checklist step 5, banner, button states. */
  lock: PeriodLockStatus
  /** The journal the preview section renders — frozen when locked, live otherwise. */
  journal: JournalExport
}

/**
 * Read every close-engine fact for one period window in one round trip.
 * parseWindowFilter semantics; FinOps always passes monthPeriod() bounds.
 * Auth/org scoping happens inside every composed read — this action only
 * adds a session-presence check for its own error shape.
 */
export async function getFinopsCloseStatus(period: {
  startDate?: string
  endDate?: string
}): Promise<{ success: boolean; data?: CloseStatusFacts; error?: string }> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const { windowStart, windowEnd } = parseWindowFilter(period)
    const [lock, score, journal, mismatched] = await Promise.all([
      // getPeriodLockStatus requires both bounds; when the caller omitted one,
      // pass the resolved window's full ISO timestamps (parseWindowFilter
      // treats those identically, so the lock lookup stays consistent).
      getPeriodLockStatus({
        startDate: period.startDate ?? windowStart.toISOString(),
        endDate: period.endDate ?? windowEnd.toISOString(),
      }),
      getDefensibilityScore(period),
      getJournalExport(period),
      getMismatchedSignalCount(),
    ])

    if (!score || !journal) {
      return {
        success: false,
        error:
          "Couldn't load the close status for this month. The session expired mid-request. Refresh the page to sign back in.",
      }
    }

    const monthsAgo = monthsAgoFromDates(period.startDate, period.endDate)
    const monthLabel =
      monthsAgo !== null
        ? monthPeriod(monthsAgo).monthLabel
        : formatWindowLabel(period, windowStart, windowEnd)

    const eventCount = journal.rows.reduce(
      (sum, row) => sum + row.eventCount,
      0
    )

    return {
      success: true,
      data: {
        monthLabel,
        totalCost: score.totalCost,
        eventCount,
        unclassifiedCost: score.unclassifiedCost,
        unmappedAmount: journal.unmappedAmount,
        unmappedSignalCount: journal.unmappedSignalCount ?? null,
        classifiedShare: score.classifiedShare,
        mismatchedSignalCount: mismatched.count,
        lock,
        journal,
      },
    }
  } catch {
    return {
      success: false,
      error:
        "Couldn't load the close status for this month. A database query failed. Refresh to retry; if it keeps happening, the database may be unreachable.",
    }
  }
}
