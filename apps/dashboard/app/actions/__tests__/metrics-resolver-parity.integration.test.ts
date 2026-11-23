/**
 * DB-GATED: needs DATABASE_URL pointing at a throwaway Postgres. Follows
 * the established apps/dashboard/app/actions/__tests__/*.integration.test.ts
 * conventions exactly (see mrr-contract-value.integration.test.ts): reuse
 * the sample test organization via getSampleOrgIdForTests(), seed an
 * ADDITIVE fixture scoped by a unique customerId filter so the org's
 * pre-existing data can't pollute the parity numbers, clean up in afterAll.
 *
 * Resolver parity:
 *   For the same (orgId, window, filters), resolveMetrics' tile values must
 *   equal the DIRECT canon function outputs it composes (getCostMetrics /
 *   getRevenueMetrics / getMrr — the resolver's own getCostBreakdown call is
 *   the SQL twin of getCostMetrics, so comparing tiles.cost
 *   against an independent getCostMetrics() call is the actual SQL-vs-Map
 *   parity proof, not a tautology). Chart-vs-table equality
 *   (Σ series[].cost === tiles.cost === Σ breakdown.rows[].cost +
 *   (other?.cost ?? 0)) holds by construction (one transaction snapshot,
 *   one snapshot), asserted directly against the resolver's own response.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { getCostMetrics, getRevenueMetrics, getMrr } from '@marginfront/db'
import { getSampleOrgIdForTests, buildAuthMock, buildHeadersMock } from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

const prisma = new PrismaClient()
const EPSILON = 0.01

let orgId: string
let customerId: string
let agentId: string
let signalId: string
let subscriptionId: string
let planId: string
let strategyId: string
const createdEventIds: string[] = []

const WINDOW_START = '2026-04-01'
const WINDOW_END = '2026-04-05'

type ResolverModule = typeof import('../metrics-resolver')
let resolveMetrics: ResolverModule['resolveMetrics']

beforeAll(async () => {
  orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  ;({ resolveMetrics } = await import('../metrics-resolver'))

  const agent = await prisma.agents.findFirst({
    where: { orgId, deletedAt: null },
    select: { id: true },
  })
  if (!agent) throw new Error('The test organization has no agents — re-run seed.')
  agentId = agent.id

  const sig = await prisma.signals.findFirst({
    where: { orgId, deletedAt: null },
    select: { id: true },
  })
  if (!sig) throw new Error('The test organization has no signals — re-run seed.')
  signalId = sig.id

  // Borrow rawIngestEventId from any existing event in the org (the same
  // pattern as full-command-center-cost-canon-parity.integration.
  // test.ts) rather than fabricating a raw_ingest_events row: the FK is not
  // semantically tied to which subscription an event belongs to.
  const template = await prisma.signal_events.findFirst({
    where: { organizationId: orgId },
    select: { rawIngestEventId: true },
  })
  if (!template) throw new Error('The test organization has no signal_events to template rawIngestEventId from.')

  const now = new Date()

  // A FRESH customer — never a borrowed one. getRevenueMetrics scopes subs
  // by customerId, so a pre-existing sample customer brings its own live
  // subscription's in-window events along, and their revenue lands on top of
  // this fixture's $34. A customer created by this suite is the only way the
  // customerId filter genuinely isolates the math.
  customerId = randomUUID()
  const customerExternalId = `test-${customerId.slice(0, 8)}`
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: `resolver parity customer ${customerId.slice(0, 8)}`,
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })

  // Isolated plan/strategy/subscription so this fixture's revenue math is
  // fully known (no interference from the org's other pricing).
  planId = randomUUID()
  await prisma.pricing_plans.create({
    data: {
      id: planId,
      orgId,
      agentId,
      name: `resolver parity ${planId.slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
    },
  })
  strategyId = randomUUID()
  await prisma.pricing_strategies.create({
    data: {
      id: strategyId,
      planId,
      orgId,
      agentId,
      signalId,
      name: `resolver parity strat ${strategyId.slice(0, 8)}`,
      chargeType: 'usage',
      pricingModel: 'flat',
      rate: 2.0,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
  })
  subscriptionId = randomUUID()
  const farFuture = new Date('2099-12-31T00:00:00Z')
  await prisma.subscriptions.create({
    data: {
      id: subscriptionId,
      organizationId: orgId,
      customerId,
      agentId,
      planId,
      name: `resolver parity sub ${subscriptionId.slice(0, 8)}`,
      status: 'active',
      billingCycle: 'monthly',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      nextRecurringInvoiceAt: farFuture,
      nextUsageInvoiceAt: farFuture,
      createdAt: now,
      updatedAt: now,
    },
  })

  const seedEvent = async (day: number, usageCost: number, quantity: number) => {
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
        rawIngestEventId: template.rawIngestEventId,
        usageDate: new Date(`2026-04-0${day}T12:00:00.000Z`),
        usageCost,
        quantity,
        environment: 'production',
        idempotencyKey: `resolver-parity-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdEventIds.push(id)
  }
  await seedEvent(1, 1.5, 5)
  await seedEvent(2, 2.25, 10)
  await seedEvent(3, 0.75, 2)
})

afterAll(async () => {
  await prisma.signal_events.deleteMany({ where: { id: { in: createdEventIds } } })
  await prisma.subscriptions.deleteMany({ where: { id: subscriptionId } })
  await prisma.pricing_strategies.deleteMany({ where: { id: strategyId } })
  await prisma.pricing_plans.deleteMany({ where: { id: planId } })
  await prisma.customers.deleteMany({ where: { id: customerId } })
  await prisma.$disconnect()
})

describe('resolveMetrics — tile parity against direct canon calls', () => {
  it('tiles.cost/eventCount match an independent getCostMetrics call (the SQL-vs-Map parity proof)', async () => {
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: { customerId },
    })
    expect(res.success).toBe(true)
    const window = { start: res.data!.window.start, end: res.data!.window.end }

    const direct = await getCostMetrics(prisma as any, orgId, window, { customerId })
    expect(Math.abs(res.data!.tiles.cost - direct.cost)).toBeLessThanOrEqual(EPSILON)
    expect(res.data!.tiles.eventCount).toBe(direct.eventCount)
  })

  it('tiles.revenue/usageRevenue/margin match an independent getRevenueMetrics call', async () => {
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: { customerId },
    })
    const window = { start: res.data!.window.start, end: res.data!.window.end }
    const direct = await getRevenueMetrics(prisma as any, orgId, window, { customerId })

    expect(Math.abs(res.data!.tiles.revenue! - direct.revenue)).toBeLessThanOrEqual(EPSILON)
    expect(Math.abs(res.data!.tiles.usageRevenue! - direct.usageRevenue)).toBeLessThanOrEqual(
      EPSILON
    )
    expect(Math.abs(res.data!.tiles.margin! - direct.margin)).toBeLessThanOrEqual(EPSILON)
    // Independent recompute of THIS fixture's revenue: flat strategy at
    // $2/unit over quantities 5 + 10 + 2 = 17 units -> $34 (canon R1, no
    // tiers, no minimumCommitment). Valid ONLY because the customer is
    // created by this suite — see the beforeAll comment.
    expect(direct.usageRevenue).toBeCloseTo(34, 6)
  })

  it('tiles.mrr/arr match an independent getMrr call', async () => {
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: { customerId },
    })
    const direct = await getMrr(prisma as any, orgId, { customerId })
    expect(Math.abs(res.data!.tiles.mrr! - direct.mrr)).toBeLessThanOrEqual(EPSILON)
    expect(Math.abs(res.data!.tiles.arr! - direct.arr)).toBeLessThanOrEqual(EPSILON)
  })

  it('chart-vs-table equality holds by construction: totals === series sum === rows + other', async () => {
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: { customerId },
    })
    const data = res.data!

    const seriesCost = data.series.reduce((s, r) => s + r.cost, 0)
    const seriesEvents = data.series.reduce((s, r) => s + r.eventCount, 0)
    expect(Math.abs(seriesCost - data.tiles.cost)).toBeLessThanOrEqual(EPSILON)
    expect(seriesEvents).toBe(data.tiles.eventCount)

    const rowsCost = data.breakdown.rows.reduce((s, r) => s + r.cost, 0) + (data.breakdown.other?.cost ?? 0)
    const rowsEvents =
      data.breakdown.rows.reduce((s, r) => s + r.eventCount, 0) +
      (data.breakdown.other?.eventCount ?? 0)
    expect(Math.abs(rowsCost - data.tiles.cost)).toBeLessThanOrEqual(EPSILON)
    expect(rowsEvents).toBe(data.tiles.eventCount)
  })

  it('earnedSeries sums to the same total as an independent getRevenueMetrics call (accurate aggregate, not per-event math)', async () => {
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: { customerId },
    })
    expect(res.success).toBe(true)
    const data = res.data!
    expect(data.earnedSeries).not.toBeNull()

    // This fixture's revenue is 100% usage-based (a single flat 'usage'
    // strategy, no recurring/seat/onetime charges — see beforeAll), so
    // per-day sums recombine to the exact whole-window total: usage revenue
    // is rate × quantity, and quantity partitions cleanly by day. This does
    // NOT generalize to recurring/seat charges, whose proration is computed
    // once over the whole window, not re-derived identically per day.
    const seriesEarned = data.earnedSeries!.reduce((s, r) => s + r.earned, 0)
    expect(Math.abs(seriesEarned - data.tiles.revenue!)).toBeLessThanOrEqual(EPSILON)

    // One row per UTC day in [windowStart, windowEnd] — WINDOW_START/END is
    // a 5-day span (2026-04-01 through 2026-04-05).
    expect(data.earnedSeries!.length).toBe(5)
  })

  it('earnedSeries is null for a scope whose SCOPE_TILE_SOURCES entry does not compute revenue', async () => {
    const res = await resolveMetrics({
      scope: 'build',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: { customerId },
    })
    expect(res.success).toBe(true)
    expect(res.data!.earnedSeries).toBeNull()
  })

  it('earnedSeries is null when the window exceeds 92 days (honest cost-only fallback)', async () => {
    const res = await resolveMetrics({
      scope: 'money',
      period: { startDate: '2026-01-01', endDate: '2026-06-01' },
      dimension: 'agent',
      filters: { customerId },
    })
    expect(res.success).toBe(true)
    expect(res.data!.earnedSeries).toBeNull()
  })

  it('build scope requests earned but not revenue/invoices/mrr tiles', async () => {
    const res = await resolveMetrics({
      scope: 'build',
      period: { startDate: WINDOW_START, endDate: WINDOW_END },
      dimension: 'agent',
      filters: { customerId },
    })
    expect(res.success).toBe(true)
    expect(res.data!.tiles.earned).toBeDefined()
    expect(res.data!.tiles.revenue).toBeUndefined()
    expect(res.data!.tiles.billed).toBeUndefined()
    expect(res.data!.tiles.mrr).toBeUndefined()
  })
})
