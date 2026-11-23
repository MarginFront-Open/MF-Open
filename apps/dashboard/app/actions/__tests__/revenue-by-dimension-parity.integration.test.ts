/**
 * DB-GATED — needs packages/db/.env pointing at a test Postgres database (same
 * as the other *.integration.test.ts). Reuses the seeded test organization via
 * getSampleOrgIdForTests(), but seeds an ADDITIVE fixture isolated by a fresh
 * customerId AND a dedicated fixture agent + signal (not borrowed from the
 * test organization) so ambient data can never land in the same bucket, clean up in
 * afterAll.
 *
 * THE parity guarantee: getRevenueByDimension's per-bucket
 * revenue EQUALS getFullCommandCenterBreakdown (the XLSX path) for the same
 * window + dimension:
 *   - agent / signal → Earned (earnedForEvent → calcRouted)
 *   - customer / plan → Billed (SUM invoice.totalAmount)
 * Plus the honest-null contract (model/environment/day/costCategory → null)
 * and the basis
 * tags. Anti-tautology: the fixture's earned ($34, flat $2 × 17 units) and
 * billed ($500, one issued invoice) are independently known, so a grouping bug
 * swings a bucket off its known value and FAILS.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { getAgentEarned } from '@marginfront/db'
import {
  getSampleOrgIdForTests,
  buildAuthMock,
  buildHeadersMock,
} from './_helpers/mock-session'
import { getRevenueByDimension } from '../_shared/revenue-by-dimension'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

const prisma = new PrismaClient()
const EPSILON = 0.01

const WINDOW_START = '2026-04-01'
const WINDOW_END = '2026-04-05'
const WINDOW = {
  start: new Date(`${WINDOW_START}T00:00:00.000Z`),
  end: new Date(`${WINDOW_END}T23:59:59.999Z`),
}
const EXPECTED_EARNED = 34 // flat $2/unit × (5 + 10 + 2) units
const EXPECTED_BILLED = 500 // one issued invoice in the window

let orgId: string
let customerId: string
let customerName: string
let agentId: string
let agentName: string
let signalId: string
let signalName: string
let planId: string
let planName: string
let subscriptionId: string
let strategyId: string
let invoiceId: string
const createdEventIds: string[] = []

type FullModule = typeof import('../full-command-center')
let getFullCommandCenterBreakdown: FullModule['getFullCommandCenterBreakdown']

beforeAll(async () => {
  orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  ;({ getFullCommandCenterBreakdown } = await import('../full-command-center'))

  const template = await prisma.signal_events.findFirst({
    where: { organizationId: orgId },
    select: { rawIngestEventId: true },
  })
  if (!template)
    throw new Error('The test organization has no signal_events to template from.')

  const now = new Date()

  // Dedicated fixture agent + signal (not borrowed from the test organization) so
  // ambient sample events sharing a real agent/signal can never land in the
  // same bucket as this fixture's events.
  agentId = randomUUID()
  agentName = `dimension parity agent ${agentId.slice(0, 8)}`
  await prisma.agents.create({
    data: {
      id: agentId,
      name: agentName,
      agentCode: `test-agent-${agentId.slice(0, 8)}`,
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })

  signalId = randomUUID()
  signalName = `dimension parity signal ${signalId.slice(0, 8)}`
  await prisma.signals.create({
    data: {
      id: signalId,
      name: signalName,
      agentId,
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })

  customerId = randomUUID()
  customerName = `dimension parity customer ${customerId.slice(0, 8)}`
  const customerExternalId = `test-${customerId.slice(0, 8)}`
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: customerName,
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })

  planId = randomUUID()
  planName = `dimension parity plan ${planId.slice(0, 8)}`
  await prisma.pricing_plans.create({
    data: {
      id: planId,
      orgId,
      agentId,
      name: planName,
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
      name: `dimension parity strat ${strategyId.slice(0, 8)}`,
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
      name: `dimension parity sub ${subscriptionId.slice(0, 8)}`,
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
        idempotencyKey: `dimension-parity-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    createdEventIds.push(id)
  }
  await seedEvent(1, 1.5, 5)
  await seedEvent(2, 2.25, 10)
  await seedEvent(3, 0.75, 2)

  // One issued invoice inside the window → Billed = $500 for this customer AND
  // this plan (via the invoice's subscription.planId).
  invoiceId = randomUUID()
  const invoiceDate = new Date('2026-04-02T12:00:00.000Z')
  await prisma.invoices.create({
    data: {
      id: invoiceId,
      customerId,
      subscriptionId,
      organizationId: orgId,
      invoiceDate,
      dueDate: new Date('2026-05-02T12:00:00.000Z'),
      billingPeriodStart: WINDOW.start,
      billingPeriodEnd: WINDOW.end,
      totalAmount: EXPECTED_BILLED,
      subtotal: EXPECTED_BILLED,
      status: 'issued',
      invoiceNumber: `dimension-parity-${invoiceId.slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
    },
  })
})

afterAll(async () => {
  await prisma.invoices.deleteMany({ where: { id: invoiceId } })
  await prisma.signal_events.deleteMany({
    where: { id: { in: createdEventIds } },
  })
  await prisma.subscriptions.deleteMany({ where: { id: subscriptionId } })
  await prisma.pricing_strategies.deleteMany({ where: { id: strategyId } })
  await prisma.pricing_plans.deleteMany({ where: { id: planId } })
  await prisma.customers.deleteMany({ where: { id: customerId } })
  await prisma.signals.deleteMany({ where: { id: signalId } })
  await prisma.agents.deleteMany({ where: { id: agentId } })
  await prisma.$disconnect()
})

describe('getRevenueByDimension — parity with getFullCommandCenterBreakdown', () => {
  // Built lazily: describe() bodies run at collection time, before beforeAll
  // populates customerId, so a plain `{ customerId }` object here would
  // freeze in the pre-beforeAll `undefined` and silently stop filtering.
  const filters = () => ({ customerId })
  const breakdownFilters = () => ({
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    customerId,
  })

  it('agent → Earned equals the XLSX Agent tab AND the known $34', async () => {
    const mine = await getRevenueByDimension(
      prisma,
      orgId,
      WINDOW,
      'agent',
      filters()
    )
    expect(mine?.basis).toBe('earned')
    expect(mine?.byKey.get(agentId)).toBeCloseTo(EXPECTED_EARNED, 2)

    const full = await getFullCommandCenterBreakdown(breakdownFilters())
    const agentRow = full.agent.find((row) => row.name === agentName)
    expect(agentRow).toBeDefined()
    expect(
      Math.abs((mine?.byKey.get(agentId) ?? 0) - agentRow!.revenue)
    ).toBeLessThanOrEqual(EPSILON)
  })

  it('signal → Earned equals the XLSX Task tab AND the known $34', async () => {
    const mine = await getRevenueByDimension(
      prisma,
      orgId,
      WINDOW,
      'signal',
      filters()
    )
    expect(mine?.basis).toBe('earned')
    expect(mine?.byKey.get(signalId)).toBeCloseTo(EXPECTED_EARNED, 2)

    const full = await getFullCommandCenterBreakdown(breakdownFilters())
    const taskRow = full.task.find((row) => row.name === signalName)
    expect(taskRow).toBeDefined()
    expect(
      Math.abs((mine?.byKey.get(signalId) ?? 0) - taskRow!.revenue)
    ).toBeLessThanOrEqual(EPSILON)
  })

  it('customer → Billed equals the XLSX Customer tab AND the known $500', async () => {
    const mine = await getRevenueByDimension(
      prisma,
      orgId,
      WINDOW,
      'customer',
      filters()
    )
    expect(mine?.basis).toBe('billed')
    expect(mine?.byKey.get(customerId)).toBeCloseTo(EXPECTED_BILLED, 2)

    const full = await getFullCommandCenterBreakdown(breakdownFilters())
    const custRow = full.customer.find((row) => row.name === customerName)
    expect(custRow).toBeDefined()
    expect(
      Math.abs((mine?.byKey.get(customerId) ?? 0) - custRow!.revenue)
    ).toBeLessThanOrEqual(EPSILON)
  })

  it('plan → Billed equals the XLSX Plan tab AND the known $500', async () => {
    const mine = await getRevenueByDimension(
      prisma,
      orgId,
      WINDOW,
      'plan',
      filters()
    )
    expect(mine?.basis).toBe('billed')
    expect(mine?.byKey.get(planId)).toBeCloseTo(EXPECTED_BILLED, 2)

    const full = await getFullCommandCenterBreakdown(breakdownFilters())
    const planRow = full.plan.find((row) => row.name === planName)
    expect(planRow).toBeDefined()
    expect(
      Math.abs((mine?.byKey.get(planId) ?? 0) - planRow!.revenue)
    ).toBeLessThanOrEqual(EPSILON)
  })

  it('model / environment / day / costCategory carry NO revenue (honest null, never fabricated)', async () => {
    for (const dimension of ['model', 'environment', 'day', 'costCategory'] as const) {
      const result = await getRevenueByDimension(
        prisma,
        orgId,
        WINDOW,
        dimension,
        filters()
      )
      expect(result).toBeNull()
    }
  })
})

// ─── canon bucket vs per-event divergence ───
//
// The parity fixture above is flat ($2/unit), where per-event pricing and canon
// bucket pricing agree, so it can't tell them apart. These three fixtures each
// price to a DIFFERENT number under per-event vs canon:
//   A. graduated tiers CROSS only when the window's events are summed first
//      (3×100 units → $200 bucketed, $300 per-event).
//   B. a minimum-commitment floor only lifts the window total, never a lone
//      event (200 units, floor 1000 @ $0.10 → $100 bucketed, $20 per-event).
//   C. a cancelled sub keeps its earned via canon's date-overlap resolution,
//      but the per-event path builds strategies from ACTIVE subs only ($100
//      bucketed, $0 per-event).
// Each case asserts three numbers agree AND equal the independently-known
// dollar figure: getRevenueByDimension, getFullCommandCenterBreakdown (the XLSX
// path), and getAgentEarned (the canon anchor). Each uses its OWN dedicated
// agent/signal/customer/plan/sub, seeded + torn down in isolation, in the same
// historical April window (clear of any "last 30 days" surface).

interface EarnedFixture {
  agentId: string
  agentName: string
  signalId: string
  signalName: string
  customerId: string
  planId: string
  subscriptionId: string
  strategyId: string
  eventIds: string[]
}

async function seedEarnedFixture(opts: {
  label: string
  pricingModel: 'flat' | 'graduated'
  rate: number
  tiers?: Array<{ lower: number; upper: number | null; rate: number }>
  minimumCommitment?: number | null
  subStatus: 'active' | 'canceled'
  eventQuantities: number[]
}): Promise<EarnedFixture> {
  const template = await prisma.signal_events.findFirst({
    where: { organizationId: orgId },
    select: { rawIngestEventId: true },
  })
  if (!template)
    throw new Error('The test organization has no signal_events to template from.')

  const now = new Date()
  const agentId = randomUUID()
  const agentName = `dimension parity ${opts.label} agent ${agentId.slice(0, 8)}`
  const signalId = randomUUID()
  const signalName = `dimension parity ${opts.label} signal ${signalId.slice(0, 8)}`
  const customerId = randomUUID()
  const customerExternalId = `test-${opts.label}-${customerId.slice(0, 8)}`
  const planId = randomUUID()
  const strategyId = randomUUID()
  const subscriptionId = randomUUID()
  const farFuture = new Date('2099-12-31T00:00:00Z')

  await prisma.agents.create({
    data: {
      id: agentId,
      name: agentName,
      agentCode: `test-${opts.label}-${agentId.slice(0, 8)}`,
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.signals.create({
    data: {
      id: signalId,
      name: signalName,
      agentId,
      orgId,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.customers.create({
    data: {
      id: customerId,
      organizationId: orgId,
      name: `dimension parity ${opts.label} customer ${customerId.slice(0, 8)}`,
      externalId: customerExternalId,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.pricing_plans.create({
    data: {
      id: planId,
      orgId,
      agentId,
      name: `dimension parity ${opts.label} plan ${planId.slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.pricing_strategies.create({
    data: {
      id: strategyId,
      planId,
      orgId,
      agentId,
      signalId,
      name: `dimension parity ${opts.label} strat ${strategyId.slice(0, 8)}`,
      chargeType: 'usage',
      pricingModel: opts.pricingModel,
      rate: opts.rate,
      tiers: opts.tiers ?? [],
      minimumCommitment: opts.minimumCommitment ?? null,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
  })
  // startDate well before the window so a canceled sub still overlaps by date
  // (canon resolves subs by date-overlap, not status).
  await prisma.subscriptions.create({
    data: {
      id: subscriptionId,
      organizationId: orgId,
      customerId,
      agentId,
      planId,
      name: `dimension parity ${opts.label} sub ${subscriptionId.slice(0, 8)}`,
      status: opts.subStatus,
      billingCycle: 'monthly',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      nextRecurringInvoiceAt: farFuture,
      nextUsageInvoiceAt: farFuture,
      createdAt: now,
      updatedAt: now,
    },
  })

  const eventIds: string[] = []
  for (let i = 0; i < opts.eventQuantities.length; i++) {
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
        usageDate: new Date(`2026-04-0${i + 2}T12:00:00.000Z`),
        usageCost: 0.5,
        quantity: opts.eventQuantities[i],
        environment: 'production',
        idempotencyKey: `dimension-parity-${opts.label}-${id}`,
        createdAt: now,
        updatedAt: now,
      },
    })
    eventIds.push(id)
  }

  return {
    agentId,
    agentName,
    signalId,
    signalName,
    customerId,
    planId,
    subscriptionId,
    strategyId,
    eventIds,
  }
}

async function teardownEarnedFixture(f: EarnedFixture): Promise<void> {
  await prisma.signal_events.deleteMany({ where: { id: { in: f.eventIds } } })
  await prisma.subscriptions.deleteMany({ where: { id: f.subscriptionId } })
  await prisma.pricing_strategies.deleteMany({ where: { id: f.strategyId } })
  await prisma.pricing_plans.deleteMany({ where: { id: f.planId } })
  await prisma.customers.deleteMany({ where: { id: f.customerId } })
  await prisma.signals.deleteMany({ where: { id: f.signalId } })
  await prisma.agents.deleteMany({ where: { id: f.agentId } })
}

/**
 * Three assertions that per-event pricing fails: getRevenueByDimension ==
 * getFullCommandCenterBreakdown == getAgentEarned == the known dollar figure,
 * for BOTH the agent and signal (task) dimensions.
 */
async function assertCanonEarned(
  f: EarnedFixture,
  expectedDollars: number
): Promise<void> {
  const scopedFilters = { customerId: f.customerId }

  const byAgent = await getRevenueByDimension(
    prisma,
    orgId,
    WINDOW,
    'agent',
    scopedFilters
  )
  const bySignal = await getRevenueByDimension(
    prisma,
    orgId,
    WINDOW,
    'signal',
    scopedFilters
  )
  expect(byAgent?.byKey.get(f.agentId)).toBeCloseTo(expectedDollars, 2)
  expect(bySignal?.byKey.get(f.signalId)).toBeCloseTo(expectedDollars, 2)

  // Canon anchor: getAgentEarned's own number for the same scope.
  const anchor = await getAgentEarned(prisma, orgId, WINDOW, scopedFilters)
  expect(anchor.revenue).toBeCloseTo(expectedDollars, 2)
  expect(byAgent?.byKey.get(f.agentId)).toBeCloseTo(anchor.revenue, 2)

  // XLSX parity: the export path computes the same canon-correct number.
  const full = await getFullCommandCenterBreakdown({
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    customerId: f.customerId,
  })
  const agentRow = full.agent.find((row) => row.name === f.agentName)
  const taskRow = full.task.find((row) => row.name === f.signalName)
  expect(agentRow?.revenue).toBeCloseTo(expectedDollars, 2)
  expect(taskRow?.revenue).toBeCloseTo(expectedDollars, 2)
  expect(agentRow!.revenue).toBeCloseTo(byAgent?.byKey.get(f.agentId) ?? -1, 2)
}

describe('canon bucket — graduated tiers cross across the window (bucket $200, per-event $300)', () => {
  let fixture: EarnedFixture
  beforeAll(async () => {
    fixture = await seedEarnedFixture({
      label: 'graduated',
      pricingModel: 'graduated',
      rate: 1,
      tiers: [
        { lower: 0, upper: 100, rate: 1 },
        { lower: 100, upper: null, rate: 0.5 },
      ],
      subStatus: 'active',
      eventQuantities: [100, 100, 100],
    })
  })
  afterAll(async () => {
    await teardownEarnedFixture(fixture)
  })

  it('agent + signal Earned = $200 (100×$1 + 200×$0.50), matching XLSX and getAgentEarned', async () => {
    await assertCanonEarned(fixture, 200)
  })
})

describe('canon bucket — minimum-commitment floor lifts the window total (bucket $100, per-event $20)', () => {
  let fixture: EarnedFixture
  beforeAll(async () => {
    fixture = await seedEarnedFixture({
      label: 'mincommit',
      pricingModel: 'flat',
      rate: 0.1,
      minimumCommitment: 1000,
      subStatus: 'active',
      eventQuantities: [200],
    })
  })
  afterAll(async () => {
    await teardownEarnedFixture(fixture)
  })

  it('agent + signal Earned = $100 (max(200,1000)×$0.10), matching XLSX and getAgentEarned', async () => {
    await assertCanonEarned(fixture, 100)
  })
})

describe('canon bucket — a cancelled sub keeps its earned via date-overlap (bucket $100, per-event $0)', () => {
  let fixture: EarnedFixture
  beforeAll(async () => {
    fixture = await seedEarnedFixture({
      label: 'canceled',
      pricingModel: 'flat',
      rate: 1,
      subStatus: 'canceled',
      eventQuantities: [60, 40],
    })
  })
  afterAll(async () => {
    await teardownEarnedFixture(fixture)
  })

  it('agent + signal Earned = $100 (100 units × $1) even though status=canceled, matching XLSX and getAgentEarned', async () => {
    await assertCanonEarned(fixture, 100)
  })
})
