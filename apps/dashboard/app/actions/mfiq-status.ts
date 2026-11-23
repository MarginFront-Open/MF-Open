'use server'

/**
 * MF IQ status: the
 * ONE read action the MF IQ page calls. It COMPOSES the six existing reads
 * (getFinopsCloseStatus, getPeriodLockStatus, getBuildAgentsOverview,
 * getNeedsCostBackfillGroups, getMissingVolumeGroups, getExhaustedCreditPools)
 * — no new SQL, no Prisma
 * client, never the metrics resolver, never a re-derived sum. Each composed
 * read owns its own SQL and resolves the org internally; this action
 * adds only a session-presence check for its own error shape.
 *
 * Promise.allSettled, NOT Promise.all, on purpose. MF IQ aggregates six independent domains, and one failing
 * domain must not blank the whole score page: a failed source maps to a null
 * fact group, which the pure derivation renders as 'No data' (canon M2),
 * never as a fake Pass.
 *
 * The scoring DERIVATION over these facts is pure and lives in
 * src/features/mfiq/iq-derivation.ts — a 'use server' file may only export
 * async functions.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { getFinopsCloseStatus } from './finops-close-status'
import { getPeriodLockStatus } from './finance-period-lock'
import { getBuildAgentsOverview } from './build-agents-overview'
import {
  getNeedsCostBackfillGroups,
  getMissingVolumeGroups,
} from './signal-events'
import { getExhaustedCreditPools } from './credit-pools'
import { monthPeriod } from '@/features/_shared/billing-period'

// Direct type DECLARATIONS in a 'use server' file are safe (they erase at
// build — metrics-resolver.ts does the same); only type RE-exports crash the
// action bundle at runtime.
export interface MfiqFacts {
  /** Source 1: getFinopsCloseStatus(monthPeriod(0)) — current-month books.
   *  null = that source failed (M2: rules over it render 'No data'). */
  books: {
    monthLabel: string
    eventCount: number
    unmappedAmount: number
    /** null only on a frozen snapshot that doesn't carry the field. */
    unmappedSignalCount: number | null
    unclassifiedCost: number
    classifiedShare: number | null
    /** CURRENT-STATE, not windowed. */
    mismatchedSignalCount: number
  } | null
  /** Source 2: getPeriodLockStatus(monthPeriod(1) bounds) — last month's sign-off. */
  prevMonth: {
    monthLabel: string
    /** `${monthPeriod(1).endDate}T23:59:59.999Z` — closeDeadline's documented input. */
    periodEndIso: string
    locked: boolean
    closable: boolean
  } | null
  /** Source 3: getBuildAgentsOverview({}) — rolling-30d agent economics. */
  agents: {
    windowLabel: string
    rows: Array<{
      /** null = the 'Deleted agents' catch-all (EXCLUDED from R6). */
      agentId: string | null
      name: string
      isActive: boolean | null
      cost: number
      earned: number
      marginPercent: number | null
    }>
    pausedCount: number
  } | null
  /** Source 4: getNeedsCostBackfillGroups().data.totalEvents — current-state queue. */
  backfillEvents: number | null
  /** Row count for the same queue: distinct models awaiting a price. */
  backfillModels?: number | null
  /** Source 5: getMissingVolumeGroups().data.totalEvents — current-state queue. */
  missingVolumeEvents: number | null
  /** Row count for the same queue: distinct models missing volume. */
  missingVolumeModels?: number | null
  /** Source 6: getExhaustedCreditPools().data.pools.length — pools at or past
   *  zero PLUS pools under 20% left, the same set the needs-attention page
   *  lists, so the two counts cannot disagree. Optional: no SCORING rule reads
   *  it. */
  lowCreditPools?: number | null
  /** ISO — the page's honesty stamp. */
  generatedAt: string
}

/**
 * Read every MF IQ fact in one round trip. No parameters: the page has no
 * date selector, so every window is pinned here — current month
 * (monthPeriod(0)) for the books, previous month (monthPeriod(1)) for the
 * sign-off lock, and {} (parseWindowFilter's rolling-30d default, applied
 * inside getBuildAgentsOverview) for agent economics.
 */
export async function getMfiqStatus(): Promise<{
  success: boolean
  data?: MfiqFacts
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const currentMonth = monthPeriod(0)
    const previousMonth = monthPeriod(1)

    const [
      closeSettled,
      lockSettled,
      agentsSettled,
      backfillSettled,
      missingVolumeSettled,
      creditPoolsSettled,
    ] = await Promise.allSettled([
      getFinopsCloseStatus({
        startDate: currentMonth.startDate,
        endDate: currentMonth.endDate,
      }),
      getPeriodLockStatus({
        startDate: previousMonth.startDate,
        endDate: previousMonth.endDate,
      }),
      getBuildAgentsOverview({}),
      getNeedsCostBackfillGroups(),
      getMissingVolumeGroups(),
      getExhaustedCreditPools(),
    ])

    // Per-source tolerance: a rejected promise OR a {success: false} result
    // nulls that fact group only. getPeriodLockStatus has no {success} wrapper
    // (it returns PeriodLockStatus directly and throws on a DB error), so its
    // failure domain is rejection alone.
    const close =
      closeSettled.status === 'fulfilled' &&
      closeSettled.value.success &&
      closeSettled.value.data
        ? closeSettled.value.data
        : null
    const lock = lockSettled.status === 'fulfilled' ? lockSettled.value : null
    const overview =
      agentsSettled.status === 'fulfilled' &&
      agentsSettled.value.success &&
      agentsSettled.value.data
        ? agentsSettled.value.data
        : null
    const backfill =
      backfillSettled.status === 'fulfilled' &&
      backfillSettled.value.success &&
      backfillSettled.value.data
        ? backfillSettled.value.data
        : null
    const missingVolume =
      missingVolumeSettled.status === 'fulfilled' &&
      missingVolumeSettled.value.success &&
      missingVolumeSettled.value.data
        ? missingVolumeSettled.value.data
        : null
    const creditPools =
      creditPoolsSettled.status === 'fulfilled' &&
      creditPoolsSettled.value.success
        ? creditPoolsSettled.value.data
        : null

    if (
      !close &&
      !lock &&
      !overview &&
      !backfill &&
      !missingVolume &&
      !creditPools
    ) {
      return {
        success: false,
        error:
          "Couldn't load the MFiQ score. All six source reads failed, which usually means the database is unreachable or your session expired. Refresh the page to retry; if it keeps happening, sign out and back in.",
      }
    }

    return {
      success: true,
      data: {
        books: close
          ? {
              monthLabel: close.monthLabel,
              eventCount: close.eventCount,
              unmappedAmount: close.unmappedAmount,
              unmappedSignalCount: close.unmappedSignalCount,
              unclassifiedCost: close.unclassifiedCost,
              classifiedShare: close.classifiedShare,
              mismatchedSignalCount: close.mismatchedSignalCount,
            }
          : null,
        prevMonth: lock
          ? {
              monthLabel: previousMonth.monthLabel,
              periodEndIso: `${previousMonth.endDate}T23:59:59.999Z`,
              locked: lock.locked,
              closable: lock.closable,
            }
          : null,
        agents: overview
          ? {
              windowLabel: overview.window.label,
              rows: overview.rows.map((row) => ({
                agentId: row.agentId,
                name: row.name,
                isActive: row.isActive,
                cost: row.cost,
                earned: row.earned,
                marginPercent: row.marginPercent,
              })),
              pausedCount: overview.pausedCount,
            }
          : null,
        backfillEvents: backfill ? backfill.totalEvents : null,
        backfillModels: backfill ? backfill.groups.length : null,
        missingVolumeEvents: missingVolume ? missingVolume.totalEvents : null,
        missingVolumeModels: missingVolume ? missingVolume.groups.length : null,
        lowCreditPools: creditPools ? creditPools.pools.length : null,
        generatedAt: new Date().toISOString(),
      },
    }
  } catch {
    return {
      success: false,
      error:
        "Couldn't load the MFiQ score. Something failed while assembling the six source reads. Refresh to retry; if it keeps happening, the database may be unreachable.",
    }
  }
}
