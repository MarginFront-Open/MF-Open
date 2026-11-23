/**
 * Parity test for the revenue-only Revenue Simulator.
 *
 * Negative assertion: the simulateRevenue response must contain NO
 * fake-margin fields anywhere in its payload. The simulator is revenue-only,
 * so any margin it reported would rest on a made-up unitCost=0. This test makes such a field show up as a concrete failure
 * rather than a silent reappearance in the UI.
 *
 * Forbidden field names (exact name match, case-insensitive): cost,
 * margin, unitCost, totalDeliveryCost, marginAmount, totalMargin,
 * yearlyMargin. "setupCosts / recurringCosts / usageBasedCosts /
 * seatBasedCosts" are intentionally allowed — those are revenue-summary
 * aliases, not fake-margin fields.
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

type InvoiceCalculatorModule = typeof import('../invoice-calculator')
let actions: InvoiceCalculatorModule

const prisma = new PrismaClient()

beforeAll(async () => {
  const orgId = await getSampleOrgIdForTests()
  authMock.__setSessionOrgId(orgId)
  actions = await import('../invoice-calculator')
})

afterAll(async () => {
  await prisma.$disconnect()
})

/**
 * Deep walk an object, collecting every property key at any depth.
 * Used below to check for forbidden field names. Exact name match
 * (not substring) so legitimate fields like setupCosts do not trip.
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

describe('invoice-calculator — no fake-margin fields in response', () => {
  it('simulateRevenue response contains no cost/margin-flavored fake-margin fields', async () => {
    const orgId = await getSampleOrgIdForTests()

    // Pick any pricing plan from the test organization that has at least one
    // active strategy so the simulator exercises its real code paths.
    const plan = await prisma.pricing_plans.findFirst({
      where: {
        orgId: orgId,
        deletedAt: null,
        pricing_strategies: {
          some: { active: true, deletedAt: null },
        },
      },
      select: { id: true },
    })
    if (!plan) {
      throw new Error(
        'No pricing plans with active strategies in the test organization; cannot exercise simulator'
      )
    }

    const result = await actions.simulateRevenue({
      pricingPlanId: plan.id,
      projectedEvents: {},
      billingCycle: 'monthly',
      seatsCount: 5,
    })
    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()

    const forbiddenExact = new Set([
      'cost',
      'margin',
      'unitcost',
      'totaldeliverycost',
      'marginamount',
      'totalmargin',
      'yearlymargin',
      'usagecost',
      'costamount',
    ])

    const keys = collectAllKeys(result.data)
    const violations: string[] = []
    for (const key of keys) {
      if (forbiddenExact.has(key.toLowerCase())) {
        violations.push(key)
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `simulateRevenue response contains forbidden fake-margin fields: ${violations.join(', ')}`
      )
    }
  })
})
