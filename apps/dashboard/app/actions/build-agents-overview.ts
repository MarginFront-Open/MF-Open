'use server'

/**
 * Build agents overview — the ONE read action
 * the Build page calls for its per-agent table. It COMPOSES existing canon
 * reads: getCostBreakdown on the 'agent' dimension (per-agent cost/tasks +
 * the canon window totals), getAgentEarned's bySubscription rows (per-agent
 * earned = the aggregate grouped by agentId, NEVER the per-event
 * approximation the command-center strip uses), and a
 * bounded agents-inventory read. No new SQL, no metrics resolver.
 * Totals are ECHOED canon values, never re-summed, so
 * Σ table rows ≡ the org tiles for scope 'build' by construction.
 *
 * The row DERIVATION (join + "Deleted agents" catch-all + margin) is pure
 * and lives in src/features/build/agents-derivation.ts — a 'use server'
 * file may only export async functions.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import {
  getCostBreakdown,
  getAgentEarned,
  ANALYTICS_MAX_ROWS,
} from '@marginfront/db'
import {
  parseWindowFilter,
  formatWindowLabel,
} from './_shared/parse-window-filter'
import { deriveAgentRows } from '@/features/build/agents-derivation'

/** Inventory bound — full lists live on /agents. */
const AGENTS_INVENTORY_MAX = 500

// Direct type DECLARATIONS in a 'use server' file are safe (they erase at
// build — metrics-resolver.ts does the same); only type RE-exports crash
// the action bundle at runtime.
export interface BuildAgentRow {
  /** null ONLY for the deleted-agents catch-all row. */
  agentId: string | null
  /** agents.name; the catch-all row is 'Deleted agents'. */
  name: string
  agentCode: string | null
  /** isActive ?? true (schema default); null on the catch-all row. */
  isActive: boolean | null
  /** Breakdown eventCount for this agentId; 0 when absent. */
  tasks: number
  /** Breakdown cost; 0 when absent. */
  cost: number
  /** Σ bySubscription[agentId].revenue; 0 when absent. */
  earned: number
  /** safeMarginPercent(earned, earned − cost) — null when earned === 0 (canon M2), never 0-for-null. */
  marginPercent: number | null
}

export interface BuildAgentsOverview {
  window: { start: Date; end: Date; label: string }
  rows: BuildAgentRow[]
  /** ECHOED canon totals (breakdown totals + getAgentEarned().revenue), never re-summed. */
  totals: { tasks: number; cost: number; earned: number }
  /** Live agents rows (excludes the catch-all). */
  agentCount: number
  /** Rows with isActive === false. */
  pausedCount: number
}

/**
 * Read the per-agent overview for one window in one round trip.
 * parseWindowFilter semantics; {} = rolling 30 days.
 */
export async function getBuildAgentsOverview(period: {
  startDate?: string
  endDate?: string
}): Promise<{ success: boolean; data?: BuildAgentsOverview; error?: string }> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    const { windowStart, windowEnd } = parseWindowFilter(period)
    const window = { start: windowStart, end: windowEnd }

    const [agents, costBreakdown, agentEarned] = await Promise.all([
      prisma.agents.findMany({
        where: { orgId, deletedAt: null },
        select: { id: true, name: true, agentCode: true, isActive: true },
        orderBy: { name: 'asc' },
        take: AGENTS_INVENTORY_MAX,
      }),
      getCostBreakdown(
        prisma,
        orgId,
        window,
        'agent',
        {},
        {
          page: 1,
          pageSize: ANALYTICS_MAX_ROWS,
          includeOtherRollup: false,
        }
      ),
      getAgentEarned(prisma, orgId, window, {}),
    ])

    if (costBreakdown.totalRowCount > ANALYTICS_MAX_ROWS) {
      return {
        success: false,
        error: `This window has ${costBreakdown.totalRowCount} agents with activity, more than the ${ANALYTICS_MAX_ROWS} this table can load at once. The cap keeps one page from pulling the whole events table. Narrow the date range, or browse the full list on the Agents page.`,
      }
    }

    const { rows, agentCount, pausedCount } = deriveAgentRows(
      agents,
      costBreakdown.rows,
      agentEarned.bySubscription
    )

    return {
      success: true,
      data: {
        window: {
          start: windowStart,
          end: windowEnd,
          label: formatWindowLabel(period, windowStart, windowEnd),
        },
        rows,
        totals: {
          tasks: costBreakdown.totals.eventCount,
          cost: costBreakdown.totals.cost,
          earned: agentEarned.revenue,
        },
        agentCount,
        pausedCount,
      },
    }
  } catch {
    return {
      success: false,
      error:
        "Couldn't load the agents overview. A database query failed. Refresh to retry; if it keeps happening, the database may be unreachable.",
    }
  }
}
