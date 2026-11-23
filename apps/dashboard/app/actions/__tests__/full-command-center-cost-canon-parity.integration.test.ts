/**
 * Cost+Rev & Platform tiles read canonical total cost.
 *
 * `getFullCommandCenterTopMetrics().cost` must equal canon C1: the SUM of
 * `signal_events.usageCost` over the rolling now()-30d window with NO
 * subscription filter — the same number `getCostCommandCenterTopMetrics()`
 * already reports.
 *
 * The tile must not use `metrics.cost` from `getRevenueMetrics()`, which is
 * subscription-scoped: it only sums events whose subscriptionId is in the
 * window's active subs and silently drops every event with
 * `subscriptionId IS NULL`, under-reporting total cost by that slice (events
 * that arrive without a subscription).
 *
 * WHY THIS TEST SEEDS DATA: the sample data wires every
 * signal_event to a subscription, so `SUM(usageCost WHERE subscriptionId IS
 * NULL) = 0` and ambient data alone cannot tell a subscription-scoped cost
 * from the full cost (both would read the same number). The difference only
 * shows where un-subscribed cost exists. So this test ADDITIVELY seeds ONE
 * `subscriptionId IS NULL` event with a distinctive sentinel cost inside the
 * window, exercises the real Server Actions against a live database, and removes the
 * row in afterAll. This seed, verify, restore pattern makes the test
 * failing-capable on ANY database, not only one whose ambient data happens to
 * contain a null-sub slice.
 *
 * Recompute-from-live-DB parity (golden-standard pattern in
 * full-command-center.integration.test.ts): the canon total is summed straight
 * from Prisma via aggregate (NOT through getCostMetrics — the very helper the
 * action delegates to, which would be circular).
 *
 * MUTATION / ANTI-TAUTOLOGY PROOF: the seeded sentinel is provably included by
 * canon C1 and provably EXCLUDED by the sub-scoped source getRevenueMetrics().cost
 * (it has no subscription). The action's returned cost is asserted strictly
 * closer to canon C1 than to the sub-scoped value, so switching to
 * `cost: metrics.cost` swings the tile down by the sentinel and FAILS this
 * suite.
 *
 * Asserts RELATIONSHIPS (tile == canon, tile == tile, gap >= sentinel), never
 * hardcoded dollar absolutes — the database is shared.
 */

import { randomUUID } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { getRevenueMetrics as canonGetRevenueMetrics } from '@marginfront/db'
import {
  getSampleOrgIdForTests,
  buildAuthMock,
  buildHeadersMock,
} from './_helpers/mock-session'

// Mocks must be declared before the action modules are loaded.
const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

type FullCommandCenterModule = typeof import('../full-command-center')
type CostCommandCenterModule = typeof import('../cost-command-center')
let fullActions: FullCommandCenterModule
let costActions: CostCommandCenterModule

const prisma = new PrismaClient()
const MS_PER_DAY = 24 * 60 * 60 * 1000

// Distinctive, 6-dp value (fits Decimal(18,6)) — unlikely to collide with any
// ambient cost so the deltas read cleanly in failure messages.
const SENTINEL_COST = 137.137137

let orgId = ''
let seededEventId = ''

beforeAll(async () => {
  orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  fullActions = await import('../full-command-center')
  costActions = await import('../cost-command-center')

  // Borrow FK values from any existing event in the org so the seeded row
  // satisfies the customers / agents / raw_ingest_events foreign keys without
  // us having to fabricate those parent rows.
  const template = await prisma.signal_events.findFirst({
    where: { organizationId: orgId },
    select: {
      customerId: true,
      customerExternalId: true,
      agentId: true,
      signalId: true,
      rawIngestEventId: true,
    },
  })
  if (!template) {
    throw new Error(
      'No signal_events in the test organization to template the seed from. Run ' +
        '`npm run db:setup` before this test so the sample data can be priced.'
    )
  }

  seededEventId = randomUUID()
  const now = new Date()
  await prisma.signal_events.create({
    data: {
      id: seededEventId,
      organizationId: orgId,
      customerId: template.customerId,
      customerExternalId: template.customerExternalId,
      agentId: template.agentId,
      signalId: template.signalId,
      rawIngestEventId: template.rawIngestEventId,
      // THE DISCRIMINATOR: no subscription. A sub-scoped cost path drops this row.
      subscriptionId: null,
      // 1h inside the window so neither the test's nor the action's slightly
      // later now()-30d boundary can clip it.
      usageDate: new Date(now.getTime() - 60 * 60 * 1000),
      quantity: 1,
      usageCost: SENTINEL_COST,
      idempotencyKey: `cost-parity-${seededEventId}`,
      createdAt: now,
      updatedAt: now,
    },
  })
})

afterAll(async () => {
  if (seededEventId) {
    await prisma.signal_events
      .delete({ where: { id: seededEventId } })
      .catch(() => {
        // Surfacing a cleanup miss is more useful than masking it, but never
        // let it fail the suite — the row is uniquely tagged for manual sweep.
        console.warn(`Cost parity test: failed to delete seeded event ${seededEventId}`)
      })
  }
  await prisma.$disconnect()
})

// Same 30-day window the actions compute internally (each recomputes its own
// `now` a few ms later). The seeded sentinel sits an hour inside the window, so
// boundary drift can't touch it.
function last30DaysWindow() {
  const now = new Date()
  return {
    start: new Date(now.getTime() - 30 * MS_PER_DAY),
    end: now,
  }
}

function toNum(x: unknown): number {
  if (x === null || x === undefined) return 0
  return Number((x as { toString(): string }).toString())
}

/**
 * Independent ground truth: raw Prisma aggregate of signal_events.usageCost.
 * Deliberately does NOT call getCostMetrics — that's the function the action
 * delegates to, so reusing it would make the parity check circular. DB SUM
 * ignores NULLs, which is exactly canon C1's "null usageCost counts as $0"
 * rule, so this aggregate equals canon C1's `cost`.
 */
async function rawWindowCostSums(window: { start: Date; end: Date }) {
  const [totalAgg, nullSubAgg] = await Promise.all([
    prisma.signal_events.aggregate({
      where: {
        organizationId: orgId,
        usageDate: { gte: window.start, lte: window.end },
      },
      _sum: { usageCost: true },
    }),
    prisma.signal_events.aggregate({
      where: {
        organizationId: orgId,
        usageDate: { gte: window.start, lte: window.end },
        subscriptionId: null,
      },
      _sum: { usageCost: true },
    }),
  ])
  return {
    canonC1: toNum(totalAgg._sum.usageCost),
    nullSubSlice: toNum(nullSubAgg._sum.usageCost),
  }
}

function expectCloseEnough(
  actual: number,
  expected: number,
  label: string,
  tol = 0.01
): void {
  const diff = Math.abs(actual - expected)
  if (diff > tol) {
    throw new Error(
      `${label}: expected ${expected.toFixed(4)}, got ${actual.toFixed(4)} (diff ${diff.toFixed(4)}, tol ${tol})`
    )
  }
}

describe('Full Command Center top-metrics cost == canon C1 (recompute parity)', () => {
  it('seeded sentinel proves a no-subscription cost slice exists in the window', async () => {
    const { canonC1, nullSubSlice } = await rawWindowCostSums(last30DaysWindow())
    // Guard against a vacuous green: the discriminating slice must be present.
    expect(canonC1).toBeGreaterThan(0)
    expect(nullSubSlice).toBeGreaterThanOrEqual(SENTINEL_COST - 0.01)
  })

  it('Full (Cost+Rev / Platform) tile cost reconciles to an independent SUM(usageCost) over the window', async () => {
    const { canonC1 } = await rawWindowCostSums(last30DaysWindow())
    const full = await fullActions.getFullCommandCenterTopMetrics()
    // tile == canon C1, which INCLUDES the seeded null-sub sentinel that a
    // sub-scoped cost path drops.
    expectCloseEnough(full.cost, canonC1, 'Full CC tile cost vs raw canon C1')
  })

  it('Full tile cost == Cost-mode tile cost (cross-surface parity, both canon C1)', async () => {
    const full = await fullActions.getFullCommandCenterTopMetrics()
    const cost = await costActions.getCostCommandCenterTopMetrics()
    expect(cost.cost).toBeGreaterThan(0)
    expectCloseEnough(
      full.cost,
      cost.cost,
      'Full CC tile cost vs Cost-mode tile cost'
    )
  })
})

describe('anti-tautology — a subscription-scoped cost would NOT reconcile', () => {
  it('the no-sub slice is INCLUDED: tile == canon C1 != getRevenueMetrics().cost', async () => {
    const window = last30DaysWindow()
    const { canonC1, nullSubSlice } = await rawWindowCostSums(window)

    // Subscription-scoped cost from getRevenueMetrics, which is what
    // `cost: metrics.cost` would give the tile. It excludes the seeded
    // null-sub sentinel.
    const subScopedCost = (
      await canonGetRevenueMetrics(prisma, orgId, {
        start: window.start,
        end: window.end,
      })
    ).cost

    // Discrimination exists: canon C1 exceeds the sub-scoped number by at least
    // the no-subscription slice (which includes the sentinel). Without this
    // gap the two implementations are indistinguishable (anti-tautology guard).
    expect(canonC1 - subScopedCost).toBeGreaterThanOrEqual(SENTINEL_COST - 0.01)
    expect(canonC1 - subScopedCost).toBeGreaterThanOrEqual(nullSubSlice - 0.01)

    const full = await fullActions.getFullCommandCenterTopMetrics()

    // MUTATION PROOF: the action chose canon C1, not the sub-scoped value.
    // Framed as "strictly closer to canon than to the sub-scoped source" so a
    // few-ms boundary drift (pennies) can't flip it, while switching to
    // `cost: metrics.cost` fails it outright.
    expect(Math.abs(full.cost - canonC1)).toBeLessThan(
      Math.abs(full.cost - subScopedCost)
    )

    // And the sub-scoped value demonstrably mis-reconciles vs canon C1 by at
    // least the dropped sentinel — i.e. shipping sub-scoped logic fails the
    // parity assertion above.
    expect(Math.abs(subScopedCost - canonC1)).toBeGreaterThanOrEqual(
      SENTINEL_COST - 0.01
    )
  })
})
