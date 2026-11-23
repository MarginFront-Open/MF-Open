/**
 * Parity tests for the Customer MRR / Run-Rate MRR action wiring.
 *
 * Three tests:
 *   1. getCustomerMrrArr.mrr matches canonGetMrr({ customerId }).
 *   2. getCustomerMrrArr.runRateMrr matches canonGetRunRateMrr({ customerId }).
 *   3. revenueTypeSplit totals match the sum of the canonical Run-Rate MRR
 *      breakdown rows (recurring, seatBased, usage). Guards the Server
 *      Action's per-row aggregation so drift between the canon breakdown
 *      and the UI's type-split card surfaces as a dollar diff.
 *
 * The math lives in @marginfront/db (tested in api-nest revenue-calc.spec).
 * These tests verify the Server Action is a thin pass-through, not a
 * second implementation.
 */

import { PrismaClient } from '@prisma/client'
import {
  getMrr as canonGetMrr,
  getRunRateMrr as canonGetRunRateMrr,
} from '@marginfront/db'
import {
  getSampleOrgIdForTests,
  buildAuthMock,
  buildHeadersMock,
} from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())

type CustomerMrrModule = typeof import('../customer-mrr')
let actions: CustomerMrrModule

const prisma = new PrismaClient()
const EPSILON = 0.01

beforeAll(async () => {
  const orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  actions = await import('../customer-mrr')
})

afterAll(async () => {
  await prisma.$disconnect()
})

/**
 * Pick a customer that has at least one active subscription so MRR2's
 * breakdown is non-empty. Falls back to the first customer in the org
 * if nothing active is found (the action still runs; tests still pass
 * with zero values).
 */
async function pickCustomerWithActiveSubs(orgId: string): Promise<string> {
  const sub = await prisma.subscriptions.findFirst({
    where: {
      organizationId: orgId,
      status: 'active',
      deletedAt: null,
    },
    select: { customerId: true },
  })
  if (sub) return sub.customerId

  const any = await prisma.customers.findFirst({
    where: { organizationId: orgId, deletedAt: null, isInternal: false },
    select: { id: true },
  })
  if (!any) throw new Error('No customers in the test organization')
  return any.id
}

describe('Customer MRR canonical parity', () => {
  it('getCustomerMrrArr.mrr matches canonGetMrr({ customerId })', async () => {
    const orgId = await getSampleOrgIdForTests()
    const customerId = await pickCustomerWithActiveSubs(orgId)

    const actionResult = await actions.getCustomerMrrArr(customerId)
    expect(actionResult.success).toBe(true)
    expect(actionResult.data).toBeDefined()

    const canonical = await canonGetMrr(prisma, orgId, { customerId })
    const diff = Math.abs(actionResult.data!.mrr - canonical.mrr)
    if (diff > EPSILON) {
      throw new Error(
        `mrr: action=${actionResult.data!.mrr.toFixed(4)}, canonical=${canonical.mrr.toFixed(4)} (diff ${diff.toFixed(4)})`
      )
    }
    // ARR parity: action returns mrr * 12 in the arr field.
    expect(actionResult.data!.arr).toBeCloseTo(canonical.mrr * 12, 6)
  })

  it('getCustomerMrrArr.runRateMrr matches canonGetRunRateMrr({ customerId })', async () => {
    const orgId = await getSampleOrgIdForTests()
    const customerId = await pickCustomerWithActiveSubs(orgId)

    const actionResult = await actions.getCustomerMrrArr(customerId)
    expect(actionResult.success).toBe(true)

    const canonical = await canonGetRunRateMrr(prisma, orgId, { customerId })
    const diff = Math.abs(actionResult.data!.runRateMrr - canonical.mrr)
    if (diff > EPSILON) {
      throw new Error(
        `runRateMrr: action=${actionResult.data!.runRateMrr.toFixed(4)}, canonical=${canonical.mrr.toFixed(4)} (diff ${diff.toFixed(4)})`
      )
    }
    expect(actionResult.data!.runRateArr).toBeCloseTo(canonical.mrr * 12, 6)
  })

  it('revenueTypeSplit matches sum of canonical Run-Rate MRR breakdown rows', async () => {
    const orgId = await getSampleOrgIdForTests()
    const customerId = await pickCustomerWithActiveSubs(orgId)

    const actionResult = await actions.getCustomerMrrArr(customerId)
    expect(actionResult.success).toBe(true)

    // Independently sum recurring / seatBased / usage across the canon
    // breakdown and compare to the action's revenueTypeSplit aggregation.
    const canonical = await canonGetRunRateMrr(prisma, orgId, { customerId })
    const expected = canonical.breakdown.reduce(
      (acc, row) => ({
        recurring: acc.recurring + row.recurring,
        seatBased: acc.seatBased + row.seatBased,
        usage: acc.usage + row.usage,
      }),
      { recurring: 0, seatBased: 0, usage: 0 }
    )

    const split = actionResult.data!.revenueTypeSplit
    const rDiff = Math.abs(split.recurring - expected.recurring)
    const sDiff = Math.abs(split.seatBased - expected.seatBased)
    const uDiff = Math.abs(split.usage - expected.usage)
    if (rDiff > EPSILON || sDiff > EPSILON || uDiff > EPSILON) {
      throw new Error(
        `revenueTypeSplit drift: recurring ${rDiff.toFixed(4)}, seatBased ${sDiff.toFixed(4)}, usage ${uDiff.toFixed(4)}`
      )
    }

    // Sanity: the three components sum to the reported runRateMrr total
    // (within epsilon). If this fails the action is over/under counting.
    const splitTotal = split.recurring + split.seatBased + split.usage
    expect(splitTotal).toBeCloseTo(actionResult.data!.runRateMrr, 6)
  })
})
