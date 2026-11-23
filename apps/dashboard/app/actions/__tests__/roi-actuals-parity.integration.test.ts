/**
 * DB-GATED — requires a live Postgres connection via DATABASE_URL. Written
 * to the established *.integration.test.ts conventions (see
 * finops-close-reconciliation.integration.test.ts). Run it only against
 * a disposable database where
 * `prisma migrate deploy` has been applied.
 *
 * The ROI parity invariant: for a
 * seeded org + window, every ROI card actual equals the corresponding
 * resolveMetrics({scope:'roi'}) tile for the same window, because
 * getRoiOverview composes the identical canon reads on windows derived by
 * the identical parseWindowFilter. Plus the M1→M2 honesty pins (zero-event
 * window ⇒ costPerTask null; cost-only window ⇒ marginPercent null AND
 * progress null, never 0) and the unmappedCount source + 92-day cap.
 *
 * Own throwaway org, not the shared test organization — these reads are org+window
 * scoped with no per-customer filter, so only a fully-owned org isolates
 * the math (the finops-close-reconciliation rationale).
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { getMatterCostRollups } from '@marginfront/db'
import {
  buildAuthMock,
  buildHeadersMock,
  buildMoneyManagerMock,
} from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())
jest.mock('../_shared/assert-money-manager', () =>
  buildMoneyManagerMock(authMock)
)

const prisma = new PrismaClient()
const EPSILON = 0.01

type RoiOverviewModule = typeof import('../roi-overview')
type ResolverModule = typeof import('../metrics-resolver')
type JournalModule = typeof import('../journal-export')
let getRoiOverview: RoiOverviewModule['getRoiOverview']
let resolveMetrics: ResolverModule['resolveMetrics']
let getJournalExport: JournalModule['getJournalExport']

const WINDOW = { startDate: '2026-04-01', endDate: '2026-04-30' }

// Fixture math (flat usage strategy, canon R1):
//   April events (cost 1.5, q 5) + (cost 2.25, q 10) at $2/unit
//     → cost 3.75, tasks 2, costPerTask 1.875, revenue 30, margin 26.25,
//       marginPercent 87.5; the UNCLASSIFIED signal has no GL
//     → unmappedSignalCount 1.
//   May event (cost 0.9, q 3, NO subscription) → cost-only window.
//   June: no events at all → zero-event window.
const APRIL_COST = 3.75
const APRIL_TASKS = 2
const APRIL_REVENUE = 30
const APRIL_MARGIN = 26.25
const APRIL_MARGIN_PCT = 87.5

// Final-day inclusion fixture: the initiative's endDate is stored as a
// full-ISO midnight timestamp — 2026-03-15T00:00:00.000Z — the exact shape
// that would silently truncate a final day if passed through verbatim. One event
// lands ON that calendar day (must be included); one lands just after
// midnight the NEXT day (negative control, must be excluded).
const FINAL_DAY_COST = 4.4
const FINAL_DAY_EVENT_COUNT = 1
const FINAL_DAY_AFTER_COST = 999.99

let orgId: string
let agentId: string
let customerId: string
let customerExternalId: string
let signalId: string
let rawIngestEventId: string
let aprilInitiativeId: string
let zeroEventInitiativeId: string
let costOnlyInitiativeId: string
let longWindowInitiativeId: string
let finalDayInitiativeId: string
// Matter-scope fixture: April's two events split across ONE matter
// and the Unassigned bucket, so a matter-scoped initiative must report less
// than the org-wide April numbers above.
let matterId: string
let orphanMatterId: string
let matterScopedInitiativeId: string
let orphanScopedInitiativeId: string
const MATTER_NUMBER = '2026-0031'
const ORPHAN_MATTER_NUMBER = '2026-0032'
const MATTER_COST = 1.5
const MATTER_EVENT_COUNT = 1
const createdEventIds: string[] = []
const createdPlanIds: string[] = []
const createdStrategyIds: string[] = []
const createdSubscriptionIds: string[] = []

async function seedInitiative(
  name: string,
  startDate: Date,
  endDate: Date,
  targets: Array<{
    metric: string
    targetValue: number
    direction: string
    baselineValue?: number | null
  }>,
  matterScope?: { matterId: string; scopedMatterNumber: string }
): Promise<string> {
  const now = new Date()
  const id = randomUUID()
  await prisma.initiatives.create({
    data: {
      id,
      orgId,
      name,
      status: 'active',
      startDate,
      endDate,
      matterId: matterScope ? matterScope.matterId : null,
      scopedMatterNumber: matterScope ? matterScope.scopedMatterNumber : null,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.initiative_targets.createMany({
    data: targets.map((t) => ({
      id: randomUUID(),
      initiativeId: id,
      metric: t.metric,
      targetValue: t.targetValue,
      baselineValue: t.baselineValue ?? null,
      direction: t.direction,
      createdAt: now,
      updatedAt: now,
    })),
  })
  return id
}

beforeAll(async () => {
  const now = new Date()
  orgId = randomUUID()
  await prisma.organizations.create({
    data: {
      id: orgId,
      name: 'fixture-org-roi-parity',
      createdAt: now,
      updatedAt: now,
    },
  })

  authMock.__setSessionOrgId(orgId)
  ;({ getRoiOverview } = await import('../roi-overview'))
  ;({ resolveMetrics } = await import('../metrics-resolver'))
  ;({ getJournalExport } = await import('../journal-export'))

  agentId = randomUUID()
  await prisma.agents.create({
    data: {
      id: agentId,
      name: 'agent',
      agentCode: 'agent',
      orgId,
      createdAt: now,
      updatedAt: now,
    },
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

  // UNCLASSIFIED with no GL mapping — stays in the journal's __unmapped
  // bucket, so unmappedSignalCount reads 1 for any window with its events.
  signalId = randomUUID()
  await prisma.signals.create({
    data: {
      id: signalId,
      name: 'signal',
      agentId,
      orgId,
      costCategory: 'UNCLASSIFIED',
      createdAt: now,
      updatedAt: now,
    },
  })

  matterId = randomUUID()
  orphanMatterId = randomUUID()
  await prisma.matters.createMany({
    data: [
      {
        id: matterId,
        orgId,
        matterNumber: MATTER_NUMBER,
        name: 'test-matter-scope',
        clientName: 'test-client',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: orphanMatterId,
        orgId,
        matterNumber: ORPHAN_MATTER_NUMBER,
        name: 'test-matter-to-delete',
        clientName: 'test-client',
        createdAt: now,
        updatedAt: now,
      },
    ],
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
      rate: 2.0,
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

  const seedEvent = async (
    usageDate: Date,
    usageCost: number,
    quantity: number,
    withSubscription: boolean,
    eventMatterId: string | null = null
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
        subscriptionId: withSubscription ? subscriptionId : null,
        rawIngestEventId,
        usageDate,
        usageCost,
        quantity,
        matterId: eventMatterId,
        matterSource: eventMatterId ? 'manual' : null,
        environment: 'production',
        idempotencyKey: `event-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdEventIds.push(id)
  }
  // Only the FIRST April event carries the matter; the second stays
  // Unassigned, so a matter-scoped read must come back smaller than org-wide.
  await seedEvent(new Date('2026-04-10T12:00:00.000Z'), 1.5, 5, true, matterId)
  await seedEvent(new Date('2026-04-12T12:00:00.000Z'), 2.25, 10, true)
  // Cost-only: no subscription ⇒ cost lands, revenue stays 0 for May.
  await seedEvent(new Date('2026-05-10T12:00:00.000Z'), 0.9, 3, false)
  // Final-day inclusion fixture: ON the initiative's stored-midnight endDate.
  await seedEvent(new Date('2026-03-15T18:00:00.000Z'), FINAL_DAY_COST, 1, true)
  // Negative control: just after midnight the NEXT calendar day.
  await seedEvent(
    new Date('2026-03-16T00:30:00.000Z'),
    FINAL_DAY_AFTER_COST,
    1,
    true
  )

  // Initiative windows resolve to the SAME bounds resolveMetrics derives
  // from WINDOW (full-ISO passthrough === bare-date + suffix).
  const aprilStart = new Date('2026-04-01T00:00:00.000Z')
  const aprilEnd = new Date('2026-04-30T23:59:59.999Z')
  aprilInitiativeId = await seedInitiative(
    'april-all-metrics',
    aprilStart,
    aprilEnd,
    [
      { metric: 'cost', targetValue: 2, direction: 'lte', baselineValue: 10 },
      { metric: 'eventCount', targetValue: 100, direction: 'gte' },
      { metric: 'costPerTask', targetValue: 1, direction: 'lte' },
      { metric: 'revenue', targetValue: 100, direction: 'gte' },
      { metric: 'margin', targetValue: 100, direction: 'gte' },
      { metric: 'marginPercent', targetValue: 90, direction: 'gte' },
      { metric: 'unmappedCount', targetValue: 0, direction: 'lte' },
    ]
  )
  zeroEventInitiativeId = await seedInitiative(
    'june-zero-events',
    new Date('2026-06-01T00:00:00.000Z'),
    new Date('2026-06-30T23:59:59.999Z'),
    [{ metric: 'costPerTask', targetValue: 1, direction: 'lte' }]
  )
  costOnlyInitiativeId = await seedInitiative(
    'may-cost-only',
    new Date('2026-05-01T00:00:00.000Z'),
    new Date('2026-05-31T23:59:59.999Z'),
    [{ metric: 'marginPercent', targetValue: 50, direction: 'gte' }]
  )
  // 120 inclusive UTC days — over the ROI_UNMAPPED_WINDOW_MAX_DAYS = 92 cap.
  longWindowInitiativeId = await seedInitiative(
    'long-window-unmapped',
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-04-30T23:59:59.999Z'),
    [{ metric: 'unmappedCount', targetValue: 0, direction: 'lte' }]
  )
  // startDate/endDate BOTH stored as full-ISO midnight. Verbatim passthrough
  // would make windowEnd
  // 2026-03-15T00:00:00.000Z, excluding the 18:00 on-day event too.
  finalDayInitiativeId = await seedInitiative(
    'final-day-inclusion',
    new Date('2026-03-15T00:00:00.000Z'),
    new Date('2026-03-15T00:00:00.000Z'),
    [
      { metric: 'cost', targetValue: 1000, direction: 'lte' },
      { metric: 'eventCount', targetValue: 100, direction: 'gte' },
    ]
  )

  // The SAME April window as aprilInitiativeId, scoped to one
  // matter, carrying every metric family so the null rule is provable.
  matterScopedInitiativeId = await seedInitiative(
    'test-april-matter-scoped',
    aprilStart,
    aprilEnd,
    [
      { metric: 'cost', targetValue: 2, direction: 'lte' },
      { metric: 'eventCount', targetValue: 100, direction: 'gte' },
      { metric: 'costPerTask', targetValue: 1, direction: 'lte' },
      { metric: 'revenue', targetValue: 100, direction: 'gte' },
      { metric: 'margin', targetValue: 100, direction: 'gte' },
      { metric: 'marginPercent', targetValue: 90, direction: 'gte' },
      { metric: 'unmappedCount', targetValue: 0, direction: 'lte' },
      { metric: 'newCustomers', targetValue: 5, direction: 'gte' },
    ],
    { matterId, scopedMatterNumber: MATTER_NUMBER }
  )
  orphanScopedInitiativeId = await seedInitiative(
    'test-april-matter-deleted',
    aprilStart,
    aprilEnd,
    [
      { metric: 'cost', targetValue: 2, direction: 'lte' },
      { metric: 'eventCount', targetValue: 100, direction: 'gte' },
    ],
    { matterId: orphanMatterId, scopedMatterNumber: ORPHAN_MATTER_NUMBER }
  )
})

afterAll(async () => {
  await prisma.initiative_targets.deleteMany({
    where: { initiatives: { orgId } },
  })
  await prisma.initiatives.deleteMany({ where: { orgId } })
  await prisma.signal_events.deleteMany({
    where: { id: { in: createdEventIds } },
  })
  await prisma.subscriptions.deleteMany({
    where: { id: { in: createdSubscriptionIds } },
  })
  await prisma.pricing_strategies.deleteMany({
    where: { id: { in: createdStrategyIds } },
  })
  await prisma.pricing_plans.deleteMany({
    where: { id: { in: createdPlanIds } },
  })
  await prisma.matters.deleteMany({ where: { orgId } })
  await prisma.signals.deleteMany({ where: { orgId } })
  await prisma.raw_ingest_events.deleteMany({
    where: { id: rawIngestEventId },
  })
  await prisma.customers.deleteMany({ where: { id: customerId } })
  await prisma.agents.deleteMany({ where: { orgId } })
  await prisma.organizations.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

function targetsByMetric(
  overview: Awaited<ReturnType<RoiOverviewModule['getRoiOverview']>>,
  initiativeId: string
) {
  const view = overview.data!.initiatives.find((i) => i.id === initiativeId)!
  expect(view).toBeDefined()
  return new Map(view.targets.map((t) => [t.metric, t]))
}

describe('ROI parity invariant — card actuals ≡ resolveMetrics scope-roi tiles', () => {
  it('the fixture produces the numbers the invariant depends on (guards the guard)', async () => {
    const overview = await getRoiOverview()
    expect(overview.success).toBe(true)
    const targets = targetsByMetric(overview, aprilInitiativeId)

    expect(
      Math.abs(targets.get('cost')!.actual! - APRIL_COST)
    ).toBeLessThanOrEqual(EPSILON)
    expect(targets.get('eventCount')!.actual).toBe(APRIL_TASKS)
    expect(
      Math.abs(targets.get('costPerTask')!.actual! - APRIL_COST / APRIL_TASKS)
    ).toBeLessThanOrEqual(EPSILON)
    expect(
      Math.abs(targets.get('revenue')!.actual! - APRIL_REVENUE)
    ).toBeLessThanOrEqual(EPSILON)
    expect(
      Math.abs(targets.get('margin')!.actual! - APRIL_MARGIN)
    ).toBeLessThanOrEqual(EPSILON)
    expect(
      Math.abs(targets.get('marginPercent')!.actual! - APRIL_MARGIN_PCT)
    ).toBeLessThanOrEqual(EPSILON)
  })

  it('all six metric actuals equal the scope-roi resolver tiles for the same window', async () => {
    const [overview, resolved] = await Promise.all([
      getRoiOverview(),
      resolveMetrics({
        scope: 'roi',
        period: WINDOW,
        dimension: 'day',
        filters: {},
      }),
    ])
    expect(overview.success).toBe(true)
    expect(resolved.success).toBe(true)

    const targets = targetsByMetric(overview, aprilInitiativeId)
    const tiles = resolved.data!.tiles

    expect(
      Math.abs(targets.get('cost')!.actual! - tiles.cost)
    ).toBeLessThanOrEqual(EPSILON)
    expect(targets.get('eventCount')!.actual).toBe(tiles.eventCount)
    expect(
      Math.abs(targets.get('costPerTask')!.actual! - tiles.costPerTask!)
    ).toBeLessThanOrEqual(EPSILON)
    expect(
      Math.abs(targets.get('revenue')!.actual! - tiles.revenue!)
    ).toBeLessThanOrEqual(EPSILON)
    expect(
      Math.abs(targets.get('margin')!.actual! - tiles.margin!)
    ).toBeLessThanOrEqual(EPSILON)
    expect(
      Math.abs(targets.get('marginPercent')!.actual! - tiles.marginPercent!)
    ).toBeLessThanOrEqual(EPSILON)
  })

  it('the stored baseline round-trips out of the DB onto the card view', async () => {
    const overview = await getRoiOverview()
    const cost = targetsByMetric(overview, aprilInitiativeId).get('cost')!
    expect(cost.baseline).toBe(10)
    // Spend is a running total, so the bar reads against the cap: $3.75 spent
    // against a $2 cap is the full bar and an unmet goal. The baseline is the
    // "Last window" line beside it, which is why it still has to round-trip.
    expect(cost.progressPct).toBe(100)
    expect(cost.met).toBe(false)
  })

  it('a level target still measures from the stored baseline', async () => {
    const overview = await getRoiOverview()
    const perEvent = targetsByMetric(overview, aprilInitiativeId).get(
      'costPerTask'
    )!
    expect(perEvent.actual).not.toBeNull()
    // No baseline on this one, so the honest proximity gauge: target / actual.
    expect(perEvent.progressPct).toBeCloseTo((1 / perEvent.actual!) * 100, 6)
  })

  it('zero-event window ⇒ costPerTask actual null (canon M2, never 0)', async () => {
    const overview = await getRoiOverview()
    const cpt = targetsByMetric(overview, zeroEventInitiativeId).get(
      'costPerTask'
    )!
    expect(cpt.actual).toBeNull()
    expect(cpt.progressPct).toBeNull()
    expect(cpt.met).toBeNull()
  })

  it('cost-only window ⇒ marginPercent actual null AND derived progress null (M1 flows to M2)', async () => {
    const overview = await getRoiOverview()
    const mp = targetsByMetric(overview, costOnlyInitiativeId).get(
      'marginPercent'
    )!
    expect(mp.actual).toBeNull()
    expect(mp.progressPct).toBeNull()
    expect(mp.met).toBeNull()
  })
})

describe('unmappedCount source + 92-day cap', () => {
  it('unmappedCount actual === getJournalExport(window).unmappedSignalCount', async () => {
    const [overview, journal] = await Promise.all([
      getRoiOverview(),
      getJournalExport(WINDOW),
    ])
    const unmapped = targetsByMetric(overview, aprilInitiativeId).get(
      'unmappedCount'
    )!
    expect(journal).not.toBeNull()
    expect(journal!.unmappedSignalCount).toBe(1)
    expect(unmapped.actual).toBe(journal!.unmappedSignalCount)
  })

  it('a 93+-day window reads null, never a fake value (the unbounded-engine cap)', async () => {
    const overview = await getRoiOverview()
    const unmapped = targetsByMetric(overview, longWindowInitiativeId).get(
      'unmappedCount'
    )!
    expect(unmapped.actual).toBeNull()
    expect(unmapped.progressPct).toBeNull()
    expect(unmapped.met).toBeNull()
  })
})

describe('Final-day inclusion — stored-midnight endDate covers its own calendar day', () => {
  it('includes the on-day event and excludes the day-after event in the card actual', async () => {
    const overview = await getRoiOverview()
    expect(overview.success).toBe(true)
    const targets = targetsByMetric(overview, finalDayInitiativeId)
    const cost = targets.get('cost')!
    const eventCount = targets.get('eventCount')!

    // Verbatim passthrough of the stored midnight endDate would make
    // windowEnd 2026-03-15T00:00:00.000Z, dropping the 18:00 on-day event
    // and reading 0/null here instead.
    expect(eventCount.actual).toBe(FINAL_DAY_EVENT_COUNT)
    expect(Math.abs(cost.actual! - FINAL_DAY_COST)).toBeLessThanOrEqual(EPSILON)
  })
})

describe('a matter-scoped initiative reports that matter only', () => {
  it('cost and eventCount equal getMatterCostRollups for the SAME window, and are less than org-wide', async () => {
    const [overview, rollups] = await Promise.all([
      getRoiOverview(),
      getMatterCostRollups(prisma, orgId, {
        matterIds: [matterId],
        window: {
          start: new Date('2026-04-01T00:00:00.000Z'),
          end: new Date('2026-04-30T23:59:59.999Z'),
        },
      }),
    ])
    expect(overview.success).toBe(true)
    const targets = targetsByMetric(overview, matterScopedInitiativeId)
    const rollup = rollups[0]!

    expect(rollup.cost).toBeCloseTo(MATTER_COST, 6)
    expect(rollup.eventCount).toBe(MATTER_EVENT_COUNT)
    expect(targets.get('cost')!.actual).toBeCloseTo(rollup.cost, 6)
    expect(targets.get('eventCount')!.actual).toBe(rollup.eventCount)
    expect(targets.get('costPerTask')!.actual).toBeCloseTo(
      rollup.cost / rollup.eventCount,
      6
    )

    // The scope is doing real work: the org-wide initiative over the same
    // window reads the other April event too.
    const orgWide = targetsByMetric(overview, aprilInitiativeId)
    expect(targets.get('cost')!.actual!).toBeLessThan(
      orgWide.get('cost')!.actual!
    )
    expect(targets.get('eventCount')!.actual!).toBeLessThan(
      orgWide.get('eventCount')!.actual!
    )
  })

  it('every metric a matter cannot answer is null, never 0', async () => {
    const overview = await getRoiOverview()
    const targets = targetsByMetric(overview, matterScopedInitiativeId)
    for (const metric of [
      'revenue',
      'margin',
      'marginPercent',
      'unmappedCount',
      'newCustomers',
    ] as const) {
      expect(targets.get(metric)!.actual).toBeNull()
      expect(targets.get(metric)!.progressPct).toBeNull()
      expect(targets.get(metric)!.met).toBeNull()
    }
    // The org-wide twin over the same window DOES answer them — proof the
    // nulls are the scope talking, not an empty fixture.
    const orgWide = targetsByMetric(overview, aprilInitiativeId)
    expect(orgWide.get('revenue')!.actual).not.toBeNull()
    expect(orgWide.get('unmappedCount')!.actual).not.toBeNull()
  })

  it('deleting the matter leaves the initiative unscoped and reading org-wide again', async () => {
    const before = targetsByMetric(
      await getRoiOverview(),
      orphanScopedInitiativeId
    )
    expect(before.get('eventCount')!.actual).toBe(0)

    await prisma.matters.delete({ where: { id: orphanMatterId } })

    const row = await prisma.initiatives.findUnique({
      where: { id: orphanScopedInitiativeId },
      select: { matterId: true, scopedMatterNumber: true },
    })
    // SET NULL clears the id; the recorded number survives, which is the only
    // thing that lets the card say the matter is gone.
    expect(row!.matterId).toBeNull()
    expect(row!.scopedMatterNumber).toBe(ORPHAN_MATTER_NUMBER)

    const after = targetsByMetric(
      await getRoiOverview(),
      orphanScopedInitiativeId
    )
    const orgWide = targetsByMetric(await getRoiOverview(), aprilInitiativeId)
    expect(after.get('eventCount')!.actual).toBe(
      orgWide.get('eventCount')!.actual
    )
    expect(after.get('cost')!.actual).toBeCloseTo(
      orgWide.get('cost')!.actual!,
      6
    )
  })
})
