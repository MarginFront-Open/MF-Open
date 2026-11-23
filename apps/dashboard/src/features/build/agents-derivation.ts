/**
 * Pure derivation of the Build page's
 * per-agent rows. Framework-free and node-testable: joins the three canon
 * reads getBuildAgentsOverview composes (bounded agents inventory,
 * getCostBreakdown 'agent' rows, getAgentEarned bySubscription rows) into
 * one row per live agent plus the "Deleted agents" catch-all. NO fetching,
 * NO money math beyond the imported canon helper — margin is
 * safeMarginPercent(earned, earned − cost) on the earned basis, null when
 * earned is 0 (canon M2: undefined-for-window renders "—", never 0).
 *
 * The catch-all exists because soft-deleted agents keep their historical
 * events' agentId: breakdown keys or bySubscription
 * agentIds with no live agent row must land SOMEWHERE or Σ rows < the org
 * tiles.
 */

import { safeMarginPercent } from '@/lib/canon-format'
import type { AgentEarnedSubscriptionRow, BreakdownRow } from '@marginfront/db'
import type { BuildAgentRow } from '@/app/actions/build-agents-overview'

/** Row shape of the action's bounded agents-inventory read. */
export interface AgentInventoryRow {
  id: string
  name: string
  agentCode: string
  isActive: boolean | null
}

export interface DerivedAgentRows {
  rows: BuildAgentRow[]
  /** Live agents in the inventory — the catch-all never counts. */
  agentCount: number
  /** Live agents with isActive === false. */
  pausedCount: number
}

/**
 * The agent ids a window has activity for. Read the roster scoped to THESE:
 * deriveAgentRows routes every id absent from the inventory into the "Deleted
 * agents" catch-all, so a capped roster read reports live agents as deleted.
 */
export function agentIdsWithActivity(
  breakdownRows: Array<Pick<BreakdownRow, 'key'>>,
  bySubscription: Array<Pick<AgentEarnedSubscriptionRow, 'agentId'>>
): string[] {
  const ids = new Set<string>()
  for (const row of breakdownRows) {
    if (row.key !== null) ids.add(row.key)
  }
  for (const sub of bySubscription) ids.add(sub.agentId)
  return [...ids]
}

export function deriveAgentRows(
  agents: AgentInventoryRow[],
  breakdownRows: Array<Pick<BreakdownRow, 'key' | 'cost' | 'eventCount'>>,
  bySubscription: Array<
    Pick<AgentEarnedSubscriptionRow, 'agentId' | 'revenue'>
  >,
  /** Agent ids carrying money the usage-only rows drop: a
   *  monthly-fee subscription bills with no events, so without them the
   *  catch-all is absent and a deleted agent's revenue lands nowhere. */
  alsoBilledAgentIds: readonly string[] = []
): DerivedAgentRows {
  const activityByAgentId = new Map<
    string | null,
    { cost: number; tasks: number }
  >()
  for (const row of breakdownRows) {
    const prev = activityByAgentId.get(row.key)
    activityByAgentId.set(row.key, {
      cost: (prev?.cost ?? 0) + row.cost,
      tasks: (prev?.tasks ?? 0) + row.eventCount,
    })
  }

  const earnedByAgentId = new Map<string, number>()
  for (const sub of bySubscription) {
    earnedByAgentId.set(
      sub.agentId,
      (earnedByAgentId.get(sub.agentId) ?? 0) + sub.revenue
    )
  }

  const liveAgentIds = new Set(agents.map((agent) => agent.id))

  const liveRows: BuildAgentRow[] = agents.map((agent) => {
    const activity = activityByAgentId.get(agent.id)
    const cost = activity?.cost ?? 0
    const earned = earnedByAgentId.get(agent.id) ?? 0
    return {
      agentId: agent.id,
      name: agent.name,
      agentCode: agent.agentCode,
      isActive: agent.isActive ?? true,
      tasks: activity?.tasks ?? 0,
      cost,
      earned,
      marginPercent: safeMarginPercent(earned, earned - cost),
    }
  })

  liveRows.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))

  // agentId NOT NULL in schema makes a null breakdown key impossible,
  // but the BreakdownRow type allows it — route it to the catch-all rather
  // than dropping its cost, so the partition stays total either way.
  let orphanCost = 0
  let orphanTasks = 0
  let orphanEarned = 0
  let hasOrphans = false
  for (const [agentId, activity] of activityByAgentId) {
    if (agentId === null || !liveAgentIds.has(agentId)) {
      hasOrphans = true
      orphanCost += activity.cost
      orphanTasks += activity.tasks
    }
  }
  for (const [agentId, revenue] of earnedByAgentId) {
    if (!liveAgentIds.has(agentId)) {
      hasOrphans = true
      orphanEarned += revenue
    }
  }
  for (const agentId of alsoBilledAgentIds) {
    if (!liveAgentIds.has(agentId)) hasOrphans = true
  }

  const rows = hasOrphans
    ? [
        ...liveRows,
        {
          agentId: null,
          name: 'Deleted agents',
          agentCode: null,
          isActive: null,
          tasks: orphanTasks,
          cost: orphanCost,
          earned: orphanEarned,
          marginPercent: safeMarginPercent(
            orphanEarned,
            orphanEarned - orphanCost
          ),
        },
      ]
    : liveRows

  return {
    rows,
    agentCount: agents.length,
    pausedCount: agents.filter((agent) => agent.isActive === false).length,
  }
}
