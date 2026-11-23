'use server'

/**
 * ROI overview — the ONE read action the ROI
 * page calls. It COMPOSES getInitiatives (CRUD, never
 * rebuilt here) with canon actuals per initiative window via the shared
 * composition in _shared/initiative-actuals.ts (which holds the reads
 * there so the auto-baseline write path and the /roi/[initiativeId] detail
 * action read through the SAME code — an ROI card can never disagree with
 * the Money page, a stored baseline, or a detail view about the same
 * window). No new SQL, never the metrics resolver, no re-derived sums.
 *
 * The progress/health DERIVATION is pure and lives in
 * src/features/roi/progress-derivation.ts — a 'use server' file may only
 * export async functions.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { getInitiatives } from './initiatives'
import type {
  InitiativeBaselineSource,
  InitiativeMetric,
  InitiativeTargetDirection,
} from './initiatives'
import { buildInitiativeView } from './_shared/initiative-actuals'
import type { InitiativeHealth } from '@/features/roi/progress-derivation'

/** Actuals bound — past this the action errors loudly, never silently truncates. */
const ROI_MAX_ACTIVE_INITIATIVES = 24

// Direct type DECLARATIONS in a 'use server' file are safe (they erase at
// build — metrics-resolver.ts does the same); only type RE-exports crash the
// action bundle at runtime.
export interface RoiTargetView {
  id: string
  metric: InitiativeMetric
  direction: InitiativeTargetDirection
  targetValue: number
  /** canon M2: null = undefined for this window, renders '—'. */
  actual: number | null
  /** Starting value — auto-measured on save or a manual
   * override; null when neither exists (rows saved without a starting value, no-data windows). */
  baseline: number | null
  /** 'auto' = measured from org data over the window before the start date, 'manual' = a
   * person typed it, null = no source recorded (treated as manual). */
  baselineSource: InitiativeBaselineSource | null
  /** 0-100 clamped; null = not computable. */
  progressPct: number | null
  /** null when actual is null. */
  met: boolean | null
}

export interface RoiInitiativeView {
  id: string
  name: string
  description: string | null
  status: 'active' | 'archived'
  /** ISO, verbatim from getInitiatives. */
  startDate: string
  endDate: string | null
  /** Matter scope, verbatim from getInitiatives. matterId null with
   * scopedMatterNumber set means the matter was DELETED and these actuals went
   * back to org-wide; matterScopeLabel turns the three into one subtitle. */
  matterId: string | null
  matterNumber: string | null
  scopedMatterNumber: string | null
  /** 0-100 share of this goal's window already spent; null with no end date.
   * Measured once on the server so three surfaces sharing one sentence never
   * depend on a clock read during render. */
  elapsedPct: number | null
  health: InitiativeHealth
  targets: RoiTargetView[]
}

export interface RoiOverview {
  /** Active first (startDate desc), archived after. */
  initiatives: RoiInitiativeView[]
  /** Drives the subtitle '{n} initiatives tracked'. */
  activeCount: number
}

/**
 * Read every initiative's card view in one round trip: the CRUD read
 * plus canon actuals over each initiative's own window. Archived and
 * not-yet-started initiatives skip all reads (no actuals spend on dead or
 * future goals).
 */
export async function getRoiOverview(): Promise<{
  success: boolean
  data?: RoiOverview
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    const initiativesResult = await getInitiatives()
    if (!initiativesResult.success || !initiativesResult.data) {
      return {
        success: false,
        error: initiativesResult.error ?? 'Failed to load initiatives',
      }
    }

    const active = initiativesResult.data.filter((i) => i.status === 'active')
    const archived = initiativesResult.data.filter((i) => i.status !== 'active')

    if (active.length > ROI_MAX_ACTIVE_INITIATIVES) {
      return {
        success: false,
        error: `This org has ${active.length} active initiatives, more than the ${ROI_MAX_ACTIVE_INITIATIVES} the ROI page computes live actuals for in one load. Each active initiative fires its own set of window queries, so the cap keeps one page load from swamping the database. Archive finished initiatives to get back under it.`,
      }
    }

    const now = new Date()
    const views: RoiInitiativeView[] = []
    // Sequential across initiatives on purpose (obvious over
    // clever); each initiative's own reads run in one Promise.all.
    for (const initiative of [...active, ...archived]) {
      views.push(await buildInitiativeView(initiative, orgId, now))
    }

    return {
      success: true,
      data: { initiatives: views, activeCount: active.length },
    }
  } catch {
    return {
      success: false,
      error:
        "Couldn't load the ROI overview. A database query failed. Refresh to retry; if it keeps happening, the database may be unreachable.",
    }
  }
}
