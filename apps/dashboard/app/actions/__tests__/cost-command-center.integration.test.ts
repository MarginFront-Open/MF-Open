/**
 * Parity tests for the Cost mode Server Actions.
 *
 * Two tests:
 *   1. getCostCommandCenterAgentStrip per-agent cost matches an
 *      independent raw-event sum of signal_events.usageCost grouped
 *      by agentId (canon C1: null usageCost contributes 0 but the
 *      event still counts). The test's expected side bypasses the
 *      canonical library entirely so a fault in either the
 *      action's canon delegation OR the canonical library itself
 *      shows up as a concrete dollar-amount diff.
 *
 *   2. Negative assertion: none of the four Cost mode action response
 *      payloads contain a field whose name matches a revenue-shaped
 *      keyword (revenue, margin, mrr, collected, collection, billed,
 *      earned). Keys-only check so sample data that happens to contain
 *      these words in string VALUES doesn't false-positive.
 *
 * Runs against the sample data seeded into
 * the scratch database named in packages/db/.env.
 */

import { PrismaClient } from '@prisma/client'
import {
  getSampleOrgIdForTests,
  buildAuthMock,
  buildHeadersMock,
} from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())
// This integration suite exercises the LIVE recompute path
// against the test database, so the period is never locked here (and we don't
// depend on the lock table existing in the test database). The lock guard itself is
// covered by period-lock-*.test.ts.
jest.mock('../_shared/period-lock-store', () => ({
  findLockedPeriod: async () => null,
}))

type CostCommandCenterModule = typeof import('../cost-command-center')
let actions: CostCommandCenterModule

const prisma = new PrismaClient()
const MS_PER_DAY = 24 * 60 * 60 * 1000

beforeAll(async () => {
  const orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  actions = await import('../cost-command-center')
})

afterAll(async () => {
  await prisma.$disconnect()
})

function last30DaysWindow() {
  const now = new Date()
  return {
    windowStart: new Date(now.getTime() - 30 * MS_PER_DAY),
    windowEnd: now,
  }
}

/**
 * Deep walk an object and collect every property key (all depths,
 * through arrays). Used by the negative-assertion test so we check
 * field NAMES rather than scanning the serialized blob (which would
 * false-positive on sample data values containing the forbidden words).
 */
function collectAllKeys(obj: unknown): Set<string> {
  const keys = new Set<string>()
  function walk(x: unknown): void {
    if (!x || typeof x !== 'object') return
    if (Array.isArray(x)) {
      for (const item of x) walk(item)
      return
    }
    for (const k of Object.keys(x)) {
      keys.add(k)
      walk((x as Record<string, unknown>)[k])
    }
  }
  walk(obj)
  return keys
}

describe('Cost mode — parity tests', () => {
  it('getCostCommandCenterAgentStrip per-agent cost matches independent raw-event sum', async () => {
    const orgId = await getSampleOrgIdForTests()
    const { windowStart, windowEnd } = last30DaysWindow()

    // Independent recompute: sum signal_events.usageCost grouped by
    // agentId, treating null as 0 per canon C1. Does NOT use the
    // canonical library, so a fault in canonGetCostMetrics
    // itself would surface here too.
    const events = await prisma.signal_events.findMany({
      where: {
        organizationId: orgId,
        usageDate: { gte: windowStart, lte: windowEnd },
      },
      select: { agentId: true, usageCost: true },
    })
    const expectedCostByAgent = new Map<string, number>()
    for (const ev of events) {
      const amt = ev.usageCost === null ? 0 : Number(ev.usageCost)
      expectedCostByAgent.set(
        ev.agentId,
        (expectedCostByAgent.get(ev.agentId) ?? 0) + amt
      )
    }

    const strip = await actions.getCostCommandCenterAgentStrip()
    expect(strip.length).toBeGreaterThan(0)

    for (const row of strip) {
      const expected = expectedCostByAgent.get(row.id) ?? 0
      const diff = Math.abs(row.cost - expected)
      if (diff > 0.01) {
        throw new Error(
          `Agent ${row.name}: action cost=${row.cost.toFixed(4)}, expected=${expected.toFixed(4)} (diff ${diff.toFixed(4)})`
        )
      }
    }
  })

  it('Cost mode action responses contain no revenue-shaped field names', async () => {
    const [top, strip, ts, bd] = await Promise.all([
      actions.getCostCommandCenterTopMetrics(),
      actions.getCostCommandCenterAgentStrip(),
      actions.getCostCommandCenterTimeSeries(),
      actions.getCostCommandCenterBreakdown(),
    ])

    const forbidden = [
      'revenue',
      'margin',
      'mrr',
      'collected',
      'collection',
      'billed',
      'earned',
    ]

    const payloads: Array<{ name: string; payload: unknown }> = [
      { name: 'TopMetrics', payload: top },
      { name: 'AgentStrip', payload: strip },
      { name: 'TimeSeries', payload: ts },
      { name: 'Breakdown', payload: bd },
    ]

    for (const { name, payload } of payloads) {
      const keys = collectAllKeys(payload)
      for (const key of keys) {
        const lower = key.toLowerCase()
        for (const word of forbidden) {
          if (lower.includes(word)) {
            throw new Error(
              `${name} payload has forbidden revenue-shaped field name "${key}" (matches "${word}")`
            )
          }
        }
      }
    }
  })
})
