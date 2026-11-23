/**
 * DB-GATED — requires a live Postgres connection via DATABASE_URL (see
 * packages/db/.env). Follows the *.integration.test.ts conventions (see
 * finops-close-reconciliation.integration.test.ts).
 *
 * The Build reconciliation invariant:
 * for a seeded org + window,
 *
 *   Σ getBuildAgentsOverview rows (incl. 'Deleted agents')
 *     === BuildAgentsOverview.totals
 *     === resolveMetrics({scope:'build'}).tiles.{cost,eventCount,earned}
 *
 * because totals are ECHOED canon values and the derivation partitions the
 * same canon responses (agentId NOT NULL → agents are a true partition).
 * A seeded soft-deleted agent's events must land in the catch-all row, not
 * nowhere, and per-agent earned must equal the Σ of getAgentEarned's
 * bySubscription rows for that agentId (the canon R1b grouping, never
 * per-event math).
 *
 * Own throwaway org, not the shared test organization — these reads are org+window
 * scoped with no per-customer filter, so only a fully-owned org isolates
 * the math (the finops-close-reconciliation rationale).
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { getAgentEarned, safeMarginPercent } from '@marginfront/db'
import { buildAuthMock, buildHeadersMock } from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

const prisma = new PrismaClient()
const EPSILON = 0.01

type OverviewModule = typeof import('../build-agents-overview')
type ResolverModule = typeof import('../metrics-resolver')
let getBuildAgentsOverview: OverviewModule['getBuildAgentsOverview']
let resolveMetrics: ResolverModule['resolveMetrics']

const WINDOW = { startDate: '2026-04-01', endDate: '2026-04-30' }

let orgId: string
let liveAgentId: string
let deletedAgentId: string
let customerId: string
let customerExternalId: string
let signalId: string
let rawIngestEventId: string
const createdPlanIds: string[] = []
const createdStrategyIds: string[] = []
const createdSubscriptionIds: string[] = []
const createdEventIds: string[] = []

// Fixture math (all flat usage strategies, canon R1):
//   live agent   — events (cost 1.5, q 5) + (cost 2.25, q 10) at $2/unit
//                  → cost 3.75, tasks 2, earned 30
//   deleted agent — event (cost 0.75, q 2) at $4/unit
//                  → cost 0.75, tasks 1, earned 8 → the catch-all row
const LIVE_COST = 3.75
const LIVE_TASKS = 2
const LIVE_EARNED = 30
const DELETED_COST = 0.75
const DELETED_TASKS = 1
const DELETED_EARNED = 8

beforeAll(async () => {
  const now = new Date()
  orgId = randomUUID()
  await prisma.organizations.create({
    data: {
      id: orgId,
      name: 'fixture-org-build-reconciliation',
      createdAt: now,
      updatedAt: now,
    },
  })

  authMock.__setSessionOrgId(orgId)
  ;({ getBuildAgentsOverview } = await import('../build-agents-overview'))
  ;({ resolveMetrics } = await import('../metrics-resolver'))

  liveAgentId = randomUUID()
  deletedAgentId = randomUUID()
  await prisma.agents.createMany({
    data: [
      {
        id: liveAgentId,
        name: 'live-agent',
        agentCode: 'live-agent',
        orgId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: deletedAgentId,
        name: 'deleted-agent',
        agentCode: 'deleted-agent',
        orgId,
        createdAt: now,
        updatedAt: now,
      },
    ],
  })

  customerId = randomUUID()
  customerExternalId = `customer-${customerId.slice(0, 8)}`
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: 'fixture-customer',
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })

  signalId = randomUUID()
  await prisma.signals.create({
    data: {
      id: signalId,
      name: 'signal',
      agentId: liveAgentId,
      orgId,
      costCategory: 'UNCLASSIFIED',
      createdAt: now,
      updatedAt: now,
    },
  })

  rawIngestEventId = randomUUID()
  await prisma.raw_ingest_events.create({
    data: {
      id: rawIngestEventId,
      organizationId: orgId,
      payload: { source: 'fixture' },
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  })

  const farFuture = new Date('2099-12-31T00:00:00Z')
  const seedSubscription = async (agentId: string, rate: number) => {
    const planId = randomUUID()
    await prisma.pricing_plans.create({
      data: {
        id: planId,
        orgId,
        agentId,
        name: `plan-${planId.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdPlanIds.push(planId)
    const strategyId = randomUUID()
    await prisma.pricing_strategies.create({
      data: {
        id: strategyId,
        planId,
        orgId,
        agentId,
        signalId,
        name: `strat-${strategyId.slice(0, 8)}`,
        chargeType: 'usage',
        pricingModel: 'flat',
        rate,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdStrategyIds.push(strategyId)
    const subscriptionId = randomUUID()
    await prisma.subscriptions.create({
      data: {
        id: subscriptionId,
        organizationId: orgId,
        customerId,
        agentId,
        planId,
        name: `sub-${subscriptionId.slice(0, 8)}`,
        status: 'active',
        billingCycle: 'monthly',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        nextRecurringInvoiceAt: farFuture,
        nextUsageInvoiceAt: farFuture,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdSubscriptionIds.push(subscriptionId)
    return subscriptionId
  }
  const liveSubscriptionId = await seedSubscription(liveAgentId, 2.0)
  const deletedSubscriptionId = await seedSubscription(deletedAgentId, 4.0)

  const seedEvent = async (
    agentId: string,
    subscriptionId: string,
    day: string,
    usageCost: number,
    quantity: number
  ) => {
    const id = randomUUID()
    await prisma.signal_events.create({
      data: {
        id,
        organizationId: orgId,
        agentId,
        customerId,
        customerExternalId,
        signalId,
        subscriptionId,
        rawIngestEventId,
        usageDate: new Date(`2026-04-${day}T12:00:00.000Z`),
        usageCost,
        quantity,
        environment: 'production',
        idempotencyKey: `event-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdEventIds.push(id)
  }
  await seedEvent(liveAgentId, liveSubscriptionId, '10', 1.5, 5)
  await seedEvent(liveAgentId, liveSubscriptionId, '12', 2.25, 10)
  await seedEvent(deletedAgentId, deletedSubscriptionId, '11', 0.75, 2)

  // Soft-delete AFTER its events exist — the historical rows keep their
  // agentId, which is exactly what the catch-all must catch.
  await prisma.agents.update({
    where: { id: deletedAgentId },
    data: { deletedAt: now },
  })
})

afterAll(async () => {
  await prisma.signal_events.deleteMany({
    where: { id: { in: createdEventIds } },
  })
  await prisma.subscriptions.deleteMany({
    where: { id: { in: createdSubscriptionIds } },
  })
  await prisma.pricing_strategies.deleteMany({
    where: { id: { in: createdStrategyIds } },
  })
  await prisma.pricing_plans.deleteMany({ where: { id: { in: createdPlanIds } } })
  await prisma.signals.deleteMany({ where: { orgId } })
  await prisma.raw_ingest_events.deleteMany({ where: { id: rawIngestEventId } })
  await prisma.customers.deleteMany({ where: { id: customerId } })
  await prisma.agents.deleteMany({ where: { orgId } })
  await prisma.organizations.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('Build reconciliation invariant — Σ rows ≡ totals ≡ scope-build tiles', () => {
  it('the fixture produces the numbers the invariant depends on (guards the guard)', async () => {
    const overview = await getBuildAgentsOverview(WINDOW)
    expect(overview.success).toBe(true)
    const rows = overview.data!.rows

    const live = rows.find((row) => row.agentId === liveAgentId)
    expect(live).toBeDefined()
    expect(live!.tasks).toBe(LIVE_TASKS)
    expect(Math.abs(live!.cost - LIVE_COST)).toBeLessThanOrEqual(EPSILON)
    expect(Math.abs(live!.earned - LIVE_EARNED)).toBeLessThanOrEqual(EPSILON)
    expect(live!.marginPercent).toBeCloseTo(
      safeMarginPercent(live!.earned, live!.earned - live!.cost)!,
      6
    )
  })

  it("the soft-deleted agent's events land in the 'Deleted agents' catch-all row, not nowhere", async () => {
    const overview = await getBuildAgentsOverview(WINDOW)
    const rows = overview.data!.rows

    expect(rows.some((row) => row.agentId === deletedAgentId)).toBe(false)

    const catchAll = rows[rows.length - 1]
    expect(catchAll.agentId).toBeNull()
    expect(catchAll.name).toBe('Deleted agents')
    expect(catchAll.tasks).toBe(DELETED_TASKS)
    expect(Math.abs(catchAll.cost - DELETED_COST)).toBeLessThanOrEqual(EPSILON)
    expect(Math.abs(catchAll.earned - DELETED_EARNED)).toBeLessThanOrEqual(
      EPSILON
    )
  })

  it('Σ rows === echoed totals === resolveMetrics({scope: build}).tiles for the same window', async () => {
    const [overview, resolved] = await Promise.all([
      getBuildAgentsOverview(WINDOW),
      resolveMetrics({
        scope: 'build',
        period: WINDOW,
        dimension: 'agent',
        filters: {},
      }),
    ])
    expect(overview.success).toBe(true)
    expect(resolved.success).toBe(true)

    const rows = overview.data!.rows
    const rowsCost = rows.reduce((sum, row) => sum + row.cost, 0)
    const rowsTasks = rows.reduce((sum, row) => sum + row.tasks, 0)
    const rowsEarned = rows.reduce((sum, row) => sum + row.earned, 0)

    const totals = overview.data!.totals
    expect(Math.abs(rowsCost - totals.cost)).toBeLessThanOrEqual(EPSILON)
    expect(rowsTasks).toBe(totals.tasks)
    expect(Math.abs(rowsEarned - totals.earned)).toBeLessThanOrEqual(EPSILON)

    const tiles = resolved.data!.tiles
    expect(Math.abs(totals.cost - tiles.cost)).toBeLessThanOrEqual(EPSILON)
    expect(totals.tasks).toBe(tiles.eventCount)
    expect(Math.abs(totals.earned - tiles.earned!)).toBeLessThanOrEqual(EPSILON)
  })

  it("per-agent earned === Σ getAgentEarned().bySubscription rows for that agentId (canon R1b grouping, never per-event math)", async () => {
    const overview = await getBuildAgentsOverview(WINDOW)
    const window = {
      start: overview.data!.window.start,
      end: overview.data!.window.end,
    }
    const direct = await getAgentEarned(prisma as never, orgId, window, {})

    const directLiveEarned = direct.bySubscription
      .filter((sub) => sub.agentId === liveAgentId)
      .reduce((sum, sub) => sum + sub.revenue, 0)
    const liveRow = overview.data!.rows.find(
      (row) => row.agentId === liveAgentId
    )!
    expect(Math.abs(liveRow.earned - directLiveEarned)).toBeLessThanOrEqual(
      EPSILON
    )

    expect(Math.abs(overview.data!.totals.earned - direct.revenue)).toBeLessThanOrEqual(
      EPSILON
    )
  })

  it('agentCount excludes the deleted agent; pausedCount is 0 for this fixture', async () => {
    const overview = await getBuildAgentsOverview(WINDOW)
    expect(overview.data!.agentCount).toBe(1)
    expect(overview.data!.pausedCount).toBe(0)
  })
})
