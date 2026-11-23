/**
 * WHAT THIS FILE DOES: proves the money-write gate on
 * createSimulatorDemoPricing — a parallel path that creates the SAME money
 * tables (pricing_plans, pricing_strategies, subscriptions) as the already-gated
 * createPricingPlan / createSubscription, so a direct action call by a plain
 * member must be refused too. Fully mocked — no DB.
 *
 *   - member / no-membership -> { success: false }, and db.$transaction (the only
 *     write path) is NEVER called: the gate stops it before any write.
 *   - finance -> the gate passes and execution reaches db.$transaction.
 *   - the role lookup is scoped to the caller's active org.
 */

export {}

const ORG = 'org-real-sim'
const USER = 'user-sim'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = { activeOrganizationId: ORG, userId: USER }

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
const baMemberFindFirst = jest.fn()
const dbTransaction = jest.fn()
jest.mock('@/app/lib/db', () => ({
  Prisma: { Decimal: class {}, InputJsonValue: class {} },
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    $transaction: (cb: unknown) => dbTransaction(cb),
  },
}))

type Mod = typeof import('../create-simulator-demo-pricing')
let mod: Mod

const VALID_INPUT = {
  agentCode: 'sim-agent',
  customerExternalId: 'sim-customer',
  signalName: 'tokens',
  ratePerUnit: 0.01,
}

beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  mod = await import('../create-simulator-demo-pricing')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  dbTransaction.mockReset()
})

describe('createSimulatorDemoPricing — money-write gate', () => {
  it('rejects a plain member and never opens a write transaction', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.createSimulatorDemoPricing(VALID_INPUT)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/finance, admin, or owner/i)
    expect(dbTransaction).not.toHaveBeenCalled()
    // role read against the caller's active org
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a caller with no membership row and never writes', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const res = await mod.createSimulatorDemoPricing(VALID_INPUT)
    expect(res.success).toBe(false)
    expect(dbTransaction).not.toHaveBeenCalled()
  })

  it('lets a finance user through to the write transaction', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    dbTransaction.mockResolvedValue({
      agentId: 'a',
      customerId: 'c',
      planId: 'p',
      strategyId: 's',
      subscriptionId: 'sub',
    })
    const res = await mod.createSimulatorDemoPricing(VALID_INPUT)
    expect(dbTransaction).toHaveBeenCalledTimes(1)
    expect(res.success).toBe(true)
  })
})
