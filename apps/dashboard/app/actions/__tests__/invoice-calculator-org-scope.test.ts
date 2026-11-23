/**
 * WHAT THIS FILE DOES: proves the dashboard simulateRevenue plan lookup is
 * scoped to the caller's org (the dashboard twin of the api-nest scoping).
 * A bare findUnique by plan ID would hand any authenticated user holding
 * another org's plan UUID that org's full pricing sheet.
 * Fully mocked — no DB.
 *
 *   - the lookup's WHERE carries the caller's activeOrganizationId
 *   - a cross-org plan ID (lookup misses) -> 'Pricing plan not found', no data
 *   - no active org -> rejected before any query
 *   - same-org happy path still simulates (seat clamp + billedSeatsCount intact)
 */

export {}

const ORG = 'org-real-sim'

let sessionState: { activeOrganizationId: string | null } = {
  activeOrganizationId: ORG,
}

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const planFindFirst = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    pricing_plans: { findFirst: (a: unknown) => planFindFirst(a) },
  },
}))

type Mod = typeof import('../invoice-calculator')
let mod: Mod

const PAYLOAD = {
  pricingPlanId: 'plan-uuid-1',
  projectedEvents: {},
  billingCycle: 'monthly',
  seatsCount: 5,
}

const SEAT_PLAN = {
  id: 'plan-uuid-1',
  name: 'Seat plan',
  description: null,
  agents: null,
  pricing_strategies: [
    {
      id: 'strat-1',
      name: 'Seats',
      chargeType: 'seat_based',
      pricingModel: 'flat',
      rate: null,
      tiers: [{ lower: 0, upper: null, rate: 10 }],
      minimumCommitment: 10,
      billingFrequency: 'monthly',
      signals: null,
    },
  ],
}

beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  mod = await import('../invoice-calculator')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG }
  planFindFirst.mockReset()
})

describe('simulateRevenue — org-scoped plan lookup', () => {
  it('queries the plan WITH the caller org in the where clause', async () => {
    planFindFirst.mockResolvedValue(SEAT_PLAN)
    await mod.simulateRevenue(PAYLOAD)
    expect(planFindFirst).toHaveBeenCalledTimes(1)
    expect(planFindFirst.mock.calls[0][0].where).toMatchObject({
      id: 'plan-uuid-1',
      orgId: ORG,
    })
  })

  it("returns 'not found' when the org filter misses (cross-org plan ID)", async () => {
    planFindFirst.mockResolvedValue(null)
    const res = await mod.simulateRevenue(PAYLOAD)
    expect(res.success).toBe(false)
    expect(res.error).toBe('Pricing plan not found')
    expect(res.data).toBeUndefined()
  })

  it('rejects a caller with no active org before any query', async () => {
    sessionState = { activeOrganizationId: null }
    const res = await mod.simulateRevenue(PAYLOAD)
    expect(res.success).toBe(false)
    expect(planFindFirst).not.toHaveBeenCalled()
  })

  it('same-org path still simulates: seat clamp and billedSeatsCount intact', async () => {
    planFindFirst.mockResolvedValue(SEAT_PLAN)
    const res = await mod.simulateRevenue(PAYLOAD)
    expect(res.success).toBe(true)
    // 5 entered against a 10-seat minimum bills 10 seats at $10
    expect(res.data.billedSeatsCount).toBe(10)
    expect(res.data.simulationSummary.seatBasedCosts).toBe(100)
    expect(res.data.recurringCharges.lineItems[0].description).toContain(
      'minimum commitment, 5 entered'
    )
  })
})
