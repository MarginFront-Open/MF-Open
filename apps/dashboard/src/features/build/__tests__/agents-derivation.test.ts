/**
 * deriveAgentRows is a pure function. Hand-built fixtures: 5 agents (2
 * zero-activity, 1 paused), breakdown rows for 3, bySubscription rows for 3
 * (one agent with TWO subscriptions — the group-sum proof), one orphan
 * breakdown key + one orphan bySubscription agentId (deleted agents).
 * Margin is cross-checked against the real safeMarginPercent helper, and the partition
 * proof (Σ rows ≡ Σ fixture inputs) is asserted at the unit level.
 */

import { safeMarginPercent } from '@marginfront/db'
import {
  agentIdsWithActivity,
  deriveAgentRows,
  type AgentInventoryRow,
} from '../agents-derivation'

const AGENT_SUPPORT = 'aaaaaaaa-0000-0000-0000-000000000001'
const AGENT_RESEARCH = 'bbbbbbbb-0000-0000-0000-000000000002'
const AGENT_PAUSED = 'cccccccc-0000-0000-0000-000000000003'
const AGENT_DEAL_OPS = 'dddddddd-0000-0000-0000-000000000004'
const AGENT_LEGACY = 'eeeeeeee-0000-0000-0000-000000000005'
const DELETED_X = 'ffffffff-0000-0000-0000-00000000000a'
const DELETED_Y = 'ffffffff-0000-0000-0000-00000000000b'

const agents: AgentInventoryRow[] = [
  {
    id: AGENT_SUPPORT,
    name: 'Support Agent',
    agentCode: 'support-agent',
    isActive: true,
  },
  {
    id: AGENT_RESEARCH,
    name: 'Research Agent',
    agentCode: 'research-agent',
    isActive: true,
  },
  {
    id: AGENT_PAUSED,
    name: 'Paused Agent',
    agentCode: 'paused-agent',
    isActive: false,
  },
  {
    id: AGENT_DEAL_OPS,
    name: 'Deal Ops',
    agentCode: 'deal-ops',
    isActive: true,
  },
  // isActive null — Prisma's Boolean? shape; schema default says treat as true.
  {
    id: AGENT_LEGACY,
    name: 'Legacy Importer',
    agentCode: 'legacy-importer',
    isActive: null,
  },
]

const breakdownRows = [
  { key: AGENT_SUPPORT, cost: 300, eventCount: 1000 },
  { key: AGENT_RESEARCH, cost: 100, eventCount: 500 },
  { key: AGENT_PAUSED, cost: 50, eventCount: 80 },
  { key: DELETED_X, cost: 40, eventCount: 60 },
]

const bySubscription = [
  { agentId: AGENT_SUPPORT, revenue: 200 },
  // Research Agent has TWO subscriptions — earned must group-sum to 400.
  { agentId: AGENT_RESEARCH, revenue: 150 },
  { agentId: AGENT_RESEARCH, revenue: 250 },
  { agentId: DELETED_Y, revenue: 90 },
]

const derived = deriveAgentRows(agents, breakdownRows, bySubscription)
const rowByName = (name: string) => {
  const row = derived.rows.find((r) => r.name === name)
  if (!row) throw new Error(`No derived row named "${name}"`)
  return row
}

describe('per-agent join — tasks/cost/earned exact', () => {
  it('Support Agent: breakdown activity + single-subscription earned', () => {
    const row = rowByName('Support Agent')
    expect(row.tasks).toBe(1000)
    expect(row.cost).toBe(300)
    expect(row.earned).toBe(200)
    expect(row.agentId).toBe(AGENT_SUPPORT)
    expect(row.agentCode).toBe('support-agent')
    expect(row.isActive).toBe(true)
  })

  it('Research Agent: earned group-sums BOTH subscription rows (150 + 250)', () => {
    const row = rowByName('Research Agent')
    expect(row.tasks).toBe(500)
    expect(row.cost).toBe(100)
    expect(row.earned).toBe(400)
  })

  it('Paused Agent: cost activity with zero earned, isActive false', () => {
    const row = rowByName('Paused Agent')
    expect(row.tasks).toBe(80)
    expect(row.cost).toBe(50)
    expect(row.earned).toBe(0)
    expect(row.isActive).toBe(false)
  })

  it('zero-activity agents get 0/0/0 (the seed Deal Ops / Legacy Importer behavior)', () => {
    for (const name of ['Deal Ops', 'Legacy Importer']) {
      const row = rowByName(name)
      expect(row.tasks).toBe(0)
      expect(row.cost).toBe(0)
      expect(row.earned).toBe(0)
    }
  })

  it('isActive null falls back to the schema default true (never renders as paused)', () => {
    expect(rowByName('Legacy Importer').isActive).toBe(true)
  })
})

describe('marginPercent — canon safeMarginPercent on the earned basis (M2 null edges)', () => {
  it('negative margin: Support Agent earned 200 / cost 300 → −50%', () => {
    const row = rowByName('Support Agent')
    expect(row.marginPercent).toBe(safeMarginPercent(200, 200 - 300))
    expect(row.marginPercent).toBe(-50)
  })

  it('positive margin: Research Agent earned 400 / cost 100 → 75%', () => {
    const row = rowByName('Research Agent')
    expect(row.marginPercent).toBe(safeMarginPercent(400, 400 - 100))
    expect(row.marginPercent).toBe(75)
  })

  it('zero-earned rows are null, NEVER 0 — cost alone cannot fake a margin', () => {
    expect(rowByName('Paused Agent').marginPercent).toBeNull()
    expect(rowByName('Deal Ops').marginPercent).toBeNull()
    expect(rowByName('Legacy Importer').marginPercent).toBeNull()
  })
})

describe('Deleted-agents catch-all', () => {
  const catchAll = derived.rows[derived.rows.length - 1]

  it('aggregates BOTH orphan sources: the orphan breakdown key AND the orphan bySubscription agentId', () => {
    expect(catchAll.name).toBe('Deleted agents')
    expect(catchAll.tasks).toBe(60)
    expect(catchAll.cost).toBe(40)
    expect(catchAll.earned).toBe(90)
  })

  it('is the synthetic row: agentId null, agentCode null, isActive null', () => {
    expect(catchAll.agentId).toBeNull()
    expect(catchAll.agentCode).toBeNull()
    expect(catchAll.isActive).toBeNull()
  })

  it('sits LAST even though its cost (40) beats the zero-activity rows', () => {
    expect(derived.rows[derived.rows.length - 1].name).toBe('Deleted agents')
    expect(
      derived.rows.filter((row) => row.name === 'Deleted agents')
    ).toHaveLength(1)
  })

  it('margin follows the same canon rule (earned 90, cost 40 → 55.55…%)', () => {
    expect(catchAll.marginPercent).toBe(safeMarginPercent(90, 90 - 40))
  })

  it('is omitted entirely when nothing is orphaned — no fake empty bucket', () => {
    const clean = deriveAgentRows(
      agents,
      breakdownRows.filter((row) => row.key !== DELETED_X),
      bySubscription.filter((sub) => sub.agentId !== DELETED_Y)
    )
    expect(clean.rows).toHaveLength(5)
    expect(clean.rows.every((row) => row.agentId !== null)).toBe(true)
  })
})

describe('sort order — cost DESC, then name ASC, catch-all last (pinned)', () => {
  it('full order', () => {
    expect(derived.rows.map((row) => row.name)).toEqual([
      'Support Agent', // 300
      'Research Agent', // 100
      'Paused Agent', // 50
      'Deal Ops', // 0, ties broken by name ASC
      'Legacy Importer', // 0
      'Deleted agents', // catch-all, always last
    ])
  })
})

describe('counts', () => {
  it('agentCount counts live agents only — the catch-all never counts', () => {
    expect(derived.agentCount).toBe(5)
  })

  it('pausedCount counts isActive === false only (null is NOT paused)', () => {
    expect(derived.pausedCount).toBe(1)
  })
})

describe('partition proof — Σ rows ≡ Σ fixture inputs (the invariant at the unit level)', () => {
  it('tasks, cost, and earned all sum to the raw canon inputs, catch-all included', () => {
    const sum = (pick: (row: (typeof derived.rows)[number]) => number) =>
      derived.rows.reduce((total, row) => total + pick(row), 0)

    expect(sum((row) => row.tasks)).toBe(
      breakdownRows.reduce((total, row) => total + row.eventCount, 0)
    )
    expect(sum((row) => row.cost)).toBe(
      breakdownRows.reduce((total, row) => total + row.cost, 0)
    )
    expect(sum((row) => row.earned)).toBe(
      bySubscription.reduce((total, sub) => total + sub.revenue, 0)
    )
  })

  it('a null breakdown key (impossible today, typed possible) still lands in the catch-all, not nowhere', () => {
    const withNullKey = deriveAgentRows(
      agents,
      [...breakdownRows, { key: null, cost: 7, eventCount: 3 }],
      bySubscription
    )
    const catchAll = withNullKey.rows[withNullKey.rows.length - 1]
    expect(catchAll.name).toBe('Deleted agents')
    expect(catchAll.cost).toBe(47)
    expect(catchAll.tasks).toBe(63)
  })
})

describe('agentIdsWithActivity — the set a caller must name before it joins', () => {
  it('collects every agent id with cost or earned activity, de-duplicated', () => {
    expect(
      [...agentIdsWithActivity(breakdownRows, bySubscription)].sort()
    ).toEqual(
      [AGENT_SUPPORT, AGENT_RESEARCH, AGENT_PAUSED, DELETED_X, DELETED_Y].sort()
    )
  })

  it('drops the null breakdown key — a null bucket is nobody to look up', () => {
    expect(agentIdsWithActivity([{ key: null }], [])).toEqual([])
  })

  it('an empty window names nobody, so the caller can skip the read entirely', () => {
    expect(agentIdsWithActivity([], [])).toEqual([])
  })

  it('an inventory read capped instead of scoped reports LIVE agents as deleted', () => {
    // The failure this function exists to stop: a caller that reads a capped
    // slice of the roster hands deriveAgentRows an inventory missing live
    // agents, and every one of them lands in the row named 'Deleted agents'.
    const capped = deriveAgentRows(
      agents.slice(0, 1),
      breakdownRows,
      bySubscription
    )
    const wrongCatchAll = capped.rows[capped.rows.length - 1]
    expect(wrongCatchAll.name).toBe('Deleted agents')
    expect(wrongCatchAll.cost).toBe(190)

    const withActivity = new Set(
      agentIdsWithActivity(breakdownRows, bySubscription)
    )
    const scoped = deriveAgentRows(
      agents.filter((agent) => withActivity.has(agent.id)),
      breakdownRows,
      bySubscription
    )
    const rightCatchAll = scoped.rows[scoped.rows.length - 1]
    expect(rightCatchAll.cost).toBe(40)
    expect(rightCatchAll.earned).toBe(90)
  })
})
