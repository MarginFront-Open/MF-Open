/**
 * Canon getMrr is active-recurring-contract-value: it sums
 * (rate / monthlyDivisor) across every active subscription's recurring +
 * seat-based strategies. Usage and one-time are excluded. ARR = MRR × 12.
 * A brand-new active sub with $50/mo recurring counts before its first
 * invoice lands.
 *
 * Scenarios exercised end-to-end against the test organization:
 *   1. Active monthly recurring $50/mo → MRR adds $50
 *   2. Active YEARLY recurring $600/yr → MRR adds $50 (÷12)
 *   3. Active seat-based $10 × 5 seats monthly → MRR adds $50
 *   4. Active usage-only strategy → MRR adds $0 (canon excludes usage)
 *   5. Active onetime strategy → MRR adds $0 (canon excludes one-time)
 *   6. Cancelled sub with recurring strategy → MRR adds $0 (status filter)
 *   7. customerId filter narrows the sum to one customer
 *   8. A customer with active recurring + zero invoices in the prior
 *      calendar month returns non-zero MRR.
 *
 * Each scenario seeds an isolated sub + plan + strategy combination, runs
 * getMrr with a customerId filter so the org's pre-existing data doesn't
 * pollute the assertion, then cleans up via cascade delete.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { getMrr } from '@marginfront/db'
import { getSampleOrgIdForTests } from './_helpers/mock-session'

const prisma = new PrismaClient()
const EPSILON = 0.01

let orgId: string
let customerId: string
let agentId: string
let signalId: string

// Tracked for cleanup. Order matters — subs FK → plans → strategies; delete
// subs first.
const createdSubIds: string[] = []
const createdPlanIds: string[] = []
const createdStrategyIds: string[] = []

beforeAll(async () => {
  orgId = await getSampleOrgIdForTests()

  // Reuse any existing customer + agent + signal — these scenarios only
  // need them as foreign-key anchors. New plan/strategy per scenario.
  const cust = await prisma.customers.findFirst({
    where: { organizationId: orgId, deletedAt: null, isInternal: false },
    select: { id: true },
  })
  if (!cust) throw new Error('The test organization has no customers — re-run seed.')
  customerId = cust.id

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
})

afterEach(async () => {
  if (createdSubIds.length > 0) {
    await prisma.subscriptions.deleteMany({
      where: { id: { in: createdSubIds } },
    })
    createdSubIds.length = 0
  }
  if (createdStrategyIds.length > 0) {
    await prisma.pricing_strategies.deleteMany({
      where: { id: { in: createdStrategyIds } },
    })
    createdStrategyIds.length = 0
  }
  if (createdPlanIds.length > 0) {
    await prisma.pricing_plans.deleteMany({
      where: { id: { in: createdPlanIds } },
    })
    createdPlanIds.length = 0
  }
})

afterAll(async () => {
  await prisma.$disconnect()
})

/**
 * Spin up an isolated plan + strategy + active sub for the given customer.
 * Each scenario passes its own strategy shape so we exercise one case per
 * test. billingCycle defaults to monthly; pass 'yearly' to test the ÷12.
 */
async function seedSubWithStrategy(args: {
  chargeType: 'recurring' | 'seat_based' | 'usage' | 'onetime'
  rate: number
  billingCycle?: 'monthly' | 'yearly'
  seatsCount?: number
  subStatus?: 'active' | 'canceled' | 'pending'
  testCustomerId?: string
}): Promise<{ subId: string }> {
  const {
    chargeType,
    rate,
    billingCycle = 'monthly',
    seatsCount = 1,
    subStatus = 'active',
    testCustomerId = customerId,
  } = args

  const planId = randomUUID()
  const strategyId = randomUUID()
  const subId = randomUUID()
  const now = new Date()

  await prisma.pricing_plans.create({
    data: {
      id: planId,
      name: `MRR-TEST-${planId.slice(0, 8)}`,
      orgId,
      agentId,
      createdAt: now,
      updatedAt: now,
    },
  })
  createdPlanIds.push(planId)

  await prisma.pricing_strategies.create({
    data: {
      id: strategyId,
      planId,
      orgId,
      agentId,
      signalId,
      name: `MRR-TEST-strat-${strategyId.slice(0, 8)}`,
      chargeType: chargeType as any,
      pricingModel: 'flat' as any,
      rate,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
  })
  createdStrategyIds.push(strategyId)

  // nextRecurringInvoiceAt is required by the schema. Test subs never
  // actually invoice — set it to a far-future date so no scheduler can
  // pick them up if anything runs concurrently.
  const farFuture = new Date('2099-12-31T00:00:00Z')

  await prisma.subscriptions.create({
    data: {
      id: subId,
      name: `MRR-TEST-sub-${subId.slice(0, 8)}`,
      organizationId: orgId,
      customerId: testCustomerId,
      agentId,
      planId,
      billingCycle: billingCycle as any,
      status: subStatus as any,
      seatsCount,
      startDate: now,
      nextRecurringInvoiceAt: farFuture,
      nextUsageInvoiceAt: farFuture,
      createdAt: now,
      updatedAt: now,
    },
  })
  createdSubIds.push(subId)

  return { subId }
}

describe('getMrr is active recurring contract value', () => {
  it('active monthly recurring $50/mo → MRR adds $50', async () => {
    const before = await getMrr(prisma, orgId, { customerId })
    await seedSubWithStrategy({ chargeType: 'recurring', rate: 50 })
    const after = await getMrr(prisma, orgId, { customerId })

    expect(after.mrr - before.mrr).toBeCloseTo(50, 2)
    expect(after.arr - before.arr).toBeCloseTo(600, 2)
  })

  it('active YEARLY recurring $600/yr → MRR adds $50 (÷12)', async () => {
    const before = await getMrr(prisma, orgId, { customerId })
    await seedSubWithStrategy({
      chargeType: 'recurring',
      rate: 600,
      billingCycle: 'yearly',
    })
    const after = await getMrr(prisma, orgId, { customerId })

    expect(after.mrr - before.mrr).toBeCloseTo(50, 2)
    expect(after.arr - before.arr).toBeCloseTo(600, 2)
  })

  it('active seat-based $10 × 5 seats monthly → MRR adds $50', async () => {
    const before = await getMrr(prisma, orgId, { customerId })
    await seedSubWithStrategy({
      chargeType: 'seat_based',
      rate: 10,
      seatsCount: 5,
    })
    const after = await getMrr(prisma, orgId, { customerId })

    expect(after.mrr - before.mrr).toBeCloseTo(50, 2)
  })

  it('active usage-only strategy → MRR adds $0 (usage excluded)', async () => {
    const before = await getMrr(prisma, orgId, { customerId })
    await seedSubWithStrategy({ chargeType: 'usage', rate: 1 })
    const after = await getMrr(prisma, orgId, { customerId })

    expect(Math.abs(after.mrr - before.mrr)).toBeLessThan(EPSILON)
  })

  it('active onetime strategy → MRR adds $0 (one-time excluded)', async () => {
    const before = await getMrr(prisma, orgId, { customerId })
    await seedSubWithStrategy({ chargeType: 'onetime', rate: 100 })
    const after = await getMrr(prisma, orgId, { customerId })

    expect(Math.abs(after.mrr - before.mrr)).toBeLessThan(EPSILON)
  })

  it('canceled sub with recurring strategy → MRR adds $0 (status filter)', async () => {
    const before = await getMrr(prisma, orgId, { customerId })
    await seedSubWithStrategy({
      chargeType: 'recurring',
      rate: 50,
      subStatus: 'canceled',
    })
    const after = await getMrr(prisma, orgId, { customerId })

    expect(Math.abs(after.mrr - before.mrr)).toBeLessThan(EPSILON)
  })

  it('regression guard: active recurring with NO recent invoice → returns non-zero MRR', async () => {
    // A brand-new sub with a recurring strategy active TODAY should show
    // MRR > 0 immediately, even though
    // its first invoice won't land until the next billing cycle close.
    const before = await getMrr(prisma, orgId, { customerId })
    await seedSubWithStrategy({ chargeType: 'recurring', rate: 99 })
    const after = await getMrr(prisma, orgId, { customerId })

    expect(after.mrr - before.mrr).toBeCloseTo(99, 2)
  })

  it('arr always equals mrr × 12', async () => {
    const result = await getMrr(prisma, orgId, { customerId })
    expect(result.arr).toBeCloseTo(result.mrr * 12, 4)
  })

  it('customerId filter narrows result to one customer', async () => {
    // Find a second customer to seed on, so we can prove the filter scopes.
    const otherCust = await prisma.customers.findFirst({
      where: {
        organizationId: orgId,
        id: { not: customerId },
        deletedAt: null,
        isInternal: false,
      },
      select: { id: true },
    })
    if (!otherCust) {
      console.warn(
        'The test organization has only one customer — skipping filter scope test'
      )
      return
    }

    const beforeUs = await getMrr(prisma, orgId, { customerId })
    const beforeThem = await getMrr(prisma, orgId, { customerId: otherCust.id })

    // Seed only for "them" — our customer's MRR should not change
    await seedSubWithStrategy({
      chargeType: 'recurring',
      rate: 77,
      testCustomerId: otherCust.id,
    })

    const afterUs = await getMrr(prisma, orgId, { customerId })
    const afterThem = await getMrr(prisma, orgId, { customerId: otherCust.id })

    expect(Math.abs(afterUs.mrr - beforeUs.mrr)).toBeLessThan(EPSILON)
    expect(afterThem.mrr - beforeThem.mrr).toBeCloseTo(77, 2)
  })
})
